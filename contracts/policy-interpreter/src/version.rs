//! Version identity baked into the wasm.
//!
//! A document whose `grammar_version` does not match this constant is rejected
//! fail-closed at install, and the check is re-asserted at evaluate as defence
//! in depth.

/// Grammar version this interpreter implements. A new condition type means a
/// new grammar version, which means a new interpreter at a new address - never
/// an upgrade of this one.
pub const SELF_VERSION: u32 = 1;
