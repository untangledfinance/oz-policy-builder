//! Per-(smart_account, rule_id) state, panic helpers, sha256 utilities.
//!
//! Storage layout (everything `persistent()`, never `instance()`):
//!   `(account, rule_id, K_DOC)`                      -> `StoredDoc`
//!   `(account, rule_id, K_NONCE)`                    -> `u32`
//!   `(account, rule_id, K_SIGNERS_HASH)`             -> `BytesN<32>`
//!   `(account, rule_id, K_MASTER_SET)`               -> `Vec<Signer>`

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
//
// Retired numbers must stay retired - a new code lives in the next free slot
// in its group, never at a recycled value. Retired so far: the whole 3xx group
// (oracle support, grammar v2), and 104 (the rolling-window deny, grammar v3 -
// the evaluator compares but never accumulates).
//
// 102 was retired in v3 and RESTORED in v4 to its original meaning, arithmetic
// overflow, when `call_arg_scaled` brought back a computed operand. Restoring
// a number to the meaning it always had is safe; the rule against recycling
// exists so a consumer that remembers `102 = ARITHMETIC_OVERFLOW` is never
// wrong, and here it stays right. 107 and 214 are new in v4 and take the next
// free slot in their groups.
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
    /// A `call_arg_scaled` operand overflowed `checked_mul`/`checked_div`, or
    /// reached the evaluator with a zero denominator. Denies rather than
    /// panicking the frame on the arithmetic itself.
    ArithmeticOverflow = 102,
    UnsupportedNode = 103,
    NotInAllowlist = 105,
    /// A comparison against a `call_arg_scaled` operand failed. Distinct from
    /// `ArgMismatch` so a swap policy's review card can say "output below the
    /// floor" rather than "argument mismatch".
    SlippageFloor = 107,

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
    /// A `call_arg_scaled` leaf declared `den == 0`, or a non-positive `num`
    /// or `den`. A zero denominator would divide by zero at evaluate; a
    /// negative ratio silently INVERTS the comparison, so a floor written as
    /// `call_arg >= call_arg_scaled(in, -1, 100)` would permit exactly the
    /// trades it was meant to refuse. Refused at install so the mistake is
    /// loud once rather than silent forever.
    InvalidScaledRatio = 214,
    /// Predicate carries no selector leaf - literals on both sides of every
    /// compare, no `call_contract`/`call_fn`/`call_arg`/`now`. Such a
    /// predicate is either trivially true or trivially false at install
    /// time, so it permits everything or nothing forever. Refused at
    /// install.
    SelectorLeafRequired = 216,
    /// Master signer set exceeded `MAX_SIGNERS`. Re-hashed on every permit
    /// and one `require_auth` per signer; an unbounded set pushes `enforce`
    /// past the CPU budget and bricks the rule.
    TooManySigners = 217,
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
            DenyReason::NotInAllowlist => PolicyError::NotInAllowlist,
            DenyReason::SlippageFloor => PolicyError::SlippageFloor,
        }
    }
}

// ---- deny -----
//
// Every deny goes through `panic_with_error!` so the host emits
// `Error(Contract, N)` rather than a bare trap. Off-chain consumers read the
// numeric code from the diagnostic event.

pub fn deny(e: &Env, error: PolicyError) -> ! {
    panic_with_error!(e, error);
}

// ---- storage key constants (u32 because u8 doesn't impl IntoVal) -----

pub const K_DOC: u32 = 1;
pub const K_NONCE: u32 = 2;
pub const K_SIGNERS_HASH: u32 = 3;
pub const K_MASTER_SET: u32 = 4;

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
    pub fn new(account: Address, rule_id: u32) -> Self {
        Self { account, rule_id }
    }

    pub fn doc_key(&self) -> RuleStorageKey {
        (self.account.clone(), self.rule_id, K_DOC)
    }
    pub fn nonce_key(&self) -> RuleStorageKey {
        (self.account.clone(), self.rule_id, K_NONCE)
    }
    pub fn signers_hash_key(&self) -> RuleStorageKey {
        (self.account.clone(), self.rule_id, K_SIGNERS_HASH)
    }
    pub fn master_set_key(&self) -> RuleStorageKey {
        (self.account.clone(), self.rule_id, K_MASTER_SET)
    }
}

/// Every per-rule entry is keyed by the same `(account, rule_id, tag)` shape.
pub type RuleStorageKey = (Address, u32, u32);

// ---- stored doc -----
//
// Persist the raw canonical ScVal XDR bytes the install payload carried.
// Enforce re-decodes from these on every call via the host's `Val::from_xdr`.

#[contracttype]
#[derive(Clone, Debug)]
pub struct StoredDoc {
    pub predicate_bytes: Bytes,
}

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
