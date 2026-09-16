use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer,
};
use soroban_sdk::{
    testutils::Address as _, vec, xdr::ToXdr, Address, Bytes, Env, IntoVal, Map, String, Symbol,
    Val, Vec,
};

fn map(e: &Env, fields: &[(&str, Val)]) -> Val {
    let mut m = Map::<Symbol, Val>::new(e);
    for (k, v) in fields {
        m.set(Symbol::new(e, k), *v);
    }
    m.into_val(e)
}
fn document(e: &Env, adapter: &Address, venue: &Address) -> Bytes {
    let selector: Vec<Val> = vec![e, Symbol::new(e, "call_contract").into_val(e)];
    let tree: Vec<Val> = vec![
        e,
        Symbol::new(e, "eq").into_val(e),
        selector.into_val(e),
        venue.into_val(e),
    ];
    let predicate = tree.to_xdr(e);
    let step = map(
        e,
        &[
            ("predicate", predicate.into_val(e)),
            ("authorizations", Vec::<Val>::new(e).into_val(e)),
        ],
    );
    let plan = map(
        e,
        &[
            ("steps", vec![e, step].into_val(e)),
            ("equalities", Vec::<Val>::new(e).into_val(e)),
        ],
    );
    let cfg = map(
        e,
        &[
            ("executor", adapter.into_val(e)),
            ("plans", vec![e, plan].into_val(e)),
        ],
    );
    vec![e, Symbol::new(e, "execution_v1").into_val(e), cfg].to_xdr(e)
}
fn rule(e: &Env, prime: &Address, target: &Address) -> ContextRule {
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(target.clone()),
        name: String::from_str(e, "execution"),
        signers: vec![e, Signer::Delegated(prime.clone())],
        signer_ids: vec![e, 0],
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: None,
    }
}
#[test]
fn execution_document_installs_through_existing_policy_interface() {
    let e = Env::default();
    e.mock_all_auths();
    let interpreter = e.register(PolicyInterpreter, ());
    let prime = Address::generate(&e);
    let adapter = Address::generate(&e);
    let venue = Address::generate(&e);
    let predicate = document(&e, &adapter, &venue);
    let r = rule(&e, &prime, &adapter);
    let params = PolicyInstallParams {
        grammar_version: 6,
        install_nonce: 1,
        predicate_hash: e.crypto().sha256(&predicate).into(),
        predicate,
        policy_admins: r.signers.clone(),
    };
    assert!(
        PolicyInterpreterClient::new(&e, &interpreter)
            .try_install(&params, &r, &prime)
            .is_ok(),
        "execution document must install on the existing interpreter"
    );
}

use policy_interpreter::execution::{Call, Config, Equality, PathPart};
use soroban_sdk::{
    auth::{Context, ContractContext},
    xdr::FromXdr,
    TryFromVal,
};
struct Setup {
    e: Env,
    interpreter: Address,
    prime: Address,
    adapter: Address,
    venue: Address,
    r: ContextRule,
    calls: Vec<Call>,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    let interpreter = e.register(PolicyInterpreter, ());
    let prime = Address::generate(&e);
    let adapter = Address::generate(&e);
    let venue = Address::generate(&e);
    let r = rule(&e, &prime, &adapter);
    let predicate = document(&e, &adapter, &venue);
    let params = PolicyInstallParams {
        grammar_version: 6,
        install_nonce: 1,
        predicate_hash: e.crypto().sha256(&predicate).into(),
        predicate,
        policy_admins: r.signers.clone(),
    };
    PolicyInterpreterClient::new(&e, &interpreter).install(&params, &r, &prime);
    let calls = vec![
        &e,
        Call {
            target: venue.clone(),
            function_name: Symbol::new(&e, "act"),
            args: vec![&e, 7u32.into_val(&e)],
            executor_authorizations: Vec::new(&e),
        },
    ];
    Setup {
        e,
        interpreter,
        prime,
        adapter,
        venue,
        r,
        calls,
    }
}
fn ctx(s: &Setup, root: bool) -> Context {
    Context::Contract(if root {
        ContractContext {
            contract: s.adapter.clone(),
            fn_name: Symbol::new(&s.e, "execute"),
            args: (&s.prime, &s.calls).into_val(&s.e),
        }
    } else {
        ContractContext {
            contract: s.venue.clone(),
            fn_name: Symbol::new(&s.e, "act"),
            args: vec![&s.e, 7u32.into_val(&s.e)],
        }
    })
}
fn begin(s: &Setup) {
    PolicyInterpreterClient::new(&s.e, &s.interpreter)
        .begin_execution(&s.adapter, &s.prime, &s.calls);
}
fn authorize(s: &Setup, root: bool) -> bool {
    PolicyInterpreterClient::new(&s.e, &s.interpreter)
        .try_enforce(&ctx(s, root), &s.r.signers, &s.r, &s.prime)
        .is_ok()
}
#[test]
fn standalone_denied_before_and_after_batch_and_after_ledger_advance() {
    use soroban_sdk::testutils::Ledger;
    let s = setup();
    assert!(!authorize(&s, false));
    begin(&s);
    assert!(!authorize(&s, false));
    assert!(authorize(&s, true));
    assert!(authorize(&s, false));
    PolicyInterpreterClient::new(&s.e, &s.interpreter).end_execution(&s.adapter);
    assert!(!authorize(&s, false));
    s.e.ledger().with_mut(|l| l.sequence_number += 1);
    assert!(!authorize(&s, false));
}
#[test]
fn unused_child_context_is_removed_by_close() {
    let s = setup();
    begin(&s);
    assert!(authorize(&s, true));
    PolicyInterpreterClient::new(&s.e, &s.interpreter).end_execution(&s.adapter);
    assert!(!authorize(&s, false));
}
#[test]
fn duplicate_child_context_and_nested_scope_are_denied() {
    let s = setup();
    begin(&s);
    assert!(PolicyInterpreterClient::new(&s.e, &s.interpreter)
        .try_begin_execution(&s.adapter, &s.prime, &s.calls)
        .is_err());
    assert!(authorize(&s, true));
    assert!(authorize(&s, false));
    assert!(!authorize(&s, false));
}
#[test]
fn root_must_match_actual_scope_and_exact_plan_length() {
    let mut s = setup();
    begin(&s);
    let c = s.calls.get(0).unwrap();
    s.calls.push_back(c);
    assert!(!authorize(&s, true));
    PolicyInterpreterClient::new(&s.e, &s.interpreter).end_execution(&s.adapter);
    begin(&s);
    assert!(!authorize(&s, true));
}
#[test]
fn extra_executor_authorization_is_denied() {
    use soroban_sdk::auth::{InvokerContractAuthEntry, SubContractInvocation};
    let mut s = setup();
    let mut c = s.calls.get(0).unwrap();
    c.executor_authorizations
        .push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: s.venue.clone(),
                fn_name: Symbol::new(&s.e, "steal"),
                args: Vec::new(&s.e),
            },
            sub_invocations: Vec::new(&s.e),
        }));
    s.calls.set(0, c);
    begin(&s);
    assert!(!authorize(&s, true));
}
#[test]
fn scope_lifecycle_cannot_be_forged_without_executor_auth() {
    let s = setup();
    s.e.set_auths(&[]);
    let c = PolicyInterpreterClient::new(&s.e, &s.interpreter);
    assert!(c
        .try_begin_execution(&s.adapter, &s.prime, &s.calls)
        .is_err());
    assert!(!c.execution_active(&s.adapter));
    s.e.mock_all_auths();
    begin(&s);
    s.e.set_auths(&[]);
    assert!(c.try_end_execution(&s.adapter).is_err());
    assert!(c.execution_active(&s.adapter));
}
#[test]
fn execution_documents_cannot_claim_legacy_grammar_version() {
    let s = setup();
    let predicate = document(&s.e, &s.adapter, &s.venue);
    let params = PolicyInstallParams {
        grammar_version: 5,
        install_nonce: 2,
        predicate_hash: s.e.crypto().sha256(&predicate).into(),
        predicate,
        policy_admins: s.r.signers.clone(),
    };
    assert!(PolicyInterpreterClient::new(&s.e, &s.interpreter)
        .try_install(&params, &s.r, &s.prime)
        .is_err());
}
fn reinstall(s: &Setup, cfg: Config) {
    let wire: Vec<Val> = vec![
        &s.e,
        Symbol::new(&s.e, "execution_v1").into_val(&s.e),
        cfg.into_val(&s.e),
    ];
    let predicate = wire.to_xdr(&s.e);
    let p = PolicyInstallParams {
        grammar_version: 6,
        install_nonce: 2,
        predicate_hash: s.e.crypto().sha256(&predicate).into(),
        predicate,
        policy_admins: s.r.signers.clone(),
    };
    PolicyInterpreterClient::new(&s.e, &s.interpreter).install(&p, &s.r, &s.prime);
}
fn config(s: &Setup) -> Config {
    let v = Val::from_xdr(&s.e, &document(&s.e, &s.adapter, &s.venue)).unwrap();
    let v = Vec::<Val>::try_from_val(&s.e, &v).unwrap();
    Config::try_from_val(&s.e, &v.get(1).unwrap()).unwrap()
}
#[test]
fn amount_equality_links_reject_mismatches_and_missing_paths() {
    for other in [7u32, 8u32] {
        let mut s = setup();
        let mut cfg = config(&s);
        let mut p = cfg.plans.get(0).unwrap();
        p.steps.push_back(p.steps.get(0).unwrap());
        let path = |i| {
            vec![
                &s.e,
                PathPart::Index(i),
                PathPart::Key(Symbol::new(&s.e, "args")),
                PathPart::Index(0),
            ]
        };
        p.equalities.push_back(Equality {
            left: path(0),
            right: path(1),
        });
        cfg.plans.set(0, p);
        reinstall(&s, cfg);
        let mut c = s.calls.get(0).unwrap();
        c.args = vec![&s.e, other.into_val(&s.e)];
        s.calls.push_back(c);
        begin(&s);
        assert_eq!(authorize(&s, true), other == 7);
    }
    let s = setup();
    let mut cfg = config(&s);
    let mut p = cfg.plans.get(0).unwrap();
    p.equalities.push_back(Equality {
        left: vec![&s.e, PathPart::Index(9)],
        right: vec![&s.e, PathPart::Index(9)],
    });
    cfg.plans.set(0, p);
    reinstall(&s, cfg);
    begin(&s);
    assert!(!authorize(&s, true));
}
#[test]
fn different_document_cannot_consume_approved_scope() {
    let s = setup();
    begin(&s);
    assert!(authorize(&s, true));
    let mut cfg = config(&s);
    cfg.plans.push_back(cfg.plans.get(0).unwrap());
    reinstall(&s, cfg);
    assert!(!authorize(&s, false));
}
