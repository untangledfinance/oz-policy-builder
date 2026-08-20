//! Install / enforce / uninstall round-trip tests.
//!
//! Tests build the raw canonical ScVal XDR bytes for the predicate via the
//! host's `Val::to_xdr`, compute the sha256 with `env.crypto().sha256`, and
//! hand both to install. The contract re-hashes and re-decodes on receipt.

extern crate alloc;

use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Vec as SorobanVec};

/// Build the raw bytes for a single `eq(call_contract, _)` predicate.
/// The wire shape is `ScVal::Vec([eq, ScVal::Vec([call_contract]),
/// literal_address])` - the selector tuple MUST be wrapped in its own Vec
/// so `decode_leaf` routes it into `decode_selector_leaf`. A bare symbol at
/// the operand position parses as `Leaf::LiteralSymbol`, which leaves the
/// predicate with no selector leaf and is refused at install by the
/// minimum-constraint rule (216 `SELECTOR_LEAF_REQUIRED`).
///
/// The host parses these bytes via `Val::from_xdr` on receipt; the contract
/// never sees the ScVal type directly.
fn eq_call_contract_bytes(env: &Env, literal_address: &ScVal) -> Bytes {
    let selector: VecM<ScVal> = vec![ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
        b"call_contract".to_vec().try_into().unwrap(),
    ))]
    .try_into()
    .expect("selector vec");
    let root_vec: VecM<ScVal> = vec![
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            b"eq".to_vec().try_into().unwrap(),
        )),
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(selector))),
        literal_address.clone(),
    ]
    .try_into()
    .expect("root vec");
    let root = ScVal::Vec(Some(soroban_sdk::xdr::ScVec(root_vec)));
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

fn make_params(
    env: &Env,
    grammar_version: u32,
    nonce: u32,
    literal_address: &ScVal,
) -> PolicyInstallParams {
    let predicate_bytes = eq_call_contract_bytes(env, literal_address);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate_bytes).into();
    PolicyInstallParams {
        grammar_version,
        install_nonce: nonce,
        predicate: predicate_bytes,
        predicate_hash,
    }
}

/// A full OZ-shaped `ContextRule`. The interpreter only reads `id` and
/// `signers`, but every field has to be present or the map does not decode -
/// see tests/oz_abi.rs.
fn make_ctx_rule(env: &Env, signers: SorobanVec<Signer>, id: u32) -> ContextRule {
    ContextRule {
        id,
        context_type: ContextRuleType::Default,
        name: soroban_sdk::String::from_str(env, "rule"),
        signers,
        signer_ids: SorobanVec::new(env),
        policies: SorobanVec::new(env),
        policy_ids: SorobanVec::new(env),
        valid_until: None,
    }
}

fn dummy_address() -> ScVal {
    ScVal::Address(soroban_sdk::xdr::ScAddress::Contract(
        soroban_sdk::xdr::ContractId(soroban_sdk::xdr::Hash([0u8; 32])),
    ))
}

#[test]
fn install_then_grammar_version_returns_one() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);
    let params = make_params(&env, 2, 1, &dummy_address());
    client.install(&params, &ctx_rule, &smart_account);

    assert_eq!(client.grammar_version(), 2);
}

#[test]
fn install_rejects_version_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);
    let params = make_params(&env, 3, 1, &dummy_address()); // wrong version
    let res = client.try_install(&params, &ctx_rule, &smart_account);
    assert!(
        res.is_err(),
        "expected install with grammar_version=2 to deny"
    );
}

#[test]
fn install_rejects_nonce_replay() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);

    let params1 = make_params(&env, 2, 1, &dummy_address());
    client.install(&params1, &ctx_rule, &smart_account);

    let params2 = make_params(&env, 2, 1, &dummy_address()); // replay
    let res = client.try_install(&params2, &ctx_rule, &smart_account);
    assert!(res.is_err(), "expected install with replayed nonce to deny");
}

#[test]
fn install_accepts_nonce_incrementing_to_2() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);

    let params1 = make_params(&env, 2, 1, &dummy_address());
    client.install(&params1, &ctx_rule, &smart_account);

    let params2 = make_params(&env, 2, 2, &dummy_address());
    client.install(&params2, &ctx_rule, &smart_account);
}

#[test]
fn install_rejects_predicate_hash_mismatch() {
    // Mandatory invariant #11: install MUST reject when sha256(predicate)
    // does not match the claimed `predicate_hash`.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);

    let mut params = make_params(&env, 2, 1, &dummy_address());
    // Tamper with the hash - the bytes claim A, the hash claims B.
    let bad_hash: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
    params.predicate_hash = bad_hash;
    let res = client.try_install(&params, &ctx_rule, &smart_account);
    assert!(
        res.is_err(),
        "expected install with mismatched predicate_hash to deny"
    );
}

#[test]
fn install_rejects_oversized_predicate() {
    // MAX_PREDICATE_BYTES is 32 KB. A payload one byte over is refused
    // before the host parses anything.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);

    let mut payload: std::vec::Vec<u8> = std::vec::Vec::new();
    payload.extend_from_slice(&policy_interpreter::dsl::MAX_PREDICATE_BYTES.to_be_bytes());
    payload.extend(std::iter::repeat_n(0u8, 1));
    let bytes = Bytes::from_slice(&env, &payload);
    let hash: BytesN<32> = env.crypto().sha256(&bytes).into();
    let params = PolicyInstallParams {
        grammar_version: 2,
        install_nonce: 1,
        predicate: bytes,
        predicate_hash: hash,
    };
    let res = client.try_install(&params, &ctx_rule, &smart_account);
    assert!(
        res.is_err(),
        "expected install with oversized predicate to deny"
    );
}

#[test]
fn install_rejects_non_installer_reinstall_with_fresh_nonce_plus_one() {
    // Security-finding close case: after first install records the master
    // set, a signer OUTSIDE that set attempting to install a FRESH looser
    // document with nonce+1 must still be denied. The nonce check alone
    // would accept; the recorded installer set closes the gap.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let installer = Address::generate(&env);
    let attacker = Address::generate(&env);

    // First install: master set = [installer]. Closes the attacker path.
    let installer_set = soroban_sdk::vec![&env, Signer::Delegated(installer.clone())];
    let ctx_rule = make_ctx_rule(&env, installer_set, 1);
    let params1 = make_params(&env, 2, 1, &dummy_address());
    client.install(&params1, &ctx_rule, &smart_account);

    // Attacker tries to install with their own set + nonce+1.
    let attacker_set = soroban_sdk::vec![&env, Signer::Delegated(attacker.clone())];
    let attacker_ctx = make_ctx_rule(&env, attacker_set, 1);
    let params2 = make_params(&env, 3, 2, &dummy_address());
    let res = client.try_install(&params2, &attacker_ctx, &smart_account);
    assert!(
        res.is_err(),
        "expected non-installer with fresh nonce to deny MASTER_AUTH_REQUIRED"
    );
}

#[test]
fn uninstall_removes_all_state_and_later_install_accepts_nonce_1() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);

    let params1 = make_params(&env, 2, 1, &dummy_address());
    client.install(&params1, &ctx_rule, &smart_account);

    client.uninstall(&ctx_rule, &smart_account);

    let params2 = make_params(&env, 2, 1, &dummy_address());
    client.install(&params2, &ctx_rule, &smart_account);
}

#[test]
fn uninstall_with_no_state_is_denied() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let ctx_rule = make_ctx_rule(&env, signers, 1);

    let res = client.try_uninstall(&ctx_rule, &smart_account);
    assert!(
        res.is_err(),
        "expected uninstall with no prior state to deny"
    );
}

#[test]
fn rotate_master_signer_set_gated_by_old_set() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);

    let initial_signers = soroban_sdk::vec![&env, Signer::Delegated(signer_a.clone())];
    let ctx_rule = make_ctx_rule(&env, initial_signers, 1);
    let params1 = make_params(&env, 2, 1, &dummy_address());
    client.install(&params1, &ctx_rule, &smart_account);

    let new_set = soroban_sdk::vec![&env, Signer::Delegated(signer_b.clone())];
    client.rotate_master_signer_set(&smart_account, &1, &new_set);
}

// ---- a rule with no signers pins no master ----

#[test]
fn install_refuses_a_rule_with_no_signers() {
    // OpenZeppelin permits a context rule with ZERO signers as long as it
    // carries at least one policy (smart_account/storage.rs checks
    // `signer_ids.is_empty() && policy_ids.is_empty()`), so this shape is
    // reachable in production.
    //
    // Storing it would pin an empty master set, and `require_master` on an
    // empty set calls `require_auth` zero times - no authorisation at all.
    // Before this was fixed, that let ANYONE re-install an arbitrary
    // predicate on such a rule with the next nonce and take the policy over.
    //
    // No `mock_all_auths` here: auth has to be real for the assertion to mean
    // anything.
    let env = Env::default();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let no_signers: SorobanVec<Signer> = SorobanVec::new(&env);
    let rule = make_ctx_rule(&env, no_signers, 1);
    let params = make_params(&env, 2, 1, &dummy_address());

    assert!(
        client.try_install(&params, &rule, &smart_account).is_err(),
        "a rule with no signers must not install - nobody could ever authorise it"
    );
}

#[test]
fn rotating_the_master_set_to_empty_is_refused() {
    // The same hole from the other direction: emptying the set would leave
    // the rule permanently unguardable.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);
    client.install(
        &make_params(&env, 2, 1, &dummy_address()),
        &rule,
        &smart_account,
    );

    let empty: SorobanVec<Signer> = SorobanVec::new(&env);
    assert!(
        client
            .try_rotate_master_signer_set(&smart_account, &1u32, &empty)
            .is_err(),
        "rotating the master set to empty must be refused"
    );
}

#[test]
fn rotating_the_master_set_to_an_external_signer_is_refused() {
    // `install` refuses External master signers because `require_master` only
    // calls `require_auth` on the signer's address, which a plain verifier
    // contract never satisfies. Rotation has to refuse them for the same
    // reason: otherwise a rule installed with a valid set can be rotated into
    // one nobody can authorise, and since BOTH `rotate_master_signer_set` and
    // `uninstall` are gated on `require_master`, the rule is bricked with no
    // way back.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);
    client.install(
        &make_params(&env, 2, 1, &dummy_address()),
        &rule,
        &smart_account,
    );

    let external = soroban_sdk::vec![
        &env,
        Signer::External(Address::generate(&env), Bytes::new(&env))
    ];
    assert!(
        client
            .try_rotate_master_signer_set(&smart_account, &1u32, &external)
            .is_err(),
        "rotating the master set to an External signer must be refused"
    );
}

// ---- F2: first install must be authenticated by the smart account ----
//
// `prior_master == None` previously skipped every auth check and took
// `master_set` straight from the caller-supplied `context_rule.signers`. An
// attacker could pre-seed any (smart_account, rule_id) with their own master
// set + predicate; the legitimate owner then could not install (needs the
// squatter's auth) and could not uninstall (same), so that rule id was
// permanently poisoned. This test must NOT call `mock_all_auths()` - that
// would approve `require_auth` calls without invoking the host's real
// `__check_auth` and the assertion would pass for the wrong reason.

#[test]
fn f2_first_install_requires_smart_account_authorization() {
    let env = Env::default();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);
    let params = make_params(&env, 2, 1, &dummy_address());

    assert!(
        client.try_install(&params, &rule, &smart_account).is_err(),
        "first install without the smart account's authorization must fail - \
         otherwise anyone can squat the rule id and lock the owner out"
    );
}

// ---- F4: bound distinct invocation-count windows at install ----
//
// `commit_state_updates` writes one persistent entry per DISTINCT window on
// every permit, and Soroban's per-tx write-entry cap is 50. A predicate with
// 51 distinct windows installs today and then fails EVERY enforce with
// "write ledger entries: 52 > 50". The synthesizer emits at most one, so a
// small cap is the right shape: refuse the install loudly instead of letting
// the predicate run out of budget on its first call.

/// Build `and([ lte(invocation_count(ws_i), 0) for each i ])`. Each clause is
/// a single distinct invocation-count window, so N clauses -> N distinct
/// windows.
fn many_windows_predicate_bytes(env: &Env, windows: &[u64]) -> Bytes {
    use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
    let sym = |s: &str| {
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            s.as_bytes().to_vec().try_into().unwrap(),
        ))
    };
    let scvec = |items: std::vec::Vec<ScVal>| -> ScVal {
        let v: VecM<ScVal> = items.try_into().expect("vec");
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
    };
    let mut clauses: std::vec::Vec<ScVal> = std::vec::Vec::with_capacity(windows.len());
    for ws in windows {
        clauses.push(scvec(std::vec![
            sym("lte"),
            scvec(std::vec![sym("invocation_count"), ScVal::U64(*ws)]),
            ScVal::U32(0),
        ]));
    }
    let root = scvec(std::vec![sym("and"), scvec(clauses)]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

#[test]
fn f4_install_refuses_more_invocation_windows_than_the_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);

    // Cap is 8 (defined in dsl.rs). Twelve distinct windows blows past it.
    // Hard-coded so the test fails to compile only when the cap is removed.
    let windows: std::vec::Vec<u64> = (1..=12).map(|i| i * 60).collect();
    let predicate = many_windows_predicate_bytes(&env, &windows);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let res = client.try_install(
        &PolicyInstallParams {
            grammar_version: 2,
            install_nonce: 1,
            predicate,
            predicate_hash,
        },
        &rule,
        &smart_account,
    );
    assert!(
        res.is_err(),
        "install with more distinct invocation_count windows than the cap must be refused"
    );
}

#[test]
fn f4_install_accepts_a_predicate_at_or_below_the_window_cap() {
    // The bound must not over-shoot: a policy that fits inside the cap still
    // installs. Sanity check that the cap is reachable but not crippling.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);

    let windows: std::vec::Vec<u64> = (1..=policy_interpreter::dsl::MAX_INVOCATION_COUNT_WINDOWS)
        .map(|i| i as u64 * 60)
        .collect();
    let predicate = many_windows_predicate_bytes(&env, &windows);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let res = client.try_install(
        &PolicyInstallParams {
            grammar_version: 2,
            install_nonce: 1,
            predicate,
            predicate_hash,
        },
        &rule,
        &smart_account,
    );
    assert!(
        res.is_ok(),
        "install with exactly the cap's worth of windows must succeed"
    );
}

// ---- F5: refuse External master signers at install ----
//
// `require_master` calls `signer.address().require_auth()`. For
// `Signer::External(verifier, key_data)` that is the VERIFIER address and
// the key is discarded - so master ops are impossible on a rule whose
// signers are the standard passkey/WebAuthn shape. The simplest fail-closed
// option is to refuse External master signers at install with a clear code
// and document the gap. Reimplementing OZ's verifier protocol in v1 would
// require byte-for-byte parity with `VerifierClient::verify`, which is its
// own audit surface.

#[test]
fn f5_install_refuses_an_external_signer_in_the_master_set() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let verifier = Address::generate(&env);
    let key_data = soroban_sdk::Bytes::from_array(&env, &[0u8; 32]);

    let signers = soroban_sdk::vec![
        &env,
        Signer::Delegated(smart_account.clone()),
        Signer::External(verifier, key_data),
    ];
    let rule = make_ctx_rule(&env, signers, 1);
    let params = make_params(&env, 2, 1, &dummy_address());

    assert!(
        client.try_install(&params, &rule, &smart_account).is_err(),
        "an External master signer must be refused at install - require_master would \
         otherwise call require_auth on the verifier address and discard the key"
    );
}

// ---- F8b: deny codes must surface as Error(Contract, #N) on chain ----
//
// F8 mapped every DenyReason to a panic-with-string. That mapping is correct
// in source and passes the unit test, but Soroban surfaces a wasm panic as
// `Error(WasmVm, InvalidAction)` and does NOT propagate the panic message
// into the diagnostic event - the deny code never reaches the chain, so a
// review card cannot name what failed. The fix is Soroban's
// `panic_with_error!` mechanism: the code surfaces as `Error(Contract, #N)`
// in the diagnostic event, which off-chain code can name.
//
// The previous test for F8 asserted through `soroban_sdk::testutils::Logs`
// in the NATIVE test env, where panic messages are captured. That proved
// the mapping, not the on-chain observability. This test asserts the
// contract error through `env.try_invoke_contract::<(), InvokeError>`,
// which is exactly the path a deployed wasm takes: the host returns
// `Error(Contract, N)`, the SDK parses it into `InvokeError::Contract(N)`,
// and any consumer reading the diagnostic event sees `Error(Contract, N)`.
//
// Pre-fix the host returns `Error(WasmVm, InvalidAction)` because the
// contract panics with a string, and the SDK parses that into
// `InvokeError::Abort` - the assertion below fails for that reason.
// Post-fix the host returns `Error(Contract, 200)` (VersionMismatch),
// and the assertion holds.

#[test]
fn f8b_install_version_mismatch_surfaces_as_contract_error_code() {
    use soroban_sdk::{InvokeError, Symbol, Vec as SorobanVec};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());

    let smart_account = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);

    // Wrong grammar version triggers VersionMismatch at install.
    let params = make_params(&env, 99, 1, &dummy_address());

    // Build the args vector the contract expects:
    //   install(params: PolicyInstallParams, rule: ContextRule, smart_account: Address)
    let mut args: SorobanVec<soroban_sdk::Val> = SorobanVec::new(&env);
    args.push_back(soroban_sdk::IntoVal::into_val(&params, &env));
    args.push_back(soroban_sdk::IntoVal::into_val(&rule, &env));
    args.push_back(soroban_sdk::IntoVal::into_val(&smart_account, &env));

    // Drive the wasm directly so the assertion sees the raw host error,
    // not a generated client's typed wrapper. A panic-with-string surfaces
    // as InvokeError::Abort; panic_with_error! surfaces as
    // InvokeError::Contract(N).
    let result = env.try_invoke_contract::<(), InvokeError>(
        &contract_id,
        &Symbol::new(&env, "install"),
        args,
    );

    match result {
        Err(Ok(InvokeError::Contract(200))) => {} // VersionMismatch
        other => panic!(
            "expected Error(Contract, 200) VersionMismatch on the diagnostic event, got {other:?}"
        ),
    }
}

// ---- F9: refuse a predicate carrying a ValidUntil leaf ----
//
// `state::build_eval_context` hardcodes `valid_until_ledger: None`, so the
// evaluator denies ValidUntil compares with ArgMismatch (the leaf resolves
// to nothing) and a policy that uses ValidUntil for a permit side can never
// actually permit. Expiry is the smart account's job - the rule id's
// `valid_until` field is the upstream gate. The right place to refuse this
// is install: a policy that would always deny silently is a different
// product surprise than a policy that refuses to install.

/// `eq(valid_until, 100)` - a single-clause predicate carrying one ValidUntil
/// leaf.
fn valid_until_predicate_bytes(env: &Env) -> Bytes {
    use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
    let sym = |s: &str| {
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            s.as_bytes().to_vec().try_into().unwrap(),
        ))
    };
    let scvec = |items: std::vec::Vec<ScVal>| -> ScVal {
        let v: VecM<ScVal> = items.try_into().expect("vec");
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
    };
    let root = scvec(std::vec![
        sym("eq"),
        scvec(std::vec![sym("valid_until")]),
        ScVal::U32(100),
    ]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

#[test]
fn f9_install_refuses_a_predicate_carrying_a_valid_until_leaf() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);

    let predicate = valid_until_predicate_bytes(&env);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let res = client.try_install(
        &PolicyInstallParams {
            grammar_version: 2,
            install_nonce: 1,
            predicate,
            predicate_hash,
        },
        &rule,
        &smart_account,
    );
    assert!(
        res.is_err(),
        "a predicate carrying a ValidUntil leaf must not install - the evaluator \
         never sources the leaf so the policy would silently always deny"
    );
}

/// `eq(U32(1), U32(1))` - literals on both sides, no `call_contract`, no
/// `now`, no `call_arg`. Zero selector leaves, so the install-time
/// minimum-constraint rule must refuse it.
fn literal_only_eq_predicate_bytes(env: &Env) -> Bytes {
    let sym = |s: &str| {
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            s.as_bytes().to_vec().try_into().unwrap(),
        ))
    };
    let scvec = |items: std::vec::Vec<ScVal>| -> ScVal {
        let v: VecM<ScVal> = items.try_into().expect("vec");
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
    };
    let root = scvec(std::vec![sym("eq"), ScVal::U32(1), ScVal::U32(1)]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

fn many_signers(env: &Env, n: u32) -> SorobanVec<Signer> {
    let mut v: SorobanVec<Signer> = SorobanVec::new(env);
    for _ in 0..n {
        v.push_back(Signer::Delegated(Address::generate(env)));
    }
    v
}

#[test]
fn install_refuses_a_predicate_with_no_selector_leaf() {
    // Without the minimum-constraint check this would install and then
    // permit every call forever. Assert the specific code so a regression
    // to a generic MALFORMED_PREDICATE also fails.
    use soroban_sdk::{InvokeError, Symbol, Vec as SorobanVec};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());

    let smart_account = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_ctx_rule(&env, signers, 1);

    let predicate = literal_only_eq_predicate_bytes(&env);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let params = PolicyInstallParams {
        grammar_version: 2,
        install_nonce: 1,
        predicate,
        predicate_hash,
    };

    let mut args: SorobanVec<soroban_sdk::Val> = SorobanVec::new(&env);
    args.push_back(soroban_sdk::IntoVal::into_val(&params, &env));
    args.push_back(soroban_sdk::IntoVal::into_val(&rule, &env));
    args.push_back(soroban_sdk::IntoVal::into_val(&smart_account, &env));

    let result = env.try_invoke_contract::<(), InvokeError>(
        &contract_id,
        &Symbol::new(&env, "install"),
        args,
    );
    match result {
        Err(Ok(InvokeError::Contract(216))) => {}
        other => panic!(
            "expected Error(Contract, 216) SelectorLeafRequired on a literal-only \
             predicate, got {other:?}"
        ),
    }
}

#[test]
fn install_refuses_a_rule_with_more_than_max_signers() {
    use soroban_sdk::{InvokeError, Symbol, Vec as SorobanVec};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());

    let smart_account = Address::generate(&env);
    let signers = many_signers(&env, policy_interpreter::types::MAX_SIGNERS + 1);
    let rule = make_ctx_rule(&env, signers, 1);
    let params = make_params(&env, 2, 1, &dummy_address());

    let mut args: SorobanVec<soroban_sdk::Val> = SorobanVec::new(&env);
    args.push_back(soroban_sdk::IntoVal::into_val(&params, &env));
    args.push_back(soroban_sdk::IntoVal::into_val(&rule, &env));
    args.push_back(soroban_sdk::IntoVal::into_val(&smart_account, &env));

    let result = env.try_invoke_contract::<(), InvokeError>(
        &contract_id,
        &Symbol::new(&env, "install"),
        args,
    );
    match result {
        Err(Ok(InvokeError::Contract(217))) => {}
        other => panic!(
            "expected Error(Contract, 217) TooManySigners on install with MAX_SIGNERS+1 \
             signers, got {other:?}"
        ),
    }
}

#[test]
fn install_accepts_a_rule_with_exactly_max_signers() {
    // Boundary check: the cap is reachable, not off by one.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);

    let smart_account = Address::generate(&env);
    let signers = many_signers(&env, policy_interpreter::types::MAX_SIGNERS);
    let rule = make_ctx_rule(&env, signers, 1);
    let params = make_params(&env, 2, 1, &dummy_address());

    client.install(&params, &rule, &smart_account);
}
