//! Reflector resolution tests against a mock Pulse feed.
//!
//! The mock is registered AT the pinned mainnet feed address so the contract
//! under test reaches it through the same const it would use on chain - the
//! address is not injectable, and pretending otherwise would test a path the
//! deployed contract never takes.
//!
//! What these do NOT cover: the real deployed Pulse instance. That needs RPC
//! against mainnet and belongs in an integration check, not this suite. The
//! record shapes here are taken from a live mainnet probe (14 decimals, 300s resolution, newest-first, and a
//! `prices(asset, 2)` that returned THREE records).

extern crate alloc;

use policy_interpreter::dsl::{DenyReason, Leaf, Node, OracleEntry};
use policy_interpreter::oracle::{
    self, Bounds, PriceData, PINNED_DECIMALS, PINNED_RESOLUTION, PULSE_DEX_FEED,
    PULSE_DEX_FEED_SECONDARY,
};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, Address, Env, String as SorobanString, Vec};

// ---- mock Pulse feed ----

#[contract]
pub struct MockPulse;

/// Records the mock returns, plus the fingerprint values, are read from
/// instance storage so each test can shape them.
#[contractimpl]
impl MockPulse {
    /// Seeded as parallel primitive vectors: a `Vec` of a user-defined type
    /// is not a supported contract-function parameter.
    pub fn seed(e: &Env, prices: Vec<i128>, timestamps: Vec<u64>, decimals: u32, resolution: u32) {
        e.storage().instance().set(&1u32, &prices);
        e.storage().instance().set(&4u32, &timestamps);
        e.storage().instance().set(&2u32, &decimals);
        e.storage().instance().set(&3u32, &resolution);
    }

    /// Set the mocked base asset; tests exercising a fingerprint drift pass
    /// a different one than the pin.
    ///
    /// Stores an `Asset`, matching what `base()` returns. Storing a bare
    /// `Address` here would not round-trip through the enum-typed getter,
    /// and the drift test would silently read the default instead of the
    /// value it set.
    pub fn seed_base(e: &Env, base: oracle::Asset) {
        e.storage().instance().set(&5u32, &base);
    }

    #[allow(unused_variables)]
    pub fn prices(e: &Env, asset: oracle::Asset, records: u32) -> Option<Vec<PriceData>> {
        let prices: Vec<i128> = e.storage().instance().get(&1u32)?;
        let timestamps: Vec<u64> = e.storage().instance().get(&4u32)?;
        let mut out: Vec<PriceData> = Vec::new(e);
        for i in 0..prices.len() {
            out.push_back(PriceData {
                price: prices.get(i).unwrap_or(0),
                timestamp: timestamps.get(i).unwrap_or(0),
            });
        }
        Some(out)
    }

    pub fn decimals(e: &Env) -> u32 {
        e.storage().instance().get(&2u32).unwrap_or(PINNED_DECIMALS)
    }

    pub fn resolution(e: &Env) -> u32 {
        e.storage()
            .instance()
            .get(&3u32)
            .unwrap_or(PINNED_RESOLUTION)
    }

    /// Returns the `Asset` ENUM, matching the live Reflector feed. This
    /// previously returned a bare `Address` - the same shape the resolver
    /// wrongly expected - so the base fingerprint agreed with the
    /// implementation's assumption instead of with the real contract, and
    /// every test passed while a real read would have trapped.
    pub fn base(e: &Env) -> oracle::Asset {
        match e.storage().instance().get::<_, oracle::Asset>(&5u32) {
            Some(a) => a,
            None => oracle::Asset::Stellar(Address::from_string(&SorobanString::from_str(
                e,
                oracle::PINNED_BASE,
            ))),
        }
    }
}

// ---- harness ----

struct Harness {
    env: Env,
    asset: Address,
    account: Address,
    /// Frame the resolver runs in. On chain that is the interpreter itself,
    /// so storage reads (the pause flag) resolve against its own state.
    interpreter: Address,
}

fn setup(records: &[(i128, u64)], decimals: u32, resolution: u32, now: u64) -> Harness {
    // The cross-feed check is mandatory, so the harness needs both feeds
    // registered. Mirroring the primary's records onto the secondary is
    // the cheapest way to keep the existing single-feed tests passing:
    // when both feeds agree exactly, the cross-feed deviation is zero and
    // the bound trivially permits. Tests that exercise a divergence shape
    // use `setup_pair` to give the two feeds different data.
    let secondary_addr = PULSE_DEX_FEED_SECONDARY
        .expect("cross-feed tests require PULSE_FEED_ADDRESS_2 at compile time");
    setup_pair(
        records,
        decimals,
        resolution,
        records,
        decimals,
        resolution,
        now,
        secondary_addr,
    )
}

/// Setup with INDEPENDENT data on the primary and secondary feeds. Each
/// feed is registered at its own address and seeded with its own
/// records/decimals/resolution so a test can drive any divergence shape.
#[allow(clippy::too_many_arguments)]
fn setup_pair(
    primary: &[(i128, u64)],
    p_decimals: u32,
    p_resolution: u32,
    secondary: &[(i128, u64)],
    s_decimals: u32,
    s_resolution: u32,
    now: u64,
    secondary_addr: &str,
) -> Harness {
    let env = Env::default();
    env.mock_all_auths();
    let primary_addr = Address::from_string(&SorobanString::from_str(&env, PULSE_DEX_FEED));
    let secondary_addr = Address::from_string(&SorobanString::from_str(&env, secondary_addr));
    env.register_at(&primary_addr, MockPulse, ());
    env.register_at(&secondary_addr, MockPulse, ());

    let mut p_prices: Vec<i128> = Vec::new(&env);
    let mut p_ts: Vec<u64> = Vec::new(&env);
    for (price, ts) in primary {
        p_prices.push_back(*price);
        p_ts.push_back(*ts);
    }
    let mut s_prices: Vec<i128> = Vec::new(&env);
    let mut s_ts: Vec<u64> = Vec::new(&env);
    for (price, ts) in secondary {
        s_prices.push_back(*price);
        s_ts.push_back(*ts);
    }
    let p_client = MockPulseClient::new(&env, &primary_addr);
    p_client.seed(&p_prices, &p_ts, &p_decimals, &p_resolution);
    let s_client = MockPulseClient::new(&env, &secondary_addr);
    s_client.seed(&s_prices, &s_ts, &s_decimals, &s_resolution);

    let interpreter = env.register(policy_interpreter::PolicyInterpreter, ());
    env.ledger().with_mut(|li| li.timestamp = now);

    let asset = Address::generate(&env);
    let account = Address::generate(&env);
    Harness {
        env,
        asset,
        account,
        interpreter,
    }
}

/// A predicate carrying one oracle leaf for `asset`.
fn oracle_predicate(asset: &Address) -> Node {
    Node::Compare {
        op: policy_interpreter::dsl::CompareOp::Lt,
        left: Leaf::OraclePrice(asset.clone()),
        // Thresholds declare their decimal basis. These cases exercise
        // resolution, not scale, so they state the normalised basis the
        // resolver already produces.
        right: Leaf::OracleThresholdI128 {
            value: i128::MAX,
            decimals: 9,
        },
    }
}

fn resolve(h: &Harness) -> OracleEntry {
    let snapshot = h.env.as_contract(&h.interpreter, || {
        oracle::resolve_snapshot(
            &h.env,
            &oracle_predicate(&h.asset),
            &h.account,
            Bounds::default(),
        )
    });
    assert_eq!(snapshot.len(), 1, "one asset in, one entry out");
    snapshot[0].1.clone()
}

fn failed_with(entry: OracleEntry) -> Option<DenyReason> {
    match entry {
        OracleEntry::Failed(r) => Some(r),
        OracleEntry::Price { .. } => None,
    }
}

// The live-probed shape: three records, newest first, 300s apart, 14 dp.
const LIVE: [(i128, u64); 3] = [
    (17_718_407_521_607, 1_784_920_800),
    (17_720_866_269_595, 1_784_920_500),
    (17_723_828_493_925, 1_784_920_200),
];

#[test]
fn live_shaped_response_resolves_and_normalises() {
    // Three records for a requested two - the registry recorded exactly this,
    // so length must not be trusted.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    match resolve(&h) {
        OracleEntry::Price {
            price,
            timestamp_seconds,
        } => {
            assert_eq!(
                timestamp_seconds, 1_784_920_800,
                "must use the NEWEST record"
            );
            // 14 dp normalised to 9 dp divides by 10^5.
            assert_eq!(price, 17_718_407_521_607i128 / 100_000);
        }
        other => panic!("expected a resolved price, got {other:?}"),
    }
}

#[test]
fn stale_beyond_the_bound_fails() {
    // Newest record is 900s old against a 600s bound.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_921_700);
    assert_eq!(failed_with(resolve(&h)), Some(DenyReason::OracleStale));
}

#[test]
fn fewer_than_two_records_is_no_confirmation_not_passes() {
    let h = setup(
        &LIVE[..1],
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
    );
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleNoConfirmation)
    );
}

// ---- F6: future-dated records must deny ----
//
// `now.saturating_sub(newest.timestamp)` yields 0 when the newest record is
// in the future, so the staleness gate passed unconditionally and a malicious
// or buggy feed could feed any forward-dated price through. Today's Reflector
// rejects future timestamps upstream, but the feed is a third-party
// upgradeable contract and every other failure in this file is fail-closed.
// No tolerance: Stellar's ledger timestamp is monotonic per network, so a
// "real" future-dated record from a trusted feed is impossible.

#[test]
fn f6_a_future_dated_newest_record_is_stale_not_fresh() {
    // Same 300s-spaced pair as the live probe, but both timestamps are AFTER
    // the ledger clock. Pre-fix the resolver would return Price; post-fix it
    // denies.
    let future = [
        (17_718_407_521_607i128, 1_784_920_800u64),
        (17_720_866_269_595, 1_784_920_500),
    ];
    let h = setup(&future, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_000);
    assert_eq!(failed_with(resolve(&h)), Some(DenyReason::OracleStale));
}

#[test]
fn f6_a_future_dated_newest_record_denies_at_enforce() {
    // End-to-end: install a policy, then move the clock so the same future
    // record fails enforce rather than just the unit resolver.
    let future = [
        (17_718_407_521_607i128, 1_784_920_800u64),
        (17_720_866_269_595, 1_784_920_500),
    ];
    let h = setup(&future, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_000);
    let target = install_with_bounds(&h, None, None).expect("installs with default bounds");
    assert!(
        !enforce_against(&h, &target),
        "enforce must deny when the only price is future-dated"
    );
}

#[test]
fn no_records_is_missing() {
    let h = setup(&[], PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert_eq!(failed_with(resolve(&h)), Some(DenyReason::OracleMissing));
}

#[test]
fn duplicate_timestamps_do_not_confirm() {
    // Two reads of the SAME bucket is not a two-round confirmation.
    let dup = [
        (17_718_407_521_607i128, 1_784_920_800u64),
        (17_718_407_521_607, 1_784_920_800),
    ];
    let h = setup(&dup, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleNoConfirmation)
    );
}

#[test]
fn gapped_records_do_not_confirm() {
    // 600s apart against a 300s resolution - a bucket is missing.
    let gapped = [
        (17_718_407_521_607i128, 1_784_920_800u64),
        (17_723_828_493_925, 1_784_920_200),
    ];
    let h = setup(&gapped, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleNoConfirmation)
    );
}

#[test]
fn non_positive_price_is_malformed_history() {
    let bad = [
        (0i128, 1_784_920_800u64),
        (17_720_866_269_595, 1_784_920_500),
    ];
    let h = setup(&bad, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleMalformedHistory)
    );
}

#[test]
fn deviation_beyond_the_bound_fails() {
    // 10% swing against a 2% (200 bps) default bound.
    let jumpy = [
        (11_000_000_000_000i128, 1_784_920_800u64),
        (10_000_000_000_000, 1_784_920_500),
    ];
    let h = setup(&jumpy, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleDeviationExceeded)
    );
}

#[test]
fn deviation_just_inside_the_bound_passes() {
    // Exactly 2% - the bound is inclusive.
    let edge = [
        (10_200_000_000_000i128, 1_784_920_800u64),
        (10_000_000_000_000, 1_784_920_500),
    ];
    let h = setup(&edge, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert!(matches!(resolve(&h), OracleEntry::Price { .. }));
}

#[test]
fn decimals_drift_fails_the_fingerprint() {
    let h = setup(&LIVE, 7, PINNED_RESOLUTION, 1_784_920_900);
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleFingerprintDrift)
    );
}

#[test]
fn resolution_drift_fails_the_fingerprint() {
    let h = setup(&LIVE, PINNED_DECIMALS, 60, 1_784_920_900);
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleFingerprintDrift)
    );
}

// ---- F7: feed fingerprint includes the base asset ----
//
// `decimals` and `resolution` alone let an upgraded feed keep the same
// numeric shape while switching its base (the asset the price is quoted
// against). Bounds then compare against the wrong basis silently. Reflector
// Pulse exposes `base()` returning the base asset address; pin it.

#[test]
fn f7_a_non_stellar_base_variant_fails_the_fingerprint() {
    // A feed quoting against an off-chain unit reports `Other(Symbol)` - the
    // shape Reflector's CEX aggregate uses for USD. It is a different basis
    // from the address we pinned, so it must FAIL the fingerprint rather than
    // be coerced into one. The old code decoded `base()` as a bare `Address`
    // and could not represent this case at all.
    let env = Env::default();
    env.mock_all_auths();
    let feed = Address::from_string(&SorobanString::from_str(&env, PULSE_DEX_FEED));
    env.register_at(&feed, MockPulse, ());
    let interpreter = env.register(policy_interpreter::PolicyInterpreter, ());

    let mut prices: Vec<i128> = Vec::new(&env);
    let mut timestamps: Vec<u64> = Vec::new(&env);
    for (price, ts) in LIVE.iter() {
        prices.push_back(*price);
        timestamps.push_back(*ts);
    }
    let client = MockPulseClient::new(&env, &feed);
    client.seed(&prices, &timestamps, &PINNED_DECIMALS, &PINNED_RESOLUTION);
    client.seed_base(&oracle::Asset::Other(soroban_sdk::Symbol::new(&env, "USD")));
    env.ledger().with_mut(|li| li.timestamp = 1_784_920_900);

    let harness = Harness {
        env: env.clone(),
        asset: Address::generate(&env),
        account: Address::generate(&env),
        interpreter,
    };
    assert_eq!(
        failed_with(resolve(&harness)),
        Some(DenyReason::OracleFingerprintDrift)
    );
}

#[test]
fn f7_base_drift_fails_the_fingerprint() {
    // Override the default base with a different address.
    let env = Env::default();
    env.mock_all_auths();
    let feed = Address::from_string(&SorobanString::from_str(&env, PULSE_DEX_FEED));
    env.register_at(&feed, MockPulse, ());
    let interpreter = env.register(policy_interpreter::PolicyInterpreter, ());

    let mut prices: Vec<i128> = Vec::new(&env);
    let mut timestamps: Vec<u64> = Vec::new(&env);
    for (price, ts) in LIVE.iter() {
        prices.push_back(*price);
        timestamps.push_back(*ts);
    }
    let client = MockPulseClient::new(&env, &feed);
    client.seed(&prices, &timestamps, &PINNED_DECIMALS, &PINNED_RESOLUTION);
    // Drift the base to a different address; decimals and resolution are
    // still pinned.
    client.seed_base(&oracle::Asset::Stellar(Address::generate(&env)));
    env.ledger().with_mut(|li| li.timestamp = 1_784_920_900);

    let harness = Harness {
        env: env.clone(),
        asset: Address::generate(&env),
        account: Address::generate(&env),
        interpreter,
    };
    assert_eq!(
        failed_with(resolve(&harness)),
        Some(DenyReason::OracleFingerprintDrift)
    );
}

#[test]
fn pausing_an_asset_denies_it() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    // The pause flag lives in the interpreter's own storage, so it is written
    // and read in the same frame the resolver runs in.
    h.env.as_contract(&h.interpreter, || {
        h.env
            .storage()
            .persistent()
            .set(&oracle::pause_key(&h.account, &h.asset), &true);
    });
    assert_eq!(failed_with(resolve(&h)), Some(DenyReason::OraclePaused));
}

#[test]
fn pausing_all_assets_denies_an_unpaused_asset_too() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    h.env.as_contract(&h.interpreter, || {
        h.env
            .storage()
            .persistent()
            .set(&oracle::pause_all_key(&h.account), &true);
    });
    assert_eq!(failed_with(resolve(&h)), Some(DenyReason::OraclePaused));
}

#[test]
fn a_pause_on_another_account_does_not_leak() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    let other = Address::generate(&h.env);
    h.env.as_contract(&h.interpreter, || {
        h.env
            .storage()
            .persistent()
            .set(&oracle::pause_key(&other, &h.asset), &true);
    });
    assert!(matches!(resolve(&h), OracleEntry::Price { .. }));
}

#[test]
fn predicate_without_oracle_leaves_costs_no_reads() {
    // No oracle leaf -> empty snapshot, and crucially no call to the feed at
    // all, so a non-oracle policy never pays for the oracle path.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    let n = Node::Compare {
        op: policy_interpreter::dsl::CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(h.asset.clone()),
    };
    let snapshot = h.env.as_contract(&h.interpreter, || {
        oracle::resolve_snapshot(&h.env, &n, &h.account, Bounds::default())
    });
    assert!(snapshot.is_empty());
}

// ---- end to end through `enforce` ----
//
// The unit tests above exercise the resolver and the evaluator separately.
// These drive the real entry point so the resolve -> evaluate -> permit/deny
// chain is proven, not inferred.

use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreterClient, Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
use soroban_sdk::{BytesN, IntoVal, Symbol, TryFromVal};

fn sym_scval(s: &str) -> ScVal {
    ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
        s.as_bytes().to_vec().try_into().unwrap(),
    ))
}

fn scvec(items: alloc::vec::Vec<ScVal>) -> ScVal {
    let v: VecM<ScVal> = items.try_into().expect("vec");
    ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
}

/// `oracle_threshold(value, decimals)` - the declared-basis RHS of an oracle
/// compare. These cases exercise resolution rather than scale, so they state
/// the normalised 9-dp basis the resolver already produces.
fn oracle_threshold_scval(value: i128, decimals: u32) -> ScVal {
    scvec(alloc::vec![
        sym_scval("oracle_threshold"),
        i128_scval(value),
        ScVal::U32(decimals),
    ])
}

fn i128_scval(v: i128) -> ScVal {
    ScVal::I128(soroban_sdk::xdr::Int128Parts {
        hi: (v >> 64) as i64,
        lo: (v & 0xFFFF_FFFF_FFFF_FFFFu128 as i128) as u64,
    })
}

/// `and([eq(call_contract, target), lt(oracle_price(asset), bound)])`
/// The non-oracle clause is the envelope install requires.
fn oracle_policy_bytes(
    env: &Env,
    target: &Address,
    asset: &Address,
    bound: i128,
) -> soroban_sdk::Bytes {
    let target_scval = ScVal::try_from_val(env, &target.to_val()).unwrap();
    let asset_scval = ScVal::try_from_val(env, &asset.to_val()).unwrap();
    let root = scvec(alloc::vec![
        sym_scval("and"),
        scvec(alloc::vec![
            scvec(alloc::vec![
                sym_scval("eq"),
                scvec(alloc::vec![sym_scval("call_contract")]),
                target_scval,
            ]),
            scvec(alloc::vec![
                sym_scval("lt"),
                scvec(alloc::vec![sym_scval("oracle_price"), asset_scval]),
                oracle_threshold_scval(bound, 9),
            ]),
        ]),
    ]);
    let val: soroban_sdk::Val = root.into_val(env);
    val.to_xdr(env)
}

struct E2e {
    h: Harness,
    rule: ContextRule,
    signers: Vec<Signer>,
    target: Address,
}

impl E2e {
    fn client(&self) -> PolicyInterpreterClient<'_> {
        PolicyInterpreterClient::new(&self.h.env, &self.h.interpreter)
    }
}

fn install_oracle_policy(records: &[(i128, u64)], now: u64, bound: i128) -> E2e {
    let h = setup(records, PINNED_DECIMALS, PINNED_RESOLUTION, now);
    let client = PolicyInterpreterClient::new(&h.env, &h.interpreter);
    let target = Address::generate(&h.env);
    let signers = soroban_sdk::vec![&h.env, Signer::Delegated(h.account.clone())];
    let rule = make_rule(&h.env, 1, signers.clone());
    let predicate = oracle_policy_bytes(&h.env, &target, &h.asset, bound);
    let predicate_hash: BytesN<32> = h.env.crypto().sha256(&predicate).into();
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
        &h.account,
    );
    drop(client);
    E2e {
        h,
        rule,
        signers,
        target,
    }
}

fn try_enforce(e: &E2e) -> bool {
    let ctx = Context::Contract(ContractContext {
        contract: e.target.clone(),
        fn_name: Symbol::new(&e.h.env, "swap"),
        args: Vec::new(&e.h.env),
    });
    e.client()
        .try_enforce(&ctx, &e.signers, &e.rule, &e.h.account)
        .is_ok()
}

#[test]
fn enforce_permits_when_the_oracle_price_is_under_the_bound() {
    // Normalised price is 17_718_407_521_607 / 10^5 = 177_184_075.
    let e = install_oracle_policy(&LIVE, 1_784_920_900, 200_000_000);
    assert!(try_enforce(&e), "price under the bound must permit");
}

#[test]
fn enforce_denies_when_the_oracle_price_is_over_the_bound() {
    let e = install_oracle_policy(&LIVE, 1_784_920_900, 100_000_000);
    assert!(!try_enforce(&e), "price over the bound must deny");
}

#[test]
fn enforce_denies_when_the_feed_is_stale() {
    // Same policy that permits above, but the clock has moved past the bound.
    let e = install_oracle_policy(&LIVE, 1_784_921_700, 200_000_000);
    assert!(
        !try_enforce(&e),
        "a stale feed must deny even though the price would satisfy the bound"
    );
}

#[test]
fn enforce_denies_while_paused() {
    let e = install_oracle_policy(&LIVE, 1_784_920_900, 200_000_000);
    assert!(try_enforce(&e), "sanity: permits before the pause");
    e.client()
        .pause_oracle_policies(&e.rule, &e.h.account, &e.h.asset);
    assert!(!try_enforce(&e), "must deny once the asset is paused");
}

#[test]
fn install_refuses_an_oracle_leaf_under_not() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    let client = PolicyInterpreterClient::new(&h.env, &h.interpreter);
    let signers = soroban_sdk::vec![&h.env, Signer::Delegated(h.account.clone())];
    let rule = make_rule(&h.env, 1, signers);
    let asset_scval = ScVal::try_from_val(&h.env, &h.asset.to_val()).unwrap();
    let root = scvec(alloc::vec![
        sym_scval("not"),
        scvec(alloc::vec![
            sym_scval("lt"),
            scvec(alloc::vec![sym_scval("oracle_price"), asset_scval]),
            oracle_threshold_scval(100, 9),
        ]),
    ]);
    let val: soroban_sdk::Val = root.into_val(&h.env);
    let predicate = val.to_xdr(&h.env);
    let predicate_hash: BytesN<32> = h.env.crypto().sha256(&predicate).into();
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
        &h.account,
    );
    assert!(res.is_err(), "an oracle leaf under `not` must not install");
}

#[test]
fn install_refuses_an_oracle_threshold_with_no_declared_basis() {
    // The fail-open case, refused on a REAL install rather than only in the
    // validator. Prices normalise to 9 dp; a bare literal states no basis, so
    // a raw 14-dp threshold would read ~10^5 too large and permit everything
    // the policy was written to deny. Refuse it once, loudly, at install.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    let client = PolicyInterpreterClient::new(&h.env, &h.interpreter);
    let signers = soroban_sdk::vec![&h.env, Signer::Delegated(h.account.clone())];
    let rule = make_rule(&h.env, 1, signers);
    let target_scval = ScVal::try_from_val(&h.env, &h.interpreter.to_val()).unwrap();
    let asset_scval = ScVal::try_from_val(&h.env, &h.asset.to_val()).unwrap();
    let root = scvec(alloc::vec![
        sym_scval("and"),
        scvec(alloc::vec![
            scvec(alloc::vec![
                sym_scval("eq"),
                scvec(alloc::vec![sym_scval("call_contract")]),
                target_scval,
            ]),
            scvec(alloc::vec![
                sym_scval("lt"),
                scvec(alloc::vec![sym_scval("oracle_price"), asset_scval]),
                i128_scval(100),
            ]),
        ]),
    ]);
    let val: soroban_sdk::Val = root.into_val(&h.env);
    let predicate = val.to_xdr(&h.env);
    let predicate_hash: BytesN<32> = h.env.crypto().sha256(&predicate).into();
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
        &h.account,
    );
    assert!(
        res.is_err(),
        "an oracle threshold with no declared decimal basis must not install"
    );
}

// ---- per-policy oracle bounds (tighten-only) ----

fn install_with_bounds(
    h: &Harness,
    staleness: Option<u32>,
    deviation: Option<u32>,
) -> Result<Address, ()> {
    let client = PolicyInterpreterClient::new(&h.env, &h.interpreter);
    let target = Address::generate(&h.env);
    let signers = soroban_sdk::vec![&h.env, Signer::Delegated(h.account.clone())];
    let rule = make_rule(&h.env, 1, signers);
    let predicate = oracle_policy_bytes(&h.env, &target, &h.asset, i128::MAX);
    let predicate_hash: BytesN<32> = h.env.crypto().sha256(&predicate).into();
    client
        .try_install(
            &PolicyInstallParams {
                grammar_version: 1,
                install_nonce: 1,
                predicate,
                predicate_hash,
                oracle_max_staleness_seconds: staleness,
                oracle_max_deviation_bps: deviation,
                oracle_max_xfeed_dev_bps: None,
            },
            &rule,
            &h.account,
        )
        .map(|_| target)
        .map_err(|_| ())
}

#[test]
fn tighter_oracle_bounds_install() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert!(install_with_bounds(&h, Some(300), Some(100)).is_ok());
}

#[test]
fn a_longer_staleness_window_is_refused() {
    // The whole point: a policy must not buy itself a looser bound than the
    // audited default.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert!(install_with_bounds(&h, Some(1200), None).is_err());
}

#[test]
fn a_wider_deviation_tolerance_is_refused() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert!(install_with_bounds(&h, None, Some(500)).is_err());
}

#[test]
fn a_zero_bound_is_refused() {
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_920_900);
    assert!(install_with_bounds(&h, Some(0), None).is_err());
    assert!(install_with_bounds(&h, None, Some(0)).is_err());
}

#[test]
fn a_tightened_staleness_bound_actually_binds_at_enforce() {
    // The newest record is 400s old. The audited default of 600s would
    // permit; this policy tightened to 300s, so it must deny. That is what
    // proves the stored override is threaded into resolution rather than
    // ignored in favour of the defaults.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_921_200);
    let target = install_with_bounds(&h, Some(300), None).expect("tighter bound installs");
    assert!(
        !enforce_against(&h, &target),
        "a tightened staleness bound must deny"
    );
}

#[test]
fn the_same_call_permits_under_the_default_bound() {
    // Same 400s-old record, no override: the default 600s bound permits. Pins
    // that the test above fails for the bound, not for some unrelated reason.
    let h = setup(&LIVE, PINNED_DECIMALS, PINNED_RESOLUTION, 1_784_921_200);
    let target = install_with_bounds(&h, None, None).expect("default bounds install");
    assert!(
        enforce_against(&h, &target),
        "the default bound must still permit"
    );
}

/// Drive `enforce` for the rule installed by `install_with_bounds`.
fn enforce_against(h: &Harness, target: &Address) -> bool {
    let client = PolicyInterpreterClient::new(&h.env, &h.interpreter);
    let signers = soroban_sdk::vec![&h.env, Signer::Delegated(h.account.clone())];
    let rule = make_rule(&h.env, 1, signers.clone());
    let ctx = Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: Symbol::new(&h.env, "swap"),
        args: Vec::new(&h.env),
    });
    client
        .try_enforce(&ctx, &signers, &rule, &h.account)
        .is_ok()
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

// ---- F8 split: 305 -> {305, 310, 311} ----
//
// The pre-fix resolver collapsed three semantically different feeder
// failures into ORACLE_MISSING (305). An operator who sees 305 cannot tell
// "this asset has no price data" (asset unsupported - do not use it) from
// "the feed has data but is not publishing continuously" (infrastructure
// degraded - escalate to the feed operator) from "the feed returned a
// non-positive price or non-monotonic timestamps" (upstream bug or attack -
// escalate to engineering). The fix splits the code:
//
//   305 ORACLE_MISSING            - truly absent (no records at all)
//   310 ORACLE_NO_CONFIRMATION    - feed has data, two-round confirmation cannot form
//   311 ORACLE_MALFORMED_HISTORY  - feed returned a non-positive price or non-monotonic ts
//
// These tests drive the wasm through `env.try_invoke_contract::<(), InvokeError>`
// rather than reading panic logs in the native env. The previous F8 test
// went through `Logs::all()` - panic messages are captured by the native
// test env and never reach the chain, so a fix that could not surface a
// code would still pass the assertion. The wasm-driven path parses the
// real host error and only passes when `Error(Contract, N)` reaches the
// diagnostic event. Pre-fix all three return 305; the post-fix split emits
// {305, 310, 311} to the three shaped inputs.

/// Drive `enforce` via the host's raw invoke so the assertion sees the
/// on-chain contract error rather than the native panic message.
fn enforce_contract_error(e: &E2e) -> u32 {
    use soroban_sdk::InvokeError;
    let ctx = Context::Contract(ContractContext {
        contract: e.target.clone(),
        fn_name: Symbol::new(&e.h.env, "swap"),
        args: Vec::new(&e.h.env),
    });
    let mut args: Vec<soroban_sdk::Val> = Vec::new(&e.h.env);
    args.push_back(ctx.into_val(&e.h.env));
    args.push_back(e.signers.clone().into_val(&e.h.env));
    args.push_back(IntoVal::into_val(&e.rule, &e.h.env));
    args.push_back(e.h.account.clone().into_val(&e.h.env));
    let raw = e.h.env.try_invoke_contract::<(), InvokeError>(
        &e.h.interpreter,
        &Symbol::new(&e.h.env, "enforce"),
        args,
    );
    match raw {
        Err(Ok(InvokeError::Contract(n))) => n,
        Err(Ok(other)) => panic!("expected Contract(N), got {other:?}"),
        Err(Err(host_err)) => panic!("unexpected host error: {host_err:?}"),
        Ok(_unexpected) => panic!("expected deny, got permit"),
    }
}

#[test]
fn f8_oracle_missing_still_emits_contract_code_305() {
    // Sanity: the truly-absent case (no records at all) keeps its existing
    // 305 code. Without this pin, a future split that buries the absent
    // case under 310/311 would silently change the public ABI.
    let e = install_oracle_policy(&[], 1_784_920_900, 200_000_000);
    assert_eq!(
        enforce_contract_error(&e),
        305,
        "no records must still be 305"
    );
}

#[test]
fn f8_oracle_no_confirmation_emits_contract_code_310() {
    // The feed returned ONE record - newer than the staleness bound, so
    // the failure is at the two-round confirmation step rather than the
    // staleness step. Pre-fix this fires 305 (OracleMissing); post-fix
    // it must fire 310 (OracleNoConfirmation) because the feed has data -
    // it just cannot form a confirmation.
    let one = [(17_718_407_521_607i128, 1_784_920_800u64)];
    let e = install_oracle_policy(&one, 1_784_920_900, 200_000_000);
    assert_eq!(
        enforce_contract_error(&e),
        310,
        "a single record must emit 310 ORACLE_NO_CONFIRMATION, not 305"
    );
}

#[test]
fn f8_oracle_gapped_rounds_emit_contract_code_310() {
    // Two records, but 600s apart against a 300s resolution - the bucket
    // between them is missing. The feed has data; the rounds are not
    // adjacent; the two-round confirmation cannot form. Pre-fix this fires
    // 305; post-fix it must fire 310.
    let gapped = [
        (17_718_407_521_607i128, 1_784_920_800u64),
        (17_723_828_493_925, 1_784_920_200),
    ];
    let e = install_oracle_policy(&gapped, 1_784_920_900, 200_000_000);
    assert_eq!(
        enforce_contract_error(&e),
        310,
        "gapped rounds must emit 310 ORACLE_NO_CONFIRMATION, not 305"
    );
}

#[test]
fn f8_oracle_malformed_history_emits_contract_code_311() {
    // The feed returned a zero price, which is never a real quote. The
    // feed has data, timestamps are adjacent, but the value fails
    // cross-validation. Pre-fix this fires 305; post-fix it must fire 311
    // ORACLE_MALFORMED_HISTORY because the data shape itself is invalid.
    let bad = [
        (0i128, 1_784_920_800u64),
        (17_720_866_269_595, 1_784_920_500),
    ];
    let e = install_oracle_policy(&bad, 1_784_920_900, 200_000_000);
    assert_eq!(
        enforce_contract_error(&e),
        311,
        "a non-positive price must emit 311 ORACLE_MALFORMED_HISTORY, not 305"
    );
}

// ---- Track B: cross-feed divergence ----
//
// The two-round confirmation reads ONE feed twice, so it cannot see a
// compromised or maliciously-upgraded feed publishing two consistent
// forged prices. The fix: read a SECOND, INDEPENDENT feed and deny when
// the two disagree by more than the bound.
//
// Each test below registers MockPulse at both the primary address
// (`PULSE_DEX_FEED`) and the secondary address (`PULSE_DEX_FEED_SECONDARY`)
// with whatever records each scenario needs. The compile-time default for
// the secondary is `None`; these tests REQUIRE `PULSE_FEED_ADDRESS_2`
// to be set when building. The expected build command is:
//   PULSE_FEED_ADDRESS_2=<addr> cargo test --test oracle_resolve

/// Helper: address the secondary feed is registered at. Pulled at compile
/// time so the harness and the resolver see the same value.
fn secondary_addr() -> &'static str {
    PULSE_DEX_FEED_SECONDARY.expect("cross-feed tests require PULSE_FEED_ADDRESS_2 at compile time")
}

// ---- HEADLINE: forged-agreement denies 312 ----
//
// The single most important test for Track B. A primary feed that
// publishes two consistent forged prices (passes its own two-round
// confirmation) is NOT a real confirmation - a malicious upgrade can
// preserve decimals/resolution/base while forging values. The secondary
// feed, which the attacker does not control, reports the real price.
// Cross-feed divergence > bound -> deny 312.
#[test]
fn cross_feed_forged_agreement_denies_312() {
    // Primary: two forged-but-consistent records (passes its own
    // 2-round confirmation, deviation well within the 200bps default).
    // Forged price: $50 (= 50 * 10^14 at 14dp = 500_000_000_000_000).
    let forged = [
        (500_000_000_000_000i128, 1_784_920_800u64),
        (500_000_000_000_000, 1_784_920_500),
    ];
    // Secondary: the real price, $0.50 (= 0.50 * 10^14 at 14dp).
    // 1000x divergence - far beyond any sane bound.
    let real = [
        (5_000_000_000_000i128, 1_784_920_800u64),
        (5_000_000_000_000, 1_784_920_500),
    ];
    let h = setup_pair(
        &forged,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &real,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleCrossFeedDivergence),
        "two consistent forged prices on the primary must NOT pass cross-feed check"
    );
}

// ---- headline end-to-end: contract emits 312 ----
//
// Same forged-agreement scenario, but driven through `enforce` so the
// real contract error code 312 reaches the host's diagnostic event.
// Without this, a fix that returns `OracleCrossFeedDivergence` from the
// resolver but is never wired to `PolicyError` would still pass the
// resolver test while leaking through install.
#[test]
fn cross_feed_forged_agreement_emits_contract_code_312() {
    // Mirror the helper that the F8 split uses: install + enforce, then
    // read the host error code via `try_invoke_contract`. The primary is
    // forged, the secondary is real.
    let env = Env::default();
    env.mock_all_auths();
    let primary = Address::from_string(&SorobanString::from_str(&env, PULSE_DEX_FEED));
    let secondary = Address::from_string(&SorobanString::from_str(&env, secondary_addr()));
    env.register_at(&primary, MockPulse, ());
    env.register_at(&secondary, MockPulse, ());
    let interpreter = env.register(policy_interpreter::PolicyInterpreter, ());

    let forged_prices: Vec<i128> =
        soroban_sdk::vec![&env, 500_000_000_000_000i128, 500_000_000_000_000];
    let forged_ts: Vec<u64> = soroban_sdk::vec![&env, 1_784_920_800u64, 1_784_920_500];
    let real_prices: Vec<i128> = soroban_sdk::vec![&env, 5_000_000_000_000i128, 5_000_000_000_000];
    let real_ts: Vec<u64> = soroban_sdk::vec![&env, 1_784_920_800u64, 1_784_920_500];
    MockPulseClient::new(&env, &primary).seed(
        &forged_prices,
        &forged_ts,
        &PINNED_DECIMALS,
        &PINNED_RESOLUTION,
    );
    MockPulseClient::new(&env, &secondary).seed(
        &real_prices,
        &real_ts,
        &PINNED_DECIMALS,
        &PINNED_RESOLUTION,
    );
    env.ledger().with_mut(|li| li.timestamp = 1_784_920_900);

    let account = Address::generate(&env);
    let asset = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(account.clone())];
    let rule = make_rule(&env, 1, signers.clone());

    let predicate = oracle_policy_bytes(&env, &target, &asset, i128::MAX);
    let predicate_hash: BytesN<32> = env.crypto().sha256(&predicate).into();

    let client = PolicyInterpreterClient::new(&env, &interpreter);
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
        &account,
    );

    let e = E2e {
        h: Harness {
            env: env.clone(),
            asset: asset.clone(),
            account: account.clone(),
            interpreter,
        },
        rule,
        signers,
        target,
    };
    assert_eq!(
        enforce_contract_error(&e),
        312,
        "forged-agreement must emit 312 ORACLE_CROSS_FEED_DIVERGENCE"
    );
}

// ---- fail-closed modes on the secondary ----
//
// Each of these exercises a different way the secondary can fail to be
// readable. Per spec: missing / paused / stale / fingerprint drift /
// deviation all DENY. None of them permit.

#[test]
fn cross_feed_missing_secondary_denies() {
    // Secondary has no records. The primary is fine.
    let h = setup_pair(
        &LIVE,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &[],
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    // A secondary with zero records is `OracleMissing` (the same shape
    // the primary uses when it has no records). The cross-feed path is
    // fail-closed: any unreadable secondary denies.
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleMissing),
        "a secondary with no records must deny"
    );
}

#[test]
fn cross_feed_stale_secondary_denies() {
    // Secondary is older than the staleness bound (300s old on a 600s
    // bound is still fresh; 700s old is stale).
    let fresh = LIVE;
    // Mirror LIVE for the primary but shift the secondary 700s into the
    // past. The two feeds need fresh timestamps on the primary and stale
    // on the secondary to demonstrate "primary fresh, secondary stale".
    let stale = [(LIVE[0].0, LIVE[0].1 - 700), (LIVE[1].0, LIVE[1].1 - 700)];
    let h = setup_pair(
        &fresh,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &stale,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleStale),
        "a stale secondary must deny (fresh primary alone is single-trust-domain)"
    );
}

#[test]
fn cross_feed_invalid_secondary_fingerprint_denies() {
    // Secondary reports `decimals == 0`, which `read_fingerprint` rejects
    // (it would always normalise to itself, and a zero-decimals feed
    // collapses to zero on every read). The primary is fine.
    let h = setup_pair(
        &LIVE,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &LIVE,
        0, // invalid decimals on secondary
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleFingerprintDrift),
        "a secondary with invalid decimals must deny"
    );
}

#[test]
fn cross_feed_decimals_mismatch_pair_normalises_correctly() {
    // Two feeds reporting different decimals but the SAME nominal price.
    // Normalising both to 9dp collapses the scale difference BEFORE the
    // bps comparison, so this case permits.
    // Primary: 14dp, price 17_718_407_521_607 (~177.184 XLM).
    // Secondary: 9dp, price 177_184_075 (~177.184 XLM).
    let primary = LIVE; // 14dp
    let secondary = [
        (177_184_075i128, 1_784_920_800u64),
        (177_184_075, 1_784_920_500),
    ];
    let h = setup_pair(
        &primary,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &secondary,
        9,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    // Both should normalise to 177_184_075 on the 9dp basis, so the
    // cross-feed deviation is zero and the resolve permits.
    assert!(
        matches!(resolve(&h), OracleEntry::Price { .. }),
        "two feeds with different decimals but the same nominal price must permit (normalisation collapses the scale)"
    );
}

#[test]
fn cross_feed_within_bound_passes() {
    // Two feeds agree to within 100bps of each other. Default bound is
    // 500bps, so this permits.
    let primary = LIVE; // 17_718_407_521_607 at 14dp
                        // Secondary: ~0.5% lower.
    let secondary = [
        (17_630_115_484_149i128, 1_784_920_800u64), // ~0.5% below primary
        (17_630_115_484_149, 1_784_920_500),
    ];
    let h = setup_pair(
        &primary,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &secondary,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    assert!(
        matches!(resolve(&h), OracleEntry::Price { .. }),
        "two feeds within the cross-feed bound must permit"
    );
}

#[test]
fn cross_feed_beyond_bound_denies_312() {
    // Two feeds disagree by 10% - well beyond the 500bps default.
    let primary = LIVE;
    let secondary = [
        (15_946_566_769_446i128, 1_784_920_800u64), // ~10% below primary
        (15_946_566_769_446, 1_784_920_500),
    ];
    let h = setup_pair(
        &primary,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &secondary,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    assert_eq!(
        failed_with(resolve(&h)),
        Some(DenyReason::OracleCrossFeedDivergence),
        "two feeds beyond the cross-feed bound must deny 312"
    );
}

#[test]
fn cross_feed_agreement_passes() {
    // Two feeds report the EXACT same data (different trust domains,
    // same answer) - the resolver permits.
    let h = setup_pair(
        &LIVE,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        &LIVE,
        PINNED_DECIMALS,
        PINNED_RESOLUTION,
        1_784_920_900,
        secondary_addr(),
    );
    assert!(
        matches!(resolve(&h), OracleEntry::Price { .. }),
        "two feeds that agree must permit"
    );
}
