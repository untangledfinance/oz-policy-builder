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
        grammar_version: 4,
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
    let contract_id = env.register(PolicyInterpreter, ());
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

    // Empty: nobody could ever authorise a later admin-gated call.
    let empty: SorobanVec<Signer> = SorobanVec::new(&s.env);
    assert!(
        client
            .try_install(&make_params(&s.env, 1, empty), &rule, &s.smart_account)
            .is_err(),
        "an empty admin set must be refused"
    );

    // External: require_auth on a verifier address can never be satisfied.
    let external = soroban_sdk::vec![
        &s.env,
        Signer::External(Address::generate(&s.env), Bytes::new(&s.env))
    ];
    assert!(
        client
            .try_install(&make_params(&s.env, 1, external), &rule, &s.smart_account)
            .is_err(),
        "an External admin must be refused"
    );

    // Oversized: one require_auth per admin; an unbounded set bricks the rule.
    let mut oversized: SorobanVec<Signer> = SorobanVec::new(&s.env);
    for _ in 0..17 {
        oversized.push_back(delegated(&Address::generate(&s.env)));
    }
    assert!(
        client
            .try_install(&make_params(&s.env, 1, oversized), &rule, &s.smart_account)
            .is_err(),
        "an oversized admin set must be refused"
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

    let uninstall_args = (rule.clone(), s.smart_account.clone());
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
