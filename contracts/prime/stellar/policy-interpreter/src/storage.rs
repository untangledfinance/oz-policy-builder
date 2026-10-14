//! Per-(smart_account, rule_id) state and the contract error ABI.
//!
//! Storage layout (`persistent()`, never `instance()`): ONE entry per rule,
//! `(account, rule_id) -> StoredDoc`. The predicate, executor binding, install
//! nonce, operator-set hash and master set were separate entries; they share a
//! lifecycle (written together at install, bumped together on every permit),
//! and any one archiving would have bricked the rule, so they now live and
//! expire together.

use soroban_sdk::{contracterror, contracttype, panic_with_error, Address, Bytes, BytesN, Env};

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
//
// Retired numbers must stay retired - a new code lives in the next free slot
// in its group, never at a recycled value. Retired so far: the whole 3xx group
// (oracle support, grammar v2), 104 (the rolling-window deny, grammar v3 -
// the evaluator compares but never accumulates), and, in grammar 7, 107
// (slippage floor) and 214 (invalid scaled ratio): `scaled` resolves to a plain
// number, so a failed comparison against it is an ordinary ARG_MISMATCH, and a
// non-positive denominator is refused as MALFORMED_PREDICATE at decode.
//
// 102 was retired in v3 and RESTORED in v4 to its original meaning, arithmetic
// overflow, when `call_arg_scaled` (now `scaled`) brought back a computed
// operand. Restoring a number to the meaning it always had is safe; the rule
// against recycling exists so a consumer that remembers
// `102 = ARITHMETIC_OVERFLOW` is never wrong, and here it stays right. 107 and
// 214 were added in v4 and retired in v7, as above.
//
// The numeric codes mirror the TS-side enum in
// `packages/policy-synth/src/errors.ts` so a review card can name the failure
// in human language and a machine can match on the number.

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    // ---- 1xx predicate / evaluator ----
    ArgMismatch = 100,
    ContractScope = 101,
    /// A `scaled` step overflowed `i128` (`checked_mul`/`checked_div`/
    /// `checked_add`). Denies rather than panicking the frame on the arithmetic
    /// itself. A constant-only overflow is refused at install instead.
    ArithmeticOverflow = 102,
    UnsupportedNode = 103,
    NotInAllowlist = 105,

    // ---- 2xx install / auth / state ----
    VersionMismatch = 200,
    MalformedPredicate = 201,
    NonceReplay = 202,
    MasterAuthRequired = 203,
    RuleSignersChanged = 204,
    MissingState = 206,
    PredicateTooLarge = 207,
    PredicateHashMismatch = 208,
    EmptySignerSet = 209,
    NoAuthenticatedSigners = 210,
    ExternalSignerNotSupported = 212,
    /// Predicate carries no selector leaf - literals on both sides of every
    /// compare, no `call_contract`/`call_fn`/`call_path`. `read` and `now` do not count. Such a
    /// predicate is either trivially true or trivially false at install
    /// time, so it permits everything or nothing forever. Refused at
    /// install.
    SelectorLeafRequired = 216,
    /// Master signer set exceeded `MAX_SIGNERS`. Re-hashed on every permit
    /// and one `require_auth` per signer; an unbounded set pushes `enforce`
    /// past the CPU budget and bricks the rule.
    TooManySigners = 217,
    /// The context rule reaches the admin surface: it is `Default`-scoped
    /// (matches every operation on the account, including its own
    /// administration), or scoped to the smart account itself or to this
    /// interpreter. The predicate would be the only fence around
    /// `add_context_rule` and the interpreter's own install and rotation, and
    /// a weakened predicate would hand the rule's operators the whole account.
    /// Predicates install on rules scoped to some other contract only.
    DefaultContextNotSupported = 218,
    /// A signer set (the rule's operators or the master set) holds this
    /// interpreter's own address. Nobody can authorise as it, so the master set
    /// could never uninstall or rotate and the rule would be bricked.
    SignerIsInterpreter = 219,
}

// ---- deny -----
//
// Every deny goes through `panic_with_error!` so the host emits
// `Error(Contract, N)` rather than a bare trap. Off-chain consumers read the
// numeric code from the diagnostic event.

pub fn deny(e: &Env, error: PolicyError) -> ! {
    panic_with_error!(e, error);
}

/// Contract side: deny with `error` unless `ok` (the decoder's `ensure` returns a `Result`).
pub fn deny_unless(e: &Env, ok: bool, error: PolicyError) {
    if !ok {
        deny(e, error);
    }
}

/// The rule's stored entry; a missing one is `MISSING_STATE`.
pub fn load(e: &Env, key: &(Address, u32)) -> StoredDoc {
    (e.storage().persistent().get(key)).unwrap_or_else(|| deny(e, PolicyError::MissingState))
}

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

// ---- stored doc -----
//
// The raw canonical ScVal XDR bytes the install payload carried; enforce
// re-decodes from these on every call via the host's `Val::from_xdr`.

#[contracttype]
#[derive(Clone, Debug)]
pub struct StoredDoc {
    /// Part of the document lifecycle; requires a fresh interpreter deployment.
    pub executor: Option<Address>,
    pub predicate_bytes: Bytes,
    pub nonce: u32,
    /// Hash of the rule's operator set, re-checked on every enforce.
    pub signers_hash: BytesN<32>,
    /// The Policy Signer role: authorises re-install, uninstall and rotation.
    pub master_set: soroban_sdk::Vec<Signer>,
}
