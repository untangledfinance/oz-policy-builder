//! Conformance harness entry. Wires the helpers (`_helpers.rs`) and the
//! auto-generated per-case tests (`_generated.rs`) into a single cargo
//! integration-test binary. Two independent implementations - the Rust
//! interpreter under test and the TypeScript reference evaluator at
//! `packages/policy-synth/src/synth/evaluate.ts` - run against the same
//! predicate + the same EvalContexts, and the per-case assertions lock the
//! verdicts to be equal.
//!
//! Run with:
//!   cargo test --test conformance -p policy-interpreter
//! Regenerate the fixture with:
//!   bun run packages/policy-synth/scripts/gen-conformance-fixture.ts \
//!     --explain /tmp/ozpub/explain-blend.json \
//!     --recording /tmp/ozpub/recording-blend.json \
//!     --out contracts/policy-interpreter/tests/conformance/_generated.rs

mod _generated;
mod _helpers;
mod oracle_threshold;
mod slippage_floor;
