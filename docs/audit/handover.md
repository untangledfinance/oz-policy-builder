# Audit handover

Scope, evidence and known issues for the OZ policy interpreter.

## 1. Subject

| | |
| --- | --- |
| Contract | `contracts/policy-interpreter` |
| Grammar version | 4 (`SELF_VERSION`, `src/version.rs`) |
| On-chain production code | 1008 nSLOC |
| Off-chain toolchain | `packages/policy-synth`, `packages/policy-builder-cli`, `packages/policy-builder-mcp` (7223 nSLOC: `packages/**/*.ts` excluding `*.test.ts`, `test/`, `scripts/`, `dist*/`, blank and comment-only lines) |

What the system does: record a transaction, lower it to a predicate that pins
the contract, method and arguments the recording carried, install that predicate
on an OpenZeppelin smart account, and evaluate it on every guarded call.

Per-file size of the audited contract. Test modules (`dsl_tests.rs`,
`test.rs`) are excluded because they are not the audited surface.

| File | nSLOC |
| --- | ---: |
| `dsl.rs` | 637 |
| `lib.rs` | 176 |
| `storage.rs` | 101 |
| `state.rs` | 29 |
| `types.rs` | 44 |
| `auth.rs` | 20 |
| `version.rs` | 1 |
| **Total** | **1008** |

Properties worth knowing before reading the code:

- **`enforce` creates, changes and removes no state, and reads only what
  install fixed.** It reads two entries - the predicate document and the
  signer-set hash, both under the `(smart_account, rule_id)` key - and calls no
  `set`, `update` or `remove` anywhere. Both are written at install and removed
  at uninstall, so neither can change while a rule is live. There is no clock
  read and no cross-contract call; every predicate leaf is answered from the
  authorised call itself.

  The one write-shaped operation is a TTL bump. On the permit path `enforce`
  calls `state::extend_state_ttl`, which runs `extend_ttl` on the four per-rule
  entries, each guarded by `has` so the bump can never create one. It changes no
  value and adds no entry - it only postpones archival - and it runs BEFORE
  `evaluate`, so a deny panics and the host rolls the bump back with the frame.
  Stated plainly because an auditor reading `enforce` will see that call on the
  line after the decode, and a claim of "no writes at all" would not survive it.
- **The grammar is closed and small.** Eight node kinds (`and`, `or`, `eq`,
  `lt`, `lte`, `gt`, `gte`, `in`), six selector leaves, five literal leaves.
  Every predicate the synthesiser can emit is some combination of those.
  `call_arg_scaled` is the one leaf whose value is COMPUTED rather than read,
  and the only selector allowed on the right of a comparison - which is what
  lets a swap bound its output against its own input.
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
- **The install path is where the fail-closed gates live**, because a predicate
  that reaches evaluation is already committed to.
- **Deny cases are derived from the predicate, so coverage is not fixed.** A
  dimension the predicate does not constrain produces no case for it, and `ok`
  means "nothing the harness could construct got through" rather than "this
  policy is tight".

### Deny-case dimensions

Where each proposal dimension is covered:

| Proposal dimension | Covered by | Layer |
| --- | --- | --- |
| amount | `amount_over_cap` - steps a capped value one unit past its cap | deny harness |
| asset | `contract_scope` when the asset IS the token contract (SEP-41); `map_field_flip` on the `address` field of a Blend `submit` request | deny harness |
| contract | `contract_scope` - the same call sent to another contract | deny harness |
| function | `function_scope` - the same arguments sent to another method | deny harness |
| timing | the context rule's `valid_until`; the interpreter has no clock, so this is not a predicate property | contract tests (`install_enforce.rs`) |
| time-window | **removed.** A rolling per-window total needs a running total across calls, which needs stored state the interpreter does not keep. A window supplied to the builder produced a byte-identical predicate and no warning, so the guarantee was never enforced | n/a |
| policy-capacity | `build-add-context-rule.ts` refuses more than `OZ_LIMITS.maxPoliciesPerRule` (5) | install builder |

Four further structural dimensions have no proposal counterpart and are
generated anyway: `arg_bound`, `argument_reorder`, `vec_append` and
`soroswap_allowed_path`.

On the three shipped walkthroughs the harness generates 3 to 5 cases each,
depending on what the predicate constrains.

## 2. Threat model

[`docs/stride-threat-model.md`](../stride-threat-model.md) is the STRIDE model,
built to the Stellar template: STRIDE per element and per data flow, five
entry points, eight trust boundaries.

One OZ semantic was settled by experiment rather than assumed, because getting
it wrong would have inverted a recommendation: **multiple policies attached to
one context rule compose as ALL-OF.** Two interpreter instances were put on one
rule with predicates that disagreed about the same call, and the refusing one
decided the outcome; a control rule carrying only the permitting policy allowed
the identical call, so the denial belongs to the second policy rather than to a
malformed rule. Evidence in
[`evidence/oz-policy-composition.log`](evidence/oz-policy-composition.log). This
is what makes an OZ built-in primitive attached beside the interpreter - a
`spending_limit`, say - a real bound rather than a bypassable one, and it is the
basis for treating rolling spend caps as the account layer's job.

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
| [`contract-gate.log`](evidence/contract-gate.log) | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, reproducible wasm build, hash pin parity | clean; 107 tests + 9 conformance pass; built wasm matches the pin |
| [`offchain-gate.log`](evidence/offchain-gate.log) | `biome check .`, `bun run typecheck`, `bun test` | clean; 654 pass, 1 skip, 0 fail across 655 tests |
| [`cargo-audit.log`](evidence/cargo-audit.log) | `cargo audit` | 0 vulnerabilities across 202 crates; 1 unmaintained-crate warning |
| [`bun-audit.log`](evidence/bun-audit.log) | `bun audit` | 0 vulnerabilities |
| [`clippy-pedantic.log`](evidence/clippy-pedantic.log) | `clippy -W pedantic -W nursery` | 180 style warnings, 0 security |
| [`scout-audit.log`](evidence/scout-audit.log) | `cargo scout-audit` | 0 Critical, 9 Medium, 0 Minor, 1 Enhancement |

Beyond the tools, the Stellar Security Portal corpus was pulled on 2026-08-04
(832 Soroban findings, 150 critical/high) and cross-checked against this
contract's five entry points. Access control dominates that set; the controls
are tabulated per entry point in
[`README.md`](README.md#3-stellar-security-portal-corpus-cross-checked). Those
corpus counts are dated: the portal's API did not resolve during the grammar-4
re-audit, so they were not re-verified. Grammar 4 added no entry point, so the
cross-check itself still stands.

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

The grammar-4 additions were checked the same way, by mutation rather than by
assuming a passing suite means anything. Collapsing `gt` to `>=` in the scaled
compare, reporting an `or`'s LAST deny instead of its first, and swapping
`checked_div` for `wrapping_div` were each introduced deliberately; the first
run caught only one of the three, and the two tests that closed the other two
were written in response. The conformance harness itself covers the
recording-derived grammar-3 shapes only - the v4 operators are covered by
parallel Rust and TypeScript suites, not differentially.

## 4. Gates

| Layer | Gate | Result |
| --- | --- | --- |
| Contract | `cargo fmt --check` | clean |
| Contract | `cargo clippy --all-targets -- -D warnings` | 0 warnings |
| Contract | `cargo test` | 116 passed, 0 failed |
| Contract | `cargo test --release --test conformance` | 9 passed, 0 failed |
| Contract | `contracts/policy-interpreter/build-wasm.sh` | builds; sha256 equals `PINNED_INTERPRETER_WASM_SHA256` |
| Off-chain | `bunx biome check .` | 123 files, 0 findings |
| Off-chain | `bun run typecheck` | clean |
| Off-chain | `bun test` | 654 passed, 1 skipped, 0 failed |
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

**This tree IS the deployed binary, on both networks.** The grammar-version-4
interpreter was deployed on 2026-08-22 and the pins in `run/schemas.ts` were
moved to it. Both instances were created from one uploaded wasm, so the same
binary runs on both networks:

| | |
| --- | --- |
| Interpreter (mainnet) | `CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52` |
| Interpreter (testnet) | `CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5` |
| wasm sha256 | `b5ba1e35ccf20cd8c13c3a2c3098bf337033a92bcaf475d63c03ddc0cba0fcae` |
| Grammar version | 4, matching `SELF_VERSION` |

Verified rather than assumed: the sha256 of the locally built wasm equals the
hash the network returned on upload, and `get_interpreter_info --verifyLive`
reports `liveMatchesPin: true` with `deployedGrammarVersion: 4` against both
networks.

The four pinned constants move together or not at all. The wasm hash and grammar
version are single values covering BOTH networks, so re-pinning one network
alone would leave the builder emitting a version the other network refuses -
with a green test run, because `grammar-version-parity.test.ts` compares the
builder against the pin and would then pass.

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
  1008 nSLOC and write-free at `enforce`; the toolchain is 7223 nSLOC and holds
  the default-deny install gates.
- Coverage of the MCP HTTP transport is thinner than the rest, because the
  deployment model is loopback stdio.
