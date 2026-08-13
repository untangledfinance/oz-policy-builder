//! End-to-end `enforce` tests for the stateful counters.
//!
//! The install/uninstall suite never calls `enforce`, so nothing covered the
//! path from stored counters back into evaluation. These tests drive the real
//! entry point twice and assert the counter written by the first call binds
//! the second.

extern crate alloc;

use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Ledger as _;
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

/// `lte(invocation_count(window_secs), limit)`
fn freq_predicate_bytes(env: &Env, window_secs: u64, limit: u32) -> Bytes {
    let root = scvec(alloc::vec![
        sym("lte"),
        scvec(alloc::vec![
            sym("invocation_count"),
            ScVal::U64(window_secs)
        ]),
        ScVal::U32(limit),
    ]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

fn install_freq_policy(
    env: &Env,
    client: &PolicyInterpreterClient,
    smart_account: &Address,
    rule: &ContextRule,
    window_secs: u64,
    limit: u32,
) {
    let predicate = freq_predicate_bytes(env, window_secs, limit);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let params = PolicyInstallParams {
        grammar_version: 1,
        install_nonce: 1,
        predicate,
        predicate_hash,
        oracle_max_staleness_seconds: None,
        oracle_max_deviation_bps: None,
        oracle_max_xfeed_dev_bps: None,
    };
    client.install(&params, rule, smart_account);
}

fn call_context(env: &Env, target: &Address) -> Context {
    Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args: SorobanVec::new(env),
    })
}

/// A frequency cap of 0 permits the first call (count starts at 0) and MUST
/// deny the second, because the first call commits a count of 1.
#[test]
fn invocation_count_from_storage_binds_the_second_call() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());
    install_freq_policy(&env, &client, &smart_account, &rule, 86400, 0);

    let ctx = call_context(&env, &target);

    // First call: stored count is 0, so 0 <= 0 permits and commits count = 1.
    let first = client.try_enforce(&ctx, &signers, &rule, &smart_account);
    assert!(first.is_ok(), "first call should permit at the limit");

    // Second call: stored count is now 1, so 1 <= 0 must deny.
    let second = client.try_enforce(&ctx, &signers, &rule, &smart_account);
    assert!(
        second.is_err(),
        "second call must deny - the committed invocation count was not read back into evaluation"
    );
}

// ---- TTL self-extend ----
//
// The default test ledger caps entry TTL at 4096, well below the ~30-day
// TTL_BUMP_TO the contract targets on mainnet, so these tests raise
// max_entry_ttl to the Stellar mainnet value (3,110,400 ledgers) first.
const MAINNET_MAX_ENTRY_TTL: u32 = 3_110_400;

fn doc_key(smart_account: &Address) -> (Address, u32, u32) {
    (
        smart_account.clone(),
        1u32,
        policy_interpreter::storage::K_DOC,
    )
}

/// Move the ledger forward until only `remaining` ledgers of TTL are left on
/// the doc entry, which is below TTL_BUMP_THRESHOLD.
fn wind_down_to(env: &Env, contract_id: &Address, smart_account: &Address, remaining: u32) {
    let ttl = env.as_contract(contract_id, || {
        env.storage().persistent().get_ttl(&doc_key(smart_account))
    });
    let advance = ttl - remaining;
    env.ledger().with_mut(|li| li.sequence_number += advance);
}

#[test]
fn allow_path_extends_ttl_of_doc_and_counters() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger()
        .with_mut(|li| li.max_entry_ttl = MAINNET_MAX_ENTRY_TTL);
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());
    install_freq_policy(&env, &client, &smart_account, &rule, 86400, 100);

    wind_down_to(&env, &contract_id, &smart_account, 50);
    let before = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&doc_key(&smart_account))
    });
    assert!(
        before < policy_interpreter::storage::TTL_BUMP_THRESHOLD,
        "precondition: entry must be near expiry, was {before}"
    );

    let ctx = call_context(&env, &target);
    assert!(client
        .try_enforce(&ctx, &signers, &rule, &smart_account)
        .is_ok());

    let after = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&doc_key(&smart_account))
    });
    assert!(
        after >= policy_interpreter::storage::TTL_BUMP_TO,
        "permit must bump the doc TTL to at least TTL_BUMP_TO, got {after}"
    );

    // The invocation-count counter is keyed separately from the doc and must
    // be bumped independently, not left to ride on the doc's TTL.
    let counter_key: (Address, u32, u32, u64) = (
        smart_account.clone(),
        1u32,
        policy_interpreter::storage::K_INVOCATION_COUNT,
        86400u64,
    );
    let counter_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&counter_key)
    });
    assert!(
        counter_ttl >= policy_interpreter::storage::TTL_BUMP_TO,
        "counter TTL must be extended independently of the doc, got {counter_ttl}"
    );
}

// ---- F3: every rule key shares one TTL lifecycle ----
//
// The audit calls out that `extend_state_ttl` only bumps the doc and the
// invocation counters. `enforce` reads `signers_hash` on every call, and
// every master op reads nonce + master_set, so if any of those four rule
// keys archive the rule is bricked - archived persistent entries cannot be
// read as absent and cannot be recreated. They must all share one lifecycle:
// bumped together on the allow path.
//
// The test cannot simulate archival in a unit env (the host never evicts),
// so it proves the fix by asserting the extend actually fires for each of
// the four rule keys.

#[test]
fn f3_allow_path_extends_ttl_of_every_rule_key() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger()
        .with_mut(|li| li.max_entry_ttl = MAINNET_MAX_ENTRY_TTL);
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());
    install_freq_policy(&env, &client, &smart_account, &rule, 86400, 100);

    // doc, nonce, signers_hash, master_set - all written at install with
    // the same TTL. Their tuples are all (Address, u32, u32) so the helper
    // can fetch each via a string label.
    let rule_keys: alloc::vec::Vec<(&str, (Address, u32, u32))> = alloc::vec![
        (
            "doc",
            (
                smart_account.clone(),
                1u32,
                policy_interpreter::storage::K_DOC
            ),
        ),
        (
            "nonce",
            (
                smart_account.clone(),
                1u32,
                policy_interpreter::storage::K_NONCE
            ),
        ),
        (
            "signers_hash",
            (
                smart_account.clone(),
                1u32,
                policy_interpreter::storage::K_SIGNERS_HASH,
            ),
        ),
        (
            "master_set",
            (
                smart_account.clone(),
                1u32,
                policy_interpreter::storage::K_MASTER_SET,
            ),
        ),
    ];

    // Wind every rule key down to near expiry so the bump is observable.
    for (_, k) in &rule_keys {
        let ttl = env.as_contract(&contract_id, || env.storage().persistent().get_ttl(k));
        env.ledger().with_mut(|li| li.sequence_number += ttl - 50);
    }

    let ctx = call_context(&env, &target);
    assert!(client
        .try_enforce(&ctx, &signers, &rule, &smart_account)
        .is_ok());

    for (name, k) in &rule_keys {
        let after = env.as_contract(&contract_id, || env.storage().persistent().get_ttl(k));
        assert!(
            after >= policy_interpreter::storage::TTL_BUMP_TO,
            "{name} TTL must be extended to at least TTL_BUMP_TO, got {after} - \
             a rule key that archives would brick the policy"
        );
    }
}

#[test]
fn denied_enforcement_does_not_extend_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger()
        .with_mut(|li| li.max_entry_ttl = MAINNET_MAX_ENTRY_TTL);
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());
    // Cap of 0: the first call permits and commits count = 1, the second denies.
    install_freq_policy(&env, &client, &smart_account, &rule, 86400, 0);

    let ctx = call_context(&env, &target);
    assert!(client
        .try_enforce(&ctx, &signers, &rule, &smart_account)
        .is_ok());

    wind_down_to(&env, &contract_id, &smart_account, 50);
    let before = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&doc_key(&smart_account))
    });

    // This call denies. The bump runs before the predicate check, so the host
    // frame rollback is the only thing keeping the TTL down.
    assert!(client
        .try_enforce(&ctx, &signers, &rule, &smart_account)
        .is_err());

    let after = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&doc_key(&smart_account))
    });
    assert_eq!(
        before, after,
        "a denied enforcement must leave the TTL untouched (host frame rollback)"
    );
    assert!(
        after < policy_interpreter::storage::TTL_BUMP_THRESHOLD,
        "TTL must still be near expiry after a deny, got {after}"
    );
}

/// `amount` and `window_spent` are not in the grammar: the interpreter cannot
/// source either on chain. They are refused at INSTALL, so a policy carrying
/// one never reaches enforcement.
#[test]
fn predicate_with_unsourceable_leaf_is_refused_at_install() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());

    // lte(window_spent(token, 86400), 1000)
    let token_scval = ScVal::Address(soroban_sdk::xdr::ScAddress::Contract(
        soroban_sdk::xdr::ContractId(soroban_sdk::xdr::Hash([7u8; 32])),
    ));
    let root = scvec(alloc::vec![
        sym("lte"),
        scvec(alloc::vec![
            sym("window_spent"),
            token_scval,
            ScVal::U64(86400)
        ]),
        ScVal::I128(soroban_sdk::xdr::Int128Parts { hi: 0, lo: 1000 }),
    ]);
    let val: soroban_sdk::Val = root.into_val(&env);
    let predicate = val.to_xdr(&env);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let res = client.try_install(
        &PolicyInstallParams {
            grammar_version: 1,
            install_nonce: 1,
            predicate,
            predicate_hash,
            oracle_max_staleness_seconds: None,
            oracle_max_deviation_bps: None,
            oracle_max_xfeed_dev_bps: None,
        },
        &rule,
        &smart_account,
    );
    assert!(
        res.is_err(),
        "a window_spent leaf must not install - it can never be sourced on chain"
    );
}

/// A full OZ-shaped `ContextRule`. The interpreter only reads `id` and
/// `signers`, but every field has to be present or the map does not decode -
/// see tests/oz_abi.rs.
fn make_rule(env: &Env, id: u32, signers: soroban_sdk::Vec<Signer>) -> ContextRule {
    ContextRule {
        id,
        context_type: ContextRuleType::Default,
        name: soroban_sdk::String::from_str(env, "rule"),
        signers,
        signer_ids: soroban_sdk::Vec::new(env),
        policies: soroban_sdk::Vec::new(env),
        policy_ids: soroban_sdk::Vec::new(env),
        valid_until: None,
    }
}

/// A window referenced twice must still count each call ONCE.
///
/// `collect_invocation_count_leaves` walks the predicate and pushes an entry
/// per matching leaf. Without dedup, a predicate mentioning the same window
/// in two clauses increments that counter twice per call, so a "3 calls per
/// day" cap silently becomes 1. Fail-closed, but wrong.
#[test]
fn a_window_referenced_twice_counts_each_call_once() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);

    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());

    // and([ lte(invocation_count(86400), 2), lte(invocation_count(86400), 2) ])
    let clause = scvec(alloc::vec![
        sym("lte"),
        scvec(alloc::vec![sym("invocation_count"), ScVal::U64(86400)]),
        ScVal::U32(2),
    ]);
    let root = scvec(alloc::vec![
        sym("and"),
        scvec(alloc::vec![clause.clone(), clause]),
    ]);
    let val: soroban_sdk::Val = root.into_val(&env);
    let predicate = val.to_xdr(&env);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    client.install(
        &PolicyInstallParams {
            grammar_version: 1,
            install_nonce: 1,
            predicate,
            predicate_hash,
            oracle_max_staleness_seconds: None,
            oracle_max_deviation_bps: None,
            oracle_max_xfeed_dev_bps: None,
        },
        &rule,
        &smart_account,
    );

    let ctx = call_context(&env, &target);
    // Cap is 2, so calls at counts 0, 1 and 2 all permit - three calls.
    for i in 0..3 {
        assert!(
            client
                .try_enforce(&ctx, &signers, &rule, &smart_account)
                .is_ok(),
            "call {i} must permit - the cap is 2 and each call counts once"
        );
    }
    // The fourth sees count 3 > 2.
    assert!(
        client
            .try_enforce(&ctx, &signers, &rule, &smart_account)
            .is_err(),
        "the fourth call must deny"
    );
}

/// `enforce` must be callable only by the smart account it guards.
///
/// It mutates state - it increments the invocation counter on every permit.
/// If any caller can invoke it, anyone can burn a rate limit: call it N times
/// with a permitting context and the legitimate agent is locked out for the
/// window. OpenZeppelin's own audited spending-limit policy opens `enforce`
/// with `smart_account.require_auth()` for exactly this reason
/// (accounts/src/policies/spending_limit.rs).
///
/// No `mock_all_auths` - auth has to be real for this to mean anything.
#[test]
fn enforce_requires_the_smart_accounts_authorization() {
    let env = Env::default();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());

    // Install needs the master's auth; mock only for that step.
    env.mock_all_auths();
    install_freq_policy(&env, &client, &smart_account, &rule, 86400, 100);
    env.set_auths(&[]);

    // Now an unauthorized third party tries to drive enforce.
    let ctx = call_context(&env, &target);
    assert!(
        client
            .try_enforce(&ctx, &signers, &rule, &smart_account)
            .is_err(),
        "enforce must not run without the smart account's authorization - \
         otherwise anyone can burn the rate limit"
    );
}

/// The window in `invocation_count_in_window` must actually be a window.
///
/// The counter is keyed by `window_secs` but stored as a bare running total
/// with no start time, so nothing ever resets it. A "1 call per day" cap
/// therefore means "1 call EVER" and the agent is locked out permanently
/// once it is reached - which is not the policy the user was shown.
#[test]
fn an_invocation_window_resets_once_it_has_elapsed() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 3_110_400;
        li.timestamp = 1_000_000;
    });
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());

    // `lte(count, 0)` permits only while the counter reads 0, i.e. exactly
    // one call per window.
    install_freq_policy(&env, &client, &smart_account, &rule, 86400, 0);
    let ctx = call_context(&env, &target);

    assert!(
        client
            .try_enforce(&ctx, &signers, &rule, &smart_account)
            .is_ok(),
        "first call in the window must permit"
    );
    assert!(
        client
            .try_enforce(&ctx, &signers, &rule, &smart_account)
            .is_err(),
        "second call in the SAME window must deny"
    );

    // Move well past the window.
    env.ledger()
        .with_mut(|li| li.timestamp = 1_000_000 + 86_401);
    assert!(
        client
            .try_enforce(&ctx, &signers, &rule, &smart_account)
            .is_ok(),
        "a call in a NEW window must permit - the window has to reset"
    );
}

/// Rotating the master set must not brick the rule.
///
/// `enforce` compares sha256(context_rule.signers) against the hash stored at
/// install, to detect the rule's signers changing behind the policy's back.
/// Rotation is the AUTHORISED way to change them, so it has to update that
/// stored hash too - otherwise every later enforce denies with
/// RULE_SIGNERS_CHANGED and the policy is permanently unusable.
#[test]
fn rotating_the_master_set_does_not_brick_enforce() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);

    let old_signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let old_rule = make_rule(&env, 1, old_signers.clone());
    install_freq_policy(&env, &client, &smart_account, &old_rule, 86400, 100);

    // Rotate to a new master set, the way the account signals a key change.
    let new_signer = Address::generate(&env);
    let new_signers = soroban_sdk::vec![&env, Signer::Delegated(new_signer)];
    client.rotate_master_signer_set(&smart_account, &1u32, &new_signers);

    // The account now presents the rotated rule.
    let new_rule = make_rule(&env, 1, new_signers.clone());
    let ctx = call_context(&env, &target);
    assert!(
        client
            .try_enforce(&ctx, &new_signers, &new_rule, &smart_account)
            .is_ok(),
        "enforce must still work after an authorised rotation"
    );
}

// ---- F8: deny reasons reach the panic message ----
//
// `enforce` was throwing `panic_predicate_false` for every Deny, so a
// review card could never say "not on the allowlist" or "oracle stale" - it
// always said "predicate false", an argument mismatch. The fix maps each
// `DenyReason` to its specific code (defined in `DenyReason::code` and
// mirrored in the existing `deny()` table for storage). Pre-fix the panic
// says PREDICATE_FALSE; post-fix it says the specific code.
//
// The host returns the panic as an `Error(WasmVm, InvalidAction)`; the
// actual contract panic message lands in the diagnostic event log as
// "caught panic 'DENY:<CODE>' from contract function 'Symbol(enforce)'".
// `Logs::all()` returns those diagnostic strings, so we can assert on the
// CODE in the log.

/// A predicate that will deny ArgMismatch at enforce: `eq(call_arg(0), 7)`
/// where the call has no args, so the call_arg resolves to None and the eq
/// falls through to ArgMismatch.
fn call_arg_arg_mismatch_bytes(env: &Env) -> Bytes {
    let root = scvec(alloc::vec![
        sym("eq"),
        scvec(alloc::vec![sym("call_arg"), ScVal::U32(0)]),
        ScVal::U32(7),
    ]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

#[test]
fn f8_enforce_deny_reaches_chain_as_contract_error_code() {
    // The previous F8 test asserted through `soroban_sdk::testutils::Logs`
    // in the NATIVE test env, where panic messages are captured. That
    // proved the mapping, not the on-chain observability - Soroban
    // surfaces a panic-with-string as `Error(WasmVm, InvalidAction)`
    // and does NOT propagate the message into the diagnostic event, so
    // the deny code never reached the chain. The fix is
    // `panic_with_error!` - the code surfaces as `Error(Contract, #N)`
    // in the diagnostic event. This test asserts the on-chain path:
    // `env.try_invoke_contract::<(), InvokeError>` parses the host
    // error into `InvokeError::Contract(N)`. Pre-fix it would be
    // `InvokeError::Abort`; post-fix it is `InvokeError::Contract(100)`.
    use soroban_sdk::{IntoVal, InvokeError, Symbol, Vec as SorobanVec};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];
    let rule = make_rule(&env, 1, signers.clone());

    let predicate = call_arg_arg_mismatch_bytes(&env);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    client.install(
        &PolicyInstallParams {
            grammar_version: 1,
            install_nonce: 1,
            predicate,
            predicate_hash,
            oracle_max_staleness_seconds: None,
            oracle_max_deviation_bps: None,
            oracle_max_xfeed_dev_bps: None,
        },
        &rule,
        &smart_account,
    );

    // Drive `enforce` directly through the wasm so the assertion sees
    // the raw host error rather than the generated client's typed
    // wrapper. The arg list matches `enforce(context, signers, rule,
    // smart_account)`.
    let ctx = call_context(&env, &target);
    let mut args: SorobanVec<soroban_sdk::Val> = SorobanVec::new(&env);
    args.push_back(ctx.into_val(&env));
    args.push_back(signers.into_val(&env));
    args.push_back(rule.into_val(&env));
    args.push_back(smart_account.into_val(&env));
    let result = env.try_invoke_contract::<(), InvokeError>(
        &contract_id,
        &Symbol::new(&env, "enforce"),
        args,
    );

    match result {
        Err(Ok(InvokeError::Contract(100))) => {} // ArgMismatch
        other => panic!(
            "expected Error(Contract, 100) ArgMismatch on the diagnostic event, got {other:?}"
        ),
    }
}
