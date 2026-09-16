# Single-adapter implementation plan

> Execute inline with the executing-plans skill; Prime independently verifies after handoff.

Goal: implement the scoped execution design without a separate ExecutionPolicy deployment.
Spec: ../specs/2026-09-16-single-adapter-design.md
Stack: Soroban SDK 27.0.2, Rust, TypeScript/Bun, actual OZ account WASM.

- [x] Add a failing install test for execution_v1; preserve legacy version-5 regression expectations through explicit version compatibility for legacy documents only.
- [x] Implement execution types, bounded plan validation and scope lifecycle in contracts/policy-interpreter/src/execution.rs; integrate through existing install/enforce, preserving all admin/signature checks. Grammar identity is 6; legacy documents may explicitly use 5, execution envelopes must use 6.
- [x] Add adapter lifecycle calls with immutable interpreter binding; keep execute ABI unchanged. Native tests exercise begin/end and rollback.
- [x] Implement a typed execution-envelope encoder and Blend supply/withdraw builder in packages/policy-synth. Exact plan lengths, recursive auth shapes, amount equality links and fixed recipients prevent partial funding and mismatched transfers.
- [x] Run interpreter/adapter native tests and builder tests; build WASMs.
- [x] Adapt the existing real OZ/Blend harness to fresh state, new interpreter/envelope, two-argument adapter constructor and new negative tests. Record hashes, real receipts, simulation denials and cleanup.
- [x] Commit code/evidence and hand Prime exact commands, integration changes, address/hash requirements, remaining mainnet/UI verification. Do not enable the superseded UI or silently migrate rules.
