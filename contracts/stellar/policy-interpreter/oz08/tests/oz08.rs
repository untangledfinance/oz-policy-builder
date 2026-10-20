//! Keyless executor rules on OpenZeppelin's smart account 0.8.0.
//!
//! `keyless.rs` drives the interpreter directly. Here the account is OZ's own
//! code, the `multisig-account-example` built from OZ `main` at `8e25220` with
//! `stellar contract build` (sha256 `8286422f…`, pinned below), committed as a
//! blob like the 0.7 fixture. OZ has not tagged 0.8.0, so this is a prototype
//! pin for testing.
//!
//! The account is built against soroban-sdk 28, which the interpreter crate's
//! soroban-sdk 27 test host cannot load, so this suite is a crate of its own
//! with a protocol-28 host.
//!
//! What is real and what is modelled:
//!
//! - **Real:** the account's code, its context rules and `__check_auth`
//!   (rule selection, the signer filter, #3016, #3017, `NoSignersAndPolicies`),
//!   the `AuthDigestPreimage { account, signature_payload, context_rule_ids }`
//!   a delegated signer authorises, the host's auth machinery (every
//!   authorisation below is a `SorobanAuthorizationEntry` given to
//!   `set_auths`, so the host builds the contexts from the entry's tree and
//!   runs the account's `__check_auth` on them), and the interpreter.
//!   The interpreter runs as the wasm `build-wasm.sh` writes
//!   (`../target/wasm32v1-none/release/policy_interpreter.wasm`, or `G7_WASM`),
//!   the bytes CI pins in `contracts/build-hashes.json`. Build it first.
//! - **Modelled** (`src/lib.rs`): the execution adapter and the venue.
//!   `Executor` makes the same authorisation calls as adapter v5
//!   (`4985cd12`): `run(id)` hands out the stored grants with
//!   `authorize_as_current_contract`, then asks the Prime with
//!   `require_auth_for_args((id,))`, then calls the venue; `execute(wait)` does
//!   the same for the agent's immediate call, with its arguments cut to the
//!   wait. `Venue::submit(from, spender, amount)` asks `from` like Blend's
//!   pool. The agent is a contract account that approves whatever reaches it,
//!   so a delegated signer needs no key and the host still checks the preimage
//!   it is asked to authorise.
//!
//! Rows follow the testnet probes (`P1`, `X1`, `X6`, `n3`, `X9`).

extern crate alloc;
extern crate std;

use policy_interpreter_oz08::{
    Approving, AuthDigestPreimage, AuthPayload, ContextRule, ContextRuleType, Executor,
    ExecutorClient, PolicyInstallParams, Signer, Venue, VenueClient, DEFAULT, MOVE,
};
use soroban_sdk::auth::{
    Context, ContractContext, InvokerContractAuthEntry, SubContractInvocation,
};
use soroban_sdk::testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke};
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

/// OZ `multisig-account-example` at `8e25220` (0.8.0, unreleased), committed
/// beside the 0.7 fixture.
const OZ08_WASM: &[u8] =
    include_bytes!("../../tests/fixtures/oz_0_8_0_multisig_account_example.wasm");
const OZ08_SHA256: &str = "8286422f205951f37f4249401b403471fc432340dde6925432d31bb8a90cce27";

const EXPIRES_IN: u32 = 100;

/// The interpreter wasm: `G7_WASM`, else the `build-wasm.sh` output.
fn interpreter_wasm() -> std::vec::Vec<u8> {
    let path = std::env::var("G7_WASM").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32v1-none/release/policy_interpreter.wasm"
        )
        .into()
    });
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!("no interpreter wasm at {path} ({e}): run ../build-wasm.sh or set G7_WASM")
    })
}

/// A test host that writes no snapshot: each would embed both wasms.
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

fn xdr_bytes(env: &Env, v: &ScVal) -> Bytes {
    let val: Val = v.into_val(env);
    val.to_xdr(env)
}

fn fn_is(name: &str) -> ScVal {
    node(
        "eq",
        alloc::vec![scvec(alloc::vec![sym("call_fn")]), sym(name)],
    )
}

// ---- the world ----

/// How a call through the host's auth machinery ended. A refusal inside the
/// account's `__check_auth` reaches the caller as `Error(Auth, ...)` whatever
/// raised it, so `World::verdict` names the reason.
#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Ran,
    Refused,
}

/// The account's own `__check_auth` verdict on a set of contexts.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Permit,
    /// A contract error: the interpreter's (2xx, 100) or the account's (30xx).
    Code(u32),
    /// The host refused an authorisation with no contract error. The only one
    /// not mocked in `verdict` is the executor's grant: the binding.
    Unauthorised,
}

struct World {
    env: Env,
    account: Address,
    interpreter: Address,
    executor: Address,
    venue: Address,
    token: Address,
    agent: Address,
    admin: Address,
    nonce: core::cell::Cell<i64>,
}

impl World {
    fn new() -> Self {
        let env = env();
        env.ledger().with_mut(|l| l.sequence_number = 1_000);
        let interpreter = env.register(interpreter_wasm().as_slice(), (DEFAULT,));
        let admin = Address::generate(&env);
        let account = env.register(
            OZ08_WASM,
            (
                soroban_sdk::vec![&env, Signer::Delegated(admin.clone())],
                Map::<Address, Val>::new(&env),
            ),
        );
        let venue = env.register(Venue, ());
        let executor = env.register(Executor, (account.clone(), venue.clone()));
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let agent = env.register(Approving, ());
        World {
            env,
            account,
            interpreter,
            executor,
            venue,
            token,
            agent,
            admin,
            nonce: core::cell::Cell::new(0),
        }
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

    /// `add_context_rule` on the account, as its owners do: the account
    /// installs each policy with the rule it builds.
    fn add_rule(
        &self,
        scope: &Address,
        signers: Vec<Signer>,
        policies: &[(&Address, &ScVal)],
    ) -> ContextRule {
        self.env.mock_all_auths();
        let mut map: Map<Address, Val> = Map::new(&self.env);
        for (policy, predicate) in policies {
            map.set(
                (*policy).clone(),
                self.params(predicate).into_val(&self.env),
            );
        }
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

    fn bind(&self, interpreter: &Address, rule: &ContextRule) -> Option<u32> {
        self.env.mock_all_auths();
        let args: Vec<Val> =
            ((self.account.clone(), rule.id), self.executor.clone()).into_val(&self.env);
        match self.env.try_invoke_contract::<(), soroban_sdk::Error>(
            interpreter,
            &Symbol::new(&self.env, "bind_executor"),
            args,
        ) {
            Ok(_) => None,
            Err(Ok(e)) => Some(e.get_code()),
            Err(Err(e)) => panic!("bind trapped: {e:?}"),
        }
    }

    /// An administration call on the account (`remove_policy`, ...): the
    /// owners' authorisation is mocked, the account's own checks are not.
    fn admin_call(&self, f: &str, args: Vec<Val>) -> Option<u32> {
        self.env.mock_all_auths();
        match self.env.try_invoke_contract::<(), soroban_sdk::Error>(
            &self.account,
            &Symbol::new(&self.env, f),
            args,
        ) {
            Ok(_) => None,
            Err(Ok(e)) => Some(e.get_code()),
            Err(Err(e)) => panic!("{f} trapped: {e:?}"),
        }
    }

    // ---- contexts and grants ----

    fn ctx(&self, contract: &Address, f: &str, args: Vec<Val>) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, f),
            args,
        })
    }

    fn run_args(&self, id: u32) -> Vec<Val> {
        soroban_sdk::vec![&self.env, id.into_val(&self.env)]
    }

    fn submit_args(&self) -> Vec<Val> {
        (self.account.clone(), self.executor.clone(), MOVE).into_val(&self.env)
    }

    fn submit_ctx(&self) -> Context {
        self.ctx(&self.venue, "submit", self.submit_args())
    }

    /// The executor's grant of `enforce(account, context)`: what adapter v5
    /// hands out for a venue call in a batch.
    fn grant(&self, ctx: &Context) -> InvokerContractAuthEntry {
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: self.interpreter.clone(),
                fn_name: Symbol::new(&self.env, "enforce"),
                args: (self.account.clone(), ctx.clone()).into_val(&self.env),
            },
            sub_invocations: Vec::new(&self.env),
        })
    }

    fn arm(&self, ctxs: &[Context]) {
        let mut grants = Vec::new(&self.env);
        for c in ctxs {
            grants.push_back(self.grant(c));
        }
        self.env.mock_all_auths();
        ExecutorClient::new(&self.env, &self.executor).arm(&grants);
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

    /// The Prime's entry for `root`, citing `rule_ids` (one per node, in tree
    /// order) with `signers` in the payload, and the preimage those signers
    /// commit to under 0.8.0.
    fn prime_entry(
        &self,
        root: SorobanAuthorizedInvocation,
        rule_ids: &[u32],
        signers: &[Signer],
    ) -> (SorobanAuthorizationEntry, AuthDigestPreimage) {
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
            context_rule_ids: ids.clone(),
        };
        let preimage = AuthDigestPreimage {
            account: self.account.clone(),
            signature_payload: self.signature_payload(nonce, &root),
            context_rule_ids: ids,
        };
        (
            self.entry(&self.account, nonce, scval(&self.env, payload), root),
            preimage,
        )
    }

    /// The agent's nested entry: it authorises the account's `__check_auth`
    /// with `arg` as the single argument (0.8.0: the preimage).
    fn agent_entry(&self, arg: ScVal) -> SorobanAuthorizationEntry {
        let root = invocation(
            &self.account,
            "__check_auth",
            alloc::vec![arg],
            alloc::vec![],
        );
        self.entry(&self.agent, self.next_nonce(), ScVal::Void, root)
    }

    fn node(&self, contract: &Address, f: &str, args: Vec<Val>) -> SorobanAuthorizedInvocation {
        let args = args.iter().map(|v| scval(&self.env, v)).collect();
        invocation(contract, f, args, alloc::vec![])
    }

    fn run_tree(
        &self,
        id: u32,
        extra: &[SorobanAuthorizedInvocation],
    ) -> SorobanAuthorizedInvocation {
        let mut root = self.node(&self.executor, "run", self.run_args(id));
        let mut subs = alloc::vec![self.node(&self.venue, "submit", self.submit_args())];
        subs.extend(extra.iter().cloned());
        root.sub_invocations = subs.try_into().unwrap();
        root
    }

    // ---- calls ----

    /// A keeper's keyless `run(id)`: the Prime's entry carries no signer.
    fn run(&self, id: u32, extra: &[SorobanAuthorizedInvocation], rule_ids: &[u32]) -> Flow {
        self.run_signed(id, extra, rule_ids, &[])
    }

    fn run_signed(
        &self,
        id: u32,
        extra: &[SorobanAuthorizedInvocation],
        rule_ids: &[u32],
        signers: &[Signer],
    ) -> Flow {
        let (entry, _) = self.prime_entry(self.run_tree(id, extra), rule_ids, signers);
        self.env.set_auths(&[entry]);
        flow(ExecutorClient::new(&self.env, &self.executor).try_run(&id))
    }

    /// The agent's `execute(0)` with its key: the agent rule for the executor
    /// context, `venue_rule` for the venue's.
    fn execute(
        &self,
        agent_rule: u32,
        venue_rule: u32,
        agent_arg: impl Fn(&AuthDigestPreimage) -> ScVal,
    ) -> Flow {
        let mut root = self.node(
            &self.executor,
            "execute",
            soroban_sdk::vec![&self.env, 0u32.into_val(&self.env)],
        );
        root.sub_invocations = alloc::vec![self.node(&self.venue, "submit", self.submit_args())]
            .try_into()
            .unwrap();
        let agent = Signer::Delegated(self.agent.clone());
        let (entry, preimage) = self.prime_entry(root, &[agent_rule, venue_rule], &[agent]);
        self.env
            .set_auths(&[entry, self.agent_entry(agent_arg(&preimage))]);
        flow(ExecutorClient::new(&self.env, &self.executor).try_execute(&0u32))
    }

    /// The account's `__check_auth` on `ctxs`, run by the host as it runs it
    /// for a call (`try_invoke_contract_check_auth`), so a refusal keeps its
    /// code. The executor's grants of `granted` are mocked; nothing else is.
    /// Call it after a test's flows: in the soroban-sdk 28 test host, a native
    /// contract invoked after `try_invoke_contract_check_auth` reports
    /// "calling unknown contract function".
    fn verdict(
        &self,
        ctxs: &[Context],
        rule_ids: &[u32],
        signers: &[Signer],
        granted: &[Context],
    ) -> Outcome {
        let args: alloc::vec::Vec<Vec<Val>> = granted
            .iter()
            .map(|c| (self.account.clone(), c.clone()).into_val(&self.env))
            .collect();
        let invokes: alloc::vec::Vec<MockAuthInvoke> = args
            .iter()
            .map(|a| MockAuthInvoke {
                contract: &self.interpreter,
                fn_name: "enforce",
                args: a.clone(),
                sub_invokes: &[],
            })
            .collect();
        let mocks: alloc::vec::Vec<MockAuth> = invokes
            .iter()
            .map(|invoke| MockAuth {
                address: &self.executor,
                invoke,
            })
            .collect();
        self.env.mock_auths(&mocks);
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
        let mut contexts = Vec::new(&self.env);
        for c in ctxs {
            contexts.push_back(c.clone());
        }
        let r = self
            .env
            .try_invoke_contract_check_auth::<soroban_sdk::Error>(
                &self.account,
                &BytesN::from_array(&self.env, &[7u8; 32]),
                payload.into_val(&self.env),
                &contexts,
            );
        match r {
            Ok(()) => Outcome::Permit,
            Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Outcome::Code(e.get_code()),
            Err(Ok(e)) if e.is_type(ScErrorType::Auth) || e.is_type(ScErrorType::Context) => {
                Outcome::Unauthorised
            }
            other => panic!("unexpected verdict {other:?}"),
        }
    }

    fn run_ctx(&self, id: u32) -> Context {
        self.ctx(&self.executor, "run", self.run_args(id))
    }

    fn supplied(&self) -> i128 {
        VenueClient::new(&self.env, &self.venue).total()
    }

    // ---- the Option A rules ----

    /// Rule `venue`: no signer, `submit` on the venue, bound to the executor.
    fn venue_rule(&self) -> ContextRule {
        let rule = self.add_rule(
            &self.venue,
            Vec::new(&self.env),
            &[(&self.interpreter, &fn_is("submit"))],
        );
        assert_eq!(self.bind(&self.interpreter, &rule), None);
        rule
    }

    /// Rule `run`: no signer, scoped to the executor, pinned to `run`, bound.
    fn run_rule(&self) -> ContextRule {
        let rule = self.add_rule(
            &self.executor,
            Vec::new(&self.env),
            &[(&self.interpreter, &fn_is("run"))],
        );
        assert_eq!(self.bind(&self.interpreter, &rule), None);
        rule
    }
}

fn scval<T: IntoVal<Env, Val>>(env: &Env, v: T) -> ScVal {
    ScVal::try_from_val(env, &v.into_val(env)).unwrap()
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
        other => panic!("unexpected result {other:?}"),
    }
}

// ---- the fixture ----

#[test]
fn the_fixture_is_the_pinned_0_8_0_build() {
    let env = env();
    let got = env.crypto().sha256(&Bytes::from_slice(&env, OZ08_WASM));
    let hex: alloc::string::String = got
        .to_array()
        .iter()
        .map(|b| alloc::format!("{b:02x}"))
        .collect();
    assert_eq!(hex, OZ08_SHA256);
}

/// The preimage mirror encodes as the account's own type: `auth_digest` is the
/// account's sha256 of it.
#[test]
fn the_preimage_mirror_matches_the_accounts_digest() {
    let w = World::new();
    let preimage = AuthDigestPreimage {
        account: w.account.clone(),
        signature_payload: BytesN::from_array(&w.env, &[7u8; 32]),
        context_rule_ids: soroban_sdk::vec![&w.env, 2u32, 1u32],
    };
    let ours: BytesN<32> = w
        .env
        .crypto()
        .sha256(&preimage.clone().to_xdr(&w.env))
        .into();
    let theirs: BytesN<32> = w.env.invoke_contract(
        &w.account,
        &Symbol::new(&w.env, "auth_digest"),
        soroban_sdk::vec![&w.env, preimage.into_val(&w.env)],
    );
    assert_eq!(ours, theirs);
}

// ---- P1: the keyless run ----

/// P1: a keeper with no key runs a batch. The Prime's entry carries an empty
/// signer map; the run rule answers the executor's `run`, the venue rule the
/// pool's `submit` through the executor's grant.
#[test]
fn p1_a_keyless_run_supplies_the_venue() {
    let w = World::new();
    let venue = w.venue_rule();
    let run = w.run_rule();
    w.arm(&[w.submit_ctx()]);
    assert_eq!(w.run(1, &[], &[run.id, venue.id]), Flow::Ran);
    assert_eq!(w.supplied(), MOVE);
    // The verdict agrees: the run needs no grant, the pool's context does.
    let ctxs = [w.run_ctx(1), w.submit_ctx()];
    let ids = [run.id, venue.id];
    assert_eq!(
        w.verdict(&ctxs, &ids, &[], &[w.submit_ctx()]),
        Outcome::Permit
    );
}

/// P1's control: the same run without the executor's grant for the pool's
/// context is refused at the binding.
#[test]
fn p1_without_the_grant_the_venue_context_is_refused() {
    let w = World::new();
    let venue = w.venue_rule();
    let run = w.run_rule();
    let ids = [run.id, venue.id];
    assert_eq!(w.run(1, &[], &ids), Flow::Refused);
    assert_eq!(w.supplied(), 0);
    let ctxs = [w.run_ctx(1), w.submit_ctx()];
    assert_eq!(w.verdict(&ctxs, &ids, &[], &[]), Outcome::Unauthorised);
}

/// P3: the agent's own `execute`, signed through the 0.8.0 preimage, with the
/// venue rule keyless through the binding. A nested entry for the old digest
/// argument (the raw payload) does not authorise the agent.
#[test]
fn p3_the_agents_execute_signs_the_0_8_0_preimage() {
    let w = World::new();
    let venue = w.venue_rule();
    let agent = Signer::Delegated(w.agent.clone());
    let rule = w.add_rule(
        &w.executor,
        soroban_sdk::vec![&w.env, agent],
        &[(&w.interpreter, &fn_is("execute"))],
    );
    w.arm(&[w.submit_ctx()]);
    let env = &w.env;
    let raw = w.execute(rule.id, venue.id, |p| {
        scval(env, p.signature_payload.clone())
    });
    assert_eq!(raw, Flow::Refused);
    let ok = w.execute(rule.id, venue.id, |p| scval(env, p.clone()));
    assert_eq!(ok, Flow::Ran);
    assert_eq!(w.supplied(), MOVE);
}

// ---- X1: an extra node in the Prime's tree ----

/// X1: `token.transfer(prime, keeper, 1)` added to the run's tree, cited
/// under a keyless rule for the token bound to the executor. The run and pool
/// contexts pass; the transfer needs the executor's grant, which the batch
/// does not carry. With the grant the same tree runs, so the binding is the
/// refusal.
#[test]
fn x1_an_extra_transfer_node_is_refused_at_the_binding() {
    let w = World::new();
    let venue = w.venue_rule();
    let run = w.run_rule();
    let token_rule = w.add_rule(
        &w.token,
        Vec::new(&w.env),
        &[(&w.interpreter, &fn_is("transfer"))],
    );
    assert_eq!(w.bind(&w.interpreter, &token_rule), None);
    let keeper = Address::generate(&w.env);
    let args: Vec<Val> = (w.account.clone(), keeper, 1i128).into_val(&w.env);
    let transfer = w.node(&w.token, "transfer", args.clone());
    let transfer_ctx = w.ctx(&w.token, "transfer", args);
    let ids = [run.id, venue.id, token_rule.id];

    // Through the host: refused without the grant, run with it.
    w.arm(&[w.submit_ctx()]);
    assert_eq!(
        w.run(1, core::slice::from_ref(&transfer), &ids),
        Flow::Refused
    );
    assert_eq!(w.supplied(), 0);
    w.arm(&[w.submit_ctx(), transfer_ctx.clone()]);
    assert_eq!(w.run(1, &[transfer], &ids), Flow::Ran);
    assert_eq!(w.supplied(), MOVE);

    // The account's verdict on the same contexts: the binding is the refusal.
    let ctxs = [w.run_ctx(1), w.submit_ctx(), transfer_ctx.clone()];
    let only_submit = [w.submit_ctx()];
    assert_eq!(
        w.verdict(&ctxs, &ids, &[], &only_submit),
        Outcome::Unauthorised
    );
    let both = [w.submit_ctx(), transfer_ctx];
    assert_eq!(w.verdict(&ctxs, &ids, &[], &both), Outcome::Permit);
}

/// X2: an extra `execute` or `cancel` node on the executor, cited under the
/// run rule. Only the executor's own `run` is exempt; these need its grant,
/// and with the grant the predicate refuses them (100).
#[test]
fn x2_an_extra_execute_or_cancel_node_is_refused_at_the_binding() {
    let w = World::new();
    let venue = w.venue_rule();
    let run = w.run_rule();
    let execute: Vec<Val> = soroban_sdk::vec![&w.env, 0u32.into_val(&w.env)];
    let cancel: Vec<Val> = (2u32, w.account.clone()).into_val(&w.env);
    let ids = [run.id, venue.id, run.id];
    let extras = [("execute", execute), ("cancel", cancel)];
    // Through the host: refused with the grant or without it.
    for (f, args) in extras.iter() {
        let extra = w.node(&w.executor, f, args.clone());
        w.arm(&[w.submit_ctx()]);
        assert_eq!(
            w.run(1, core::slice::from_ref(&extra), &ids),
            Flow::Refused,
            "{f}"
        );
        w.arm(&[w.submit_ctx(), w.ctx(&w.executor, f, args.clone())]);
        assert_eq!(w.run(1, &[extra], &ids), Flow::Refused, "{f}");
    }
    assert_eq!(w.supplied(), 0);
    // The account's verdict: the binding without the grant, the predicate
    // (100) with it.
    for (f, args) in extras {
        let extra_ctx = w.ctx(&w.executor, f, args);
        let ctxs = [w.run_ctx(1), w.submit_ctx(), extra_ctx.clone()];
        let only_submit = [w.submit_ctx()];
        assert_eq!(
            w.verdict(&ctxs, &ids, &[], &only_submit),
            Outcome::Unauthorised,
            "{f}"
        );
        let both = [w.submit_ctx(), extra_ctx];
        assert_eq!(
            w.verdict(&ctxs, &ids, &[], &both),
            Outcome::Code(100),
            "{f}"
        );
    }
}

// ---- X6: the keyless gate on the real rule ----

/// X5: a keyless run rule with two policies (two interpreter instances, each
/// bound) is refused 210.
#[test]
fn x6_a_keyless_rule_with_two_policies_is_refused_210() {
    let w = World::new();
    let venue = w.venue_rule();
    let second = w.env.register(interpreter_wasm().as_slice(), (DEFAULT,));
    let run = w.add_rule(
        &w.executor,
        Vec::new(&w.env),
        &[(&w.interpreter, &fn_is("run")), (&second, &fn_is("run"))],
    );
    assert_eq!(run.policies.len(), 2);
    assert_eq!(w.bind(&w.interpreter, &run), None);
    assert_eq!(w.bind(&second, &run), None);
    w.arm(&[w.submit_ctx()]);
    let ids = [run.id, venue.id];
    assert_eq!(w.run(1, &[], &ids), Flow::Refused);
    let ctxs = [w.run_ctx(1), w.submit_ctx()];
    assert_eq!(
        w.verdict(&ctxs, &ids, &[], &[w.submit_ctx()]),
        Outcome::Code(210)
    );
}

/// X14: a keyless run rule never bound is refused 210.
#[test]
fn x6_an_unbound_keyless_rule_is_refused_210() {
    let w = World::new();
    let venue = w.venue_rule();
    let run = w.add_rule(
        &w.executor,
        Vec::new(&w.env),
        &[(&w.interpreter, &fn_is("run"))],
    );
    w.arm(&[w.submit_ctx()]);
    let ids = [run.id, venue.id];
    assert_eq!(w.run(1, &[], &ids), Flow::Refused);
    let ctxs = [w.run_ctx(1), w.submit_ctx()];
    assert_eq!(
        w.verdict(&ctxs, &ids, &[], &[w.submit_ctx()]),
        Outcome::Code(210)
    );
}

/// X6a and X6b: the old run rule shape, `Delegated(executor)` with the run
/// predicate, bound. With the executor in the payload, 0.8.0 refuses it as a
/// context contract (3017, OZ's #3017 fix); left out, the interpreter refuses
/// a rule that lists a signer nobody authenticated (210).
#[test]
fn x6_the_executor_signed_run_rule_is_3017_or_210() {
    let w = World::new();
    let venue = w.venue_rule();
    let executor = Signer::Delegated(w.executor.clone());
    let run = w.add_rule(
        &w.executor,
        soroban_sdk::vec![&w.env, executor.clone()],
        &[(&w.interpreter, &fn_is("run"))],
    );
    assert_eq!(w.bind(&w.interpreter, &run), None);
    w.arm(&[w.submit_ctx()]);
    let ids = [run.id, venue.id];
    assert_eq!(
        w.run_signed(1, &[], &ids, core::slice::from_ref(&executor)),
        Flow::Refused
    );
    assert_eq!(w.run(1, &[], &ids), Flow::Refused);
    assert_eq!(w.supplied(), 0);
    let ctxs = [w.run_ctx(1), w.submit_ctx()];
    let granted = [w.submit_ctx()];
    assert_eq!(
        w.verdict(&ctxs, &ids, &[executor], &granted),
        Outcome::Code(3017)
    );
    assert_eq!(w.verdict(&ctxs, &ids, &[], &granted), Outcome::Code(210));
}

// ---- n3: the keyless rule keeps its policy ----

/// n3: `remove_policy` on the keyless run rule would leave a rule with no
/// signer and no policy, which 0.8.0 refuses (3004). A keyed rule may drop its
/// last policy, so the refusal is the empty signer set's.
#[test]
fn n3_remove_policy_on_a_keyless_rule_is_no_signers_and_policies() {
    let w = World::new();
    let run = w.run_rule();
    let args: Vec<Val> = (run.id, run.policy_ids.get(0).unwrap()).into_val(&w.env);
    assert_eq!(w.admin_call("remove_policy", args), Some(3004));

    let agent = Signer::Delegated(w.agent.clone());
    let keyed = w.add_rule(
        &w.executor,
        soroban_sdk::vec![&w.env, agent],
        &[(&w.interpreter, &fn_is("execute"))],
    );
    let args: Vec<Val> = (keyed.id, keyed.policy_ids.get(0).unwrap()).into_val(&w.env);
    assert_eq!(w.admin_call("remove_policy", args), None);
}

// ---- X9: a keyed bound rule stripped of its signer ----

/// X9 and X9b: `remove_signer` turns a keyed bound venue rule into one with no
/// signer and one policy, which passes the keyless gate. The stored signer
/// hash still names the agent, so with the executor's grant the interpreter
/// refuses 204; without it, the binding refuses first.
#[test]
fn x9_a_keyed_rule_stripped_of_its_signer_is_204() {
    let w = World::new();
    let run = w.run_rule();
    let agent = Signer::Delegated(w.agent.clone());
    let venue = w.add_rule(
        &w.venue,
        soroban_sdk::vec![&w.env, agent],
        &[(&w.interpreter, &fn_is("submit"))],
    );
    assert_eq!(w.bind(&w.interpreter, &venue), None);
    let args: Vec<Val> = (venue.id, venue.signer_ids.get(0).unwrap()).into_val(&w.env);
    assert_eq!(w.admin_call("remove_signer", args), None);

    let ids = [run.id, venue.id];
    w.arm(&[w.submit_ctx()]);
    assert_eq!(w.run(1, &[], &ids), Flow::Refused);
    assert_eq!(w.supplied(), 0);
    let ctxs = [w.run_ctx(1), w.submit_ctx()];
    assert_eq!(
        w.verdict(&ctxs, &ids, &[], &[w.submit_ctx()]),
        Outcome::Code(204)
    );
    assert_eq!(w.verdict(&ctxs, &ids, &[], &[]), Outcome::Unauthorised);
}
