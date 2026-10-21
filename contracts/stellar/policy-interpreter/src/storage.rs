//! Per-(smart_account, rule_id) state and the contract error ABI.
//!
//! Storage layout: the deploy-time `Limits` are the one `instance()` entry, written by
//! the constructor. Everything else is `persistent()`: ONE entry per rule,
//! `(account, rule_id) -> StoredDoc`. The predicate, the executor, the nonce,
//! the operator-set hash and the master set all sit in that one doc: they share
//! a lifecycle (written together at install, bumped together when a permit
//! bumps them), and as separate entries any one archiving would brick the rule,
//! so they live and expire together.

use soroban_sdk::{contracterror, contracttype, panic_with_error, Address, Bytes, BytesN, Env};

use crate::types::{Limits, Signer};

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
// in its group, never at a recycled value. Reserved and never reused: the whole
// 3xx group (oracle support), 104 (a rolling-window deny; the evaluator
// compares but never accumulates), 107 (a slippage floor) and 214 (an invalid
// scaled ratio). The last two are unused because `scaled` resolves to a plain
// number, so a failed comparison against it is an ordinary ARG_MISMATCH, and a
// non-positive denominator is refused as MALFORMED_PREDICATE at decode.
//
// 102 has one meaning only, arithmetic overflow: a `scaled` step that
// overflows `i128` denies with it (see `ArithmeticOverflow` below). Keeping
// each number to one meaning is what the rule against recycling protects:
// a consumer that remembers `102 = ARITHMETIC_OVERFLOW` is never wrong, and
// a consumer that meets a reserved number knows it means nothing here.
// The codes the interpreter emits are exactly the variants of `PolicyError`.
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
    /// itself. A constant product or fold that overflows is refused at install
    /// instead, whether or not `add` is constant.
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
    /// A signer set (the master set or the rule's operators) exceeded
    /// `MAX_SIGNERS`. Re-hashed on every permit
    /// and one `require_auth` per signer; an unbounded set pushes `enforce`
    /// past the CPU budget and bricks the rule.
    TooManySigners = 217,
    /// The context rule reaches the admin surface: it is `Default`-scoped
    /// (matches every operation on the account, including its own
    /// administration), or scoped to the smart account itself or to this
    /// interpreter. The predicate would be the only fence around
    /// `add_context_rule` and the interpreter's own install and rotation, and
    /// a weakened predicate would hand the rule's operators the whole account.
    /// Only those three are refused: a rule scoped to any other contract still
    /// installs, including another policy contract (a second interpreter, OZ's
    /// `spending_limit`), whose own admin calls it would then expose.
    DefaultContextNotSupported = 218,
    /// A signer set (the rule's operators or the master set) holds this
    /// interpreter's own address. Nobody can authorise as it: an operator set
    /// holding it could never authorise a call, and a master set holding it could
    /// never uninstall or rotate (the rule would be bricked).
    SignerIsInterpreter = 219,
    /// The deploy-time `Limits` had a field of 0 or above its ceiling; the
    /// constructor refuses, so no such instance exists.
    LimitsOutOfRange = 220,
    /// A rule bound to an executor and scoped to that executor whose predicate
    /// does not pin `call_fn == run` on every path (`dsl::pins_call_fn`). Such
    /// a rule answers the executor's own requests, and `run` is the only one
    /// that needs no grant from it, so anything wider would approve an
    /// `execute` or `cancel` nobody signed. Refused by `bind_executor`, by a
    /// re-install under a binding, and by `enforce` against the rule the
    /// account itself passes.
    RunNotPinned = 221,
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

pub const LIMITS: soroban_sdk::Symbol = soroban_sdk::symbol_short!("limits");

/// The deploy-time limits, kept once in instance storage (the constructor is the
/// only writer, and the contract has no upgrade path).
pub fn load_limits(e: &Env) -> Limits {
    (e.storage().instance().get(&LIMITS)).unwrap_or_else(|| deny(e, PolicyError::MissingState))
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
/// time (30 * 24 * 60 * 60 / 5 = 518,400). The bump runs only when fewer than
/// `TTL_BUMP_THRESHOLD` ledgers (about eight minutes) remain, so a permit keeps
/// the rule alive only if one lands in that last window; a rule authorised less
/// often archives, and a restore brings it back. An abandoned rule ages out
/// rather than occupying state rent forever.
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
    /// The contract a `CallContract` rule is scoped to, as the last install
    /// was told; none for any other scope. Only `bind_executor` reads it, to
    /// refuse binding a self-scoped rule whose predicate leaves `run` open. A
    /// direct install can misstate it, so `enforce` checks the scope of the
    /// rule the account passes, not this.
    pub scope: Option<Address>,
}
