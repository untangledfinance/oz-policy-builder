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

use policy_interpreter::{PolicyInstallParams, PolicyInterpreter};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec};

/// OZ's reference multisig smart account.
const OZ_ACCOUNT_WASM: &[u8] = include_bytes!("fixtures/multisig_account_example.wasm");

/// `Signer::Delegated(addr)` in the account's own encoding.
fn delegated(env: &Env, addr: &Address) -> Val {
    let mut v: Vec<Val> = Vec::new(env);
    v.push_back(Symbol::new(env, "Delegated").into_val(env));
    v.push_back(addr.to_val());
    v.into_val(env)
}

/// `eq(call_fn, <name>)` - scopes the policy to one function by name, which
/// avoids needing the account's address before it exists.
fn predicate_on_fn(env: &Env, fn_name: &str) -> Bytes {
    let sym = |s: &str| {
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            s.as_bytes().to_vec().try_into().unwrap(),
        ))
    };
    let scvec = |items: alloc::vec::Vec<ScVal>| {
        let v: VecM<ScVal> = items.try_into().unwrap();
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
    };
    let root = scvec(alloc::vec![
        sym("eq"),
        scvec(alloc::vec![sym("call_fn")]),
        sym(fn_name),
    ]);
    let val: Val = root.into_val(env);
    val.to_xdr(env)
}

fn install_params(env: &Env, fn_name: &str) -> PolicyInstallParams {
    let predicate = predicate_on_fn(env, fn_name);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    PolicyInstallParams {
        grammar_version: 2,
        install_nonce: 1,
        predicate,
        predicate_hash,
    }
}

/// Deploy the interpreter, then deploy OZ's account with the interpreter
/// registered as a policy. The account calls our `install` as it builds its
/// default context rule - if the ABI were wrong, this would trap here.
fn deploy(env: &Env, policy_fn_name: &str) -> (Address, Address, Address) {
    let interpreter = env.register(PolicyInterpreter, ());

    let signer_addr = Address::generate(env);
    let signers: Vec<Val> = soroban_sdk::vec![env, delegated(env, &signer_addr)];

    let mut policies: Map<Address, Val> = Map::new(env);
    policies.set(
        interpreter.clone(),
        install_params(env, policy_fn_name).into_val(env),
    );

    let account = env.register(OZ_ACCOUNT_WASM, (signers, policies));
    (account, interpreter, signer_addr)
}

#[test]
fn the_account_installs_our_policy_when_it_adds_its_context_rule() {
    // Deployment succeeding IS the assertion: OZ builds a real ContextRule
    // and passes it to our `install`. A field-set mismatch traps.
    let env = Env::default();
    env.mock_all_auths();
    let (account, interpreter, _signer) = deploy(&env, "batch_add_signer");
    assert_ne!(account, interpreter);
}

// ---- what is NOT covered here, and why ----
//
// The `enforce` half of the flow - the account calling our policy from
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
    let interpreter = env.register(PolicyInterpreter, ());
    let signer_addr = Address::generate(&env);
    let signers: Vec<Val> = soroban_sdk::vec![&env, delegated(&env, &signer_addr)];

    let garbage = Bytes::from_array(&env, &[0xde, 0xad, 0xbe, 0xef]);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&garbage).into();
    let bad = PolicyInstallParams {
        grammar_version: 2,
        install_nonce: 1,
        predicate: garbage,
        predicate_hash,
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
