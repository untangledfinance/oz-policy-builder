//! End-to-end against OpenZeppelin's REAL smart account.
//!
//! Everything else drives the interpreter directly. Here the account is in
//! charge: it calls `install` while adding its context rule, and calls
//! `enforce` from `__check_auth` when something needs authorizing. That is
//! the path a deployment actually takes, and it is the one the ContextRule
//! ABI bug broke while every direct-call test stayed green.
//!
//! The account is registered from OZ's compiled wasm, committed as a blob
//! rather than a Cargo dependency so the suite pins the exact deployed bytes.

extern crate alloc;
mod common;

use policy_interpreter::{PolicyInstallParams, PolicyInterpreter};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::xdr::{FromXdr, ScVal, ToXdr, VecM};
use soroban_sdk::{
    contract, contractimpl, Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

/// OZ's reference multisig smart account.
const OZ_ACCOUNT_WASM: &[u8] = include_bytes!("fixtures/multisig_account_example.wasm");

/// `Signer::Delegated(addr)` in the account's own encoding.
fn delegated(env: &Env, addr: &Address) -> Val {
    let mut v: Vec<Val> = Vec::new(env);
    v.push_back(Symbol::new(env, "Delegated").into_val(env));
    v.push_back(addr.to_val());
    v.into_val(env)
}

/// A grammar-7 rule: `eq(call_fn, <name>)` scopes the policy to one function by
/// name, which avoids needing the account's address before it exists, and
/// `read(oracle, "updated") >= scaled(now, 1, 1, -300)` - the oracle's last
/// update is under five minutes old - exercises the three new leaves.
fn predicate_on_fn(env: &Env, fn_name: &str, oracle: &Address) -> Bytes {
    let sym = |s: &str| {
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            s.as_bytes().to_vec().try_into().unwrap(),
        ))
    };
    let scvec = |items: alloc::vec::Vec<ScVal>| {
        let v: VecM<ScVal> = items.try_into().unwrap();
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
    };
    let int = |n: i128| {
        ScVal::I128(soroban_sdk::xdr::Int128Parts {
            hi: (n >> 64) as i64,
            lo: n as u64,
        })
    };
    let oracle = {
        let v: Val = oracle.into_val(env);
        ScVal::from_xdr(env, &v.to_xdr(env)).unwrap()
    };
    let fresh = scvec(alloc::vec![
        sym("gte"),
        scvec(alloc::vec![
            sym("read"),
            oracle,
            sym("updated"),
            scvec(alloc::vec![])
        ]),
        scvec(alloc::vec![
            sym("scaled"),
            scvec(alloc::vec![sym("now")]),
            int(1),
            int(1),
            int(-300)
        ]),
    ]);
    let root = scvec(alloc::vec![
        sym("and"),
        scvec(alloc::vec![
            scvec(alloc::vec![
                sym("eq"),
                scvec(alloc::vec![sym("call_fn")]),
                sym(fn_name)
            ]),
            fresh,
        ]),
    ]);
    let val: Val = root.into_val(env);
    val.to_xdr(env)
}

fn install_params(
    env: &Env,
    fn_name: &str,
    oracle: &Address,
    admins: &Vec<policy_interpreter::Signer>,
) -> PolicyInstallParams {
    let predicate = predicate_on_fn(env, fn_name, oracle);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate,
        predicate_hash,
        policy_admins: admins.clone(),
    }
}

/// `ContextRuleType::CallContract(addr)` in the account's own encoding.
fn call_contract_context(env: &Env, addr: &Address) -> Val {
    let mut v: Vec<Val> = Vec::new(env);
    v.push_back(Symbol::new(env, "CallContract").into_val(env));
    v.push_back(addr.into_val(env));
    v.into_val(env)
}

/// Deploy the interpreter and OZ's account WITHOUT a policy - the production
/// shape: the constructor's rule 0 is `Default`-scoped and predicates refuse
/// that scope, so policies arrive later on scoped rules.
fn deploy(env: &Env) -> (Address, Address, Address) {
    let interpreter = env.register(PolicyInterpreter, (common::DEFAULT,));

    let signer_addr = Address::generate(env);
    let signers: Vec<Val> = soroban_sdk::vec![env, delegated(env, &signer_addr)];

    let policies: Map<Address, Val> = Map::new(env);
    let account = env.register(OZ_ACCOUNT_WASM, (signers, policies));
    (account, interpreter, signer_addr)
}

#[test]
fn the_account_installs_our_policy_when_it_adds_a_scoped_context_rule() {
    // The account is in charge: `add_context_rule` builds a real ContextRule
    // and passes it to our `install`. The call succeeding IS the assertion -
    // a field-set mismatch or a refused install traps here.
    let env = Env::default();
    env.mock_all_auths();
    let (account, interpreter, signer_addr) = deploy(&env);

    let admins: Vec<policy_interpreter::Signer> = soroban_sdk::vec![
        &env,
        policy_interpreter::Signer::Delegated(signer_addr.clone())
    ];
    let venue = Address::generate(&env);
    let rule_signers: Vec<Val> = soroban_sdk::vec![&env, delegated(&env, &signer_addr)];
    let mut policies: Map<Address, Val> = Map::new(&env);
    policies.set(
        interpreter.clone(),
        install_params(&env, "batch_add_signer", &Address::generate(&env), &admins).into_val(&env),
    );

    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(call_contract_context(&env, &venue));
    args.push_back(soroban_sdk::String::from_str(&env, "agent-rule").into_val(&env));
    args.push_back(Option::<u32>::None.into_val(&env));
    args.push_back(rule_signers.into_val(&env));
    args.push_back(policies.into_val(&env));
    let _: Val = env.invoke_contract(&account, &Symbol::new(&env, "add_context_rule"), args);
}

#[test]
fn the_account_cannot_install_a_policy_on_its_default_rule() {
    // The constructor's rule 0 is `Default`-scoped: it matches every
    // operation, including the account's own administration. A predicate
    // there would be the only fence around `add_context_rule` itself, so
    // install refuses the scope - and the refusal has to hold when the REAL
    // account is the caller, not only on the direct path.
    let env = Env::default();
    env.mock_all_auths();
    let interpreter = env.register(PolicyInterpreter, (common::DEFAULT,));
    let signer_addr = Address::generate(&env);
    let signers: Vec<Val> = soroban_sdk::vec![&env, delegated(&env, &signer_addr)];
    let admins: Vec<policy_interpreter::Signer> = soroban_sdk::vec![
        &env,
        policy_interpreter::Signer::Delegated(signer_addr.clone())
    ];

    let mut policies: Map<Address, Val> = Map::new(&env);
    policies.set(
        interpreter,
        install_params(&env, "batch_add_signer", &Address::generate(&env), &admins).into_val(&env),
    );

    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(OZ_ACCOUNT_WASM, (signers, policies));
    }));
    assert!(
        res.is_err(),
        "a predicate must not install on the constructor's Default-scoped rule"
    );
}

/// `add_context_rule` on the real account, scoped to whatever `scope` picks out
/// of `(account, interpreter)`, with the interpreter as the rule's policy.
fn add_scoped_rule(scope: impl Fn(&Env, &Address, &Address) -> Address) -> Result<(), u32> {
    let env = Env::default();
    env.mock_all_auths();
    let (account, interpreter, signer_addr) = deploy(&env);
    let admins = soroban_sdk::vec![
        &env,
        policy_interpreter::Signer::Delegated(signer_addr.clone())
    ];
    let mut policies: Map<Address, Val> = Map::new(&env);
    policies.set(
        interpreter.clone(),
        install_params(&env, "add_context_rule", &Address::generate(&env), &admins).into_val(&env),
    );
    let target = scope(&env, &account, &interpreter);
    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(call_contract_context(&env, &target));
    args.push_back(soroban_sdk::String::from_str(&env, "rule").into_val(&env));
    args.push_back(Option::<u32>::None.into_val(&env));
    args.push_back(soroban_sdk::vec![&env, delegated(&env, &signer_addr)].into_val(&env));
    args.push_back(policies.into_val(&env));
    match env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &account,
        &Symbol::new(&env, "add_context_rule"),
        args,
    ) {
        Ok(_) => Ok(()),
        Err(Ok(e)) => Err(e.get_code()),
        Err(Err(e)) => panic!("trapped: {e:?}"),
    }
}

#[test]
fn a_rule_scoped_to_the_account_itself_is_refused_like_default() {
    // `CallContract(account)` matches `add_context_rule` on the account, so it
    // reaches the same admin surface `Default` does (218 for both).
    assert_eq!(add_scoped_rule(|_, account, _| account.clone()), Err(218));
}

#[test]
fn a_rule_scoped_to_the_interpreter_is_refused_like_default() {
    // `CallContract(interpreter)` matches `install` and `rotate_master_signer_set`
    // on the interpreter itself, so a rule holder could squat rule ids.
    assert_eq!(
        add_scoped_rule(|_, _, interpreter| interpreter.clone()),
        Err(218)
    );
}

#[test]
fn a_rule_scoped_to_any_other_contract_is_installed() {
    assert_eq!(add_scoped_rule(|env, _, _| Address::generate(env)), Ok(()));
}

// ---- why the first `enforce` attempts here were dropped ----
//
// (The `enforce` half IS covered now, at the bottom of this file, through the
// SDK's `try_invoke_contract_check_auth`; the two approaches below are why that
// is the only way.) The `enforce` half of the flow - the account calling our policy from
// `__check_auth` - is deliberately absent from this file.
//
// Two approaches were tried and BOTH produced false positives:
//
//   1. `mock_all_auths()` + invoking a self-authorizing entry point. The host
//      approves mocked auth WITHOUT calling a custom account's
//      `__check_auth`, so the policy is never consulted. A policy scoped to
//      the wrong function still "passed".
//
//   2. Invoking `__check_auth` directly. The host rejects that with
//      `Error(Context, InvalidAction)` - it is reserved for the auth
//      machinery. The deny-case assertion then "passed" on the host's
//      rejection rather than on our verdict.
//
// Either would have been a green test proving nothing, which is the exact
// failure mode that let the ContextRule bug reach this point. Driving it
// honestly needs real `SorobanAuthorizationEntry` construction, which is done
// against a live network instead.
//
// What IS covered here is the install half, which is what the ABI bug broke:
// OZ builds its own ContextRule and hands it to our `install`.

#[test]
fn the_account_rejects_a_policy_whose_predicate_is_malformed() {
    // Install-time validation has to hold when OZ is the caller too, not just
    // on the direct path.
    let env = Env::default();
    env.mock_all_auths();
    let interpreter = env.register(PolicyInterpreter, (common::DEFAULT,));
    let signer_addr = Address::generate(&env);
    let signers: Vec<Val> = soroban_sdk::vec![&env, delegated(&env, &signer_addr)];

    let garbage = Bytes::from_array(&env, &[0xde, 0xad, 0xbe, 0xef]);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&garbage).into();
    let bad = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate: garbage,
        predicate_hash,
        policy_admins: soroban_sdk::vec![
            &env,
            policy_interpreter::Signer::Delegated(signer_addr.clone())
        ],
    };
    let mut policies: Map<Address, Val> = Map::new(&env);
    policies.set(interpreter, bad.into_val(&env));

    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(OZ_ACCOUNT_WASM, (signers, policies));
    }));
    assert!(res.is_err(), "a malformed predicate must not install");
}

/// Sanity: the fixture is the wasm we think it is, so a silent swap is caught.
#[test]
fn the_account_fixture_is_a_soroban_wasm() {
    assert_eq!(&OZ_ACCOUNT_WASM[0..4], b"\0asm");
    assert!(OZ_ACCOUNT_WASM.len() > 10_000);
    let _ = ScVal::Void;
    let env = Env::default();
    let _ = Val::try_from_val(&env, &());
}

// ---- enforce, through the real account --------------------------------------
//
// The note above explains why `mock_all_auths` + a self-authorizing call proves
// nothing: the host approves mocked auth without running the account's
// `__check_auth`. The SDK's `try_invoke_contract_check_auth` runs it for real,
// so the account decodes its `AuthPayload`, picks the context rule, and calls
// our `enforce`, which in turn calls the oracle named in the predicate.

/// A price oracle's freshness field, the only thing the rule reads.
#[contract]
pub struct Oracle;

#[contractimpl]
impl Oracle {
    pub fn __constructor(e: &Env, updated: u64) {
        e.storage().instance().set(&0u32, &updated);
    }
    pub fn updated(e: &Env) -> u64 {
        e.storage().instance().get(&0u32).unwrap()
    }
}

/// `AuthPayload { signers: {Delegated(signer): ""}, context_rule_ids: [id] }`.
fn auth_payload(env: &Env, signer: &Address, rule_id: u32) -> Val {
    let mut signers: Map<Val, Bytes> = Map::new(env);
    signers.set(delegated(env, signer), Bytes::new(env));
    let mut payload: Map<Symbol, Val> = Map::new(env);
    payload.set(
        Symbol::new(env, "context_rule_ids"),
        soroban_sdk::vec![env, rule_id].into_val(env),
    );
    payload.set(Symbol::new(env, "signers"), signers.into_val(env));
    payload.into_val(env)
}

/// The account with a policy-guarded rule 1 for `batch_add_signer` on `venue`
/// whose predicate reads `oracle`, and the result of asking the account to
/// authorise that call.
type Verdict = Result<(), Result<soroban_sdk::Error, soroban_sdk::InvokeError>>;

fn authorise(oracle_updated: u64, fn_name: &str) -> Verdict {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|l| l.timestamp = 10_000);
    let (account, interpreter, signer_addr) = deploy(&env);
    let oracle = env.register(Oracle, (oracle_updated,));

    let admins: Vec<policy_interpreter::Signer> = soroban_sdk::vec![
        &env,
        policy_interpreter::Signer::Delegated(signer_addr.clone())
    ];
    let venue = Address::generate(&env);
    let mut policies: Map<Address, Val> = Map::new(&env);
    policies.set(
        interpreter,
        install_params(&env, "batch_add_signer", &oracle, &admins).into_val(&env),
    );
    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(call_contract_context(&env, &venue));
    args.push_back(soroban_sdk::String::from_str(&env, "agent-rule").into_val(&env));
    args.push_back(Option::<u32>::None.into_val(&env));
    args.push_back(soroban_sdk::vec![&env, delegated(&env, &signer_addr)].into_val(&env));
    args.push_back(policies.into_val(&env));
    let _: Val = env.invoke_contract(&account, &Symbol::new(&env, "add_context_rule"), args);

    let ctx = soroban_sdk::auth::Context::Contract(soroban_sdk::auth::ContractContext {
        contract: venue,
        fn_name: Symbol::new(&env, fn_name),
        args: Vec::new(&env),
    });
    env.try_invoke_contract_check_auth::<soroban_sdk::Error>(
        &account,
        &BytesN::from_array(&env, &[7u8; 32]),
        auth_payload(&env, &signer_addr, 1),
        &soroban_sdk::vec![&env, ctx],
    )
}

/// Our `ARG_MISMATCH` (100), as the account surfaces it.
fn arg_mismatch() -> Verdict {
    Err(Ok(soroban_sdk::Error::from_contract_error(100)))
}

#[test]
fn the_account_permits_a_call_when_the_read_in_its_rule_holds() {
    // The oracle updated 200 s ago; the rule asks for under 300. Exactly 300
    // is still inside the window.
    assert_eq!(authorise(9_800, "batch_add_signer"), Ok(()));
    assert_eq!(authorise(9_700, "batch_add_signer"), Ok(()));
}

#[test]
fn the_account_refuses_a_call_when_the_read_in_its_rule_fails() {
    // 301 s old: the account's `__check_auth` calls our `enforce`, which reads
    // the oracle and denies, and the denial reaches the host.
    assert_eq!(authorise(9_699, "batch_add_signer"), arg_mismatch());
}

#[test]
fn the_account_refuses_a_call_the_rule_does_not_name_even_when_the_read_holds() {
    // The read alone is not the rule: `eq(call_fn, ..)` still binds the call.
    assert_eq!(authorise(9_800, "burn"), arg_mismatch());
}
