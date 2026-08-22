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
| Off-chain toolchain | `packages/policy-synth`, `packages/policy-builder-cli`, `packages/policy-builder-mcp` (6652 nSLOC: `packages/**/*.ts` excluding `*.test.ts`, `test/`, `scripts/`, `dist*/`, blank and comment-only lines) |

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

- **`enforce` writes nothing, and reads only what install fixed.** It makes
  exactly two storage reads - the predicate document and the signer-set hash,
  both under the `(smart_account, rule_id)` key - and performs no writes at all:
  no `set`, `update`, `extend_ttl` or `remove` appears anywhere in the function.
  Both entries are written at install and removed at uninstall, so neither can
  change while a rule is live. There is no clock read and no cross-contract
  call; every predicate leaf is answered from the authorised call itself.
  Verified by inspection of every storage and cross-contract call site in
  `lib.rs`. "Stateless" is used in that sense throughout this document: an
  auditor reading `enforce` will find those two `storage().persistent().get()`
  calls, and they are the whole of it.
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
| [`contract-gate.log`](evidence/contract-gate.log) | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, reproducible wasm build, hash pin parity | clean; 70 tests + 9 conformance pass; built wasm matches the pin |
| [`offchain-gate.log`](evidence/offchain-gate.log) | `biome check .`, `bun run typecheck`, `bun test` | clean; 612 pass, 1 skip, 0 fail |
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

The conformance harness was checked for discrimination rather than assumed to
have it. A harness that passes because it compares nothing is the failure mode
worth ruling out, so the Rust evaluator was deliberately mutated twice and the
harness had to catch both: narrowing `lte` to `<` was caught by the permit case,
and forcing `eq` true was caught by three separate deny cases.

## 4. Gates

| Layer | Gate | Result |
| --- | --- | --- |
| Contract | `cargo fmt --check` | clean |
| Contract | `cargo clippy --all-targets -- -D warnings` | 0 warnings |
| Contract | `cargo test` | 79 passed, 0 failed |
| Contract | `cargo test --release --test conformance` | 9 passed, 0 failed |
| Contract | `contracts/policy-interpreter/build-wasm.sh` | builds; sha256 equals `PINNED_INTERPRETER_WASM_SHA256` |
| Off-chain | `bunx biome check .` | 112 files, 0 findings |
| Off-chain | `bun run typecheck` | clean |
| Off-chain | `bun test` | 612 passed, 1 skipped, 0 failed |
| Off-chain | `bun audit` | 0 vulnerabilities |

Both gates run in CI on every push, including the two dependency-advisory
scans. The deployment-pin guard in `grammar-version-parity.test.ts` is part of
that run: it fails whenever the builder's grammar version and the pinned
deployment disagree, so a red build there means "not shippable against the
current pin" rather than a broken tree.

One reported item is triaged as a non-issue rather than fixed, argued in
[`README.md`](README.md#findings):

- `paste` 1.0.15 is flagged unmaintained (RUSTSEC-2024-0436), transitively
  through `soroban-sdk`. The advisory is "no longer maintained", not a
  vulnerability, and it is not actionable without an SDK change.

## 5. Scope and known issues

**This tree IS the deployed binary, on both networks.** The grammar-version-3
interpreter was deployed on 2026-08-22 and the pins in `run/schemas.ts` were
moved to it. Both instances were created from one uploaded wasm, so the same
binary runs on both networks:

| | |
| --- | --- |
| Interpreter (mainnet) | `CBZXLSTQUITBFZHQH6XRXF3XIVRQR4RHRI64Q5WELS5KGY3ZKJPFWDPF` |
| Interpreter (testnet) | `CCL336TCK2Y5OFNRCMN2M3HVPBCEX4PW5H6EQ5VW5NPMXOCP4ESB5XR4` |
| wasm sha256 | `a2b36e8ac5a61caf3757af26aa79e83f2995b451099f44772383806a55fe3414` |
| Grammar version | 3, matching `SELF_VERSION` |

Verified rather than assumed: the sha256 of the locally built wasm equals the
hash the network returned on upload, and `get_interpreter_info --verifyLive`
reports `liveMatchesPin: true` with `deployedGrammarVersion: 3` against both
networks. The contract remains UNAUDITED; deploying it is what makes an audit of
this tree worth commissioning, not a statement about its assurance level.

The four pinned constants move together or not at all. The wasm hash and grammar
version are single values covering BOTH networks, so re-pinning one network
alone would leave the builder emitting a version the other network refuses -
with a green test run, because `grammar-version-parity.test.ts` compares the
builder against the pin and would then pass. That test exists because this skew
was live until the deployment above: the tree had moved to grammar 3 while the
pin still named version-1 instances, so every install it built was refused on
chain with error 200 `VersionMismatch`.

Two gates hold the pin, because a version number does not identify a binary.
`grammar-version-parity.test.ts` compares the builder's grammar version against
`PINNED_INTERPRETER_GRAMMAR_VERSION`, and a CI step rebuilds the wasm and
compares its sha256 against `PINNED_INTERPRETER_WASM_SHA256` - so a contract
change without a redeploy, or a redeploy that updates the address and version
but not the hash, fails the build.

**The deployed bytecode can be independently verified.** Run
`contracts/policy-interpreter/build-wasm.sh`; the sha256 it prints is the pinned
hash, and it is the hash uploaded to both networks. A bare
`cargo build --release --target wasm32v1-none` will NOT match: rustc bakes the
crate root and the registry source paths into the binary, so an unremapped build
differs per machine - three builds of an earlier commit gave three hashes, one
locally, one with a fresh `CARGO_HOME`, one in CI. The script passes
`--remap-path-prefix` for both roots, verified to produce a byte-identical wasm
across differing source paths and `CARGO_HOME`s, and `strings` on the result
shows no host paths. Anything deployed, or compared against the pin, has to be
built through it.

Two further points on where the risk sits, both carried in the threat model
rather than only here:

- The off-chain half carries more risk than the on-chain half. The contract is
  842 nSLOC and write-free at `enforce`; the toolchain is 6652 nSLOC and holds
  the default-deny install gates.
- Coverage of the MCP HTTP transport is thinner than the rest, because the
  deployment model is loopback stdio.
