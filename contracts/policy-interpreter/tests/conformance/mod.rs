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
//! Regenerate the fixtures with:
//!   bun run packages/policy-synth/scripts/gen-conformance-fixture.ts \
//!     --recording packages/policy-synth/fixtures/recordings/demo-tx-260725/recording-blend.json \
//!     --out contracts/policy-interpreter/tests/conformance/_generated.rs
//!   bun run packages/policy-synth/scripts/gen-conformance-fixture.ts \
//!     --scenario packages/policy-synth/fixtures/conformance/grammar-v4-scenario.json \
//!     --out contracts/policy-interpreter/tests/conformance/_generated_v4.rs
//!
//! `_generated.rs` covers the predicate a recording synthesises. `_generated_v4.rs`
//! covers the grammar-4 operators, which the recording path cannot reach: its
//! deny-case mutators cannot violate a scaled bound, and they skip `or` because
//! violating one branch proves nothing while another can still permit.

mod _generated;
mod _generated_v4;
mod _helpers;
