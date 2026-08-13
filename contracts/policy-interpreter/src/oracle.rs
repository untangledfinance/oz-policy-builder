//! Reflector Pulse price resolution.
//!
//! Resolves every `oracle_price` asset a predicate references into a snapshot
//! BEFORE the predicate is walked, so the evaluator stays pure. Every failure
//! is represented as a `DenyReason` on the entry rather than an absent value:
//! a missing asset reads as stale, never as price zero.
//!
//! Pins were live-probed against mainnet on 2026-07-24: DEX feed decimals 14, resolution 300s. Two-round confirmation
//! compares the two newest records and requires them exactly one resolution
//! interval apart - the live feed returns records newest-first and may return
//! MORE than the requested count, so neither ordering nor length is assumed.

extern crate alloc;

use alloc::vec::Vec;

use soroban_sdk::{
    contracttype, symbol_short, Address, Env, IntoVal, String as SorobanString, Symbol, Val,
    Vec as SorobanVec,
};

use crate::dsl::{DenyReason, Node, OracleEntry};

// ---- pinned oracle instance ----

/// Reflector Pulse DEX feed, selected at COMPILE time.
///
/// The address is baked into the wasm deliberately: the spec pins the oracle
/// instance in the interpreter's version identity, so pointing at a different
/// feed is a different wasm hash and an explicit audit event, not a runtime
/// configuration change. That means one build per network - the mainnet wasm
/// cannot run on testnet, where the feed lives at a different address.
///
/// Build for testnet with `--features testnet`.
///
/// `PULSE_FEED_ADDRESS` overrides it at BUILD time, for pointing a testnet
/// build at a seeded feed so the oracle paths that need real price records
/// can be exercised on a network. It is still compile-time, so the override
/// yields its own wasm hash and cannot be mistaken for a mainnet build.
pub const PULSE_DEX_FEED: &str = match option_env!("PULSE_FEED_ADDRESS") {
    Some(a) => a,
    None => DEFAULT_PULSE_DEX_FEED,
};

#[cfg(not(feature = "testnet"))]
const DEFAULT_PULSE_DEX_FEED: &str = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";

/// Reflector Pulse DEX feed, Stellar testnet.
#[cfg(feature = "testnet")]
const DEFAULT_PULSE_DEX_FEED: &str = "CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP";

/// The secondary feed to actually use, or `None` when there is no usable
/// second opinion.
///
/// A secondary equal to the primary is NOT a second opinion: it reads one
/// feed twice, agrees with itself by construction, and would turn the whole
/// cross-feed check into a no-op that still passes every test - the exact
/// failure this check exists to prevent, one layer up. `None` denies
/// (`OracleCrossFeedDivergence`), matching how the rest of the oracle code
/// treats a read it cannot form.
///
/// A free function rather than an inline condition because
/// `PULSE_FEED_ADDRESS` and `PULSE_FEED_ADDRESS_2` are independent COMPILE
/// time inputs: a test binary cannot vary them, so the self-pair rule would
/// otherwise be unverifiable. Here it is ordinary testable logic.
fn usable_secondary<'a>(primary: &str, secondary: Option<&'a str>) -> Option<&'a str> {
    match secondary {
        Some(addr) if addr != primary => Some(addr),
        _ => None,
    }
}

/// Reflector Pulse SECONDARY feed, selected at COMPILE time.
///
/// The primary feed (above) is one trust domain - if it is compromised or
/// maliciously upgraded while preserving its self-reported fingerprint
/// (decimals/resolution/base), two-round confirmation reads two records
/// from the SAME compromised source. This constant is the SECOND,
/// INDEPENDENT feed the cross-feed divergence check compares the primary
/// against. Same compile-time-pin shape as the primary: a different
/// address is a different wasm hash, and a real production build must
/// pin a feed that is operationally independent from the primary.
///
/// `PULSE_FEED_ADDRESS_2` overrides at BUILD time, for pointing a testnet
/// build at a seeded feed so the cross-feed path can be exercised on a
/// network.
///
/// Defaults to Reflector's "external CEX & DEX aggregate" feed, which is a
/// genuinely different SOURCE from the primary's Stellar-DEX order book:
/// moving the on-chain book with capital does not move a CEX aggregate.
/// Live-probed 2026-07-29 - same `decimals` (14), `resolution` (300) and
/// contract `version` (6) as the primary, so normalisation is unchanged.
///
/// RESIDUAL, and it is deliberate: both feeds are published by the same
/// operator (Reflector's node consensus). This narrows the SOURCE trust
/// domain, NOT the OPERATOR one - a compromise of that node set takes both
/// feeds together. Closing that needs a different publisher entirely (Band
/// Protocol is on mainnet, with an incompatible interface). Recorded here
/// rather than left implicit.
///
/// NOTE the two feeds quote against different bases: the primary in USDC,
/// this one in USD. They track within a few bps, so the 500 bps default
/// bound absorbs the basis - but a USDC depeg past the bound denies every
/// oracle-bounded call. That is intended: a policy priced in USDC terms
/// should stop if USDC breaks.
#[cfg(not(feature = "testnet"))]
const DEFAULT_PULSE_FEED_SECONDARY: &str =
    "CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN";
#[cfg(feature = "testnet")]
const DEFAULT_PULSE_FEED_SECONDARY: &str =
    "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";

/// `PULSE_FEED_ADDRESS_2` overrides the default at BUILD time, for pointing
/// a build at a seeded feed. Never `None`: an unpinned secondary would fail
/// closed on every oracle read, and the pin above is a real address.
pub const PULSE_DEX_FEED_SECONDARY: Option<&str> = match option_env!("PULSE_FEED_ADDRESS_2") {
    Some(addr) => Some(addr),
    None => Some(DEFAULT_PULSE_FEED_SECONDARY),
};

/// Decimals the pinned feed reports. Part of the fingerprint.
pub const PINNED_DECIMALS: u32 = 14;

/// Bucket size in seconds the pinned feed reports. Part of the fingerprint.
pub const PINNED_RESOLUTION: u32 = 300;

/// Base asset the pinned feed quotes against. Part of the fingerprint. An
/// upgraded feed that kept decimals+resolution while switching the base
/// would silently change what every price means while our bounds compare
/// against the wrong basis.
///
/// These are the values the live feeds actually report, read by
/// `simulateTransaction` against each network on 2026-07-29 - USDC, not
/// XLM. The previous constants were the XLM SAC, an unverified
/// plan assumption; against a real feed they would have failed the
/// fingerprint on every read.
#[cfg(not(feature = "testnet"))]
pub const PINNED_BASE: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
#[cfg(feature = "testnet")]
pub const PINNED_BASE: &str = "CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7";

/// Common basis every oracle comparison is normalised to, so a policy's
/// literal is written against one scale regardless of the feed's own.
pub const NORMALISED_DECIMALS: u32 = 9;

/// Default staleness bound: two buckets at the pinned 300s resolution.
pub const DEFAULT_MAX_STALENESS_SECONDS: u64 = 600;

/// Default deviation bound between the two confirmation rounds, in bps.
pub const DEFAULT_MAX_DEVIATION_BPS: u64 = 200;

/// Default deviation bound between the primary and the secondary feed, in
/// bps. The secondary feed is independent (a separate trust domain), so it
/// can legitimately diverge from the primary by more than two consecutive
/// reads of one feed - the default is therefore wider than
/// `DEFAULT_MAX_DEVIATION_BPS`. The orchestrator can tighten per-policy
/// via `Bounds::from_params`; widening is refused at install, exactly
/// mirroring the staleness / deviation contract above.
///
/// No secondary feed has been selected yet, so the
/// production build will pin one via `PULSE_FEED_ADDRESS_2` at compile
/// time. Until it does, every oracle read fails closed with
/// `OracleCrossFeedDivergence` - the cross-feed validation cannot form,
/// which is the same shape the rest of the oracle code already follows
/// (missing/paused/stale/decode-failed reads deny, never permit).
pub const DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS: u64 = 500;

// ---- Reflector wire types ----

/// Reflector's asset argument. A `contracttype` enum encodes as the
/// 2-element vec `[Symbol("Stellar"), Address]` the feed expects - a bare
/// address does not bind.
#[contracttype]
#[derive(Clone, Debug)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Per-policy bounds, already validated as tighten-only at install.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub max_staleness_seconds: u64,
    pub max_deviation_bps: u64,
    /// Maximum allowed deviation between the primary and the secondary feed,
    /// in bps. The cross-feed check fails (and the policy denies with
    /// `OracleCrossFeedDivergence`) when the two normalised prices diverge
    /// by more than this bound.
    pub max_cross_feed_deviation_bps: u64,
}

impl Default for Bounds {
    fn default() -> Self {
        Self {
            max_staleness_seconds: DEFAULT_MAX_STALENESS_SECONDS,
            max_deviation_bps: DEFAULT_MAX_DEVIATION_BPS,
            max_cross_feed_deviation_bps: DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS,
        }
    }
}

impl Bounds {
    /// Resolve the bounds a stored policy evaluates under.
    ///
    /// `None` means the wasm defaults. An override may only TIGHTEN: a policy
    /// cannot buy itself a longer staleness window, a wider deviation
    /// tolerance, or a wider cross-feed tolerance than the audited defaults
    /// allow. A zero is rejected too - it would be a bound no live feed
    /// could ever satisfy, which is a misconfiguration rather than a strict
    /// policy.
    // The only failure is "bound refused"; the caller maps it to a single
    // deny reason, so an error payload would carry no extra information.
    #[allow(clippy::result_unit_err)]
    pub fn from_params(
        max_staleness_seconds: Option<u32>,
        max_deviation_bps: Option<u32>,
        max_cross_feed_deviation_bps: Option<u32>,
    ) -> Result<Self, ()> {
        if max_staleness_seconds.is_none()
            && max_deviation_bps.is_none()
            && max_cross_feed_deviation_bps.is_none()
        {
            return Ok(Self::default());
        }
        let staleness = max_staleness_seconds.map_or(DEFAULT_MAX_STALENESS_SECONDS, u64::from);
        let deviation = max_deviation_bps.map_or(DEFAULT_MAX_DEVIATION_BPS, u64::from);
        let cross_feed =
            max_cross_feed_deviation_bps.map_or(DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS, u64::from);
        if staleness == 0
            || deviation == 0
            || cross_feed == 0
            || staleness > DEFAULT_MAX_STALENESS_SECONDS
            || deviation > DEFAULT_MAX_DEVIATION_BPS
            || cross_feed > DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS
        {
            return Err(());
        }
        Ok(Self {
            max_staleness_seconds: staleness,
            max_deviation_bps: deviation,
            max_cross_feed_deviation_bps: cross_feed,
        })
    }
}

// ---- resolution ----

/// Resolve every distinct oracle asset the predicate references.
///
/// Returns one entry per asset - either a confirmed, normalised price or the
/// reason it could not be established. Assets are resolved even when the feed
/// is degraded, because the evaluator needs the failure reason to deny with.
pub fn resolve_snapshot(
    e: &Env,
    root: &Node,
    smart_account: &Address,
    bounds: Bounds,
) -> Vec<(Address, OracleEntry)> {
    let assets = collect_oracle_assets(root);
    let mut out: Vec<(Address, OracleEntry)> = Vec::new();
    if assets.is_empty() {
        return out;
    }

    let primary = Address::from_string(&SorobanString::from_str(e, PULSE_DEX_FEED));

    // Secondary feed: when compile-time unconfigured, every oracle read
    // fails closed with `OracleCrossFeedDivergence` because the cross-feed
    // validation cannot form - this is the same shape the rest of the
    // oracle code already follows (missing/paused/stale reads deny, never
    // permit). The orchestrator must pin a real address via
    // `PULSE_FEED_ADDRESS_2` for this to mean anything.
    // A secondary equal to the primary is NOT a second opinion. It reads one
    // feed twice, agrees with itself by construction, and would turn the
    // whole cross-feed check into a no-op that still passes every test - the
    // exact failure this check exists to prevent, one layer up. Treat a
    // self-pair as unconfigured so it denies rather than silently permits.
    // Cheap enough to do per enforcement, and it cannot be asserted at
    // compile time: `PULSE_FEED_ADDRESS` and `PULSE_FEED_ADDRESS_2` are
    // independent build inputs and either may be overridden.
    let secondary = usable_secondary(PULSE_DEX_FEED, PULSE_DEX_FEED_SECONDARY)
        .map(|addr| Address::from_string(&SorobanString::from_str(e, addr)));

    // Fingerprint once per enforcement rather than per asset: the values are
    // instance-wide, and drift invalidates every read equally.
    //
    // The primary is pinned to `PINNED_DECIMALS` / `PINNED_RESOLUTION` /
    // `PINNED_BASE` because the contract's version identity pins those
    // values - a different fingerprint is a different wasm hash, not a
    // runtime configuration. The secondary is a different trust domain:
    // we still read its decimals/resolution/base so we can normalise its
    // prices, but we do NOT pin them to the primary's values, because a
    // cross-feed check is only meaningful if the two feeds can report
    // different decimals. An attacker who lies about the secondary's
    // decimals is caught by the cross-feed deviation itself, not by the
    // fingerprint pin.
    if let Err(reason) = check_fingerprint_pinned(e, &primary) {
        for asset in assets {
            out.push((asset, OracleEntry::Failed(reason)));
        }
        return out;
    }
    let secondary_decimals;
    let secondary_resolution;
    if let Some(ref sec) = secondary {
        match read_fingerprint(e, sec) {
            Ok((d, r)) => {
                secondary_decimals = d;
                secondary_resolution = r;
            }
            Err(reason) => {
                for asset in assets {
                    out.push((asset, OracleEntry::Failed(reason)));
                }
                return out;
            }
        }
    } else {
        secondary_decimals = 0;
        secondary_resolution = 0;
    }

    for asset in assets {
        let entry = if is_paused(e, smart_account, &asset) {
            OracleEntry::Failed(DenyReason::OraclePaused)
        } else {
            match resolve_one(
                e,
                &primary,
                secondary.as_ref(),
                secondary_decimals,
                secondary_resolution,
                &asset,
                bounds,
            ) {
                Ok(entry) => entry,
                Err(reason) => OracleEntry::Failed(reason),
            }
        };
        out.push((asset, entry));
    }
    out
}

/// Two-round confirmation for a single asset, plus cross-feed divergence
/// against a second, independent feed. The two-round check guards against
/// a transient flash spike; the cross-feed check guards against a
/// compromised or maliciously-upgraded feed publishing two consistent
/// forged prices. They are NOT substitutes - each catches what the other
/// cannot.
///
/// When `secondary` is `None` the cross-feed validation cannot form, so we
/// deny with `OracleCrossFeedDivergence` rather than permit on a single
/// trust domain. This matches the established fail-closed shape: missing /
/// paused / stale / decode-failed reads deny, never permit.
///
/// `secondary_decimals` and `secondary_resolution` are the values the
/// secondary feed reported at the per-enforcement fingerprint read. They
/// may differ from the primary's pinned values, and the cross-feed
/// normalisation handles that explicitly so a 14dp-vs-9dp pair with the
/// same nominal price doesn't accidentally diverge.
#[allow(clippy::too_many_arguments)]
fn resolve_one(
    e: &Env,
    feed: &Address,
    secondary: Option<&Address>,
    secondary_decimals: u32,
    secondary_resolution: u32,
    asset: &Address,
    bounds: Bounds,
) -> Result<OracleEntry, DenyReason> {
    let records = read_prices(e, feed, asset)?;

    // The feed returns newest-first but that is an observation, not a
    // guarantee, so pick the two newest explicitly.
    let (newest, previous) = two_newest(&records).ok_or(DenyReason::OracleNoConfirmation)?;

    // A non-positive price is never a real quote - the data shape itself
    // is invalid, so surface it as malformed history rather than a
    // missing-asset failure.
    if newest.price <= 0 || previous.price <= 0 {
        return Err(DenyReason::OracleMalformedHistory);
    }

    // The rounds must be genuinely distinct and exactly adjacent - two reads
    // of the same bucket, or a gap, is not a confirmation. The feed has
    // data; the two-round check just cannot form against this shape.
    let delta = newest
        .timestamp
        .checked_sub(previous.timestamp)
        .ok_or(DenyReason::OracleMalformedHistory)?;
    if delta != u64::from(PINNED_RESOLUTION) {
        return Err(DenyReason::OracleNoConfirmation);
    }

    // Staleness is measured in seconds against the newest record. A record
    // dated in the future is also fail-closed: `saturating_sub` would yield
    // 0 and the bound would pass unconditionally, so a malicious or buggy
    // feed could feed any forward-dated price through. Stellar's ledger
    // timestamp is monotonic per network, so a "real" future-dated record
    // is impossible.
    let now = e.ledger().timestamp();
    if newest.timestamp > now || now.saturating_sub(newest.timestamp) > bounds.max_staleness_seconds
    {
        return Err(DenyReason::OracleStale);
    }

    // Deviation on the RAW values, before any rescaling, so no precision is
    // discarded ahead of the comparison:
    //   |cur - prev| * 10_000 <= max_bps * prev
    check_within_feed_deviation(&newest, &previous, bounds.max_deviation_bps)?;

    // Cross-feed divergence: the primary has cleared two-round confirmation,
    // but a compromised feed can publish two consistent forged prices, so
    // "two rounds agreed" proves nothing about the source. Read the
    // secondary feed (independent trust domain) and compare.
    //
    // Unconfigured secondary -> deny with OracleCrossFeedDivergence: the
    // cross-feed validation cannot form, which is the same fail-closed
    // shape the rest of the oracle code already follows.
    let secondary_feed = secondary.ok_or(DenyReason::OracleCrossFeedDivergence)?;
    let sec_records = read_prices(e, secondary_feed, asset)?;
    let (sec_newest, sec_previous) =
        two_newest(&sec_records).ok_or(DenyReason::OracleNoConfirmation)?;
    if sec_newest.price <= 0 || sec_previous.price <= 0 {
        return Err(DenyReason::OracleMalformedHistory);
    }
    // The secondary's two-round confirmation uses ITS OWN resolution (a
    // different feed may legitimately report at a different cadence).
    let sec_delta = sec_newest
        .timestamp
        .checked_sub(sec_previous.timestamp)
        .ok_or(DenyReason::OracleMalformedHistory)?;
    if sec_delta != u64::from(secondary_resolution) {
        return Err(DenyReason::OracleNoConfirmation);
    }
    // Staleness on the secondary is checked at the same wall-clock bound as
    // the primary - a fresh-looking primary against a stale secondary is
    // not a confirmation, it's a single-trust-domain read.
    if sec_newest.timestamp > now
        || now.saturating_sub(sec_newest.timestamp) > bounds.max_staleness_seconds
    {
        return Err(DenyReason::OracleStale);
    }
    // Same within-feed deviation bound on the secondary - a compromised
    // secondary is just as real a risk as a compromised primary.
    check_within_feed_deviation(&sec_newest, &sec_previous, bounds.max_deviation_bps)?;

    // Compare on the NORMALISED basis. If the two feeds report different
    // decimals, normalising both collapses the scale difference BEFORE the
    // bps comparison so a decimals mismatch cannot accidentally pass a
    // 14dp-vs-9dp pair that are actually far apart.
    let primary_norm = normalise_to(newest.price, PINNED_DECIMALS)?;
    let secondary_norm = normalise_to(sec_newest.price, secondary_decimals)?;
    // Reference basis for bps: average of the two, so a 5% move on a
    // small quoted price doesn't dominate an absolute divergence on a
    // larger one.
    let reference = primary_norm
        .unsigned_abs()
        .saturating_add(secondary_norm.unsigned_abs())
        / 2;
    if reference == 0 {
        // Both feeds at zero is malformed - shouldn't reach here after
        // the non-positive checks above, but defend anyway.
        return Err(DenyReason::OracleMalformedHistory);
    }
    let cross_diff = (primary_norm - secondary_norm).unsigned_abs();
    let lhs = cross_diff
        .checked_mul(10_000)
        .ok_or(DenyReason::OracleCrossFeedDivergence)?;
    let rhs = reference
        .checked_mul(u128::from(bounds.max_cross_feed_deviation_bps))
        .ok_or(DenyReason::OracleCrossFeedDivergence)?;
    if lhs > rhs {
        return Err(DenyReason::OracleCrossFeedDivergence);
    }

    Ok(OracleEntry::Price {
        price: primary_norm,
        timestamp_seconds: newest.timestamp,
    })
}

/// Rescale a feed price from the given decimals to the common basis. The
/// cross-feed comparison passes `PINNED_DECIMALS` for the primary and
/// whatever the secondary reports for itself, so a decimals mismatch
/// between the two feeds is collapsed BEFORE the bps comparison - a 14-dp
/// value and a 9-dp value reported as the same nominal price do not
/// accidentally pass.
fn normalise_to(price: i128, decimals: u32) -> Result<i128, DenyReason> {
    if decimals < NORMALISED_DECIMALS {
        let scale = pow10(NORMALISED_DECIMALS - decimals)?;
        return price
            .checked_mul(scale)
            .ok_or(DenyReason::OracleDecimalsMismatch);
    }
    let scale = pow10(decimals - NORMALISED_DECIMALS)?;
    price
        .checked_div(scale)
        .ok_or(DenyReason::OracleDecimalsMismatch)
}

fn pow10(exp: u32) -> Result<i128, DenyReason> {
    let mut acc: i128 = 1;
    for _ in 0..exp {
        acc = acc
            .checked_mul(10)
            .ok_or(DenyReason::OracleDecimalsMismatch)?;
    }
    Ok(acc)
}

/// Within-feed deviation on the RAW values, before any rescaling, so no
/// precision is discarded ahead of the comparison:
///   |cur - prev| * 10_000 <= max_bps * prev
fn check_within_feed_deviation(
    newest: &PriceData,
    previous: &PriceData,
    max_deviation_bps: u64,
) -> Result<(), DenyReason> {
    let diff = (newest.price - previous.price).unsigned_abs();
    let lhs = diff
        .checked_mul(10_000)
        .ok_or(DenyReason::OracleDeviationExceeded)?;
    let rhs = (previous.price.unsigned_abs())
        .checked_mul(u128::from(max_deviation_bps))
        .ok_or(DenyReason::OracleDeviationExceeded)?;
    if lhs > rhs {
        return Err(DenyReason::OracleDeviationExceeded);
    }
    Ok(())
}

/// The two newest records by timestamp, or `None` if fewer than two distinct
/// timestamps are present. Duplicates of the same bucket do not confirm
/// anything, so they collapse rather than pairing with themselves.
fn two_newest(records: &[PriceData]) -> Option<(PriceData, PriceData)> {
    let mut newest: Option<&PriceData> = None;
    let mut second: Option<&PriceData> = None;
    for r in records {
        let ts = r.timestamp;
        match newest {
            None => newest = Some(r),
            Some(n) if ts > n.timestamp => {
                second = newest;
                newest = Some(r);
            }
            Some(n) if ts == n.timestamp => {}
            _ => match second {
                None => second = Some(r),
                Some(s) if ts > s.timestamp => second = Some(r),
                _ => {}
            },
        }
    }
    match (newest, second) {
        (Some(n), Some(s)) if n.timestamp != s.timestamp => Some((n.clone(), s.clone())),
        _ => None,
    }
}

/// `prices(asset, 2)`. The feed may return more than the requested count, so
/// the caller filters rather than trusting the length.
fn read_prices(e: &Env, feed: &Address, asset: &Address) -> Result<Vec<PriceData>, DenyReason> {
    let arg: Asset = Asset::Stellar(asset.clone());
    let mut args: SorobanVec<Val> = SorobanVec::new(e);
    args.push_back(arg.into_val(e));
    args.push_back(2u32.into_val(e));

    let returned: Option<SorobanVec<PriceData>> =
        e.invoke_contract(feed, &symbol_short!("prices"), args);
    let records = returned.ok_or(DenyReason::OracleMissing)?;
    let mut out: Vec<PriceData> = Vec::new();
    for r in records.iter() {
        out.push(r);
    }
    // 0 records: the feed had nothing for this asset, so the entry is
    // truly absent. 1 record: the feed has data, but two-round
    // confirmation cannot be formed - the bare-record fall-through to
    // `two_newest` below surfaces that as `OracleNoConfirmation`.
    if out.is_empty() {
        return Err(DenyReason::OracleMissing);
    }
    Ok(out)
}

/// Reject an instance whose decimals, resolution, or base no longer match
/// the pin. Reflector's contract is upgradeable, so drift is an audit
/// event, not a value to adapt to at runtime. The base is part of the
/// fingerprint because an upgraded feed could keep decimals+resolution
/// while switching the asset the price is quoted against, silently
/// changing what every price means while our bounds compare against the
/// wrong basis.
///
/// Used for the PRIMARY feed, whose fingerprint is part of the contract's
/// version identity. A different fingerprint is a different wasm hash,
/// not a runtime configuration. The secondary feed uses `read_fingerprint`
/// below because pinning it to the primary's values would defeat the
/// point of having a second feed.
fn check_fingerprint_pinned(e: &Env, feed: &Address) -> Result<(), DenyReason> {
    let decimals: u32 = e.invoke_contract(feed, &symbol_short!("decimals"), SorobanVec::new(e));
    if decimals != PINNED_DECIMALS {
        return Err(DenyReason::OracleFingerprintDrift);
    }
    let resolution: u32 =
        e.invoke_contract(feed, &Symbol::new(e, "resolution"), SorobanVec::new(e));
    if resolution != PINNED_RESOLUTION {
        return Err(DenyReason::OracleFingerprintDrift);
    }
    // `base()` returns the `Asset` ENUM, not a bare address - the same shape
    // this module already builds for the `prices()` argument, and the shape
    // confirmed against the live feed. Decoding
    // it as an `Address` does not merely mismatch: the conversion fails and
    // traps, so every read against a real feed would die here.
    //
    // Matched on the variant rather than unwrapped: a feed quoting against an
    // off-chain unit reports `Other(Symbol)`, which is a different basis from
    // the address we pinned and must fail the fingerprint rather than be
    // coerced into one.
    let pinned_base = Address::from_string(&SorobanString::from_str(e, PINNED_BASE));
    let actual_base: Asset = e.invoke_contract(feed, &symbol_short!("base"), SorobanVec::new(e));
    match actual_base {
        Asset::Stellar(addr) if addr == pinned_base => Ok(()),
        _ => Err(DenyReason::OracleFingerprintDrift),
    }
}

/// Read the secondary feed's decimals and resolution WITHOUT pinning them.
/// The cross-feed check is only meaningful if the two feeds can report
/// different decimals, so a strict pin on the secondary would collapse the
/// check into a tautology (same decimals = same normalised value = zero
/// deviation). The attacker who lies about the secondary's decimals is
/// caught by the cross-feed deviation itself, not by the fingerprint.
///
/// Returns `(decimals, resolution)`. `base` is not needed for the
/// cross-feed comparison.
fn read_fingerprint(e: &Env, feed: &Address) -> Result<(u32, u32), DenyReason> {
    let decimals: u32 = e.invoke_contract(feed, &symbol_short!("decimals"), SorobanVec::new(e));
    if decimals == 0 {
        // A feed reporting zero decimals would always normalise to itself
        // (no scaling), and a divide-by-NORMALISED_DECIMALS decimal would
        // collapse to zero on every read. Reject as malformed rather than
        // silently passing through.
        return Err(DenyReason::OracleFingerprintDrift);
    }
    let resolution: u32 =
        e.invoke_contract(feed, &Symbol::new(e, "resolution"), SorobanVec::new(e));
    if resolution == 0 {
        return Err(DenyReason::OracleFingerprintDrift);
    }
    Ok((decimals, resolution))
}

// ---- pause ----

const K_PAUSE: u32 = 7;
const K_PAUSE_ALL: u32 = 8;

pub type PauseKeyTuple = (Address, u32, Address);
pub type PauseAllKeyTuple = (Address, u32);

/// Pause key is `(account, 'pause', asset)` - deliberately NOT mixed with the
/// `(account, rule_id)` rule state, so one pause covers every rule on the
/// account.
pub fn pause_key(smart_account: &Address, asset: &Address) -> PauseKeyTuple {
    (smart_account.clone(), K_PAUSE, asset.clone())
}

pub fn pause_all_key(smart_account: &Address) -> PauseAllKeyTuple {
    (smart_account.clone(), K_PAUSE_ALL)
}

pub fn is_paused(e: &Env, smart_account: &Address, asset: &Address) -> bool {
    let p = e.storage().persistent();
    p.get::<_, bool>(&pause_all_key(smart_account))
        .unwrap_or(false)
        || p.get::<_, bool>(&pause_key(smart_account, asset))
            .unwrap_or(false)
}

// ---- predicate walk ----

/// Distinct oracle assets referenced by the predicate, in first-seen order.
pub fn collect_oracle_assets(root: &Node) -> Vec<Address> {
    let mut out: Vec<Address> = Vec::new();
    walk(root, &mut out);
    out
}

fn walk(node: &Node, out: &mut Vec<Address>) {
    use crate::dsl::Leaf;
    fn push(leaf: &Leaf, out: &mut Vec<Address>) {
        match leaf {
            Leaf::OraclePrice(a) => {
                if !out.iter().any(|x| x == a) {
                    out.push(a.clone());
                }
            }
            // Mirror `dsl::collect_oracle_leaf`: a literal vector can wrap
            // an oracle leaf, and the asset must still be resolved.
            Leaf::LiteralVec(elements) => {
                for e in elements {
                    push(e, out);
                }
            }
            _ => {}
        }
    }
    match node {
        Node::And(children) | Node::Or(children) => {
            for c in children {
                walk(c, out);
            }
        }
        Node::Not(inner) => walk(inner, out),
        Node::Compare { left, right, .. } => {
            push(left, out);
            push(right, out);
        }
        Node::In { needle, haystack } => {
            push(needle, out);
            for h in haystack {
                push(h, out);
            }
        }
    }
}

// ---- cross-feed divergence bounds ----
//
// The two-round confirmation reads ONE feed twice, so it cannot see a feed
// that publishes two consistent forged prices (a malicious upgrade that
// preserves the self-reported fingerprint). The fix: read a SECOND,
// INDEPENDENT feed and deny when the two disagree by more than the bound.
//
// The secondary feed address is compile-time. No such address has been
// selected yet, so this constant is `None` until the
// orchestrator pins one. When None, the resolver fails closed - every
// oracle read denies with `OracleCrossFeedDivergence` because the
// cross-feed validation cannot form. This is the same shape the existing
// oracle code uses: missing/paused/stale/decode-failed reads deny, never
// permit. Adding a new constant is the work; picking the address is the
// orchestrator's.

#[cfg(test)]
mod secondary_feed_tests {
    use super::usable_secondary;

    const PRIMARY: &str = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
    const OTHER: &str = "CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP";

    #[test]
    fn a_distinct_secondary_is_usable() {
        assert_eq!(usable_secondary(PRIMARY, Some(OTHER)), Some(OTHER));
    }

    /// The whole point. Pointing the secondary at the primary would make the
    /// divergence check compare a feed with itself, agree always, and read as
    /// a passing security control while enforcing nothing.
    #[test]
    fn a_secondary_equal_to_the_primary_is_not_a_second_opinion() {
        assert_eq!(usable_secondary(PRIMARY, Some(PRIMARY)), None);
    }

    #[test]
    fn an_unconfigured_secondary_is_none() {
        assert_eq!(usable_secondary(PRIMARY, None), None);
    }
}

#[cfg(test)]
mod bounds_tests {
    use super::Bounds;

    // Tightening cross-feed deviation works.
    #[test]
    fn cross_feed_default_is_used_when_unspecified() {
        let b = Bounds::from_params(None, None, None).expect("defaults install");
        assert_eq!(
            b.max_cross_feed_deviation_bps,
            super::DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS
        );
    }

    // The exact-equal-to-default case installs - mirroring `from_params` for
    // the staleness/deviation fields, which the audit verified correct at
    // every boundary including exact-equal-to-default.
    #[test]
    fn cross_feed_exact_default_installs() {
        let b = Bounds::from_params(
            None,
            None,
            Some(super::DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS as u32),
        )
        .expect("exact default installs");
        assert_eq!(
            b.max_cross_feed_deviation_bps,
            super::DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS
        );
    }

    // A tighter bound installs and is preserved.
    #[test]
    fn cross_feed_tightening_installs() {
        let b = Bounds::from_params(None, None, Some(100)).expect("tighter installs");
        assert_eq!(b.max_cross_feed_deviation_bps, 100);
    }

    // A looser bound is refused at install - a policy cannot buy itself a
    // wider cross-feed tolerance than the audited default allows.
    #[test]
    fn cross_feed_loosening_is_refused() {
        let too_loose: u32 = (super::DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS + 1) as u32;
        assert!(Bounds::from_params(None, None, Some(too_loose)).is_err());
    }

    // Zero is refused - it would be a bound no live feed could satisfy, a
    // misconfiguration rather than a strict policy.
    #[test]
    fn cross_feed_zero_is_refused() {
        assert!(Bounds::from_params(None, None, Some(0)).is_err());
    }

    // The default + a None cross-feed still installs - `None` keeps the
    // default, distinct from `Some(0)` which is a hard-zero and is refused.
    #[test]
    fn cross_feed_none_uses_default_not_zero() {
        let b = Bounds::from_params(None, None, None).expect("None is not zero");
        assert!(b.max_cross_feed_deviation_bps > 0);
    }
}
