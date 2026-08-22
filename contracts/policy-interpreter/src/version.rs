//! Version identity baked into the wasm.
//!
//! A document whose `grammar_version` does not match this constant is rejected
//! fail-closed at install, and the check is re-asserted at evaluate as defence
//! in depth.

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
pub const SELF_VERSION: u32 = 4;
