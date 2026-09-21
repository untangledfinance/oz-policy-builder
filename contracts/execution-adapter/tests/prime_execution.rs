//! Real OZ account authorization against the production stateless adapter and v5.
use execution_adapter::{
    execution_address, Call, ExecutionAdapter as Adapter, ExecutionAdapterClient,
};
use soroban_sdk::{
    auth::{Context, ContractContext, InvokerContractAuthEntry},
    contract, contracterror, contractimpl, contracttype, vec, Address, Bytes, BytesN, Env, IntoVal,
    Map, Symbol, Val, Vec,
};
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Err {
    Invalid = 1,
}
fn contexts(e: &Env, _calls: &Vec<Call>) -> Vec<ContractContext> {
    Vec::new(e)
}
// A permissive test signer models an agent who can sign any transaction.
// It does not replace Prime, the adapter, or the interpreter.
#[contract]
pub struct TestSigner;
#[contractimpl]
impl TestSigner {
    pub fn __check_auth(
        _e: Env,
        _payload: BytesN<32>,
        _signature: Val,
        _contexts: Vec<Context>,
    ) -> Result<(), Err> {
        Ok(())
    }
}
#[contract]
pub struct Venue;
#[contractimpl]
impl Venue {
    pub fn set(e: Env, prime: Address, value: i128) {
        prime.require_auth();
        e.storage()
            .instance()
            .set(&Symbol::new(&e, "value"), &value);
    }
    pub fn fail(_e: Env, prime: Address) {
        prime.require_auth();
        panic!("intentional failure");
    }
    pub fn get(e: Env) -> i128 {
        e.storage()
            .instance()
            .get(&Symbol::new(&e, "value"))
            .unwrap_or(0)
    }
}
#[contracttype]
#[derive(Clone)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}
#[contract]
pub struct Pool;
#[contractimpl]
impl Pool {
    pub fn submit(
        e: Env,
        prime: Address,
        spender: Address,
        recipient: Address,
        requests: Vec<Request>,
    ) {
        prime.require_auth();
        for r in requests {
            let t = soroban_sdk::token::Client::new(&e, &r.address);
            let pos: i128 = e.storage().instance().get(&prime).unwrap_or(0);
            if r.request_type == 0 {
                t.transfer(&spender, &e.current_contract_address(), &r.amount);
                e.storage().instance().set(&prime, &(pos + r.amount));
                if e.storage()
                    .instance()
                    .get(&Symbol::new(&e, "extra"))
                    .unwrap_or(false)
                {
                    t.transfer_from(&prime, &recipient, &spender, &r.amount);
                }
            } else if r.request_type == 1 {
                assert!(pos >= r.amount);
                t.transfer(&e.current_contract_address(), &recipient, &r.amount);
                e.storage().instance().set(&prime, &(pos - r.amount));
            } else {
                panic!("unknown request");
            }
            if let Some(other) = e
                .storage()
                .instance()
                .get::<Symbol, Address>(&Symbol::new(&e, "other"))
            {
                e.invoke_contract::<Val>(
                    &other,
                    &Symbol::new(&e, "set"),
                    vec![&e, prime.clone().into_val(&e), 7i128.into_val(&e)],
                );
            }
        }
    }
    pub fn set_other(e: Env, other: Address) {
        e.storage()
            .instance()
            .set(&Symbol::new(&e, "other"), &other);
    }
    pub fn set_extra(e: Env) {
        e.storage().instance().set(&Symbol::new(&e, "extra"), &true);
    }
    pub fn position(e: Env, prime: Address) -> i128 {
        e.storage().instance().get(&prime).unwrap_or(0)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use policy_interpreter::{PolicyInstallParams, PolicyInterpreter, Signer};
    use soroban_sdk::vec;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        xdr::{self, ToXdr, WriteXdr},
        String, TryFromVal,
    };
    const OZ: &[u8] =
        include_bytes!("../../policy-interpreter/tests/fixtures/multisig_account_example.wasm");
    fn sym(e: &Env, s: &str) -> Val {
        Symbol::new(e, s).into_val(e)
    }
    fn node(e: &Env, s: &str, a: Vec<Val>) -> Val {
        let mut v = vec![e, sym(e, s)];
        if s == "and" || s == "or" {
            v.push_back(a.into_val(e))
        } else {
            v.append(&a)
        };
        v.into_val(e)
    }
    fn selector(e: &Env, s: &str) -> Val {
        node(e, s, Vec::new(e))
    }
    fn eq(e: &Env, a: Val, b: Val) -> Val {
        node(e, "eq", vec![e, a, b])
    }
    fn delegated(e: &Env, a: &Address) -> Val {
        vec![e, sym(e, "Delegated"), a.into_val(e)].into_val(e)
    }
    fn add_rule(
        e: &Env,
        prime: &Address,
        scope: &Address,
        signer: &Address,
        interpreter: &Address,
        predicate: Val,
        owner: &Address,
        executor: &Address,
    ) {
        let bytes = predicate.to_xdr(e);
        let params = PolicyInstallParams {
            grammar_version: 6,
            install_nonce: 1,
            predicate_hash: e.crypto().sha256(&bytes).into(),
            predicate: bytes,
            policy_admins: vec![e, Signer::Delegated(owner.clone())],
        };
        let mut policies = Map::<Address, Val>::new(e);
        policies.set(interpreter.clone(), params.into_val(e));
        let rule = e.invoke_contract::<policy_interpreter::ContextRule>(
            prime,
            &Symbol::new(e, "add_context_rule"),
            vec![
                e,
                vec![e, sym(e, "CallContract"), scope.into_val(e)].into_val(e),
                String::from_str(e, "probe").into_val(e),
                Option::<u32>::None.into_val(e),
                vec![e, delegated(e, signer)].into_val(e),
                policies.into_val(e),
            ],
        );
        policy_interpreter::PolicyInterpreterClient::new(e, interpreter)
            .bind_executor(&(prime.clone(), rule.id), executor);
    }
    /// A `call_path` node from a list of steps.
    fn path(e: &Env, steps: &Vec<Val>) -> Val {
        node(e, "call_path", steps.clone())
    }
    fn step_idx(e: &Env, i: u32) -> Val {
        i.into_val(e)
    }
    fn step_len(e: &Env) -> Val {
        true.into_val(e)
    }
    /// Pin how many elements a nested vector has. Pinning each element is not
    /// enough on its own: an APPENDED element is simply unmentioned, and an
    /// extra executor authorization is exactly that.
    fn pin_len(e: &Env, checks: &mut Vec<Val>, base: &Vec<Val>, field: &str, n: u32) {
        let mut p = base.clone();
        p.push_back(sym(e, field));
        p.push_back(step_len(e));
        checks.push_back(eq(e, path(e, &p), n.into_val(e)));
    }
    /// True for the argument kinds the grammar has a literal for.
    fn is_scalar(e: &Env, v: &Val) -> bool {
        Address::try_from_val(e, v).is_ok()
            || i128::try_from_val(e, v).is_ok()
            || u32::try_from_val(e, v).is_ok()
            || Symbol::try_from_val(e, v).is_ok()
    }
    /// Walk one value to whatever depth it has, pinning every scalar it
    /// reaches. An amount of 7 is bounded instead and tied to the first one
    /// seen, which is the cross-call constraint: what was pulled is what was
    /// supplied.
    ///
    /// Grammar 5 could not do this. Its deepest selector stopped three levels
    /// in, so Blend's `args[3][0].amount` was out of reach from the root and
    /// the adapter had to flatten the whole request to expose it.
    fn walk(
        e: &Env,
        steps: Vec<Val>,
        v: Val,
        checks: &mut Vec<Val>,
        first: &mut Option<Val>,
        depth: u32,
    ) {
        if depth >= 6 {
            return;
        }
        if i128::try_from_val(e, &v).ok() == Some(7) {
            let a = path(e, &steps);
            checks.push_back(node(e, "gt", vec![e, a, 0i128.into_val(e)]));
            checks.push_back(node(e, "lt", vec![e, a, 10i128.into_val(e)]));
            if let Some(f) = *first {
                checks.push_back(eq(e, a, f));
            } else {
                *first = Some(a);
            }
            return;
        }
        if is_scalar(e, &v) {
            checks.push_back(eq(e, path(e, &steps), v));
            return;
        }
        if let Ok(items) = Vec::<Val>::try_from_val(e, &v) {
            for (i, item) in items.iter().enumerate() {
                let mut next = steps.clone();
                next.push_back(step_idx(e, i as u32));
                walk(e, next, item, checks, first, depth + 1);
            }
            return;
        }
        if let Ok(m) = Map::<Symbol, Val>::try_from_val(e, &v) {
            for (k, item) in m.iter() {
                let mut next = steps.clone();
                next.push_back(k.into_val(e));
                walk(e, next, item, checks, first, depth + 1);
            }
        }
    }
    fn root_predicate(s: &S, cs: &Vec<Call>) -> Val {
        root_predicate_full(s, cs, &Vec::new(&s.e))
    }
    /// Pins the batch's shape: how many calls, each call's target and
    /// function, every scalar argument at any depth, and the equality between
    /// the amount pulled and the amount spent.
    fn root_predicate_full(s: &S, cs: &Vec<Call>, pcs: &Vec<ContractContext>) -> Val {
        let e = &s.e;
        let mut checks = vec![e, eq(e, selector(e, "call_fn"), sym(e, "execute"))];
        checks.push_back(eq(
            e,
            node(e, "call_arg_len", vec![e, 0u32.into_val(e)]),
            cs.len().into_val(e),
        ));
        let mut first: Option<Val> = None;
        for (n, c) in cs.iter().enumerate() {
            let n = n as u32;
            let base = vec![e, step_idx(e, 0), step_idx(e, n)];
            let mut t = base.clone();
            t.push_back(sym(e, "target"));
            checks.push_back(eq(e, path(e, &t), c.target.into_val(e)));
            let mut f = base.clone();
            f.push_back(sym(e, "function_name"));
            checks.push_back(eq(e, path(e, &f), c.function_name.into_val(e)));
            pin_len(e, &mut checks, &base, "args", c.args.len());
            pin_len(
                e,
                &mut checks,
                &base,
                "executor_authorizations",
                c.executor_authorizations.len(),
            );
            for (i, v) in c.args.iter().enumerate() {
                let mut a = base.clone();
                a.push_back(sym(e, "args"));
                a.push_back(step_idx(e, i as u32));
                walk(e, a, v, &mut checks, &mut first, 0);
            }
        }
        checks.push_back(eq(
            e,
            node(e, "call_arg_len", vec![e, 1u32.into_val(e)]),
            pcs.len().into_val(e),
        ));
        for (n, c) in pcs.iter().enumerate() {
            let n = n as u32;
            let base = vec![e, step_idx(e, 1), step_idx(e, n)];
            let mut ct = base.clone();
            ct.push_back(sym(e, "contract"));
            checks.push_back(eq(e, path(e, &ct), c.contract.into_val(e)));
            let mut fnm = base.clone();
            fnm.push_back(sym(e, "fn_name"));
            checks.push_back(eq(e, path(e, &fnm), c.fn_name.into_val(e)));
        }
        node(e, "and", checks)
    }
    struct S {
        e: Env,
        prime: Address,
        agent: Address,
        adapter: Address,
        venue: Address,
        interpreter: Address,
        owner: Address,
    }
    /// What the adapter commits to: the request itself, not a flattening of it.
    fn project(s: &S, cs: &Vec<Call>) -> Vec<Val> {
        request_args(&s.e, cs, &contexts(&s.e, cs), &s.interpreter)
    }
    fn policy_fn(e: &Env) -> Symbol {
        Symbol::new(e, "enforce")
    }
    fn request_args(
        e: &Env,
        cs: &Vec<Call>,
        pcs: &Vec<ContractContext>,
        policy: &Address,
    ) -> Vec<Val> {
        vec![
            e,
            cs.into_val(e),
            pcs.into_val(e),
            policy.into_val(e),
            policy_fn(e).into_val(e),
        ]
    }
    struct AdapterClient<'a>(&'a S);
    impl<'a> AdapterClient<'a> {
        fn new(s: &'a S) -> Self {
            Self(s)
        }
        fn execute(&self, calls: &Vec<Call>) -> Vec<Val> {
            let s = self.0;
            if std::env::var_os("PRIME_DEFAULT_BUDGET").is_some() {
                s.e.cost_estimate().budget().reset_default();
            }
            let result = ExecutionAdapterClient::new(&s.e, &s.adapter).execute(
                &s.prime,
                &s.interpreter,
                &policy_fn(&s.e),
                calls,
                &contexts(&s.e, calls),
            );
            if std::env::var_os("PRIME_DEFAULT_BUDGET").is_some() {
                let estimate = s.e.cost_estimate();
                let budget = estimate.budget();
                std::eprintln!(
                    "execution budget: cpu={} memory={}",
                    budget.cpu_instruction_cost(),
                    budget.memory_bytes_cost()
                );
            }
            result
        }
        fn try_execute(&self, calls: &Vec<Call>) -> Result<(), ()> {
            let s = self.0;
            match ExecutionAdapterClient::new(&s.e, &s.adapter).try_execute(
                &s.prime,
                &s.interpreter,
                &policy_fn(&s.e),
                calls,
                &contexts(&s.e, calls),
            ) {
                Ok(Ok(_)) => Ok(()),
                _ => Err(()),
            }
        }
    }
    fn setup() -> S {
        let e = Env::default();
        e.cost_estimate().budget().reset_unlimited();
        e.ledger().with_mut(|li| {
            li.sequence_number = 10;
            li.network_id = [0; 32];
        });
        e.mock_all_auths();
        let owner = Address::generate(&e);
        let prime = e.register(
            OZ,
            (
                vec![&e, delegated(&e, &owner)],
                Map::<Address, Val>::new(&e),
            ),
        );
        let interpreter = if let Ok(path) = std::env::var("PRIME_INTERPRETER_WASM") {
            e.register(std::fs::read(path).unwrap().as_slice(), ())
        } else {
            e.register(PolicyInterpreter, ())
        };
        let agent = e.register(TestSigner, ());
        let adapter = if let Ok(path) = std::env::var("PRIME_ADAPTER_WASM") {
            e.register_at(
                &execution_address(&e, &prime),
                std::fs::read(path).unwrap().as_slice(),
                (),
            )
        } else {
            e.register_at(&execution_address(&e, &prime), Adapter, ())
        };
        let venue = e.register(Venue, ());
        let temp = S {
            e: e.clone(),
            prime: prime.clone(),
            agent: agent.clone(),
            adapter: adapter.clone(),
            venue: venue.clone(),
            interpreter: interpreter.clone(),
            owner: owner.clone(),
        };
        let root = node(
            &e,
            "or",
            vec![
                &e,
                root_predicate(&temp, &calls(&temp, 7, false)),
                root_predicate(&temp, &calls(&temp, 7, true)),
            ],
        );
        add_rule(
            &e,
            &prime,
            &adapter,
            &agent,
            &interpreter,
            root,
            &owner,
            &adapter,
        );
        let arg1 = node(&e, "call_arg", vec![&e, 1u32.into_val(&e)]);
        let child = node(
            &e,
            "or",
            vec![
                &e,
                node(
                    &e,
                    "and",
                    vec![
                        &e,
                        eq(&e, selector(&e, "call_fn"), sym(&e, "set")),
                        node(&e, "lt", vec![&e, arg1, 10i128.into_val(&e)]),
                    ],
                ),
                eq(&e, selector(&e, "call_fn"), sym(&e, "fail")),
            ],
        );
        add_rule(
            &e,
            &prime,
            &venue,
            &adapter,
            &interpreter,
            child,
            &owner,
            &adapter,
        );
        e.set_auths(&[]);
        S {
            e,
            prime,
            agent,
            adapter,
            venue,
            interpreter,
            owner,
        }
    }
    fn invoke(
        e: &Env,
        target: &Address,
        fun: &str,
        args: Vec<Val>,
        children: std::vec::Vec<xdr::SorobanAuthorizedInvocation>,
    ) -> xdr::SorobanAuthorizedInvocation {
        xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: target.into(),
                function_name: fun.try_into().unwrap(),
                args: args
                    .iter()
                    .map(|v| xdr::ScVal::try_from_val(e, &v).unwrap())
                    .collect::<std::vec::Vec<_>>()
                    .try_into()
                    .unwrap(),
            }),
            sub_invocations: children.try_into().unwrap(),
        }
    }
    fn entry(
        e: &Env,
        address: &Address,
        root: xdr::SorobanAuthorizedInvocation,
        signature: Val,
        nonce: i64,
    ) -> xdr::SorobanAuthorizationEntry {
        xdr::SorobanAuthorizationEntry {
            credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
                address: address.into(),
                nonce,
                signature_expiration_ledger: 100,
                signature: xdr::ScVal::try_from_val(e, &signature).unwrap(),
            }),
            root_invocation: root,
        }
    }
    fn auth(s: &S, root: xdr::SorobanAuthorizedInvocation, ids: &[u32], signers: &[Address]) {
        auth_nonce(s, root, ids, signers, 1)
    }
    fn auth_nonce(
        s: &S,
        root: xdr::SorobanAuthorizedInvocation,
        ids: &[u32],
        signers: &[Address],
        nonce: i64,
    ) {
        let e = &s.e;
        let rule_ids = Vec::<u32>::from_slice(e, ids);
        let pre =
            xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
                network_id: xdr::Hash([0; 32]),
                nonce,
                signature_expiration_ledger: 100,
                invocation: root.clone(),
            });
        let hash = e.crypto().sha256(&Bytes::from_slice(
            e,
            &pre.to_xdr(xdr::Limits::none()).unwrap(),
        ));
        let mut digest_input = hash.to_bytes().to_bytes();
        digest_input.append(&rule_ids.clone().to_xdr(e));
        let digest = e.crypto().sha256(&digest_input).to_bytes();
        let mut sm = Map::<Val, Bytes>::new(e);
        for signer in signers {
            sm.set(delegated(e, signer), Bytes::new(e));
        }
        let mut payload = Map::<Symbol, Val>::new(e);
        payload.set(Symbol::new(e, "signers"), sm.into_val(e));
        payload.set(Symbol::new(e, "context_rule_ids"), rule_ids.into_val(e));
        let mut entries = std::vec![entry(e, &s.prime, root, payload.into_val(e), nonce)];
        for (i, signer) in signers.iter().enumerate() {
            if *signer == s.adapter {
                continue;
            }
            entries.push(entry(
                e,
                signer,
                invoke(
                    e,
                    &s.prime,
                    "__check_auth",
                    vec![e, digest.clone().into_val(e)],
                    std::vec![],
                ),
                ().into_val(e),
                nonce + 1 + i as i64,
            ));
        }
        e.set_auths(&entries);
    }
    fn calls(s: &S, value: i128, fail: bool) -> Vec<Call> {
        let e = &s.e;
        let mut cs = vec![
            e,
            Call {
                target: s.venue.clone(),
                function_name: Symbol::new(e, "set"),
                args: vec![e, s.prime.into_val(e), value.into_val(e)],
                executor_authorizations: Vec::new(e),
            },
        ];
        if fail {
            cs.push_back(Call {
                target: s.venue.clone(),
                function_name: Symbol::new(e, "fail"),
                args: vec![e, s.prime.into_val(e)],
                executor_authorizations: Vec::new(e),
            });
        }
        cs
    }
    fn batch_auth(s: &S, cs: &Vec<Call>, signers: &[Address]) {
        let children = cs
            .iter()
            .map(|c| {
                invoke(
                    &s.e,
                    &c.target,
                    &c.function_name.to_string(),
                    c.args,
                    std::vec![],
                )
            })
            .collect::<std::vec::Vec<_>>();
        let mut ids = std::vec![1];
        ids.extend(std::iter::repeat_n(2, cs.len() as usize));
        auth(
            s,
            invoke(&s.e, &s.adapter, "execute", project(s, cs), children),
            &ids,
            signers,
        );
    }
    #[test]
    fn bound_adapter_delegation_real_oz_and_v5() {
        let s = setup();
        let cs = calls(&s, 7, false);
        batch_auth(&s, &cs, &[s.agent.clone(), s.adapter.clone()]);
        AdapterClient::new(&s).execute(&cs);
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 7);
    }
    #[test]
    fn direct_venue_with_adapter_signature_is_denied() {
        let s = setup();
        let args = vec![&s.e, s.prime.into_val(&s.e), 7i128.into_val(&s.e)];
        auth(
            &s,
            invoke(&s.e, &s.venue, "set", args, std::vec![]),
            &[2],
            &[s.adapter.clone()],
        );
        assert!(VenueClient::new(&s.e, &s.venue)
            .try_set(&s.prime, &7)
            .is_err());
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 0);
    }
    #[test]
    fn batch_without_agent_is_denied() {
        let s = setup();
        let cs = calls(&s, 7, false);
        batch_auth(&s, &cs, &[s.adapter.clone()]);
        assert!(AdapterClient::new(&s).try_execute(&cs).is_err());
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 0);
    }
    #[test]
    fn child_policy_still_caps_amount() {
        let s = setup();
        let cs = calls(&s, 11, false);
        s.e.mock_all_auths();
        // This root explicitly permits 11; only the unchanged child cap can reject it.
        add_rule(
            &s.e,
            &s.prime,
            &s.adapter,
            &s.agent,
            &s.interpreter,
            root_predicate(&s, &cs),
            &s.owner,
            &s.adapter,
        ); // id3
        s.e.set_auths(&[]);
        let c = cs.get(0).unwrap();
        auth(
            &s,
            invoke(
                &s.e,
                &s.adapter,
                "execute",
                project(&s, &cs),
                std::vec![invoke(&s.e, &c.target, "set", c.args, std::vec![])],
            ),
            &[3, 2],
            &[s.agent.clone(), s.adapter.clone()],
        );
        assert!(AdapterClient::new(&s).try_execute(&cs).is_err());
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 0);
    }
    #[test]
    fn late_failure_rolls_back() {
        let s = setup();
        let cs = calls(&s, 7, true);
        batch_auth(&s, &cs, &[s.agent.clone(), s.adapter.clone()]);
        assert!(AdapterClient::new(&s).try_execute(&cs).is_err());
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 0);
    }
    struct F {
        s: S,
        token: Address,
        pool: Address,
        custody: Address,
    }
    fn supply_calls(f: &F, pull: i128, supply: i128) -> Vec<Call> {
        use soroban_sdk::auth::{ContractContext, SubContractInvocation};
        let e = &f.s.e;
        let req = vec![
            e,
            Request {
                address: f.token.clone(),
                amount: supply,
                request_type: 0,
            },
        ];
        let transfer = InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: f.token.clone(),
                fn_name: Symbol::new(e, "transfer"),
                args: vec![
                    e,
                    f.s.adapter.into_val(e),
                    f.pool.into_val(e),
                    supply.into_val(e),
                ],
            },
            sub_invocations: Vec::new(e),
        });
        vec![
            e,
            Call {
                target: f.token.clone(),
                function_name: Symbol::new(e, "transfer_from"),
                args: vec![
                    e,
                    f.s.prime.into_val(e),
                    f.custody.into_val(e),
                    f.s.adapter.into_val(e),
                    pull.into_val(e),
                ],
                executor_authorizations: Vec::new(e),
            },
            Call {
                target: f.pool.clone(),
                function_name: Symbol::new(e, "submit"),
                args: vec![
                    e,
                    f.s.prime.into_val(e),
                    f.s.adapter.into_val(e),
                    f.custody.into_val(e),
                    req.into_val(e),
                ],
                executor_authorizations: vec![e, transfer],
            },
        ]
    }
    fn withdraw_calls(f: &F, amount: i128) -> Vec<Call> {
        let e = &f.s.e;
        vec![
            e,
            Call {
                target: f.pool.clone(),
                function_name: Symbol::new(e, "submit"),
                args: vec![
                    e,
                    f.s.prime.into_val(e),
                    f.s.adapter.into_val(e),
                    f.custody.into_val(e),
                    vec![
                        e,
                        Request {
                            address: f.token.clone(),
                            amount,
                            request_type: 1,
                        },
                    ]
                    .into_val(e),
                ],
                executor_authorizations: Vec::new(e),
            },
        ]
    }
    fn fund_setup() -> F {
        use soroban_sdk::token;
        let s = setup();
        let e = &s.e;
        e.mock_all_auths();
        let custody = Address::generate(e);
        let token = e
            .register_stellar_asset_contract_v2(s.owner.clone())
            .address();
        let pool = e.register(Pool, ());
        token::StellarAssetClient::new(e, &token).mint(&custody, &100);
        token::Client::new(e, &token).approve(&custody, &s.prime, &7, &100);
        let f = F {
            s,
            token,
            pool,
            custody,
        };
        let e = &f.s.e;
        let root = node(
            e,
            "or",
            vec![
                e,
                root_predicate(&f.s, &supply_calls(&f, 7, 7)),
                root_predicate(&f.s, &withdraw_calls(&f, 7)),
            ],
        );
        add_rule(
            e,
            &f.s.prime,
            &f.s.adapter,
            &f.s.agent,
            &f.s.interpreter,
            root,
            &f.s.owner,
            &f.s.adapter,
        ); // id3
        let token_rule = node(
            e,
            "and",
            vec![
                e,
                eq(e, selector(e, "call_fn"), sym(e, "transfer_from")),
                eq(
                    e,
                    node(e, "call_arg", vec![e, 0u32.into_val(e)]),
                    f.s.prime.into_val(e),
                ),
                eq(
                    e,
                    node(e, "call_arg", vec![e, 1u32.into_val(e)]),
                    f.custody.into_val(e),
                ),
                eq(
                    e,
                    node(e, "call_arg", vec![e, 2u32.into_val(e)]),
                    f.s.adapter.into_val(e),
                ),
                node(
                    e,
                    "lt",
                    vec![
                        e,
                        node(e, "call_arg", vec![e, 3u32.into_val(e)]),
                        10i128.into_val(e),
                    ],
                ),
            ],
        );
        add_rule(
            e,
            &f.s.prime,
            &f.token,
            &f.s.adapter,
            &f.s.interpreter,
            token_rule,
            &f.s.owner,
            &f.s.adapter,
        ); // id4
        let pool_rule = node(
            e,
            "and",
            vec![
                e,
                eq(e, selector(e, "call_fn"), sym(e, "submit")),
                eq(
                    e,
                    node(e, "call_arg", vec![e, 0u32.into_val(e)]),
                    f.s.prime.into_val(e),
                ),
                eq(
                    e,
                    node(e, "call_arg", vec![e, 1u32.into_val(e)]),
                    f.s.adapter.into_val(e),
                ),
                eq(
                    e,
                    node(e, "call_arg", vec![e, 2u32.into_val(e)]),
                    f.custody.into_val(e),
                ),
                node(
                    e,
                    "lt",
                    vec![
                        e,
                        node(
                            e,
                            "call_arg_field",
                            vec![e, 3u32.into_val(e), 0u32.into_val(e), sym(e, "amount")],
                        ),
                        10i128.into_val(e),
                    ],
                ),
            ],
        );
        add_rule(
            e,
            &f.s.prime,
            &f.pool,
            &f.s.adapter,
            &f.s.interpreter,
            pool_rule,
            &f.s.owner,
            &f.s.adapter,
        ); // id5
        e.set_auths(&[]);
        f
    }
    fn fund_auth(f: &F, cs: &Vec<Call>, nonce: i64) {
        let children = cs
            .iter()
            .map(|c| {
                invoke(
                    &f.s.e,
                    &c.target,
                    &c.function_name.to_string(),
                    c.args,
                    std::vec![],
                )
            })
            .collect::<std::vec::Vec<_>>();
        let mut ids = std::vec![3];
        for c in cs {
            ids.push(if c.target == f.token { 4 } else { 5 });
        }
        auth_nonce(
            &f.s,
            invoke(&f.s.e, &f.s.adapter, "execute", project(&f.s, cs), children),
            &ids,
            &[f.s.agent.clone(), f.s.adapter.clone()],
            nonce,
        );
    }
    #[test]
    fn prime_allowance_only_supply_and_withdraw_keep_prime_unfunded() {
        use soroban_sdk::token;
        let f = fund_setup();
        let e = &f.s.e;
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).allowance(&f.custody, &f.s.adapter),
            0
        );
        let supply = supply_calls(&f, 7, 7);
        fund_auth(&f, &supply, 10);
        AdapterClient::new(&f.s).execute(&supply);
        let t = token::Client::new(e, &f.token);
        assert_eq!(t.balance(&f.custody), 93);
        assert_eq!(t.balance(&f.s.prime), 0);
        assert_eq!(t.balance(&f.s.adapter), 0);
        assert_eq!(PoolClient::new(e, &f.pool).position(&f.s.prime), 7);
        let withdraw = withdraw_calls(&f, 7);
        fund_auth(&f, &withdraw, 20);
        AdapterClient::new(&f.s).execute(&withdraw);
        assert_eq!(t.balance(&f.custody), 100);
        assert_eq!(t.balance(&f.s.prime), 0);
        assert_eq!(t.balance(&f.s.adapter), 0);
        assert_eq!(t.allowance(&f.custody, &f.s.prime), 0);
        assert_eq!(PoolClient::new(e, &f.pool).position(&f.s.prime), 0);
    }
    #[test]
    fn unequal_funding_and_supply_denied_by_unchanged_v5() {
        let f = fund_setup();
        let cs = supply_calls(&f, 7, 6);
        fund_auth(&f, &cs, 10);
        assert!(AdapterClient::new(&f.s).try_execute(&cs).is_err());
        assert_eq!(
            soroban_sdk::token::Client::new(&f.s.e, &f.token).balance(&f.custody),
            100
        );
    }
    #[test]
    fn standalone_custody_pull_denied_even_with_adapter_signer_claim() {
        let f = fund_setup();
        let e = &f.s.e;
        let c = supply_calls(&f, 7, 7).get(0).unwrap();
        auth(
            &f.s,
            invoke(e, &f.token, "transfer_from", c.args, std::vec![]),
            &[4],
            &[f.s.adapter.clone()],
        );
        assert!(soroban_sdk::token::Client::new(e, &f.token)
            .try_transfer_from(&f.s.prime, &f.custody, &f.s.adapter, &7)
            .is_err());
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).balance(&f.custody),
            100
        );
    }
    #[test]
    fn extra_executor_authorization_changes_authenticated_shape_and_is_denied() {
        use soroban_sdk::auth::{ContractContext, SubContractInvocation};
        let f = fund_setup();
        let e = &f.s.e;
        let mut cs = supply_calls(&f, 7, 7);
        let mut c = cs.get(1).unwrap();
        c.executor_authorizations
            .push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: f.token.clone(),
                    fn_name: Symbol::new(e, "transfer"),
                    args: vec![
                        e,
                        f.s.adapter.into_val(e),
                        f.s.agent.into_val(e),
                        7i128.into_val(e),
                    ],
                },
                sub_invocations: Vec::new(e),
            }));
        cs.set(1, c);
        fund_auth(&f, &cs, 10);
        assert!(AdapterClient::new(&f.s).try_execute(&cs).is_err());
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).balance(&f.custody),
            100
        );
    }

    #[test]
    fn duplicate_prime_auth_exceeds_available_context_grants() {
        let f = fund_setup();
        let e = &f.s.e;
        e.mock_all_auths();
        soroban_sdk::token::Client::new(e, &f.token).approve(&f.custody, &f.s.prime, &14, &100);
        PoolClient::new(e, &f.pool).set_extra();
        e.set_auths(&[]);
        let cs = supply_calls(&f, 7, 7);
        let pull = cs.get(0).unwrap();
        let pool = cs.get(1).unwrap();
        let extra = invoke(e, &f.token, "transfer_from", pull.args.clone(), std::vec![]);
        let children = std::vec![
            invoke(e, &pull.target, "transfer_from", pull.args, std::vec![]),
            invoke(e, &pool.target, "submit", pool.args, std::vec![extra])
        ];
        auth_nonce(
            &f.s,
            invoke(e, &f.s.adapter, "execute", project(&f.s, &cs), children),
            &[3, 4, 5, 4],
            &[f.s.agent.clone(), f.s.adapter.clone()],
            30,
        );
        assert!(AdapterClient::new(&f.s).try_execute(&cs).is_err());
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).balance(&f.custody),
            100
        );
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).balance(&f.s.adapter),
            0
        );
        assert_eq!(PoolClient::new(e, &f.pool).position(&f.s.prime), 0);
    }
    #[test]
    fn claimed_agent_without_auth_entry_is_denied() {
        let s = setup();
        let cs = calls(&s, 7, false);
        let children = cs
            .iter()
            .map(|c| {
                invoke(
                    &s.e,
                    &c.target,
                    &c.function_name.to_string(),
                    c.args,
                    std::vec![],
                )
            })
            .collect::<std::vec::Vec<_>>();
        let root = invoke(&s.e, &s.adapter, "execute", project(&s, &cs), children);
        let mut sm = Map::<Val, Bytes>::new(&s.e);
        sm.set(delegated(&s.e, &s.agent), Bytes::new(&s.e));
        sm.set(delegated(&s.e, &s.adapter), Bytes::new(&s.e));
        let mut p = Map::<Symbol, Val>::new(&s.e);
        p.set(Symbol::new(&s.e, "signers"), sm.into_val(&s.e));
        p.set(
            Symbol::new(&s.e, "context_rule_ids"),
            vec![&s.e, 1u32, 2u32].into_val(&s.e),
        );
        s.e.set_auths(&[entry(&s.e, &s.prime, root, p.into_val(&s.e), 1)]);
        assert!(AdapterClient::new(&s).try_execute(&cs).is_err());
    }

    #[test]
    fn adapter_spender_needs_no_prime_token_rule_and_blocks_hidden_prime_pull() {
        use soroban_sdk::token;
        let s = setup();
        let e = &s.e;
        e.mock_all_auths();
        let custody = Address::generate(e);
        let token = e
            .register_stellar_asset_contract_v2(s.owner.clone())
            .address();
        let pool = e.register(Pool, ());
        token::StellarAssetClient::new(e, &token).mint(&custody, &100);
        token::Client::new(e, &token).approve(&custody, &s.adapter, &7, &100);
        let f = F {
            s,
            token,
            pool,
            custody,
        };
        let e = &f.s.e;
        let mut cs = supply_calls(&f, 7, 7);
        let mut pull = cs.get(0).unwrap();
        pull.args.set(0, f.s.adapter.into_val(e));
        cs.set(0, pull);
        let root = root_predicate(&f.s, &cs);
        add_rule(
            e,
            &f.s.prime,
            &f.s.adapter,
            &f.s.agent,
            &f.s.interpreter,
            root,
            &f.s.owner,
            &f.s.adapter,
        ); // id3
        let child = eq(e, selector(e, "call_fn"), sym(e, "submit"));
        add_rule(
            e,
            &f.s.prime,
            &f.pool,
            &f.s.adapter,
            &f.s.interpreter,
            child,
            &f.s.owner,
            &f.s.adapter,
        ); // id4; NO token rule
        e.set_auths(&[]);
        let c = cs.get(1).unwrap();
        let children = std::vec![invoke(e, &c.target, "submit", c.args, std::vec![])];
        auth_nonce(
            &f.s,
            invoke(e, &f.s.adapter, "execute", project(&f.s, &cs), children),
            &[3, 4],
            &[f.s.agent.clone(), f.s.adapter.clone()],
            40,
        );
        AdapterClient::new(&f.s).execute(&cs);
        assert_eq!(token::Client::new(e, &f.token).balance(&f.custody), 93);
        assert_eq!(token::Client::new(e, &f.token).balance(&f.s.prime), 0);
        assert_eq!(token::Client::new(e, &f.token).balance(&f.s.adapter), 0);
        // Same approved batch, venue now attempts an additional Prime-authorized pull.
        e.mock_all_auths();
        token::Client::new(e, &f.token).approve(&f.custody, &f.s.adapter, &7, &100);
        token::Client::new(e, &f.token).approve(&f.custody, &f.s.prime, &7, &100);
        PoolClient::new(e, &f.pool).set_extra();
        e.set_auths(&[]);
        let c = cs.get(1).unwrap();
        let extra = invoke(
            e,
            &f.token,
            "transfer_from",
            vec![
                e,
                f.s.prime.into_val(e),
                f.custody.into_val(e),
                f.s.adapter.into_val(e),
                7i128.into_val(e),
            ],
            std::vec![],
        );
        let children = std::vec![invoke(e, &c.target, "submit", c.args, std::vec![extra])];
        // Trying the pool-scoped rule for the unexpected token context must fail.
        auth_nonce(
            &f.s,
            invoke(e, &f.s.adapter, "execute", project(&f.s, &cs), children),
            &[3, 4, 4],
            &[f.s.agent.clone(), f.s.adapter.clone()],
            50,
        );
        assert!(AdapterClient::new(&f.s).try_execute(&cs).is_err());
        assert_eq!(token::Client::new(e, &f.token).balance(&f.custody), 93);
    }

    #[test]
    fn rejects_extra_prime_context_absent_from_approved_batch() {
        use soroban_sdk::token;
        let s = setup();
        let e = &s.e;
        e.mock_all_auths();
        let custody = Address::generate(e);
        let token = e
            .register_stellar_asset_contract_v2(s.owner.clone())
            .address();
        let pool = e.register(Pool, ());
        let other = e.register(Venue, ());
        token::StellarAssetClient::new(e, &token).mint(&custody, &100);
        token::Client::new(e, &token).approve(&custody, &s.adapter, &7, &100);
        let f = F {
            s,
            token,
            pool,
            custody,
        };
        let e = &f.s.e;
        let mut cs = supply_calls(&f, 7, 7);
        let mut pull = cs.get(0).unwrap();
        pull.args.set(0, f.s.adapter.into_val(e));
        cs.set(0, pull);
        add_rule(
            e,
            &f.s.prime,
            &f.s.adapter,
            &f.s.agent,
            &f.s.interpreter,
            root_predicate(&f.s, &cs),
            &f.s.owner,
            &f.s.adapter,
        ); //3 approved supply
        add_rule(
            e,
            &f.s.prime,
            &f.pool,
            &f.s.adapter,
            &f.s.interpreter,
            eq(e, selector(e, "call_fn"), sym(e, "submit")),
            &f.s.owner,
            &f.s.adapter,
        ); //4
        add_rule(
            e,
            &f.s.prime,
            &other,
            &f.s.adapter,
            &f.s.interpreter,
            eq(e, selector(e, "call_fn"), sym(e, "set")),
            &f.s.owner,
            &f.s.adapter,
        ); //5 extra venue child permission
        let mandatory_other_batch = vec![
            e,
            Call {
                target: other.clone(),
                function_name: Symbol::new(e, "set"),
                args: vec![e, f.s.prime.into_val(e), 7i128.into_val(e)],
                executor_authorizations: Vec::new(e),
            },
            Call {
                target: other.clone(),
                function_name: Symbol::new(e, "get"),
                args: Vec::new(e),
                executor_authorizations: Vec::new(e),
            },
        ];
        add_rule(
            e,
            &f.s.prime,
            &f.s.adapter,
            &f.s.agent,
            &f.s.interpreter,
            root_predicate(&f.s, &mandatory_other_batch),
            &f.s.owner,
            &f.s.adapter,
        ); //6 separate batch rule; NOT selected
        PoolClient::new(e, &f.pool).set_other(&other);
        e.set_auths(&[]);
        let c = cs.get(1).unwrap();
        let extra = invoke(
            e,
            &other,
            "set",
            vec![e, f.s.prime.into_val(e), 7i128.into_val(e)],
            std::vec![],
        );
        let children = std::vec![invoke(e, &c.target, "submit", c.args, std::vec![extra])];
        auth_nonce(
            &f.s,
            invoke(e, &f.s.adapter, "execute", project(&f.s, &cs), children),
            &[3, 4, 5],
            &[f.s.agent.clone(), f.s.adapter.clone()],
            60,
        );
        assert!(AdapterClient::new(&f.s).try_execute(&cs).is_err());
        assert_eq!(VenueClient::new(e, &other).get(), 0); // Extra action is blocked; its separate batch rule was never approved.
        assert_eq!(token::Client::new(e, &f.token).balance(&f.s.prime), 0);
        assert_eq!(token::Client::new(e, &f.token).balance(&f.s.adapter), 0);
    }

    #[test]
    fn bounded_amount_can_change_without_changing_request_shape() {
        let s = setup();
        let cs = calls(&s, 8, false);
        batch_auth(&s, &cs, &[s.agent.clone(), s.adapter.clone()]);
        AdapterClient::new(&s).execute(&cs);
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 8);
    }

    #[test]
    fn caller_cannot_substitute_interpreter() {
        let s = setup();
        let cs = calls(&s, 7, false);
        batch_auth(&s, &cs, &[s.agent.clone(), s.adapter.clone()]);
        let other = s.e.register(PolicyInterpreter, ());
        assert!(ExecutionAdapterClient::new(&s.e, &s.adapter)
            .try_execute(&s.prime, &other, &policy_fn(&s.e), &cs, &Vec::new(&s.e))
            .is_err());
        assert_eq!(VenueClient::new(&s.e, &s.venue).get(), 0);
    }

    #[test]
    fn nested_prime_context_requires_explicit_root_policy_approval() {
        let f = fund_setup();
        let e = &f.s.e;
        e.mock_all_auths();
        let other = e.register(Venue, ());
        PoolClient::new(e, &f.pool).set_other(&other);
        add_rule(
            e,
            &f.s.prime,
            &other,
            &f.s.adapter,
            &f.s.interpreter,
            eq(e, selector(e, "call_fn"), sym(e, "set")),
            &f.s.owner,
            &f.s.adapter,
        ); // id6
        let cs = supply_calls(&f, 7, 7);
        let extra = ContractContext {
            contract: other.clone(),
            fn_name: Symbol::new(e, "set"),
            args: vec![e, f.s.prime.into_val(e), 7i128.into_val(e)],
        };
        let nested = vec![e, extra.clone()];
        let projected = request_args(e, &cs, &nested, &f.s.interpreter);
        add_rule(
            e,
            &f.s.prime,
            &f.s.adapter,
            &f.s.agent,
            &f.s.interpreter,
            root_predicate_full(&f.s, &cs, &nested),
            &f.s.owner,
            &f.s.adapter,
        ); // id7 explicit nested batch
        e.set_auths(&[]);
        let pull = cs.get(0).unwrap();
        let pool = cs.get(1).unwrap();
        let tree = invoke(
            e,
            &f.s.adapter,
            "execute",
            projected,
            std::vec![
                invoke(e, &pull.target, "transfer_from", pull.args, std::vec![]),
                invoke(
                    e,
                    &pool.target,
                    "submit",
                    pool.args,
                    std::vec![invoke(e, &other, "set", extra.args, std::vec![])]
                )
            ],
        );
        // Merely appending a grant does not widen the previously installed batch rule.
        auth_nonce(
            &f.s,
            tree.clone(),
            &[3, 4, 5, 6],
            &[f.s.agent.clone(), f.s.adapter.clone()],
            80,
        );
        assert!(ExecutionAdapterClient::new(e, &f.s.adapter)
            .try_execute(&f.s.prime, &f.s.interpreter, &policy_fn(e), &cs, &nested)
            .is_err());
        assert_eq!(VenueClient::new(e, &other).get(), 0);
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).balance(&f.custody),
            100
        );
        // With an explicitly installed root policy the identical nested action is allowed.
        auth_nonce(
            &f.s,
            tree,
            &[7, 4, 5, 6],
            &[f.s.agent.clone(), f.s.adapter.clone()],
            90,
        );
        ExecutionAdapterClient::new(e, &f.s.adapter).execute(
            &f.s.prime,
            &f.s.interpreter,
            &policy_fn(e),
            &cs,
            &nested,
        );
        assert_eq!(VenueClient::new(e, &other).get(), 7);
        assert_eq!(
            soroban_sdk::token::Client::new(e, &f.token).balance(&f.custody),
            93
        );
    }
}
