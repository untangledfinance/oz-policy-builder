extern crate std;
use super::*;
use soroban_sdk::{
    auth::{ContractContext, SubContractInvocation},
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
