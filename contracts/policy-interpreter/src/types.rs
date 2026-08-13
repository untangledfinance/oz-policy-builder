//! Local types the contract uses in place of the OpenZeppelin `Signer` and
//! `ContextRule`.
//!
//! The `predicate` field on `PolicyInstallParams` is the RAW canonical ScVal
//! XDR (the same bytes the encoder emits). The contract hands those bytes to
//! the host via `Val::from_xdr` and walks the resulting native soroban-sdk
//! tree — see `dsl.rs`. Holding the raw bytes (rather than the parsed
//! `Vec<Val>`) lets install hash-check them with `env.crypto().sha256` and
//! enforce the 32 KB cap before any parsing work.

extern crate alloc;

use soroban_sdk::{contracttype, Bytes, BytesN};

/// An authorised identity for a context rule.
#[contracttype]
#[derive(Clone, Debug)]
pub enum Signer {
    Delegated(soroban_sdk::Address),
    External(soroban_sdk::Address, Bytes),
}

impl Signer {
    pub fn address(&self) -> &soroban_sdk::Address {
        match self {
            Signer::Delegated(a) => a,
            Signer::External(a, _) => a,
        }
    }
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

/// OZ's `ContextRule`, in full.
///
/// Every field is declared even though the interpreter only reads `id`,
/// `signers` and (via the caller) `valid_until`. A `#[contracttype]` struct
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

/// Oracle parameter overrides attached to a policy document.
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleParams {
    pub max_staleness_seconds: u32,
    pub max_deviation_bps: u32,
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
    /// Per-policy oracle bounds. `None` on any field uses the wasm default.
    /// Overrides may only TIGHTEN - a widening value is refused at install.
    ///
    /// Carried as scalars rather than the `Option<OracleParams>` the ABI
    /// note describes: soroban-sdk 27 cannot derive the ScVal conversion for
    /// an `Option<T>` where T is a `#[contracttype]` struct, so that shape
    /// compiles for wasm but breaks every test build. The wire content is
    /// the same set of values.
    pub oracle_max_staleness_seconds: Option<u32>,
    pub oracle_max_deviation_bps: Option<u32>,
    /// Cross-feed divergence bound override (Track B). Tighten-only against
    /// `oracle::DEFAULT_MAX_CROSS_FEED_DEVIATION_BPS`. Field name kept
    /// under 30 chars for the soroban-sdk contracttype limit.
    pub oracle_max_xfeed_dev_bps: Option<u32>,
}
