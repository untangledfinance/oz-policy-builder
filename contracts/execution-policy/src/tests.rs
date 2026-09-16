extern crate std;
use super::*;
use soroban_sdk::{
    auth::{Context, ContractContext, SubContractInvocation},
    testutils::Address as _,
    vec, IntoVal,
};
fn predicate(e: &Env, target: &Address, name: &str) -> Bytes {
    let left: Val = vec![e, Symbol::new(e, "call_contract")].into_val(e);
    let right: Val = vec![e, Symbol::new(e, "call_fn")].into_val(e);
    let c: Val = vec![
        e,
        Symbol::new(e, "eq").into_val(e),
        left,
        target.into_val(e),
    ]
    .into_val(e);
    let f: Val = vec![
        e,
        Symbol::new(e, "eq").into_val(e),
        right,
        Symbol::new(e, name).into_val(e),
    ]
    .into_val(e);
    let root: Vec<Val> = vec![
        e,
        Symbol::new(e, "and").into_val(e),
        vec![e, c, f].into_val(e),
    ];
    root.to_xdr(e)
}
fn setup(e: &Env) -> (Address, Call, Config) {
    let p = Address::generate(e);
    let target = Address::generate(e);
    let token = Address::generate(e);
    let c = Call {
        target: target.clone(),
        function_name: Symbol::new(e, "claim"),
        args: Vec::new(e),
        executor_authorizations: Vec::new(e),
    };
    let cfg = Config {
        executor: Address::generate(e),
        call_predicate: predicate(e, &target, "claim"),
        auth_predicate: predicate(e, &token, "transfer"),
        max_calls: 2,
    };
    (p, c, cfg)
}
#[test]
fn permits_valid_no_funding_plan() {
    let e = Env::default();
    let (p, c, cfg) = setup(&e);
    assert_eq!(validate_batch(&e, &p, &vec![&e, c], &cfg), Ok(()));
}
#[test]
fn denies_changed_target() {
    let e = Env::default();
    let (p, mut c, cfg) = setup(&e);
    c.target = Address::generate(&e);
    assert_eq!(
        validate_batch(&e, &p, &vec![&e, c], &cfg),
        Err(Error::Denied)
    );
}
#[test]
fn denies_appended_unapproved_call() {
    let e = Env::default();
    let (p, c, cfg) = setup(&e);
    let mut bad = c.clone();
    bad.function_name = Symbol::new(&e, "steal");
    assert_eq!(
        validate_batch(&e, &p, &vec![&e, c, bad], &cfg),
        Err(Error::Denied)
    );
}
#[test]
fn denies_unapproved_executor_authorization() {
    let e = Env::default();
    let (p, mut c, cfg) = setup(&e);
    c.executor_authorizations
        .push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: Address::generate(&e),
                fn_name: Symbol::new(&e, "approve"),
                args: Vec::new(&e),
            },
            sub_invocations: Vec::new(&e),
        }));
    assert_eq!(
        validate_batch(&e, &p, &vec![&e, c], &cfg),
        Err(Error::Denied)
    );
}
#[test]
fn denies_unapproved_nested_executor_authorization() {
    let e = Env::default();
    let (p, mut c, mut cfg) = setup(&e);
    let token = Address::generate(&e);
    cfg.auth_predicate = predicate(&e, &token, "transfer");
    let child = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&e, "approve"),
            args: Vec::new(&e),
        },
        sub_invocations: Vec::new(&e),
    });
    c.executor_authorizations
        .push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token,
                fn_name: Symbol::new(&e, "transfer"),
                args: Vec::new(&e),
            },
            sub_invocations: vec![&e, child],
        }));
    assert_eq!(
        validate_batch(&e, &p, &vec![&e, c], &cfg),
        Err(Error::Denied)
    );
}
#[test]
fn denies_replacing_installed_policy() {
    let e = Env::default();
    e.mock_all_auths();
    let (p, _, mut cfg) = setup(&e);
    let id = e.register(ExecutionPolicy, ());
    let client = ExecutionPolicyClient::new(&e, &id);
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(cfg.executor.clone()),
        name: soroban_sdk::String::from_str(&e, "test"),
        signers: vec![&e, Signer::Delegated(Address::generate(&e))],
        signer_ids: vec![&e, 0u32],
        policies: vec![&e, id.clone()],
        policy_ids: vec![&e, 0u32],
        valid_until: None,
    };
    client.install(&cfg, &rule, &p);
    cfg.max_calls = 8;
    assert_eq!(
        client.try_install(&cfg, &rule, &p),
        Err(Ok(soroban_sdk::Error::from_contract_error(902)))
    );
    client.uninstall(&rule, &p);
    assert_eq!(
        client.try_install(&cfg, &rule, &p),
        Err(Ok(soroban_sdk::Error::from_contract_error(902)))
    );
}
#[test]
fn denies_empty_and_overlong_batches() {
    let e = Env::default();
    let (p, c, cfg) = setup(&e);
    assert_eq!(
        validate_batch(&e, &p, &Vec::new(&e), &cfg),
        Err(Error::Denied)
    );
    assert_eq!(
        validate_batch(&e, &p, &vec![&e, c.clone(), c.clone(), c], &cfg),
        Err(Error::Denied)
    );
}

// M1: the direct-call bypass. A standalone nested context (e.g. the custody
// pull) that matches call_predicate must NOT authorize on its own - only as a
// descendant of a validated `execute` batch in the same transaction. Current
// enforce permits it via the non-execute arm; this test locks the DESIRED
// behavior (deny) and fails until in-transaction arming lands.
#[test]
fn denies_standalone_nested_context_without_execute() {
    let e = Env::default();
    e.mock_all_auths();
    let p = Address::generate(&e);
    let token = Address::generate(&e);
    let executor = Address::generate(&e);
    let agent = Address::generate(&e);
    let cfg = Config {
        executor: executor.clone(),
        call_predicate: predicate(&e, &token, "transfer_from"),
        auth_predicate: predicate(&e, &token, "transfer"),
        max_calls: 3,
    };
    let id = e.register(ExecutionPolicy, ());
    let client = ExecutionPolicyClient::new(&e, &id);
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(executor.clone()),
        name: soroban_sdk::String::from_str(&e, "exec"),
        signers: vec![&e, Signer::Delegated(agent.clone())],
        signer_ids: vec![&e, 0u32],
        policies: vec![&e, id.clone()],
        policy_ids: vec![&e, 0u32],
        valid_until: None,
    };
    client.install(&cfg, &rule, &p);
    // Standalone token.transfer_from, NOT nested under execute in this tx.
    let ctx = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&e, "transfer_from"),
        args: Vec::new(&e),
    });
    let signers = vec![&e, Signer::Delegated(agent)];
    assert!(
        client.try_enforce(&ctx, &signers, &rule, &p).is_err(),
        "a standalone nested context must be denied without a preceding execute"
    );
}

// M1 GREEN, real multi-rule topology: the OZ account requires each context's
// rule to be scoped to that context's contract, so the `execute` context is
// enforced under an executor-scoped rule (id 1) while the nested pull is
// enforced under a DIFFERENT token-scoped rule (id 2) - both sharing one
// mandate config (same executor). Arming keyed by the executor must bridge the
// two rules; a per-rule-id key would never match and would deny the batch.
#[test]
fn permits_nested_context_across_separately_scoped_rules_single_use() {
    let e = Env::default();
    e.mock_all_auths();
    let p = Address::generate(&e);
    let token = Address::generate(&e);
    let executor = Address::generate(&e);
    let agent = Address::generate(&e);
    let cfg = Config {
        executor: executor.clone(),
        call_predicate: predicate(&e, &token, "transfer_from"),
        auth_predicate: predicate(&e, &token, "transfer"),
        max_calls: 3,
    };
    let id = e.register(ExecutionPolicy, ());
    let client = ExecutionPolicyClient::new(&e, &id);
    let signers = vec![&e, Signer::Delegated(agent.clone())];
    let mk_rule = |rid: u32, scope: &Address| ContextRule {
        id: rid,
        context_type: ContextRuleType::CallContract(scope.clone()),
        name: soroban_sdk::String::from_str(&e, "m"),
        signers: signers.clone(),
        signer_ids: vec![&e, 0u32],
        policies: vec![&e, id.clone()],
        policy_ids: vec![&e, 0u32],
        valid_until: None,
    };
    // Rule 1 authorizes the execute context (scoped to the executor); rule 2
    // authorizes the nested token context (scoped to the token). Same config.
    let exec_rule = mk_rule(1, &executor);
    let token_rule = mk_rule(2, &token);
    client.install(&cfg, &exec_rule, &p);
    client.install(&cfg, &token_rule, &p);

    // The approved batch: one transfer_from the predicate permits.
    let call = Call {
        target: token.clone(),
        function_name: Symbol::new(&e, "transfer_from"),
        args: Vec::new(&e),
        executor_authorizations: Vec::new(&e),
    };
    let calls = vec![&e, call];
    let exec_ctx = Context::Contract(ContractContext {
        contract: executor.clone(),
        fn_name: Symbol::new(&e, "execute"),
        args: vec![&e, p.clone().into_val(&e), calls.clone().into_val(&e)],
    });
    // Arm under the executor-scoped rule (id 1).
    client.enforce(&exec_ctx, &signers, &exec_rule, &p);

    // Consume under the DIFFERENT token-scoped rule (id 2) - the cross-rule case.
    let nested = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&e, "transfer_from"),
        args: Vec::new(&e),
    });
    client.enforce(&nested, &signers, &token_rule, &p);

    // Single-use: a second identical nested context has no record left -> denied.
    assert!(
        client
            .try_enforce(&nested, &signers, &token_rule, &p)
            .is_err(),
        "armed record must be single-use"
    );
}
