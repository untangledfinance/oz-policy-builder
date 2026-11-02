//! Three-role separation: Owner (the smart account's admin rule), Policy
//! Signer (`policy_admins`, stored as the master set) and Manager (the
//! context rule's signers, the operators).
//!
//! Before this suite the master set was CAPTURED from the rule's signers at
//! first install, so the people who execute a mandate and the people who can
//! change it were forced to be the same set. These tests pin the separated
//! semantics:
//!
//! - the master set comes from `policy_admins`, appointed explicitly under
//!   the account's own authorisation;
//! - re-install, uninstall and rotation answer to the admins, never to the
//!   operators;
//! - rotation ALSO needs the account (the Owner's rule), so the admin set is
//!   not self-perpetuating;
//! - rotating admins leaves the operator pinning (`signers_hash`) alone;
//! - a predicate cannot install on a `Default`-context rule, because that
//!   scope includes account administration and a weakened predicate there
//!   would hand the operators the admin surface.

extern crate alloc;
mod common;

use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec as SorobanVec};

fn sym(s: &str) -> ScVal {
    ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
        s.as_bytes().to_vec().try_into().unwrap(),
    ))
}

fn scvec(items: alloc::vec::Vec<ScVal>) -> ScVal {
    let v: VecM<ScVal> = items.try_into().expect("vec");
    ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
}

/// `eq(call_fn, "transfer")` - smallest predicate with a selector leaf that
/// permits the `call_context` below. These tests are about who may install,
/// rotate and uninstall, not about what the predicate says.
fn permitting_predicate_bytes(env: &Env) -> Bytes {
    let root = scvec(alloc::vec![
        sym("eq"),
        scvec(alloc::vec![sym("call_fn")]),
        sym("transfer"),
    ]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

fn make_params(env: &Env, nonce: u32, admins: SorobanVec<Signer>) -> PolicyInstallParams {
    let predicate = permitting_predicate_bytes(env);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    PolicyInstallParams {
        grammar_version: 7,
        install_nonce: nonce,
        predicate,
        predicate_hash,
        policy_admins: admins,
    }
}

/// A venue-scoped rule: `CallContract`, never `Default`.
fn make_rule(env: &Env, id: u32, venue: &Address, signers: SorobanVec<Signer>) -> ContextRule {
    ContextRule {
        id,
        context_type: ContextRuleType::CallContract(venue.clone()),
        name: soroban_sdk::String::from_str(env, "rule"),
        signers,
        signer_ids: SorobanVec::new(env),
        policies: SorobanVec::new(env),
        policy_ids: SorobanVec::new(env),
        valid_until: None,
    }
}

fn call_context(env: &Env, target: &Address) -> Context {
    Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args: SorobanVec::new(env),
    })
}

fn delegated(a: &Address) -> Signer {
    Signer::Delegated(a.clone())
}

struct Setup {
    env: Env,
    contract_id: Address,
    smart_account: Address,
    venue: Address,
    admin: Address,
    operator: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    let contract_id = env.register(PolicyInterpreter, (common::DEFAULT,));
    Setup {
        smart_account: Address::generate(&env),
        venue: Address::generate(&env),
        admin: Address::generate(&env),
        operator: Address::generate(&env),
        contract_id,
        env,
    }
}

// ---- appointment ----

#[test]
fn admins_distinct_from_operators_install_and_enforce() {
    let s = setup();
    s.env.mock_all_auths();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators.clone());
    client.install(&make_params(&s.env, 1, admins), &rule, &s.smart_account);

    // The operators still drive enforce exactly as before the separation.
    let ctx = call_context(&s.env, &s.venue);
    assert!(
        client
            .try_enforce(&ctx, &operators, &rule, &s.smart_account)
            .is_ok(),
        "operators must keep enforcing after admins were appointed separately"
    );
}

#[test]
fn reinstall_answers_to_admins_not_operators() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators.clone());

    s.env.mock_all_auths();
    client.install(
        &make_params(&s.env, 1, admins.clone()),
        &rule,
        &s.smart_account,
    );

    // Re-install granting the ACCOUNT and the OPERATOR, but not the admin.
    // Before the separation the operator WAS the master, so this passed;
    // now it must fail.
    let params2 = make_params(&s.env, 2, admins.clone());
    let install_args = (params2.clone(), rule.clone(), s.smart_account.clone());
    s.env.mock_auths(&[
        MockAuth {
            address: &s.smart_account,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "install",
                args: install_args.clone().into_val(&s.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &s.operator,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "install",
                args: install_args.clone().into_val(&s.env),
                sub_invokes: &[],
            },
        },
    ]);
    assert!(
        client
            .try_install(&params2, &rule, &s.smart_account)
            .is_err(),
        "operators must not be able to re-install the mandate"
    );

    // The same re-install granting the account and the ADMIN succeeds.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.smart_account,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "install",
                args: install_args.clone().into_val(&s.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "install",
                args: install_args.clone().into_val(&s.env),
                sub_invokes: &[],
            },
        },
    ]);
    assert!(
        client
            .try_install(&params2, &rule, &s.smart_account)
            .is_ok(),
        "the appointed admin plus the account must be able to re-install"
    );
}

#[test]
fn reinstall_cannot_swap_the_admin_set() {
    // Changing WHO administers the mandate is rotation's job, with its own
    // authorisation. A re-install that smuggles a different admin set in
    // through `policy_admins` must be refused even when fully authorised.
    let s = setup();
    s.env.mock_all_auths();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators);
    client.install(&make_params(&s.env, 1, admins), &rule, &s.smart_account);

    let other_admins = soroban_sdk::vec![&s.env, delegated(&Address::generate(&s.env))];
    assert!(
        client
            .try_install(
                &make_params(&s.env, 2, other_admins),
                &rule,
                &s.smart_account
            )
            .is_err(),
        "a re-install must not change the admin set"
    );
}

// ---- unusable admin sets ----

#[test]
fn install_refuses_unusable_admin_sets() {
    let s = setup();
    s.env.mock_all_auths();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let rule = make_rule(&s.env, 1, &s.venue, operators);

    // Empty: nobody could ever authorise a later admin-gated call (EmptySignerSet).
    let empty: SorobanVec<Signer> = SorobanVec::new(&s.env);
    let res = client.try_install(&make_params(&s.env, 1, empty), &rule, &s.smart_account);
    let expected = soroban_sdk::Error::from_contract_error(209);
    assert!(
        matches!(res, Err(Ok(e)) if e == expected),
        "an empty admin set must be refused with Error(Contract, #209), got {res:?}"
    );

    // External: require_auth on a verifier address can never be satisfied (ExternalSignerNotSupported).
    let external = soroban_sdk::vec![
        &s.env,
        Signer::External(Address::generate(&s.env), Bytes::new(&s.env))
    ];
    let res = client.try_install(&make_params(&s.env, 1, external), &rule, &s.smart_account);
    let expected = soroban_sdk::Error::from_contract_error(212);
    assert!(
        matches!(res, Err(Ok(e)) if e == expected),
        "an External admin must be refused with Error(Contract, #212), got {res:?}"
    );

    // Oversized: one require_auth per admin; an unbounded set bricks the rule (TooManySigners).
    let mut oversized: SorobanVec<Signer> = SorobanVec::new(&s.env);
    for _ in 0..17 {
        oversized.push_back(delegated(&Address::generate(&s.env)));
    }
    let res = client.try_install(&make_params(&s.env, 1, oversized), &rule, &s.smart_account);
    let expected = soroban_sdk::Error::from_contract_error(217);
    assert!(
        matches!(res, Err(Ok(e)) if e == expected),
        "an oversized admin set must be refused with Error(Contract, #217), got {res:?}"
    );
}

// ---- rotation ----

#[test]
fn rotation_requires_the_account_and_the_current_admins() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators);

    s.env.mock_all_auths();
    client.install(&make_params(&s.env, 1, admins), &rule, &s.smart_account);

    let new_admins = soroban_sdk::vec![&s.env, delegated(&Address::generate(&s.env))];
    let rotate_args = (s.smart_account.clone(), 1u32, new_admins.clone());

    // Admins alone: before the separation this succeeded, making the master
    // set self-perpetuating. Now the Owner's rule must co-sign.
    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "rotate_master_signer_set",
            args: rotate_args.clone().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        client
            .try_rotate_master_signer_set(&s.smart_account, &1, &new_admins)
            .is_err(),
        "the admin set must not rotate itself without the account"
    );

    // Account alone: the current admins must consent to their replacement.
    s.env.mock_auths(&[MockAuth {
        address: &s.smart_account,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "rotate_master_signer_set",
            args: rotate_args.clone().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        client
            .try_rotate_master_signer_set(&s.smart_account, &1, &new_admins)
            .is_err(),
        "the account must not replace the admins without their consent"
    );

    // Both together succeed.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.smart_account,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "rotate_master_signer_set",
                args: rotate_args.clone().into_val(&s.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "rotate_master_signer_set",
                args: rotate_args.clone().into_val(&s.env),
                sub_invokes: &[],
            },
        },
    ]);
    assert!(
        client
            .try_rotate_master_signer_set(&s.smart_account, &1, &new_admins)
            .is_ok(),
        "account plus current admins must rotate"
    );
}

#[test]
fn rotating_admins_leaves_operator_pinning_alone() {
    let s = setup();
    s.env.mock_all_auths();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators.clone());
    client.install(&make_params(&s.env, 1, admins), &rule, &s.smart_account);

    let new_admins = soroban_sdk::vec![&s.env, delegated(&Address::generate(&s.env))];
    client.rotate_master_signer_set(&s.smart_account, &1, &new_admins);

    // The rule and its operators are untouched: enforce still permits.
    let ctx = call_context(&s.env, &s.venue);
    assert!(
        client
            .try_enforce(&ctx, &operators, &rule, &s.smart_account)
            .is_ok(),
        "admin rotation must not disturb the operators' enforce path"
    );

    // A rule presenting the ADMIN set as its signers is a different rule
    // from the one pinned at install: enforce refuses it.
    let admin_shaped = make_rule(&s.env, 1, &s.venue, new_admins.clone());
    assert!(
        client
            .try_enforce(&ctx, &new_admins, &admin_shaped, &s.smart_account)
            .is_err(),
        "admins must not become operators through rotation"
    );
}

// ---- uninstall ----

#[test]
fn uninstall_answers_to_admins_not_operators() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators);

    s.env.mock_all_auths();
    client.install(&make_params(&s.env, 1, admins), &rule, &s.smart_account);

    // F-2026-20275: uninstall keeps the 2-argument OZ signature and instead has
    // the master set authorise the version it moves to. Install at nonce 1 set
    // the shared counter to 1, so uninstall moves it to 2 and the signer
    // authorises `((smart_account, rule_id), 2)`.
    let key = (s.smart_account.clone(), rule.id);
    let uninstall_args = (key.clone(), 2u32);
    s.env.mock_auths(&[MockAuth {
        address: &s.operator,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "uninstall",
            args: uninstall_args.clone().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        client.try_uninstall(&rule, &s.smart_account).is_err(),
        "operators must not remove their own mandate"
    );

    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "uninstall",
            args: uninstall_args.clone().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        client.try_uninstall(&rule, &s.smart_account).is_ok(),
        "the admins must be able to kill the mandate"
    );
}

// ---- scope ----

#[test]
fn install_refuses_a_default_context_rule() {
    // A Default-context rule matches EVERY operation, including the
    // account's own administration. A predicate there is the only fence on
    // the admin surface, so a weakened predicate would hand the operators
    // `add_context_rule` itself. Scoped rules only.
    let s = setup();
    s.env.mock_all_auths();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);

    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let mut rule = make_rule(&s.env, 1, &s.venue, operators);
    rule.context_type = ContextRuleType::Default;

    assert!(
        client
            .try_install(&make_params(&s.env, 1, admins), &rule, &s.smart_account)
            .is_err(),
        "a predicate must not install on a Default-context rule"
    );
}

#[test]
fn executor_binding_requires_account_and_admin() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);
    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(&s.env, 1, &s.venue, operators);
    let executor = Address::generate(&s.env);
    let key = (s.smart_account.clone(), rule.id);
    s.env.mock_all_auths();
    client.install(&make_params(&s.env, 1, admins), &rule, &s.smart_account);
    for only_signer in [&s.smart_account, &s.admin, &s.operator] {
        s.env.mock_auths(&[MockAuth {
            address: only_signer,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "bind_executor",
                args: (key.clone(), executor.clone(), 2u32).into_val(&s.env),
                sub_invokes: &[],
            },
        }]);
        assert!(client.try_bind_executor(&key, &executor, &2u32).is_err());
    }
    s.env.mock_all_auths();
    client.bind_executor(&key, &executor, &2u32);
    let doc: policy_interpreter::StoredDoc = s.env.as_contract(&s.contract_id, || {
        s.env.storage().persistent().get(&(key.0, key.1)).unwrap()
    });
    assert_eq!(doc.executor, Some(executor));
}

/// F-2026-20242: a rule may be bound only to an execution adapter. Binding to
/// the smart account itself or to this interpreter is refused with
/// InvalidExecutor (222). The account case is an escalation: a
/// venue-scoped keyless rule bound to the account never reaches `pins_own`, and
/// `enforce` would then satisfy the executor's approval with the account's own
/// authorisation, permitting with no grant and no signer.
#[test]
fn binding_to_the_account_or_the_interpreter_is_refused_222() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let operators = soroban_sdk::vec![&s.env, delegated(&s.operator)];
    s.env.mock_all_auths();

    let invalid = Some(Ok(soroban_sdk::Error::from_contract_error(222)));
    // Bind to the smart account itself.
    let r1 = make_rule(&s.env, 1, &s.venue, operators.clone());
    client.install(
        &make_params(&s.env, 1, admins.clone()),
        &r1,
        &s.smart_account,
    );
    let k1 = (s.smart_account.clone(), r1.id);
    assert_eq!(
        client.try_bind_executor(&k1, &s.smart_account, &2u32).err(),
        invalid,
        "the account is refused as executor"
    );
    // Bind to this interpreter.
    let r2 = make_rule(&s.env, 2, &s.venue, operators.clone());
    client.install(
        &make_params(&s.env, 1, admins.clone()),
        &r2,
        &s.smart_account,
    );
    let k2 = (s.smart_account.clone(), r2.id);
    assert_eq!(
        client.try_bind_executor(&k2, &s.contract_id, &2u32).err(),
        invalid,
        "the interpreter is refused as executor"
    );
    // A real adapter still binds.
    let r3 = make_rule(&s.env, 3, &s.venue, operators);
    client.install(&make_params(&s.env, 1, admins), &r3, &s.smart_account);
    let k3 = (s.smart_account.clone(), r3.id);
    let adapter = Address::generate(&s.env);
    client.bind_executor(&k3, &adapter, &2u32);
    let doc: policy_interpreter::StoredDoc = s.env.as_contract(&s.contract_id, || {
        s.env.storage().persistent().get(&k3).unwrap()
    });
    assert_eq!(doc.executor, Some(adapter));
}

#[test]
fn executor_binding_survives_reinstall_and_is_removed_with_document() {
    let s = setup();
    s.env.mock_all_auths();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);
    let rule = make_rule(
        &s.env,
        1,
        &s.venue,
        soroban_sdk::vec![&s.env, delegated(&s.operator)],
    );
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let executor = Address::generate(&s.env);
    client.install(
        &make_params(&s.env, 1, admins.clone()),
        &rule,
        &s.smart_account,
    );
    client.bind_executor(&(s.smart_account.clone(), rule.id), &executor, &2u32);
    // F-2026-20275: install set the version to 1 and bind to 2, so the
    // re-install takes nonce 3.
    client.install(&make_params(&s.env, 3, admins), &rule, &s.smart_account);
    let key = (s.smart_account.clone(), rule.id);
    let doc: policy_interpreter::StoredDoc = s.env.as_contract(&s.contract_id, || {
        s.env.storage().persistent().get(&key).unwrap()
    });
    assert_eq!(doc.executor, Some(executor));
    client.uninstall(&rule, &s.smart_account);
    assert!(!s
        .env
        .as_contract(&s.contract_id, || s.env.storage().persistent().has(&key)));
}

// ---- F-2026-20275 replay protection (shared per-rule version key) ----

/// A stale `bind_executor` is refused once the shared counter advances. The
/// counter is one per rule, raised by `install`, `bind_executor` and
/// `uninstall`, and `bind_executor` names the version it moves to.
#[test]
fn a_stale_bind_is_refused_after_the_counter_advances() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(
        &s.env,
        1,
        &s.venue,
        soroban_sdk::vec![&s.env, delegated(&s.operator)],
    );
    let key = (s.smart_account.clone(), rule.id);
    let executor = Address::generate(&s.env);

    s.env.mock_all_auths();
    client.install(
        &make_params(&s.env, 1, admins.clone()),
        &rule,
        &s.smart_account,
    ); // ver 1
       // The rule is scoped to a venue, not the executor, so the batch-shape pin is
       // skipped and the bind turns on the version check alone.
    client.bind_executor(&key, &executor, &2u32); // ver 2
    assert_eq!(
        client.try_bind_executor(&key, &executor, &2u32).err(),
        Some(Ok(soroban_sdk::Error::from_contract_error(202))),
        "replaying the same bind (version 2) is refused: the counter is at 2"
    );

    // A re-install advances the counter again; a stale bind for an earlier
    // version stays refused, only the next one is accepted.
    client.install(&make_params(&s.env, 3, admins), &rule, &s.smart_account); // ver 3
    assert!(
        client.try_bind_executor(&key, &executor, &2u32).is_err(),
        "version 2 stale"
    );
    assert!(
        client.try_bind_executor(&key, &executor, &3u32).is_err(),
        "version 3 stale"
    );
    client.bind_executor(&key, &executor, &4u32); // the live version binds
}

/// A stale `uninstall` cannot delete a rule the owners installed again. The
/// version key survives `uninstall`, so after an uninstall and a re-install the
/// counter does not restart at 1, and a replayed uninstall signed for the old
/// version no longer matches the version the master set must authorise now.
#[test]
fn a_stale_uninstall_cannot_delete_a_reinstalled_rule() {
    let s = setup();
    let client = PolicyInterpreterClient::new(&s.env, &s.contract_id);
    let admins = soroban_sdk::vec![&s.env, delegated(&s.admin)];
    let rule = make_rule(
        &s.env,
        1,
        &s.venue,
        soroban_sdk::vec![&s.env, delegated(&s.operator)],
    );
    let key = (s.smart_account.clone(), rule.id);

    s.env.mock_all_auths();
    client.install(
        &make_params(&s.env, 1, admins.clone()),
        &rule,
        &s.smart_account,
    ); // ver 1
    client.uninstall(&rule, &s.smart_account); // master authorises version 2, ver 2, removed
    client.install(&make_params(&s.env, 3, admins), &rule, &s.smart_account); // reinstall, ver 3

    // The stale uninstall carries the admin's old signature over version 2.
    // uninstall now needs the master to authorise version 4, so it does not
    // match and the rule survives.
    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "uninstall",
            args: (key.clone(), 2u32).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        client.try_uninstall(&rule, &s.smart_account).is_err(),
        "a replay signed for version 2 is refused after the re-install"
    );
    assert!(
        s.env
            .as_contract(&s.contract_id, || s.env.storage().persistent().has(&key)),
        "the reinstalled rule survives the replay"
    );

    // The live uninstall, signed for version 4, removes it.
    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "uninstall",
            args: (key.clone(), 4u32).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    client.uninstall(&rule, &s.smart_account);
    assert!(!s
        .env
        .as_contract(&s.contract_id, || s.env.storage().persistent().has(&key)));
}
