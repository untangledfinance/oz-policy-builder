# Execution adapter simplification — 2026-09-16

Branch: `feat/policy-signer`. Baseline: `647ca0f`.

The adapter runtime source drops from 224 to 201 lines after rustfmt (23 fewer, 10.3%). Comments and blank lines are counted consistently. No code was moved to another production file and no tests were deleted.

Changes cache the adapter address and three forbidden management targets, derive direct call contexts while validating calls, simplify recursive authorization checking with a shared forbidden-target list, and construct grants/results through ordered `Vec::from_iter` calls.

The public contract interface, deterministic address domain, authorization-grant order, batch/context/depth/count limits, and forbidden-target checks are preserved. The complete projection implementation is byte-for-byte unchanged. There are no interpreter source changes; the earlier 24-net-line interpreter delta remains intact.

Verification:

- Baseline and refactored native suites: 6 unit + 16 authorization integration + 1 TypeScript/Rust projection fixture test passed each.
- Refactored compiled adapter against the pinned deployed interpreter WASM: all 16 integration tests passed, including rollback, hidden calls, missing signatures, substituted interpreter, child amount limits, and custody-to-venue execution.
- Locked offline release build, rustfmt check, and git diff whitespace check passed.
- Independent review found no correctness/security blockers. Exact CPU/memory equivalence is not claimed; context construction makes different host calls.

Compiled adapter artifact SHA256: `8b2c0db7a1c0a8ab6373555b86df955956cc030568cdbe50002efeee2cb36742` (18,268 bytes). The existing deployed artifact remains `57bf132b9537f0d35b9de4327e047f920938eac655e7d140c108e84da3b03474` (18,367 bytes).

No deployment, on-chain change, SDK/app pin change, or policy migration was performed. The new WASM is a locally verified candidate; using it in production requires an explicit deployment/versioning decision.
