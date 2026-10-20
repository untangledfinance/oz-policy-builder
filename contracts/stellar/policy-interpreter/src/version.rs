//! Version identity baked into the wasm. `packages/policy-synth`'s
//! grammar-version parity test parses `SELF_VERSION` out of THIS file, so it
//! stays a file of its own.

/// Grammar version this interpreter implements. A new condition type means a
/// new grammar version, which means a new interpreter at a new address - never
/// an upgrade of this one.
///
/// `install` compares the `grammar_version` of the install document with this
/// number before it reads anything else, and refuses a mismatch with
/// `VersionMismatch` (200). The check covers three kinds of change:
///
/// - A leaf variant is removed. The predicate wire format changes, and a
///   document that still carries the removed variant is refused here, before
///   any decoding. See `dsl.rs` for the grammar this number stands for.
///
/// - The grammar is widened. A document written for the narrower grammar
///   would still decode, but the gate refuses it anyway: its builder cannot
///   know whether the interpreter it is addressing speaks the wider grammar,
///   and letting it guess is how a policy silently means something other
///   than what its author reviewed.
///
/// - The install ABI changes while the grammar does not, e.g. a field added
///   to `PolicyInstallParams`. An install document written for another number
///   no longer describes what this contract stores, and the gate refuses the
///   skew before a half-understood install can appoint an admin set the
///   author never reviewed.
///
/// The number is a wire-compatibility check. The grammar it stands for
/// addresses a batch through `call_path` (a rule names the call,
/// the argument and the field it means, so it can tie two arguments of a batch
/// to each other), reads other contracts and the clock (`read` calls a fixed
/// function of a fixed contract with literal arguments; `now` is the ledger
/// timestamp), and computes values with `scaled(src, num, den, add)` over any
/// value leaf. Because of `read`, `enforce` performs cross-contract calls.
///
/// Builders read the number with `grammar_version()` and write it into every
/// install. `policy-synth` mirrors it as `GRAMMAR_VERSION`, and its parity
/// test holds the two equal, so changing one without the other fails CI.
///
/// The value carries no meaning beyond that match. It moves only together
/// with a new interpreter at a new address, never through an upgrade of a
/// deployed instance.
pub const SELF_VERSION: u32 = 7;
