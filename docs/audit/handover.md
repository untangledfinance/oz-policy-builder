# Audit handover

Entry point for the external audit of the OZ policy interpreter. It states what
is in scope, what evidence exists for the claims made about it, and what is
knowingly left open.

## 1. Subject

| | |
| --- | --- |
| Contract | `contracts/policy-interpreter` |
| Grammar version | 2 (`SELF_VERSION`, `src/version.rs`) |
| On-chain production code | 1,225 nSLOC |
| Off-chain toolchain | `packages/policy-synth`, `packages/policy-builder-cli`, `packages/policy-builder-mcp` (roughly 8,500 nSLOC) |

What the system does: record a transaction, synthesise the minimal policy that
permits exactly that flow, install it on an OpenZeppelin smart account, and
evaluate one predicate per guarded call.

Per-file size of the audited contract. Test modules (`dsl_tests.rs`,
`test.rs`) are excluded because they are not the audited surface.

| File | nSLOC |
| --- | ---: |
| `dsl.rs` | 768 |
| `lib.rs` | 182 |
| `storage.rs` | 171 |
| `state.rs` | 39 |
| `types.rs` | 44 |
| `auth.rs` | 20 |
| `version.rs` | 1 |
| **Total** | **1,225** |

Two properties worth knowing before reading the code:

- **`enforce` is stateless.** It reads no mutable state and writes none. Every
  predicate leaf is answered from the authorised call itself. Verified by
  inspection of every storage and cross-contract call site in `lib.rs`.
- **The install path is where the fail-closed gates live**, because a predicate
  that reaches evaluation is already committed to.

## 2. Threat model

[`docs/stride-threat-model.md`](../stride-threat-model.md) is the STRIDE model,
built to the Stellar template: STRIDE per element and per data flow, five
entry points, four trust boundaries.

Live residual risks are enumerated there with the reason each is accepted. In
summary: four are OpenZeppelin account-model semantics the interpreter cannot
override (transitive authority, all-of-N versus any-of-N signer sets, the
refusal of `External` masters, and per-rule authority maxima), and the rest are
scoping decisions about the off-chain surface.

## 3. Tool reports

Every log in [`evidence/`](evidence/) was produced against this tree.
[`README.md`](README.md) carries the triage for each finding.

| Log | Command | Result |
| --- | --- | --- |
| [`contract-gate.log`](evidence/contract-gate.log) | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm build | clean; 94 + 6 tests pass |
| [`offchain-gate.log`](evidence/offchain-gate.log) | `biome check .`, `bun run typecheck`, `bun test` | clean; 839 pass, 1 skip, 0 fail |
| [`cargo-audit.log`](evidence/cargo-audit.log) | `cargo audit` | 0 vulnerabilities across 202 crates; 1 unmaintained-crate warning |
| [`bun-audit.log`](evidence/bun-audit.log) | `bun audit` | 0 vulnerabilities |
| [`clippy-pedantic.log`](evidence/clippy-pedantic.log) | `clippy -W pedantic -W nursery` | 228 style warnings, 0 security |
| [`scout-audit.log`](evidence/scout-audit.log) | `cargo scout-audit` | 2 Critical, 9 Medium, 1 Enhancement - all triaged |

Beyond the tools, the Stellar Security Portal corpus (832 Soroban findings) was
pulled and its 150 critical/high findings cross-checked against this contract's
five entry points. The dominant class, a privileged entry point missing an
authorization check, is tabulated per entry point in
[`README.md`](README.md#4-stellar-security-portal-corpus---832-findings-cross-checked).

`cargo-scout-audit` 0.3.16 reports a build that never compiled as "Analyzed"
with 0 findings, so the Scout numbers above are only meaningful because a
compiled artifact was confirmed under `target/dylint/` first. The exact
invocation is in [`README.md`](README.md#reproducing-the-scout-run). Treat any
Scout run that does not do this as unrun.

## 4. Gates

| Layer | Gate | Result |
| --- | --- | --- |
| Contract | `cargo fmt --check` | clean |
| Contract | `cargo clippy --all-targets -- -D warnings` | 0 warnings |
| Contract | `cargo test` | 94 passed, 0 failed |
| Contract | `cargo test --release --test conformance` | 6 passed, 0 failed |
| Contract | `cargo build --release --target wasm32v1-none` | builds |
| Off-chain | `bunx biome check .` | 145 files, 0 findings |
| Off-chain | `bun run typecheck` | clean |
| Off-chain | `bun test` | 839 passed, 1 skipped, 0 failed |
| Off-chain | `bun audit` | 0 vulnerabilities |

Both gates run in CI on every push, including the two dependency-advisory
scans.

Two reported items are triaged as non-issues rather than fixed, both argued in
[`README.md`](README.md#findings):

- Scout's two Criticals are `d + 1` in the AST depth walk. `decode_with_byte_cap`
  rejects anything over 32 KB before parsing, and each nesting level costs at
  least one byte, so depth is bounded near 3.2x10^4 - eight orders of magnitude
  below `u32::MAX`. Scout reports the raw operator without following the
  dominating guard.
- `paste` 1.0.15 is flagged unmaintained (RUSTSEC-2024-0436), transitively
  through `soroban-sdk`. The advisory is "no longer maintained", not a
  vulnerability, and it is not actionable without an SDK change.

## 5. Limits of this handover

**The audited tree is not the deployed mainnet binary.** The address pinned in
`run/schemas.ts` runs a different build. An audit of this tree therefore says
nothing about the contract currently deployed, and is only worth commissioning
if this tree is what ships.

Two further caveats, both carried in the threat model rather than only here:

- The off-chain half carries more risk than the on-chain half. The contract is
  1,225 nSLOC and stateless; the toolchain is roughly 8,500 nSLOC and holds the
  default-deny install gates.
- Coverage of the MCP HTTP transport is thinner than the rest, because the
  deployment model is loopback stdio.
