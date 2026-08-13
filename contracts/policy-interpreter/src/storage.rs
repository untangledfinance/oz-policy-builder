//! Per-(smart_account, rule_id) state, panic helpers, sha256 utilities.
//!
//! Storage layout (everything `persistent()`, never `instance()`):
//!   `(account, rule_id, K_DOC)`                      -> `StoredDoc`
//!   `(account, rule_id, K_NONCE)`                    -> `u32`
//!   `(account, rule_id, K_SIGNERS_HASH)`             -> `BytesN<32>`
//!   `(account, rule_id, K_MASTER_SET)`               -> `Vec<Signer>`
//!   `(account, rule_id, K_INVOCATION_COUNT, ws)`     -> `u32`

extern crate alloc;

use soroban_sdk::Vec;
use soroban_sdk::{
    contracterror, contracttype, panic_with_error, Address, Bytes, BytesN, Env, IntoVal,
};

use crate::dsl::DenyReason;
use crate::types::Signer;

// ---- contract error ABI ----
//
// Every deny code the interpreter can emit is a variant here, so the host
// surfaces it as `Error(Contract, N)` in the diagnostic event - machine-
// readable off chain. The numeric codes are a PUBLIC ABI: the off-chain
// UI / wallet / audit tooling consumes them. They are grouped and never
// renumbered once published (add new codes at the next free slot in the
// group; do not reuse a retired number).
//
//   1xx  predicate / evaluator denies (mirrors `dsl::DenyReason`)
//   2xx  install / auth / state denies
//   3xx  oracle denies (install-time shape + runtime resolution)
//
// The string form of each code (the `code_str()` impl below) mirrors the
// TS-side enum in `packages/policy-synth/src/errors.ts` so a review card
// can name the failure in human language and a machine can match on the
// numeric code.

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    // ---- 1xx predicate / evaluator ----
    ArgMismatch = 100,
    ContractScope = 101,
    ArithmeticOverflow = 102,
    UnsupportedNode = 103,
    StatefulBound = 104,
    NotInAllowlist = 105,
    Frequency = 106,
    // A `call_arg >= call_arg_scaled(..)` floor was not met. Distinct from
    // StatefulBound so a violated slippage floor reads as one in the review
    // card rather than as a generic numeric bound.
    SlippageFloor = 107,

    // ---- 2xx install / auth / state ----
    VersionMismatch = 200,
    MalformedPredicate = 201,
    NonceReplay = 202,
    MasterAuthRequired = 203,
    RuleSignersChanged = 204,
    PredicateFalse = 205,
    MissingState = 206,
    PredicateTooLarge = 207,
    PredicateHashMismatch = 208,
    EmptySignerSet = 209,
    NoAuthenticatedSigners = 210,
    TooManyInvocationWindows = 211,
    ExternalSignerNotSupported = 212,
    ValidUntilNotSupported = 213,
    // A `call_arg_scaled` leaf carried `den == 0` or non-positive
    // `num`/`den`. Refused at install (`validate_scaled_ratios`) so a
    // ratio that would silently invert the comparison or divide by zero
    // cannot be installed in the first place.
    InvalidScaledRatio = 214,

    // ---- 3xx oracle ----
    OracleLeafInvalidPosition = 300,
    OracleReadLimit = 301,
    OracleEnvelopeRequired = 302,
    OracleParamsOutOfRange = 303,
    OracleStale = 304,
    OracleMissing = 305,
    OracleDeviationExceeded = 306,
    OraclePaused = 307,
    OracleDecimalsMismatch = 308,
    OracleFingerprintDrift = 309,
    // The feed has data but the two-round confirmation cannot be formed -
    // fewer than two distinct timestamps, or rounds that are not exactly
    // one resolution apart. Distinct from OracleMissing so an operator can
    // tell "asset unsupported" from "feed degraded".
    OracleNoConfirmation = 310,
    // The feed returned a non-positive price or non-monotonic timestamps.
    OracleMalformedHistory = 311,
    // The primary and secondary feeds disagree by more than the bound. The
    // two-round confirmation reads one feed twice, so it cannot see a
    // compromised feed publishing consistent forged prices; this can.
    OracleCrossFeedDivergence = 312,
    /// An oracle comparison's threshold did not declare its decimal basis.
    /// Refused at install: without the basis the contract cannot tell a
    /// correctly scaled threshold from one that is 10^5 too large, and the
    /// latter permits everything.
    OracleThresholdBasisRequired = 215,
    /// The declared basis exceeded `MAX_ORACLE_THRESHOLD_DECIMALS`.
    OracleThresholdDecimalsOutOfRange = 313,
}

impl PolicyError {
    /// Human-readable string code (matches `dsl::DenyReason::code()` for the
    /// 1xx group and `packages/policy-synth/src/errors.ts` for the rest).
    /// Surfaced in native env logs but NOT in the on-chain diagnostic event
    /// - that carries only the numeric code from `panic_with_error!`.
    pub const fn code_str(&self) -> &'static str {
        match self {
            PolicyError::ArgMismatch => "ARG_MISMATCH",
            PolicyError::ContractScope => "CONTRACT_SCOPE",
            PolicyError::ArithmeticOverflow => "ARITHMETIC_OVERFLOW",
            PolicyError::UnsupportedNode => "UNSUPPORTED_NODE",
            PolicyError::StatefulBound => "STATEFUL_BOUND",
            PolicyError::NotInAllowlist => "NOT_IN_ALLOWLIST",
            PolicyError::Frequency => "FREQUENCY",
            PolicyError::SlippageFloor => "SLIPPAGE_FLOOR",
            PolicyError::VersionMismatch => "VERSION_MISMATCH",
            PolicyError::MalformedPredicate => "MALFORMED_PREDICATE",
            PolicyError::NonceReplay => "NONCE_REPLAY",
            PolicyError::MasterAuthRequired => "MASTER_AUTH_REQUIRED",
            PolicyError::RuleSignersChanged => "RULE_SIGNERS_CHANGED",
            PolicyError::PredicateFalse => "PREDICATE_FALSE",
            PolicyError::MissingState => "MISSING_STATE",
            PolicyError::PredicateTooLarge => "PREDICATE_TOO_LARGE",
            PolicyError::PredicateHashMismatch => "PREDICATE_HASH_MISMATCH",
            PolicyError::EmptySignerSet => "EMPTY_SIGNER_SET",
            PolicyError::NoAuthenticatedSigners => "NO_AUTHENTICATED_SIGNERS",
            PolicyError::TooManyInvocationWindows => "TOO_MANY_INVOCATION_WINDOWS",
            PolicyError::ExternalSignerNotSupported => "EXTERNAL_SIGNER_NOT_SUPPORTED",
            PolicyError::ValidUntilNotSupported => "VALID_UNTIL_NOT_SUPPORTED",
            PolicyError::InvalidScaledRatio => "INVALID_SCALED_RATIO",
            PolicyError::OracleLeafInvalidPosition => "ORACLE_LEAF_INVALID_POSITION",
            PolicyError::OracleReadLimit => "ORACLE_READ_LIMIT",
            PolicyError::OracleEnvelopeRequired => "ORACLE_ENVELOPE_REQUIRED",
            PolicyError::OracleParamsOutOfRange => "ORACLE_PARAMS_OUT_OF_RANGE",
            PolicyError::OracleStale => "ORACLE_STALE",
            PolicyError::OracleMissing => "ORACLE_MISSING",
            PolicyError::OracleNoConfirmation => "ORACLE_NO_CONFIRMATION",
            PolicyError::OracleMalformedHistory => "ORACLE_MALFORMED_HISTORY",
            PolicyError::OracleCrossFeedDivergence => "ORACLE_CROSS_FEED_DIVERGENCE",
            PolicyError::OracleThresholdBasisRequired => "ORACLE_THRESHOLD_BASIS_REQUIRED",
            PolicyError::OracleThresholdDecimalsOutOfRange => {
                "ORACLE_THRESHOLD_DECIMALS_OUT_OF_RANGE"
            }
            PolicyError::OracleDeviationExceeded => "ORACLE_DEVIATION_EXCEEDED",
            PolicyError::OraclePaused => "ORACLE_PAUSED",
            PolicyError::OracleDecimalsMismatch => "ORACLE_DECIMALS_MISMATCH",
            PolicyError::OracleFingerprintDrift => "ORACLE_FINGERPRINT_DRIFT",
        }
    }
}

impl From<DenyReason> for PolicyError {
    /// Exhaustively maps every `DenyReason` to a `PolicyError` variant. A
    /// new variant added to `DenyReason` will fail to compile until it is
    /// wired here, which is what the audit wants - the contract ABI cannot
    /// drift behind the evaluator.
    fn from(r: DenyReason) -> Self {
        match r {
            DenyReason::ArgMismatch => PolicyError::ArgMismatch,
            DenyReason::ContractScope => PolicyError::ContractScope,
            DenyReason::ArithmeticOverflow => PolicyError::ArithmeticOverflow,
            DenyReason::UnsupportedNode => PolicyError::UnsupportedNode,
            DenyReason::StatefulBound => PolicyError::StatefulBound,
            DenyReason::NotInAllowlist => PolicyError::NotInAllowlist,
            DenyReason::Frequency => PolicyError::Frequency,
            DenyReason::SlippageFloor => PolicyError::SlippageFloor,
            DenyReason::OracleStale => PolicyError::OracleStale,
            DenyReason::OracleMissing => PolicyError::OracleMissing,
            DenyReason::OracleNoConfirmation => PolicyError::OracleNoConfirmation,
            DenyReason::OracleMalformedHistory => PolicyError::OracleMalformedHistory,
            DenyReason::OracleDeviationExceeded => PolicyError::OracleDeviationExceeded,
            DenyReason::OraclePaused => PolicyError::OraclePaused,
            DenyReason::OracleDecimalsMismatch => PolicyError::OracleDecimalsMismatch,
            DenyReason::OracleFingerprintDrift => PolicyError::OracleFingerprintDrift,
            DenyReason::OracleCrossFeedDivergence => PolicyError::OracleCrossFeedDivergence,
            DenyReason::OracleThresholdDecimalsOutOfRange => {
                PolicyError::OracleThresholdDecimalsOutOfRange
            }
        }
    }
}

// ---- panic helpers -----
//
// Every deny goes through `panic_with_error!` so the host emits
// `Error(Contract, N)` rather than a bare trap. Off-chain consumers read
// the numeric code from the diagnostic event; the human-readable string
// (`PolicyError::code_str()`) is only available in the native test env.

pub fn deny(e: &Env, error: PolicyError) -> ! {
    panic_with_error!(e, error);
}

pub(crate) fn panic_version_mismatch(e: &Env) -> ! {
    deny(e, PolicyError::VersionMismatch)
}
pub(crate) fn panic_malformed_predicate(e: &Env) -> ! {
    deny(e, PolicyError::MalformedPredicate)
}
pub(crate) fn panic_nonce_replay(e: &Env) -> ! {
    deny(e, PolicyError::NonceReplay)
}
pub(crate) fn panic_master_auth_required(e: &Env) -> ! {
    deny(e, PolicyError::MasterAuthRequired)
}
pub(crate) fn panic_rule_signers_changed(e: &Env) -> ! {
    deny(e, PolicyError::RuleSignersChanged)
}
pub(crate) fn panic_predicate_false(e: &Env) -> ! {
    deny(e, PolicyError::PredicateFalse)
}
pub(crate) fn panic_missing_state(e: &Env) -> ! {
    deny(e, PolicyError::MissingState)
}
pub(crate) fn panic_predicate_too_large(e: &Env) -> ! {
    deny(e, PolicyError::PredicateTooLarge)
}
pub(crate) fn panic_predicate_hash_mismatch(e: &Env) -> ! {
    deny(e, PolicyError::PredicateHashMismatch)
}
pub(crate) fn panic_oracle_leaf_invalid_position(e: &Env) -> ! {
    deny(e, PolicyError::OracleLeafInvalidPosition)
}
pub(crate) fn panic_oracle_read_limit(e: &Env) -> ! {
    deny(e, PolicyError::OracleReadLimit)
}
pub(crate) fn panic_oracle_envelope_required(e: &Env) -> ! {
    deny(e, PolicyError::OracleEnvelopeRequired)
}
pub(crate) fn panic_oracle_params_out_of_range(e: &Env) -> ! {
    deny(e, PolicyError::OracleParamsOutOfRange)
}
pub(crate) fn panic_empty_signer_set(e: &Env) -> ! {
    deny(e, PolicyError::EmptySignerSet)
}
pub(crate) fn panic_no_authenticated_signers(e: &Env) -> ! {
    deny(e, PolicyError::NoAuthenticatedSigners)
}
pub(crate) fn panic_too_many_invocation_windows(e: &Env) -> ! {
    deny(e, PolicyError::TooManyInvocationWindows)
}
pub(crate) fn panic_external_signer_not_supported(e: &Env) -> ! {
    deny(e, PolicyError::ExternalSignerNotSupported)
}
pub(crate) fn panic_valid_until_not_supported(e: &Env) -> ! {
    deny(e, PolicyError::ValidUntilNotSupported)
}
pub(crate) fn panic_invalid_scaled_ratio(e: &Env) -> ! {
    deny(e, PolicyError::InvalidScaledRatio)
}
pub(crate) fn panic_oracle_threshold_basis_required(e: &Env) -> ! {
    deny(e, PolicyError::OracleThresholdBasisRequired)
}
/// Evaluator-driven deny: surface the specific `DenyReason` as the contract
/// error code so a review card can name it. The match in `From<DenyReason>`
/// is exhaustive, so a new `DenyReason` variant cannot compile without a
/// matching `PolicyError` code.
pub(crate) fn panic_deny_reason(e: &Env, reason: DenyReason) -> ! {
    deny(e, PolicyError::from(reason));
}

// ---- storage key constants (u32 because u8 doesn't impl IntoVal) -----

pub const K_DOC: u32 = 1;
pub const K_NONCE: u32 = 2;
pub const K_SIGNERS_HASH: u32 = 3;
pub const K_MASTER_SET: u32 = 4;
pub const K_INVOCATION_COUNT: u32 = 6;

// ---- TTL self-extend -----
//
// `enforce` bumps an entry whose remaining TTL has fallen below
// `TTL_BUMP_THRESHOLD` back up to `TTL_BUMP_TO`. The bump happens before the
// predicate check: a denied enforcement panics, and the Soroban host rolls
// the storage frame back with it, so a deny cannot buy an extension. That is
// what makes this allow-path-only without an explicit branch.

/// Bump when fewer than this many ledgers of TTL remain.
pub const TTL_BUMP_THRESHOLD: u32 = 100;

/// Bump back up to this many ledgers. Roughly 30 days at Stellar's ~5s close
/// time (30 * 24 * 60 * 60 / 5 = 518,400), so a rule used at least monthly
/// never archives, while an abandoned rule still ages out rather than
/// occupying state rent forever.
pub const TTL_BUMP_TO: u32 = 518_400;

pub struct RuleKey {
    pub account: Address,
    pub rule_id: u32,
}

impl RuleKey {
    pub fn new(_e: &Env, account: Address, rule_id: u32) -> Self {
        Self { account, rule_id }
    }

    pub fn doc_key(&self) -> DocKeyTuple {
        (self.account.clone(), self.rule_id, K_DOC)
    }
    pub fn nonce_key(&self) -> NonceKeyTuple {
        (self.account.clone(), self.rule_id, K_NONCE)
    }
    pub fn signers_hash_key(&self) -> SignersHashKeyTuple {
        (self.account.clone(), self.rule_id, K_SIGNERS_HASH)
    }
    pub fn master_set_key(&self) -> MasterSetKeyTuple {
        (self.account.clone(), self.rule_id, K_MASTER_SET)
    }
    pub fn invocation_count_key(&self, window_secs: u64) -> InvocationCountKeyTuple {
        (
            self.account.clone(),
            self.rule_id,
            K_INVOCATION_COUNT,
            window_secs,
        )
    }
}

pub type DocKeyTuple = (Address, u32, u32);
pub type NonceKeyTuple = (Address, u32, u32);
pub type SignersHashKeyTuple = (Address, u32, u32);
pub type MasterSetKeyTuple = (Address, u32, u32);
pub type InvocationCountKeyTuple = (Address, u32, u32, u64);

// ---- stored doc -----
//
// Persist the raw canonical ScVal XDR bytes the install payload carried.
// Enforce re-decodes from these on every call via the host's `Val::from_xdr`.

#[contracttype]
#[derive(Clone, Debug)]
pub struct StoredDoc {
    pub predicate_bytes: Bytes,
    pub oracle_max_staleness_seconds: Option<u32>,
    pub oracle_max_deviation_bps: Option<u32>,
    /// Per-policy override on the cross-feed deviation bound. Same shape as
    /// the other two: `None` means the wasm default, an override may only
    /// TIGHTEN against `oracle::DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS`.
    /// Field name kept under 30 chars for the soroban-sdk contracttype limit.
    pub oracle_max_xfeed_dev_bps: Option<u32>,
}

pub type StoredRule = StoredDoc;

// ---- sha256 helpers ----

/// Stable 32-byte hash of the signer set. Each signer is serialized via the
/// SDK's `Val::to_xdr` (its canonical XDR form) and prefixed with a length
/// to keep the encoding unambiguous. The host computes sha256.
pub fn sha256_of_signer_set(env: &Env, signers: &Vec<Signer>) -> BytesN<32> {
    let mut buf: Bytes = Bytes::new(env);
    for s in signers.iter() {
        let part: Bytes = match &s {
            Signer::Delegated(a) => val_to_xdr(env, &a.clone().into_val(env)),
            Signer::External(a, sig) => {
                let mut b = val_to_xdr(env, &a.clone().into_val(env));
                b.append(sig);
                b
            }
        };
        let len: u32 = part.len();
        buf.append(&Bytes::from_slice(env, &len.to_be_bytes()));
        buf.append(&part);
    }
    env.crypto().sha256(&buf).into()
}

fn val_to_xdr(env: &Env, val: &soroban_sdk::Val) -> Bytes {
    use soroban_sdk::xdr::ToXdr;
    (*val).to_xdr(env)
}
