//! Version identity baked into the wasm.
//!
//! The install gate accepts v6 execution documents and ordinary v5/v6 DSL
//! documents. Older deployed interpreters remain immutable.

/// Grammar version this interpreter implements. A new condition type means a
/// new grammar version, which means a new interpreter at a new address - never
/// an upgrade of this one.
///
/// Bumped to 2 when the `oracle_price` / `oracle_threshold` leaves were
/// retired, then to 3 when the grammar was reduced to what the synthesiser
/// actually emits. Removing a leaf variant changes the predicate wire format,
/// so any previously-installed doc carrying a retired variant is refused at
/// install by the version mismatch gate. See `dsl.rs` for the current grammar.
///
/// Bumped to 4 when `or`, `lt`, `gt`, `gte` and the `call_arg_scaled` leaf
/// were added. Widening the grammar rather than narrowing it means a v3
/// document would still decode here, but the version gate refuses it anyway:
/// a v3 builder cannot know whether the interpreter it is addressing speaks
/// the wider grammar, and letting it guess is how a policy silently means
/// something other than what its author reviewed.
///
/// Bumped to 5 when the Policy Signer role was separated from the operators.
/// The predicate grammar is unchanged, but the install ABI is not:
/// `PolicyInstallParams` gained `policy_admins`, so a v4 builder's install
/// document no longer describes what this contract stores. The version gate
/// refuses the skew before a half-understood install can appoint an admin
/// set the author never reviewed.
// Version 6 adds execution_v1 documents and explicit execution scopes.
// Legacy v5 documents remain accepted; execution documents require v6.
pub const SELF_VERSION: u32 = 6;
