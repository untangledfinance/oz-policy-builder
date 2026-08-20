# Audit handover

This is the entry point for the external audit of the OZ policy interpreter.
It states what is being handed over, what was done to get it here, and what is
deliberately still open.

Scope of the audit: `contracts/policy-interpreter` (grammar version 2), plus
the off-chain toolkit under `packages/` that builds and installs against it.

| Condition | Status | Evidence |
| --- | --- | --- |
| Skeleton codebase, no more than 50% of the previous size | 2,422 to 1,225 nSLOC, a 49.4% cut | [Size](#1-size) |
| STRIDE re-run, results stated clearly | Re-run against the reduced tree; 2 risks retired, 4 closed | [`stride-threat-model.md`](../stride-threat-model.md) |
| All tool reports produced on the reduced codebase | 6 logs, all regenerated from this tree | [`evidence/`](evidence/) |
| No issues at handover | Both gates clean; 0 advisories on both sides | [Gates](#4-gates) |

## 1. Size

Production sources only. Test modules (`dsl_tests.rs`, `test.rs`) are excluded
because they are not the audited surface.

| File | Before | After |
| --- | ---: | ---: |
| `dsl.rs` | 1,213 | 768 |
| `lib.rs` | 260 | 182 |
| `storage.rs` | 259 | 171 |
| `oracle.rs` | 461 | removed |
| `state.rs` | 156 | 39 |
| `types.rs` | 52 | 44 |
| `auth.rs` | 20 | 20 |
| `version.rs` | 1 | 1 |
| **Total** | **2,422** | **1,225** |

"Before" is commit `da568de`, the initial import of the toolkit.

State the result precisely: the cut is 49.4%, so the remaining tree is 50.6% of
the original - 14 nSLOC above a literal reading of the "no more than 50%"
target. Reaching 1,211 would mean removing another capability rather than
another 14 lines of slack. That trade was put to the sponsor and the 49.4%
figure was accepted.

What went, and why it was safe to lose:

- **The oracle path in full** (`oracle.rs`, the oracle leaves, the oracle pause
  entrypoints, the 3xx error group, the `test-oracle` crate). This removes the
  single largest residual risk in the previous model, an oracle operator who
  controls both feeds, and it removes it by deletion rather than by mitigation.
- **Stateful rate limiting** and most of `state.rs`. This is a real capability
  cut, not dead code.

Removing leaves changes the wire format, so `SELF_VERSION` moved 1 to 2.

What survives is the brief: record a transaction, synthesise the minimal policy
that permits exactly that flow, install it on an OZ smart account.

## 2. What the re-run found

The threat model was regenerated against the reduced tree, not edited in place:
[`docs/stride-threat-model.md`](../stride-threat-model.md).

Retired with the feature - not accepted, not mitigated, gone:

| ID | Was |
| --- | --- |
| R-1 | Oracle operator compromising both feeds beats the within-feed, two-round and cross-feed checks. Previously the headline residual, and not closable by us. |
| R-6 | The oracle circuit breaker was account-scoped but rule-master-gated, so any rule master could pause oracle enforcement across the account. |

Closed by work in this round:

| ID | Was | Closed by |
| --- | --- | --- |
| R-2 | A hand-crafted permissive predicate installs and permits everything. | The interpreter refuses any predicate carrying no selector leaf (216 `SELECTOR_LEAF_REQUIRED`). |
| R-8 | Grammar-version parity held by convention, not by a check. | A test parses `SELF_VERSION` out of `version.rs` and asserts the TypeScript literal matches. |
| A-14 | `bun audit` and `cargo audit` not wired into CI. | Both now run in CI. |
| A-15 | Three high advisories against `@modelcontextprotocol/sdk` 1.18.1. | Pinned to 1.30.0, and the code pattern behind one of them was fixed - see below. |

Still open, with reasons, in the model: R-3, R-4, R-5 and R-7 (all OZ
account-model semantics the interpreter cannot override), and A-6, A-12, A-13
and A-16.

Three findings from this round are worth reading before the code:

1. **A live cross-layer defect.** `SELF_VERSION` had been bumped to 2 with the
   reduction, but the off-chain builder still emitted `grammar_version: 1`.
   Every install the toolkit produced would have failed on chain. Fixed at four
   production sites, and R-8 now pins the parity in CI.
2. **A cross-client instance-reuse defect in the MCP HTTP transport.** One of
   the SDK advisories, GHSA-345p-7cg4-v4c7, describes a code pattern rather
   than just a vulnerable version, and this transport used it: one `McpServer`
   and one `StreamableHTTPServerTransport` built at startup and shared by every
   request. Both are now built per request. A regression test asserts eight
   concurrent clients each get their own JSON-RPC id back.
3. **A CI job that could never have passed.** The contracts matrix still listed
   `test-oracle`, a crate deleted with the oracle path.

Two of those three were found by doing the dependency work rather than by
reading the code, which is the argument for the CI gates now being in place.

## 3. Tool reports

Every log in [`evidence/`](evidence/) was produced against this tree.
[`README.md`](README.md) carries the triage for each.

| Log | Command | Result |
| --- | --- | --- |
| [`contract-gate.log`](evidence/contract-gate.log) | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm build | clean; 94 + 6 tests pass |
| [`offchain-gate.log`](evidence/offchain-gate.log) | `biome check .`, `bun run typecheck`, `bun test` | clean; 839 pass, 1 skip, 0 fail |
| [`cargo-audit.log`](evidence/cargo-audit.log) | `cargo audit` | 0 vulnerabilities across 202 crates; 1 unmaintained-crate warning |
| [`bun-audit.log`](evidence/bun-audit.log) | `bun audit` | 0 vulnerabilities |
| [`clippy-pedantic.log`](evidence/clippy-pedantic.log) | `clippy -W pedantic -W nursery` | 228 style warnings, 0 security |
| [`scout-audit.log`](evidence/scout-audit.log) | `cargo scout-audit` | 2 Critical, 9 Medium, 1 Enhancement - all triaged |

Beyond the tools, the Stellar Security Portal corpus (832 real Soroban
findings) was pulled and its 150 critical/high findings cross-checked against
this contract's five entry points. The dominant class, a privileged entry point
missing an authorization check, is tabulated per entry point in
[`README.md`](README.md#5-stellar-security-portal-corpus---832-findings-cross-checked).

`cargo-scout-audit` 0.3.16 reports a build that never compiled as "Analyzed"
with 0 findings, so the Scout numbers above are only meaningful because a
compiled artifact was confirmed under `target/dylint/` first. The exact
invocation is in [`README.md`](README.md#reproducing-the-scout-run). Treat any
Scout run that does not do this as unrun.

## 4. Gates

Both gates are clean on this tree.

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

## 5. What is not ticked

One item, and it is a governance decision rather than a technical one.

**A-16: the reduced contract is not the deployed mainnet binary.** This tree is
grammar version 2. The address pinned in `run/schemas.ts` runs version 1, with
the oracle path. Auditing this tree therefore says nothing about the contract
currently deployed. That is only the right trade if the reduced version becomes
the shipped product. If it does not, the audit covers a binary nobody runs.

This should be settled before the engagement starts, because it determines
whether the audit result is worth anything operationally.

Two smaller caveats, both stated in the model rather than hidden:

- The off-chain half carries more risk than the on-chain half. The contract is
  1,225 nSLOC and stateless; the toolchain is roughly 8,500 nSLOC and holds the
  default-deny install gates.
- Coverage of the MCP HTTP transport is thinner than the rest, because the
  deployment model is loopback stdio. This round found a real defect on that
  path, which is the argument for widening it.
