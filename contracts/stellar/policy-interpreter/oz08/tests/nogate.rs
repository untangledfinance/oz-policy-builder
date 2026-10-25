//! Liquidation by anyone through an execution adapter with no gate, on
//! OpenZeppelin's smart account 0.8.0.
//!
//! Everything here is the real code: OZ's account (`multisig-account-example`
//! at `8e25220`, the fixture `oz08.rs` pins), the interpreter wasm
//! (`build-wasm.sh`, or `INTERPRETER_WASM`) and the execution adapter wasm
//! (`../../execution-adapter/build-wasm.sh`, or `ADAPTER_WASM`). The tokens are
//! Stellar asset contracts; the market and the gate are the models in
//! `src/lib.rs`. Every authorisation is a real `SorobanAuthorizationEntry`.
//!
//! The account (the line's settlement account) holds a debt at the market and
//! a basket of XLM. A liquidator `L`, on no list of the line, runs one batch
//! through the no-gate adapter `N`, with no key of the line signing:
//!
//! 1. `tusd.transfer(L, account, R)`, L paying R in;
//! 2. `xlm.transfer(account, L, y)`, the basket out to the same L;
//! 3. `market.repay(account, R)`, which pulls `tusd.transfer(account, market,
//!    R)` from the account - a request nested inside the venue;
//! 4. `market.withdraw_collateral(account, R)`;
//! 5. `pot.burn(account, R)`.
//!
//! The account's rules are all keyless and bound to `N`: the liquidate rule
//! scoped to `N` (the batch shape, the relational binding of the liquidator,
//! the market's numbers) and one inner rule per contract. `N` hands out, for
//! this call only, its word for each context the batch names and for its own
//! `execute`.

extern crate alloc;
extern crate std;

use policy_interpreter_oz08::{
    Approving, AuthPayload, Call, ContextRule, ContextRuleType, Gate, Market, MarketClient,
    PolicyInstallParams, Signer, DEFAULT,
};
use soroban_sdk::auth::{
    Context, ContractContext, InvokerContractAuthEntry, SubContractInvocation,
};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::xdr::{
    self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, ScErrorType,
    ScSymbol, ScVal, ScVec, SorobanAddressCredentials, SorobanAuthorizationEntry,
    SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, ToXdr, VecM,
    WriteXdr,
};
use soroban_sdk::{
    testutils::EnvTestConfig, Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val,
    Vec,
};

const OZ08_WASM: &[u8] =
    include_bytes!("../../tests/fixtures/oz_0_8_0_multisig_account_example.wasm");
const EXPIRES_IN: u32 = 100;
const SALT_TEXT: &[u8] = b"prime.execution.adapter.v5";

/// What the line owes, its cover, R, y and the XLM price (7 decimals).
const DEBT: i128 = 10_000_000_000;
const COVER: i128 = 1_000_000_000; // 10% of the debt: below 15%
const R: i128 = 4_000_000_000; // 40% of the debt
const PRICE: i128 = 2_000_000; // 0.2 TUSD per XLM
const Y: i128 = 20_000_000_000; // 2,000 XLM = 400 TUSD at 0.2: 100% of R

fn wasm(var: &str, rel: &str) -> std::vec::Vec<u8> {
    let path =
        std::env::var(var).unwrap_or_else(|_| std::format!("{}/{rel}", env!("CARGO_MANIFEST_DIR")));
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("no wasm at {path} ({e}): build it or set {var}"))
}

fn interpreter_wasm() -> std::vec::Vec<u8> {
    wasm(
        "INTERPRETER_WASM",
        "../target/wasm32v1-none/release/policy_interpreter.wasm",
    )
}

fn adapter_wasm() -> std::vec::Vec<u8> {
    wasm(
        "ADAPTER_WASM",
        "../../execution-adapter/target/wasm32v1-none/release/execution_adapter.wasm",
    )
}

fn env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

// ---- predicates, in the wire shape ----

fn sym(s: &str) -> ScVal {
    ScVal::Symbol(ScSymbol(s.as_bytes().to_vec().try_into().unwrap()))
}

fn scvec(items: alloc::vec::Vec<ScVal>) -> ScVal {
    let v: VecM<ScVal> = items.try_into().unwrap();
    ScVal::Vec(Some(ScVec(v)))
}

fn node(op: &str, rest: alloc::vec::Vec<ScVal>) -> ScVal {
    let mut items = alloc::vec![sym(op)];
    items.extend(rest);
    scvec(items)
}

fn and(kids: alloc::vec::Vec<ScVal>) -> ScVal {
    node("and", alloc::vec![scvec(kids)])
}

fn eq(a: ScVal, b: ScVal) -> ScVal {
    node("eq", alloc::vec![a, b])
}

fn i(v: i128) -> ScVal {
    ScVal::I128(xdr::Int128Parts {
        hi: (v >> 64) as i64,
        lo: (v as u128 & u128::from(u64::MAX)) as u64,
    })
}

fn u(n: u32) -> ScVal {
    ScVal::U32(n)
}

fn call_fn() -> ScVal {
    scvec(alloc::vec![sym("call_fn")])
}

fn fn_is(name: &str) -> ScVal {
    eq(call_fn(), sym(name))
}

fn arg(n: u32) -> ScVal {
    scvec(alloc::vec![sym("call_arg"), u(n)])
}

/// `calls[c].<field>`, or `calls[c].args[a]`.
fn at(c: u32, field: &str) -> ScVal {
    scvec(alloc::vec![sym("call_path"), u(0), u(c), sym(field)])
}

fn at_arg(c: u32, a: u32) -> ScVal {
    scvec(alloc::vec![sym("call_path"), u(0), u(c), sym("args"), u(a)])
}

fn scaled(src: ScVal, num: i128, den: i128) -> ScVal {
    scvec(alloc::vec![sym("scaled"), src, i(num), i(den), i(0)])
}

fn xdr_bytes(env: &Env, v: &ScVal) -> Bytes {
    let val: Val = v.into_val(env);
    val.to_xdr(env)
}

fn scval<T: IntoVal<Env, Val>>(env: &Env, v: T) -> ScVal {
    ScVal::try_from_val(env, &v.into_val(env)).unwrap()
}

// ---- the world ----

#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Ran,
    /// Refused in an authorisation: by a policy, by OZ or by the host.
    Refused,
    /// A contract error raised outside any authorisation (the adapter's).
    Code(u32),
}

struct World {
    env: Env,
    account: Address,
    interpreter: Address,
    adapter: Address,
    market: Address,
    tusd: Address,
    xlm: Address,
    pot: Address,
    liquidator: Address,
    insider: Address,
    admin: Address,
    nonce: core::cell::Cell<i64>,
}

/// The adapter's address for `(gate, min_wait, window)` under `prime`.
fn derived(env: &Env, prime: &Address, gate: Option<Address>, window: u32) -> Address {
    let mut b = Bytes::from_slice(env, SALT_TEXT);
    b.append(&(gate, 0u32, window).to_xdr(env));
    env.deployer()
        .with_address(prime.clone(), env.crypto().sha256(&b))
        .deployed_address()
}

impl World {
    fn new() -> Self {
        let env = env();
        env.ledger().with_mut(|l| {
            l.sequence_number = 1_000;
            l.timestamp = 1_800_000_000;
        });
        env.mock_all_auths();
        let interpreter = env.register(interpreter_wasm().as_slice(), (DEFAULT,));
        let admin = Address::generate(&env);
        let account = env.register(
            OZ08_WASM,
            (
                soroban_sdk::vec![&env, Signer::Delegated(admin.clone())],
                Map::<Address, Val>::new(&env),
            ),
        );
        let sac = |env: &Env| {
            env.register_stellar_asset_contract_v2(admin.clone())
                .address()
        };
        let (tusd, xlm, pot) = (sac(&env), sac(&env), sac(&env));
        let market = env.register(Market, (tusd.clone(),));
        let at = derived(&env, &account, None, 0);
        let adapter = env.register_at(
            &at,
            adapter_wasm().as_slice(),
            (account.clone(), None::<Address>, 0u32, 0u32),
        );
        let liquidator = env.register(Approving, ());
        let insider = env.register(Approving, ());
        StellarAssetClient::new(&env, &tusd).mint(&liquidator, &(10 * R));
        StellarAssetClient::new(&env, &tusd).mint(&insider, &(10 * R));
        StellarAssetClient::new(&env, &xlm).mint(&account, &(10 * Y));
        StellarAssetClient::new(&env, &pot).mint(&account, &DEBT);
        MarketClient::new(&env, &market).set(&account, &DEBT, &COVER, &PRICE);
        World {
            env,
            account,
            interpreter,
            adapter,
            market,
            tusd,
            xlm,
            pot,
            liquidator,
            insider,
            admin,
            nonce: core::cell::Cell::new(0),
        }
    }

    fn a(&self, a: &Address) -> ScVal {
        scval(&self.env, a.clone())
    }

    fn params(&self, predicate: &ScVal) -> PolicyInstallParams {
        let predicate = xdr_bytes(&self.env, predicate);
        let predicate_hash: BytesN<32> = self.env.crypto().sha256(&predicate).into();
        PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate,
            predicate_hash,
            policy_admins: soroban_sdk::vec![&self.env, Signer::Delegated(self.admin.clone())],
        }
    }

    /// `add_context_rule` on the account, as its owners do.
    fn add_rule(&self, scope: &Address, signers: Vec<Signer>, predicate: &ScVal) -> ContextRule {
        self.env.mock_all_auths();
        let mut map: Map<Address, Val> = Map::new(&self.env);
        map.set(
            self.interpreter.clone(),
            self.params(predicate).into_val(&self.env),
        );
        let args: Vec<Val> = (
            ContextRuleType::CallContract(scope.clone()),
            soroban_sdk::String::from_str(&self.env, "rule"),
            Option::<u32>::None,
            signers,
            map,
        )
            .into_val(&self.env);
        self.env.invoke_contract(
            &self.account,
            &Symbol::new(&self.env, "add_context_rule"),
            args,
        )
    }

    /// `bind_executor` of the account's rule to `executor`.
    fn bind(&self, rule: &ContextRule, executor: &Address) -> Option<u32> {
        self.env.mock_all_auths();
        let args: Vec<Val> =
            ((self.account.clone(), rule.id), executor.clone()).into_val(&self.env);
        match self.env.try_invoke_contract::<(), soroban_sdk::Error>(
            &self.interpreter,
            &Symbol::new(&self.env, "bind_executor"),
            args,
        ) {
            Ok(_) => None,
            Err(Ok(e)) => Some(e.get_code()),
            Err(Err(e)) => panic!("bind trapped: {e:?}"),
        }
    }

    fn keyless(&self, scope: &Address, predicate: &ScVal) -> ContextRule {
        let rule = self.add_rule(scope, Vec::new(&self.env), predicate);
        assert_eq!(self.bind(&rule, &self.adapter), None);
        rule
    }

    // ---- the rules ----

    /// The line's own addresses, none of which may be the liquidator.
    fn line(&self) -> ScVal {
        scvec(alloc::vec![
            self.a(&self.account),
            self.a(&self.adapter),
            self.a(&self.market),
            self.a(&self.admin),
            self.a(&self.insider),
        ])
    }

    fn read(&self, f: &str, args: alloc::vec::Vec<ScVal>) -> ScVal {
        scvec(alloc::vec![
            sym("read"),
            self.a(&self.market),
            sym(f),
            scvec(args)
        ])
    }

    /// The liquidate rule's predicate: PayFi's "Liquidation by anyone" shape.
    fn liquidate(&self) -> ScVal {
        let (paid, payer) = (at_arg(0, 2), at_arg(0, 0));
        let debt = self.read("debt", alloc::vec![self.a(&self.account)]);
        let cover = self.read("cover", alloc::vec![self.a(&self.account)]);
        let price = self.read("price", alloc::vec![]);
        let updated = self.read("updated", alloc::vec![]);
        let now = scvec(alloc::vec![sym("now")]);
        let fresh = scvec(alloc::vec![sym("scaled"), now, i(1), i(1), i(-300)]);
        and(alloc::vec![
            // The shape: five calls, each target and function fixed, at once.
            fn_is("execute"),
            eq(arg(2), u(0)),
            eq(scvec(alloc::vec![sym("call_arg_len"), u(0)]), u(5)),
            eq(at(0, "target"), self.a(&self.tusd)),
            eq(at(0, "function_name"), sym("transfer")),
            eq(at(1, "target"), self.a(&self.xlm)),
            eq(at(1, "function_name"), sym("transfer")),
            eq(at(2, "target"), self.a(&self.market)),
            eq(at(2, "function_name"), sym("repay")),
            eq(at(3, "target"), self.a(&self.market)),
            eq(at(3, "function_name"), sym("withdraw_collateral")),
            eq(at(4, "target"), self.a(&self.pot)),
            eq(at(4, "function_name"), sym("burn")),
            // The liquidator pays R in and takes the basket out, and is none
            // of the line's addresses.
            eq(payer.clone(), at_arg(1, 1)),
            node("nin", alloc::vec![payer, self.line()]),
            eq(at_arg(0, 1), self.a(&self.account)),
            eq(at_arg(1, 0), self.a(&self.account)),
            eq(at_arg(2, 0), self.a(&self.account)),
            eq(at_arg(3, 0), self.a(&self.account)),
            eq(at_arg(4, 0), self.a(&self.account)),
            node("gt", alloc::vec![paid.clone(), i(0)]),
            eq(paid.clone(), at_arg(2, 1)),
            eq(paid.clone(), at_arg(3, 1)),
            eq(paid.clone(), at_arg(4, 1)),
            // The market's numbers: cover below 15% of the debt, R at most
            // half of it, y at its price at most 105% of R, a fresh price.
            node(
                "lt",
                alloc::vec![scaled(cover, 100, 1), scaled(debt.clone(), 15, 1)]
            ),
            node("lte", alloc::vec![scaled(paid.clone(), 2, 1), debt]),
            node("gte", alloc::vec![updated, fresh]),
            node(
                "lte",
                alloc::vec![
                    scvec(alloc::vec![
                        sym("scaled"),
                        scaled(at_arg(1, 2), 100, 1),
                        price,
                        i(10_000_000),
                        i(0)
                    ]),
                    scaled(paid, 105, 1)
                ]
            ),
        ])
    }

    /// The inner rules: what the account does inside the batch.
    fn inner(&self) -> [(Address, ScVal); 4] {
        let own = || eq(arg(0), self.a(&self.account));
        [
            (
                self.xlm.clone(),
                and(alloc::vec![
                    fn_is("transfer"),
                    own(),
                    node("gt", alloc::vec![arg(2), i(0)]),
                    node(
                        "nin",
                        alloc::vec![arg(1), scvec(alloc::vec![self.a(&self.account)])]
                    ),
                ]),
            ),
            (
                self.market.clone(),
                and(alloc::vec![
                    node(
                        "in",
                        alloc::vec![
                            call_fn(),
                            scvec(alloc::vec![sym("repay"), sym("withdraw_collateral")])
                        ]
                    ),
                    own(),
                ]),
            ),
            (
                self.tusd.clone(),
                and(alloc::vec![
                    fn_is("transfer"),
                    own(),
                    eq(arg(1), self.a(&self.market)),
                ]),
            ),
            (self.pot.clone(), and(alloc::vec![fn_is("burn"), own()])),
        ]
    }

    /// Install every rule keyless and bound to `N`: the ids of the liquidate
    /// rule and of the xlm, market, tusd and pot rules.
    fn rules(&self) -> Rules {
        let liquidate = self.keyless(&self.adapter, &self.liquidate()).id;
        let [x, m, t, p] = self
            .inner()
            .map(|(scope, pred)| self.keyless(&scope, &pred).id);
        Rules {
            liquidate,
            xlm: x,
            market: m,
            tusd: t,
            pot: p,
        }
    }

    // ---- the batch ----

    fn call(&self, target: &Address, f: &str, args: Vec<Val>) -> Call {
        Call {
            target: target.clone(),
            function_name: Symbol::new(&self.env, f),
            args,
            executor_authorizations: Vec::new(&self.env),
        }
    }

    fn batch(&self, payer: &Address, r: i128, y: i128) -> Vec<Call> {
        let e = &self.env;
        let me = self.account.clone();
        soroban_sdk::vec![
            e,
            self.call(
                &self.tusd,
                "transfer",
                (payer.clone(), me.clone(), r).into_val(e)
            ),
            self.call(
                &self.xlm,
                "transfer",
                (me.clone(), payer.clone(), y).into_val(e)
            ),
            self.call(&self.market, "repay", (me.clone(), r).into_val(e)),
            self.call(
                &self.market,
                "withdraw_collateral",
                (me.clone(), r).into_val(e)
            ),
            self.call(&self.pot, "burn", (me, r).into_val(e)),
        ]
    }

    fn ctx(&self, contract: &Address, f: &str, args: Vec<Val>) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, f),
            args,
        })
    }

    /// The account's contexts inside the batch, in the order the host meets
    /// them: the basket out, the repay and its nested pull, the withdrawal,
    /// the burn.
    fn inner_ctxs(&self, payer: &Address, r: i128, y: i128) -> [Context; 5] {
        let e = &self.env;
        let me = self.account.clone();
        [
            self.ctx(
                &self.xlm,
                "transfer",
                (me.clone(), payer.clone(), y).into_val(e),
            ),
            self.ctx(&self.market, "repay", (me.clone(), r).into_val(e)),
            self.ctx(
                &self.tusd,
                "transfer",
                (me.clone(), self.market.clone(), r).into_val(e),
            ),
            self.ctx(
                &self.market,
                "withdraw_collateral",
                (me.clone(), r).into_val(e),
            ),
            self.ctx(&self.pot, "burn", (me, r).into_val(e)),
        ]
    }

    /// The word `N` is asked for: `enforce(account, context)` on `policy`.
    fn word(&self, policy: &Address, account: &Address, ctx: &Context) -> InvokerContractAuthEntry {
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: policy.clone(),
                fn_name: Symbol::new(&self.env, "enforce"),
                args: (account.clone(), ctx.clone()).into_val(&self.env),
            },
            sub_invocations: Vec::new(&self.env),
        })
    }

    fn words(&self, ctxs: &[Context]) -> Vec<InvokerContractAuthEntry> {
        let mut v = Vec::new(&self.env);
        for c in ctxs {
            v.push_back(self.word(&self.interpreter, &self.account, c));
        }
        v
    }

    // ---- authorisation entries ----

    fn next_nonce(&self) -> i64 {
        self.nonce.set(self.nonce.get() + 1);
        self.nonce.get()
    }

    fn expiry(&self) -> u32 {
        self.env.ledger().sequence() + EXPIRES_IN
    }

    fn signature_payload(&self, nonce: i64, root: &SorobanAuthorizedInvocation) -> BytesN<32> {
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(self.env.ledger().get().network_id),
            nonce,
            signature_expiration_ledger: self.expiry(),
            invocation: root.clone(),
        });
        let bytes = preimage.to_xdr(xdr::Limits::none()).unwrap();
        self.env
            .crypto()
            .sha256(&Bytes::from_slice(&self.env, &bytes))
            .to_bytes()
    }

    fn entry(
        &self,
        address: &Address,
        nonce: i64,
        signature: ScVal,
        root: SorobanAuthorizedInvocation,
    ) -> SorobanAuthorizationEntry {
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: address.into(),
                nonce,
                signature_expiration_ledger: self.expiry(),
                signature,
            }),
            root_invocation: root,
        }
    }

    /// The account's entry for `root`, citing `rule_ids` in tree order, with
    /// `signers` in the payload (each signs nothing: they approve whatever
    /// reaches them, and 0.8.0 checks the preimage).
    fn account_entry(
        &self,
        root: SorobanAuthorizedInvocation,
        rule_ids: &[u32],
        signers: &[Signer],
    ) -> (SorobanAuthorizationEntry, BytesN<32>) {
        let nonce = self.next_nonce();
        let mut ids = Vec::new(&self.env);
        for id in rule_ids {
            ids.push_back(*id);
        }
        let mut map: Map<Signer, Bytes> = Map::new(&self.env);
        for s in signers {
            map.set(s.clone(), Bytes::new(&self.env));
        }
        let payload = AuthPayload {
            signers: map,
            context_rule_ids: ids,
        };
        let digest = self.signature_payload(nonce, &root);
        (
            self.entry(&self.account, nonce, scval(&self.env, payload), root),
            digest,
        )
    }

    /// An entry of a contract account that approves anything (`Approving`).
    fn approving_entry(
        &self,
        who: &Address,
        root: SorobanAuthorizedInvocation,
    ) -> SorobanAuthorizationEntry {
        self.entry(who, self.next_nonce(), ScVal::Void, root)
    }

    /// An agent's entry authorising the account's `__check_auth` with the
    /// 0.8.0 preimage of `digest` for the one rule `id`.
    fn agent_entry(
        &self,
        agent: &Address,
        id: u32,
        digest: BytesN<32>,
    ) -> SorobanAuthorizationEntry {
        let preimage = policy_interpreter_oz08::AuthDigestPreimage {
            account: self.account.clone(),
            signature_payload: digest,
            context_rule_ids: soroban_sdk::vec![&self.env, id],
        };
        let root = invocation(
            &self.account,
            "__check_auth",
            alloc::vec![scval(&self.env, preimage)],
            alloc::vec![],
        );
        self.approving_entry(agent, root)
    }

    fn node(&self, contract: &Address, f: &str, args: Vec<Val>) -> SorobanAuthorizedInvocation {
        let args: alloc::vec::Vec<ScVal> = args.iter().map(|v| scval(&self.env, v)).collect();
        invocation(contract, f, args, alloc::vec![])
    }

    fn ctx_node(&self, ctx: &Context) -> SorobanAuthorizedInvocation {
        let Context::Contract(c) = ctx else {
            panic!("contract context")
        };
        let f =
            alloc::string::String::from_utf8(c.fn_name.to_string().as_bytes().to_vec()).unwrap();
        self.node(&c.contract, &f, c.args.clone())
    }

    /// The account's tree for `execute(calls, words, wait)`: the execute
    /// node, the five contexts under it (the pull nested under the repay).
    fn tree(
        &self,
        calls: &Vec<Call>,
        words: &Vec<InvokerContractAuthEntry>,
        wait: u32,
        inner: &[Context],
    ) -> SorobanAuthorizedInvocation {
        let args: Vec<Val> = (calls.clone(), words.clone(), wait).into_val(&self.env);
        let mut root = self.node(&self.adapter, "execute", args);
        let mut subs = alloc::vec::Vec::new();
        let mut k = 0;
        while k < inner.len() {
            let mut n = self.ctx_node(&inner[k]);
            let repay = matches!(&inner[k], Context::Contract(c) if c.fn_name == Symbol::new(&self.env, "repay"));
            if repay && k + 1 < inner.len() {
                n.sub_invocations = alloc::vec![self.ctx_node(&inner[k + 1])]
                    .try_into()
                    .unwrap();
                k += 1;
            }
            subs.push(n);
            k += 1;
        }
        root.sub_invocations = subs.try_into().unwrap();
        root
    }

    /// The liquidator's own entry for call 1.
    fn payer_entry(&self, payer: &Address, r: i128) -> SorobanAuthorizationEntry {
        let args: Vec<Val> = (payer.clone(), self.account.clone(), r).into_val(&self.env);
        self.approving_entry(payer, self.node(&self.tusd, "transfer", args))
    }

    /// Run `execute(calls, words, wait)` on `adapter` with exactly `entries`.
    fn run(
        &self,
        adapter: &Address,
        calls: &Vec<Call>,
        words: &Vec<InvokerContractAuthEntry>,
        wait: u32,
        entries: &[SorobanAuthorizationEntry],
    ) -> Flow {
        self.env.set_auths(entries);
        let args: Vec<Val> = (calls.clone(), words.clone(), wait).into_val(&self.env);
        // The test host's record of the authorisations, kept for `auths()`
        // after a call, is metered too; the call's own cost is printed.
        self.env.cost_estimate().budget().reset_unlimited();
        let r = self.env.try_invoke_contract::<Val, soroban_sdk::Error>(
            adapter,
            &Symbol::new(&self.env, "execute"),
            args,
        );
        let cpu = self.env.cost_estimate().budget().cpu_instruction_cost();
        std::println!("execute: {cpu} instructions");
        flow(r)
    }

    /// The whole liquidation: L pays `r` for `y`, under `rules` (the ids the
    /// account's entry cites, in tree order), with the words for `inner`.
    fn liquidate_with(
        &self,
        payer: &Address,
        r: i128,
        y: i128,
        ids: &[u32],
        signers: &[Signer],
    ) -> Flow {
        let calls = self.batch(payer, r, y);
        let inner = self.inner_ctxs(payer, r, y);
        let words = self.words(&inner);
        let (entry, _) = self.account_entry(self.tree(&calls, &words, 0, &inner), ids, signers);
        self.run(
            &self.adapter,
            &calls,
            &words,
            0,
            &[entry, self.payer_entry(payer, r)],
        )
    }

    fn ids(&self, r: &Rules) -> [u32; 6] {
        [r.liquidate, r.xlm, r.market, r.tusd, r.market, r.pot]
    }

    fn balance(&self, token: &Address, who: &Address) -> i128 {
        TokenClient::new(&self.env, token).balance(who)
    }
}

struct Rules {
    liquidate: u32,
    xlm: u32,
    market: u32,
    tusd: u32,
    pot: u32,
}

fn invocation(
    contract: &Address,
    f: &str,
    args: alloc::vec::Vec<ScVal>,
    subs: alloc::vec::Vec<SorobanAuthorizedInvocation>,
) -> SorobanAuthorizedInvocation {
    let args: VecM<ScVal> = args.try_into().unwrap();
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: contract.into(),
            function_name: f.try_into().unwrap(),
            args,
        }),
        sub_invocations: subs.try_into().unwrap(),
    }
}

fn flow<T: core::fmt::Debug, C: core::fmt::Debug, I: core::fmt::Debug>(
    r: Result<Result<T, C>, Result<soroban_sdk::Error, I>>,
) -> Flow {
    match r {
        Ok(Ok(_)) => Flow::Ran,
        Err(Ok(e)) if e.is_type(ScErrorType::Auth) || e.is_type(ScErrorType::Context) => {
            Flow::Refused
        }
        Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Flow::Code(e.get_code()),
        other => panic!("unexpected result {other:?}"),
    }
}

// ---- the liquidation ----

/// L1: a stranger liquidates alone. No key of the line signs: the account's
/// entry carries an empty signer map, and every rule it cites is keyless and
/// bound to `N`.
#[test]
fn l1_anyone_liquidates_through_the_no_gate_adapter() {
    let w = World::new();
    let rules = w.rules();
    let l = w.liquidator.clone();
    assert_eq!(w.liquidate_with(&l, R, Y, &w.ids(&rules), &[]), Flow::Ran);
    assert_eq!(w.balance(&w.xlm, &l), Y);
    assert_eq!(w.balance(&w.tusd, &w.market), R);
    assert_eq!(w.balance(&w.pot, &w.account), DEBT - R);
    assert_eq!(
        MarketClient::new(&w.env, &w.market).debt(&w.account),
        DEBT - R
    );
}

/// L1b: the same liquidation with the numbers off: y above 105% of R, R
/// above half the debt, the liquidator one of the line's addresses (the
/// account's admin), a healthy position. Each is refused by the liquidate
/// predicate; nothing moves.
#[test]
fn l1b_the_predicate_still_decides() {
    let w = World::new();
    let rules = w.rules();
    let ids = w.ids(&rules);
    let l = w.liquidator.clone();
    assert_eq!(
        w.liquidate_with(&l, R, Y * 106 / 100, &ids, &[]),
        Flow::Refused
    );
    assert_eq!(
        w.liquidate_with(&l, DEBT / 2 + 1, Y, &ids, &[]),
        Flow::Refused
    );
    // One of the line's own addresses as the liquidator.
    let insider = w.insider.clone();
    assert_eq!(w.liquidate_with(&insider, R, Y, &ids, &[]), Flow::Refused);
    assert_eq!(w.balance(&w.xlm, &insider), 0);
    // A healthy position: cover at 20% of the debt.
    MarketClient::new(&w.env, &w.market).set(&w.account, &DEBT, &(DEBT / 5), &PRICE);
    assert_eq!(w.liquidate_with(&l, R, Y, &ids, &[]), Flow::Refused);
    // A stale price.
    MarketClient::new(&w.env, &w.market).set(&w.account, &DEBT, &COVER, &PRICE);
    w.env.ledger().with_mut(|li| li.timestamp += 301);
    assert_eq!(w.liquidate_with(&l, R, Y, &ids, &[]), Flow::Refused);
    assert_eq!(w.balance(&w.xlm, &l), 0);
    // Back in range, the same liquidation runs.
    w.env.ledger().with_mut(|li| li.timestamp -= 301);
    assert_eq!(w.liquidate_with(&l, R, Y, &ids, &[]), Flow::Ran);
}

/// L2: the old shape - the liquidate rule signed by the adapter
/// (`Delegated(N)`) - is refused by OZ 0.8.0 as a delegated signer that is
/// also a contract called in the operation (3017), unchanged.
#[test]
fn l2_an_adapter_signed_liquidate_rule_is_still_3017() {
    let w = World::new();
    let rules = w.rules();
    let signer = Signer::Delegated(w.adapter.clone());
    let signed = w.add_rule(
        &w.adapter,
        soroban_sdk::vec![&w.env, signer.clone()],
        &w.liquidate(),
    );
    let mut ids = w.ids(&rules);
    ids[0] = signed.id;
    let l = w.liquidator.clone();
    assert_eq!(
        w.liquidate_with(&l, R, Y, &ids, core::slice::from_ref(&signer)),
        Flow::Refused
    );
    assert_eq!(w.balance(&w.xlm, &l), 0);
    // OZ's own verdict on the execute context alone is 3017.
    let calls = w.batch(&l, R, Y);
    let ctx = w.ctx(
        &w.adapter,
        "execute",
        (calls, w.words(&w.inner_ctxs(&l, R, Y)), 0u32).into_val(&w.env),
    );
    let mut map: Map<Signer, Bytes> = Map::new(&w.env);
    map.set(signer, Bytes::new(&w.env));
    let payload = AuthPayload {
        signers: map,
        context_rule_ids: soroban_sdk::vec![&w.env, signed.id],
    };
    w.env.mock_all_auths();
    let r = w.env.try_invoke_contract_check_auth::<soroban_sdk::Error>(
        &w.account,
        &BytesN::from_array(&w.env, &[7u8; 32]),
        payload.into_val(&w.env),
        &soroban_sdk::vec![&w.env, ctx],
    );
    assert!(matches!(r, Err(Ok(e)) if e.get_code() == 3017), "{r:?}");
}

// ---- the shape pin ----

/// L3: a liquidate rule that leaves the batch open cannot be bound (221), and
/// a batch off the pinned shape is refused by the predicate.
#[test]
fn l3_an_open_rule_does_not_bind_and_an_off_shape_batch_is_refused() {
    let w = World::new();
    let open = and(alloc::vec![fn_is("execute"), eq(arg(2), u(0))]);
    let rule = w.add_rule(&w.adapter, Vec::new(&w.env), &open);
    assert_eq!(w.bind(&rule, &w.adapter), Some(221));

    let rules = w.rules();
    let l = w.liquidator.clone();
    // A sixth call appended: the shape says five.
    let mut calls = w.batch(&l, R, Y);
    calls.push_back(w.call(
        &w.xlm,
        "transfer",
        (w.account.clone(), l.clone(), Y).into_val(&w.env),
    ));
    let mut inner = w.inner_ctxs(&l, R, Y).to_vec();
    inner.push(w.ctx(
        &w.xlm,
        "transfer",
        (w.account.clone(), l.clone(), Y).into_val(&w.env),
    ));
    let words = w.words(&inner);
    let mut ids = w.ids(&rules).to_vec();
    ids.push(rules.xlm);
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner), &ids, &[]);
    assert_eq!(
        w.run(
            &w.adapter,
            &calls,
            &words,
            0,
            &[entry, w.payer_entry(&l, R)]
        ),
        Flow::Refused
    );
    // The basket out to someone other than the payer.
    let other = Address::generate(&w.env);
    let mut calls = w.batch(&l, R, Y);
    calls.set(
        1,
        w.call(
            &w.xlm,
            "transfer",
            (w.account.clone(), other.clone(), Y).into_val(&w.env),
        ),
    );
    let mut inner = w.inner_ctxs(&l, R, Y);
    inner[0] = w.ctx(
        &w.xlm,
        "transfer",
        (w.account.clone(), other, Y).into_val(&w.env),
    );
    let words = w.words(&inner);
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner), &w.ids(&rules), &[]);
    assert_eq!(
        w.run(
            &w.adapter,
            &calls,
            &words,
            0,
            &[entry, w.payer_entry(&l, R)]
        ),
        Flow::Refused
    );
    assert_eq!(w.balance(&w.xlm, &l), 0);
}

// ---- the word: exact, this account only, this call only ----

/// L4: the adapter refuses, before the account is asked (error 3), any grant
/// that is not its word for its own account: one naming another account, one
/// for another function, one with an invocation nested under it, and a word
/// handed to a callee.
#[test]
fn l4_the_adapter_hands_out_nothing_but_its_word_for_its_own_account() {
    let w = World::new();
    let rules = w.rules();
    let l = w.liquidator.clone();
    let calls = w.batch(&l, R, Y);
    let inner = w.inner_ctxs(&l, R, Y);
    let good = w.words(&inner);
    let stranger = w.env.register(
        OZ08_WASM,
        (
            soroban_sdk::vec![&w.env, Signer::Delegated(w.admin.clone())],
            Map::<Address, Val>::new(&w.env),
        ),
    );
    let transfer = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: w.xlm.clone(),
            fn_name: Symbol::new(&w.env, "transfer"),
            args: (w.adapter.clone(), l.clone(), Y).into_val(&w.env),
        },
        sub_invocations: Vec::new(&w.env),
    });
    let nested = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: w.interpreter.clone(),
            fn_name: Symbol::new(&w.env, "enforce"),
            args: (w.account.clone(), inner[0].clone()).into_val(&w.env),
        },
        sub_invocations: soroban_sdk::vec![&w.env, transfer.clone()],
    });
    let bad = [
        w.word(&w.interpreter, &stranger, &inner[0]),
        transfer,
        nested,
    ];
    for (k, g) in bad.iter().enumerate() {
        let mut words = good.clone();
        words.push_back(g.clone());
        let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner), &w.ids(&rules), &[]);
        assert_eq!(
            w.run(
                &w.adapter,
                &calls,
                &words,
                0,
                &[entry, w.payer_entry(&l, R)]
            ),
            Flow::Code(3),
            "case {k}"
        );
    }
    // A word handed to a callee.
    let mut calls2 = calls.clone();
    let mut first = calls2.get(0).unwrap();
    first.executor_authorizations = soroban_sdk::vec![&w.env, good.get(0).unwrap()];
    calls2.set(0, first);
    let (entry, _) = w.account_entry(w.tree(&calls2, &good, 0, &inner), &w.ids(&rules), &[]);
    assert_eq!(
        w.run(
            &w.adapter,
            &calls2,
            &good,
            0,
            &[entry, w.payer_entry(&l, R)]
        ),
        Flow::Code(3)
    );
    assert_eq!(w.balance(&w.xlm, &l), 0);
}

/// L5: a word covers only the contexts it names. Leave out the word for the
/// nested pull, and the account refuses inside the same batch.
#[test]
fn l5_a_context_without_its_word_is_refused() {
    let w = World::new();
    let rules = w.rules();
    let l = w.liquidator.clone();
    let calls = w.batch(&l, R, Y);
    let inner = w.inner_ctxs(&l, R, Y);
    let mut short = inner.to_vec();
    short.remove(2);
    let words = w.words(&short);
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner), &w.ids(&rules), &[]);
    assert_eq!(
        w.run(
            &w.adapter,
            &calls,
            &words,
            0,
            &[entry, w.payer_entry(&l, R)]
        ),
        Flow::Refused
    );
    // A word for the right context of another account's rule does not help.
    let mut words = w.words(&short);
    words.push_back(w.word(&w.interpreter, &w.liquidator, &inner[2]));
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner), &w.ids(&rules), &[]);
    assert_eq!(
        w.run(
            &w.adapter,
            &calls,
            &words,
            0,
            &[entry, w.payer_entry(&l, R)]
        ),
        Flow::Code(3)
    );
    assert_eq!(w.balance(&w.xlm, &l), 0);
}

/// L6: the words live only for the account's approval of the batch they
/// came with. (a) After a liquidation, the inner rule asked directly - the
/// basket out to L, with the same context the word named - is refused. (b)
/// Inside a batch, a context approved by a second entry of the account rather
/// than under the execute node is asked for after that approval, when the
/// words are gone, and is refused although the batch carries its word.
#[test]
fn l6_a_word_does_not_outlive_its_call() {
    let w = World::new();
    let rules = w.rules();
    let l = w.liquidator.clone();
    assert_eq!(w.liquidate_with(&l, R, Y, &w.ids(&rules), &[]), Flow::Ran);
    let before = w.balance(&w.xlm, &l);

    // (a) The same transfer, asked directly, cites the keyless xlm rule.
    let args: Vec<Val> = (w.account.clone(), l.clone(), Y).into_val(&w.env);
    let (entry, _) = w.account_entry(w.node(&w.xlm, "transfer", args.clone()), &[rules.xlm], &[]);
    w.env.set_auths(&[entry]);
    let direct = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.xlm,
        &Symbol::new(&w.env, "transfer"),
        args,
    );
    assert_eq!(flow(direct), Flow::Refused);

    // (b) Inside the batch, every request of the account must match the one
    // tree under `execute`, whose single approval is where the words are used:
    // the host refuses a second, disjoint entry of the account while that tree
    // is active. The basket's transfer approved by its own entry is refused,
    // under the keyless rule and under a rule an agent signs alike.
    MarketClient::new(&w.env, &w.market).set(&w.account, &DEBT, &COVER, &PRICE);
    let calls = w.batch(&l, R, Y);
    let inner = w.inner_ctxs(&l, R, Y);
    let words = w.words(&inner);
    let rest = [
        rules.liquidate,
        rules.market,
        rules.tusd,
        rules.market,
        rules.pot,
    ];
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner[1..]), &rest, &[]);
    let (side, _) = w.account_entry(w.ctx_node(&inner[0]), &[rules.xlm], &[]);
    let pay = w.payer_entry(&l, R);
    assert_eq!(
        w.run(&w.adapter, &calls, &words, 0, &[entry, side, pay]),
        Flow::Refused
    );
    let agent = w.env.register(Approving, ());
    let key = Signer::Delegated(agent.clone());
    let keyed = w.add_rule(
        &w.xlm,
        soroban_sdk::vec![&w.env, key.clone()],
        &fn_is("transfer"),
    );
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner[1..]), &rest, &[]);
    let (side, digest) = w.account_entry(
        w.ctx_node(&inner[0]),
        &[keyed.id],
        core::slice::from_ref(&key),
    );
    let signed = w.agent_entry(&agent, keyed.id, digest);
    let pay = w.payer_entry(&l, R);
    assert_eq!(
        w.run(&w.adapter, &calls, &words, 0, &[entry, side, signed, pay]),
        Flow::Refused
    );
    assert_eq!(w.balance(&w.xlm, &l), before);

    // (b2) The words do not outlive that approval into the batch's calls: a
    // call that asks the adapter for a word it handed out, one contract down
    // (so the adapter is not its direct caller), is refused. The batch runs
    // under an agent's rule; the word names the asking contract.
    let asker = w.env.register(policy_interpreter_oz08::Asker, ());
    let relay = w.env.register(policy_interpreter_oz08::Relay, ());
    let probe = w.ctx(
        &w.xlm,
        "transfer",
        (w.account.clone(), l.clone(), 1i128).into_val(&w.env),
    );
    let go: Vec<Val> = (
        asker.clone(),
        w.adapter.clone(),
        w.account.clone(),
        probe.clone(),
    )
        .into_val(&w.env);
    let calls = soroban_sdk::vec![&w.env, w.call(&relay, "go", go)];
    let words = soroban_sdk::vec![&w.env, w.word(&asker, &w.account, &probe)];
    let execute = w.add_rule(
        &w.adapter,
        soroban_sdk::vec![&w.env, key.clone()],
        &fn_is("execute"),
    );
    let (entry, digest) = w.account_entry(
        w.tree(&calls, &words, 0, &[]),
        &[execute.id],
        core::slice::from_ref(&key),
    );
    let signed = w.agent_entry(&agent, execute.id, digest);
    assert_eq!(
        w.run(&w.adapter, &calls, &words, 0, &[entry, signed]),
        Flow::Refused
    );
    // Controls: the same entries with an empty batch run, so the probe is
    // what refused; and a contract that hands out the same word just before
    // calling the relay passes the probe, so the probe sees a live word.
    let empty: Vec<policy_interpreter_oz08::Call> = Vec::new(&w.env);
    let (entry, digest) = w.account_entry(
        w.tree(&empty, &words, 0, &[]),
        &[execute.id],
        core::slice::from_ref(&key),
    );
    let signed = w.agent_entry(&agent, execute.id, digest);
    assert_eq!(
        w.run(&w.adapter, &empty, &words, 0, &[entry, signed]),
        Flow::Ran
    );
    let granter = w.env.register(policy_interpreter_oz08::Granter, ());
    let live = soroban_sdk::vec![&w.env, w.word(&asker, &w.account, &probe)];
    w.env.set_auths(&[]);
    policy_interpreter_oz08::GranterClient::new(&w.env, &granter)
        .go(&live, &relay, &asker, &w.account, &probe);

    // (c) The whole entry of a run that went through, replayed.
    let calls = w.batch(&l, R, Y);
    let inner = w.inner_ctxs(&l, R, Y);
    let words = w.words(&inner);
    let (entry, _) = w.account_entry(w.tree(&calls, &words, 0, &inner), &w.ids(&rules), &[]);
    let payer = w.payer_entry(&l, R);
    let pair = [entry, payer];
    assert_eq!(w.run(&w.adapter, &calls, &words, 0, &pair), Flow::Ran);
    assert_eq!(w.run(&w.adapter, &calls, &words, 0, &pair), Flow::Refused);
    assert_eq!(w.balance(&w.xlm, &l), before + Y);
}

// ---- nothing waits, nothing is stored ----

/// L7: with words, a wait above 0 is still refused before anything is asked
/// (`NoWait`, 10), nothing is stored, and `run` finds nothing
/// (`NotScheduled`, 5).
#[test]
fn l7_a_wait_is_still_refused_and_run_finds_nothing() {
    let w = World::new();
    let rules = w.rules();
    let l = w.liquidator.clone();
    let calls = w.batch(&l, R, Y);
    let inner = w.inner_ctxs(&l, R, Y);
    let words = w.words(&inner);
    for wait in [1u32, 17_280] {
        let (entry, _) = w.account_entry(w.tree(&calls, &words, wait, &inner), &w.ids(&rules), &[]);
        assert_eq!(
            w.run(
                &w.adapter,
                &calls,
                &words,
                wait,
                &[entry, w.payer_entry(&l, R)]
            ),
            Flow::Code(10)
        );
    }
    w.env.ledger().with_mut(|li| li.sequence_number += 20_000);
    w.env.set_auths(&[]);
    let r = w.env.try_invoke_contract::<(), soroban_sdk::Error>(
        &w.adapter,
        &Symbol::new(&w.env, "run"),
        soroban_sdk::vec![&w.env, 1u32.into_val(&w.env)],
    );
    assert_eq!(flow(r), Flow::Code(5));
    assert_eq!(w.balance(&w.xlm, &l), 0);
}

// ---- a gated adapter is unaffected ----

/// L8: the same liquidate rule bound to a GATED adapter whose gate lists
/// every address of the batch. A gated adapter never vouches for its own
/// `execute`, so the rule binds but the account refuses at the binding.
#[test]
fn l8_a_gated_adapter_never_vouches_for_its_own_execute() {
    let w = World::new();
    let l = w.liquidator.clone();
    let custody = Address::generate(&w.env);
    let allowed = soroban_sdk::vec![
        &w.env,
        w.tusd.clone(),
        w.xlm.clone(),
        w.market.clone(),
        w.pot.clone(),
        w.account.clone(),
        w.interpreter.clone(),
        l.clone(),
    ];
    let gate = w.env.register(Gate, (allowed, custody));
    let gated_at = derived(&w.env, &w.account, Some(gate.clone()), 100);
    w.env.mock_all_auths();
    let gated = w.env.register_at(
        &gated_at,
        adapter_wasm().as_slice(),
        (w.account.clone(), Some(gate), 0u32, 100u32),
    );
    // The liquidate predicate names `N` as a line address; scoped to the gated
    // adapter, it is the same shape.
    let rule = w.add_rule(&gated, Vec::new(&w.env), &w.liquidate());
    assert_eq!(w.bind(&rule, &gated), None);
    let inner_ids: alloc::vec::Vec<u32> = w
        .inner()
        .map(|(scope, pred)| {
            let r = w.add_rule(&scope, Vec::new(&w.env), &pred);
            assert_eq!(w.bind(&r, &gated), None);
            r.id
        })
        .to_vec();
    let calls = w.batch(&l, R, Y);
    let inner = w.inner_ctxs(&l, R, Y);
    let words = w.words(&inner);
    let ids = [
        rule.id,
        inner_ids[0],
        inner_ids[1],
        inner_ids[2],
        inner_ids[1],
        inner_ids[3],
    ];
    let args: Vec<Val> = (calls.clone(), words.clone(), 0u32).into_val(&w.env);
    let mut root = w.node(&gated, "execute", args);
    root.sub_invocations = w.tree(&calls, &words, 0, &inner).sub_invocations;
    let (entry, _) = w.account_entry(root, &ids, &[]);
    assert_eq!(
        w.run(&gated, &calls, &words, 0, &[entry, w.payer_entry(&l, R)]),
        Flow::Refused
    );
    assert_eq!(w.balance(&w.xlm, &l), 0);
}

// ---- keyed rules through N are unchanged ----

/// L9: an agent's keyed rules through `N`, with no words, run exactly as
/// before: the agent signs the 0.8.0 preimage, and nothing is handed out.
#[test]
fn l9_a_keyed_batch_through_the_adapter_runs_as_before() {
    let w = World::new();
    let agent = w.env.register(Approving, ());
    let key = Signer::Delegated(agent.clone());
    let keys = soroban_sdk::vec![&w.env, key.clone()];
    let execute = w.add_rule(&w.adapter, keys.clone(), &fn_is("execute"));
    let xlm = w.add_rule(&w.xlm, keys, &fn_is("transfer"));
    let to = Address::generate(&w.env);
    let calls = soroban_sdk::vec![
        &w.env,
        w.call(
            &w.xlm,
            "transfer",
            (w.account.clone(), to.clone(), 5i128).into_val(&w.env)
        ),
    ];
    let none: Vec<InvokerContractAuthEntry> = Vec::new(&w.env);
    let inner = [w.ctx(
        &w.xlm,
        "transfer",
        (w.account.clone(), to.clone(), 5i128).into_val(&w.env),
    )];
    let (entry, digest) = w.account_entry(
        w.tree(&calls, &none, 0, &inner),
        &[execute.id, xlm.id],
        core::slice::from_ref(&key),
    );
    let preimage = policy_interpreter_oz08::AuthDigestPreimage {
        account: w.account.clone(),
        signature_payload: digest,
        context_rule_ids: soroban_sdk::vec![&w.env, execute.id, xlm.id],
    };
    let agent_root = invocation(
        &w.account,
        "__check_auth",
        alloc::vec![scval(&w.env, preimage)],
        alloc::vec![],
    );
    let agent_entry = w.approving_entry(&agent, agent_root);
    assert_eq!(
        w.run(&w.adapter, &calls, &none, 0, &[entry, agent_entry]),
        Flow::Ran
    );
    assert_eq!(w.balance(&w.xlm, &to), 5);
}

// ---- another account's rule bound to our adapter ----

/// L10: a stranger account binds its own keyless rule to our adapter. The
/// adapter asks only its own account and vouches only for it: a word naming
/// the stranger is refused (3), and without one the stranger's rule, asked
/// for a call inside our batch, is refused at its binding.
#[test]
fn l10_a_strangers_rule_bound_to_our_adapter_gets_nothing() {
    let w = World::new();
    let stranger = w.env.register(
        OZ08_WASM,
        (
            soroban_sdk::vec![&w.env, Signer::Delegated(w.admin.clone())],
            Map::<Address, Val>::new(&w.env),
        ),
    );
    StellarAssetClient::new(&w.env, &w.xlm).mint(&stranger, &Y);
    // The stranger's keyless rule on the XLM token, bound to OUR adapter.
    w.env.mock_all_auths();
    let mut map: Map<Address, Val> = Map::new(&w.env);
    map.set(
        w.interpreter.clone(),
        w.params(&fn_is("transfer")).into_val(&w.env),
    );
    let args: Vec<Val> = (
        ContextRuleType::CallContract(w.xlm.clone()),
        soroban_sdk::String::from_str(&w.env, "s"),
        Option::<u32>::None,
        Vec::<Signer>::new(&w.env),
        map,
    )
        .into_val(&w.env);
    let s_rule: ContextRule =
        w.env
            .invoke_contract(&stranger, &Symbol::new(&w.env, "add_context_rule"), args);
    let bind: Vec<Val> = ((stranger.clone(), s_rule.id), w.adapter.clone()).into_val(&w.env);
    let _: () = w
        .env
        .invoke_contract(&w.interpreter, &Symbol::new(&w.env, "bind_executor"), bind);

    // Our account's agent runs a batch moving the STRANGER's XLM.
    let agent = w.env.register(Approving, ());
    let key = Signer::Delegated(agent.clone());
    let execute = w.add_rule(
        &w.adapter,
        soroban_sdk::vec![&w.env, key.clone()],
        &fn_is("execute"),
    );
    let to = Address::generate(&w.env);
    let move_args: Vec<Val> = (stranger.clone(), to.clone(), 5i128).into_val(&w.env);
    let calls = soroban_sdk::vec![&w.env, w.call(&w.xlm, "transfer", move_args.clone())];
    let s_ctx = w.ctx(&w.xlm, "transfer", move_args.clone());
    let run_with = |words: &Vec<InvokerContractAuthEntry>| {
        let (entry, digest) = w.account_entry(
            w.tree(&calls, words, 0, &[]),
            &[execute.id],
            core::slice::from_ref(&key),
        );
        let preimage = policy_interpreter_oz08::AuthDigestPreimage {
            account: w.account.clone(),
            signature_payload: digest,
            context_rule_ids: soroban_sdk::vec![&w.env, execute.id],
        };
        let agent_entry = w.approving_entry(
            &agent,
            invocation(
                &w.account,
                "__check_auth",
                alloc::vec![scval(&w.env, preimage)],
                alloc::vec![],
            ),
        );
        // The stranger's own entry, citing its keyless rule.
        let nonce = w.next_nonce();
        let payload = AuthPayload {
            signers: Map::new(&w.env),
            context_rule_ids: soroban_sdk::vec![&w.env, s_rule.id],
        };
        let s_entry = w.entry(&stranger, nonce, scval(&w.env, payload), w.ctx_node(&s_ctx));
        w.run(&w.adapter, &calls, words, 0, &[entry, agent_entry, s_entry])
    };
    let naming = soroban_sdk::vec![&w.env, w.word(&w.interpreter, &stranger, &s_ctx)];
    assert_eq!(run_with(&naming), Flow::Code(3));
    assert_eq!(run_with(&Vec::new(&w.env)), Flow::Refused);
    assert_eq!(w.balance(&w.xlm, &to), 0);
    assert_eq!(w.balance(&w.xlm, &stranger), Y);
}
