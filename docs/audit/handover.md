# Audit handover

Entry point for the external audit of the OZ policy interpreter. It states what
is in scope, what evidence exists for the claims made about it, and what is
knowingly left open.

## 1. Subject

| | |
| --- | --- |
| Contract | `contracts/policy-interpreter` |
| Grammar version | 3 (`SELF_VERSION`, `src/version.rs`) |
| On-chain production code | 842 nSLOC |
| Off-chain toolchain | `packages/policy-synth`, `packages/policy-builder-cli`, `packages/policy-builder-mcp` (6160 nSLOC: `packages/**/*.ts` excluding `*.test.ts`, `test/`, `scripts/`, `dist*/`, blank and comment-only lines) |

What the system does: record a transaction, lower it to a predicate that pins
the contract, method and arguments the recording carried, install that predicate
on an OpenZeppelin smart account, and evaluate it on every guarded call.

Per-file size of the audited contract. Test modules (`dsl_tests.rs`,
`test.rs`) are excluded because they are not the audited surface.

| File | nSLOC |
| --- | ---: |
| `dsl.rs` | 479 |
| `lib.rs` | 173 |
| `storage.rs` | 96 |
| `state.rs` | 29 |
| `types.rs` | 44 |
| `auth.rs` | 20 |
| `version.rs` | 1 |
| **Total** | **842** |

Two properties worth knowing before reading the code:

- **`enforce` is stateless.** It reads no mutable state and writes none. Every
  predicate leaf is answered from the authorised call itself. Verified by
  inspection of every storage and cross-contract call site in `lib.rs`.
- **The grammar is closed and small.** Four node kinds (`and`, `eq`, `lte`,
  `in`), five selector leaves, five literal leaves. Every predicate the
  synthesiser can emit is some combination of those; there is no operator whose
  only caller is a hand-written predicate.
- **There is no intermediate representation between the composer and the
  predicate.** With one enforcement backend the IR was pure translation, so the
  composer emits predicate nodes directly and a `ComposedRule` carries only
  scope, constraints and expiry. Nothing can reach the compiler that it cannot
  compile.
- **The self-call gate is one walk, not three call sites.** Any address literal
  anywhere in the assembled predicate that names the smart account itself is
  refused, so a new constraint shape cannot be added without the check.
- **`simulate_policy` and `verify_policy` share the evaluator the conformance
  harness checks.** `src/simulate/` holds a second implementation of the
  predicate semantics; the harness runs it and the Rust interpreter against the
  same predicate and asserts the verdicts match, so a simulated verdict is a
  claim about the contract rather than about a separate model that could drift
  from it. `verify_policy` reports `ok` only when the recorded transaction is
  permitted AND every generated deny case is denied.
- **Deny cases are derived from the predicate, so coverage is not fixed.** A
  dimension the predicate does not constrain produces no case for it, and `ok`
  means "nothing the harness could construct got through" rather than "this
  policy is tight".

### Deny-case dimensions

The proposal names seven dimensions. The architecture changed underneath them:
it was written for composed OpenZeppelin primitives including
`spending_limit(limit, time_window)`, and became a single audited interpreter.
Two dimensions therefore moved layer and one stopped existing. Where each is
covered now:

| Proposal dimension | Covered by | Layer |
| --- | --- | --- |
| amount | `amount_over_cap` - steps a capped value one unit past its cap | deny harness |
| asset | `contract_scope` when the asset IS the token contract (SEP-41); `map_field_flip` on the `address` field of a Blend `submit` request | deny harness |
| contract | `contract_scope` - the same call sent to another contract | deny harness |
| function | `function_scope` - the same arguments sent to another method | deny harness |
| timing | the context rule's `valid_until`; the interpreter has no clock, so this is not a predicate property | contract tests (`install_enforce.rs`) |
| time-window | **removed.** A rolling per-window total needs a running total across calls, which needs stored state the interpreter does not keep. Supplying a window produced a byte-identical predicate and no warning, so the guarantee was never enforced - removing it is what made that visible | n/a |
| policy-capacity | `build-add-context-rule.ts` refuses more than `OZ_LIMITS.maxPoliciesPerRule` (5) | install builder |

Three further structural dimensions have no proposal counterpart and are
generated anyway: `arg_bound`, `argument_reorder`, `vec_append` and
`soroswap_allowed_path`.

On the three shipped walkthroughs the harness generates 3 to 5 cases each,
depending on what the predicate constrains.
- **The install path is where the fail-closed gates live**, because a predicate
  that reaches evaluation is already committed to.

## 2. Threat model

[`docs/stride-threat-model.md`](../stride-threat-model.md) is the STRIDE model,
built to the Stellar template: STRIDE per element and per data flow, five
entry points, four trust boundaries.

Live residual risks are enumerated there with the reason each is accepted. Four
are OpenZeppelin account-model semantics the interpreter cannot override
(transitive authority, all-of-N versus any-of-N signer sets, the refusal of
`External` masters, and per-rule authority maxima); the rest are scoping
decisions about the off-chain surface.

## 3. Tool reports

Every log in [`evidence/`](evidence/) was produced against this tree.
[`README.md`](README.md) carries the triage for each finding.

| Log | Command | Result |
| --- | --- | --- |
| [`contract-gate.log`](evidence/contract-gate.log) | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm build | clean; 70 tests + 9 conformance pass |
| [`offchain-gate.log`](evidence/offchain-gate.log) | `biome check .`, `bun run typecheck`, `bun test` | clean; 567 pass, 1 skip, 0 fail |
| [`cargo-audit.log`](evidence/cargo-audit.log) | `cargo audit` | 0 vulnerabilities across 202 crates; 1 unmaintained-crate warning |
| [`bun-audit.log`](evidence/bun-audit.log) | `bun audit` | 0 vulnerabilities |
| [`clippy-pedantic.log`](evidence/clippy-pedantic.log) | `clippy -W pedantic -W nursery` | 170 style warnings, 0 security |
| [`scout-audit.log`](evidence/scout-audit.log) | `cargo scout-audit` | 0 Critical, 9 Medium, 1 Enhancement |

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
| Contract | `cargo test` | 79 passed, 0 failed |
| Contract | `cargo test --release --test conformance` | 9 passed, 0 failed |
| Contract | `cargo build --release --target wasm32v1-none` | builds |
| Off-chain | `bunx biome check .` | 111 files, 0 findings |
| Off-chain | `bun run typecheck` | clean |
| Off-chain | `bun test` | 567 passed, 1 skipped, 0 failed |
| Off-chain | `bun audit` | 0 vulnerabilities |

Both gates run in CI on every push, including the two dependency-advisory
scans.

One reported item is triaged as a non-issue rather than fixed, argued in
[`README.md`](README.md#findings):

- `paste` 1.0.15 is flagged unmaintained (RUSTSEC-2024-0436), transitively
  through `soroban-sdk`. The advisory is "no longer maintained", not a
  vulnerability, and it is not actionable without an SDK change.

Scout previously reported two Criticals against `d + 1` in the depth walk. They
were unreachable but the proof was non-local, so the arithmetic was made
saturating instead of argued about; the run is now clean of Criticals.

## 5. Limits of this handover

**The audited tree is not the deployed mainnet binary.** The address pinned in
`run/schemas.ts` runs a different build. An audit of this tree therefore says
nothing about the contract currently deployed, and is only worth commissioning
if this tree is what ships.

Two further caveats, both carried in the threat model rather than only here:

- The off-chain half carries more risk than the on-chain half. The contract is
  842 nSLOC and stateless; the toolchain is 6160 nSLOC and holds the
  default-deny install gates. The toolchain figure previously read 7340. That
  was a restatement, not a deletion of 1180 lines: the old number could not be
  reproduced from the definition printed beside it, and the counter used here
  reproduces the contract's 842 exactly, file by file.
- Coverage of the MCP HTTP transport is thinner than the rest, because the
  deployment model is loopback stdio.
- The conformance harness was broken between `50a2aa4` and this tree: the
  TypeScript reference evaluator it cross-checks against had been deleted and
  the fixture generator was never updated, so `_generated.rs` was a frozen
  artifact rather than a regenerated one. Both sides are restored and the
  fixture regenerates cleanly. The harness was checked for discrimination
  rather than assumed: two deliberate mutations of the Rust evaluator
  (`lte` narrowed to `<`, and `eq` forced true) were each caught, the first by
  the permit case and the second by three deny cases.
