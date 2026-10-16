//! Local types the contract uses in place of the OpenZeppelin `Signer` and
//! `ContextRule`.
//!
//! The `predicate` field on `PolicyInstallParams` is the RAW canonical ScVal
//! XDR (the same bytes the encoder emits). The contract hands those bytes to
//! the host via `Val::from_xdr` and walks the resulting native soroban-sdk
//! tree — see `dsl.rs`. Holding the raw bytes (rather than the parsed
//! `Vec<Val>`) lets install hash-check them with `env.crypto().sha256` and
//! enforce the 32 KB cap before any parsing work.

use soroban_sdk::{contracttype, Bytes, BytesN};

/// An authorised identity for a context rule.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signer {
    Delegated(soroban_sdk::Address),
    External(soroban_sdk::Address, Bytes),
}

/// What a context rule is scoped to. Mirrors OZ's
/// `smart_account::storage::ContextRuleType`.
#[contracttype]
#[derive(Clone, Debug)]
pub enum ContextRuleType {
    Default,
    CallContract(soroban_sdk::Address),
    CreateContract(BytesN<32>),
}

/// Upper bound on a signer set: the master set stored per rule, and the rule's
/// own signers (which `enforce` re-hashes). Far above any realistic OZ context
/// rule; low enough that re-hashing on every permit and one `require_auth` per
/// signer stay well inside the CPU budget.
pub const MAX_SIGNERS: u32 = 16;

/// The interpreter's hard limits, chosen once at deploy time (`__constructor`) and
/// immutable after: no setter exists and the contract cannot be upgraded. `install`
/// and `check` hold a predicate to them (byte size, depth, weighted leaves, distinct
/// reads, `in` entries); `enforce` uses `max_elems` (a longer vector denies) and the
/// depth and entry caps while it decodes. A quantifier body leaf and a `sum` weigh
/// `max_elems` leaves. `MAX_PATH_STEPS` and `MAX_DEN` stay fixed constants.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub max_reads: u32,
    pub max_leaves: u32,
    pub max_predicate_bytes: u32,
    pub max_elems: u32,
    pub max_in_operands: u32,
    pub max_depth: u32,
}

impl Limits {
    /// Every field is at least its FLOOR and at most its HARD CEILING. The floors keep an
    /// instance from being deployed that can hold no rule: the smallest rule of any use (a
    /// function pin and one argument constraint under an `and`) is 4 leaves, 2 levels deep and
    /// under 256 bytes. `max_elems` starts at 2: with one element a body leaf weighs what a
    /// top-level leaf does, and the placement rules, which compare weights, stop holding.
    /// The ceilings (reads 8, leaves 400, bytes 40 KiB, elems 64, `in` entries 64, depth 8)
    /// are set by what a transaction can carry: the README's Limits section has the
    /// measurements, and `tests/worst_case.rs` proves them on the real wasm.
    pub fn in_range(&self) -> bool {
        let ranges = [
            (self.max_reads, 1, 8),
            (self.max_leaves, 4, 400),
            (self.max_predicate_bytes, 256, 40 * 1024),
            (self.max_elems, 2, 64),
            (self.max_in_operands, 1, 64),
            (self.max_depth, 2, 8),
        ];
        ranges.iter().all(|&(v, min, max)| (min..=max).contains(&v))
    }
}

/// OZ's `ContextRule`, in full.
///
/// Every field is declared even though the interpreter only reads `id`,
/// `context_type` (to refuse the scopes that reach the admin surface) and
/// `signers`. A `#[contracttype]` struct
/// decodes from a host map keyed by field name and requires an EXACT field
/// set - a subset raises `Error(Object, UnexpectedSize)` and the call traps
/// before any policy logic runs. This type is the wire shape the smart
/// account sends, not a convenience view of it, so it has to match OZ's
/// definition field for field.
///
/// Pinned against `packages/accounts/src/smart_account/storage.rs` in OZ
/// stellar-accounts. `tests/oz_abi.rs` decodes a hand-built map into this
/// struct so a drift here fails a test rather than only failing on chain.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ContextRule {
    pub id: u32,
    pub context_type: ContextRuleType,
    pub name: soroban_sdk::String,
    pub signers: soroban_sdk::Vec<Signer>,
    pub signer_ids: soroban_sdk::Vec<u32>,
    pub policies: soroban_sdk::Vec<soroban_sdk::Address>,
    pub policy_ids: soroban_sdk::Vec<u32>,
    pub valid_until: Option<u32>,
}

/// Frozen wire ABI for `Policy::install`'s `AccountParams`.
///
/// `predicate` is the raw canonical ScVal XDR — `ScVal::Vec([symbol, ...])`
/// for the root — that the encoder emits. The host parses it on receipt; the
/// contract never touches `stellar-xdr`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PolicyInstallParams {
    pub grammar_version: u32,
    pub install_nonce: u32,
    pub predicate: Bytes,
    pub predicate_hash: BytesN<32>,
    /// The Policy Signer role: the set that authorises re-install, uninstall
    /// and rotation of this mandate. Appointed explicitly here, under the
    /// account's own authorisation, so it can differ from the rule's signers
    /// (the operators). The first install stores it as the master set; a
    /// re-install must present the same set, and only
    /// `rotate_master_signer_set` may change it.
    pub policy_admins: soroban_sdk::Vec<Signer>,
}
