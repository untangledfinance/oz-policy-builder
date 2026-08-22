# Audit evidence

Logs in `evidence/` were produced against this tree.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, reproducible wasm build, hash pin parity | clean; 70 tests + 9 conformance pass; built wasm matches the pin |
| `offchain-gate.log` | `biome check .`, `bun run typecheck`, `bun test` | clean; 612 pass, 1 skip, 0 fail |
| `cargo-audit.log` | `cargo audit` | 0 vulnerabilities; 1 unmaintained-crate warning |
| `bun-audit.log` | `bun audit` | 0 vulnerabilities |
| `clippy-pedantic.log` | `clippy -W clippy::pedantic -W clippy::nursery` | 170 style warnings, 0 security |
| `scout-audit.log` | `cargo scout-audit` | Analyzed: 0 Critical, 9 Medium, 0 Minor, 1 Enhancement |
| `e2e-network.log` | `scripts/e2e-network.ts --network testnet` and `--network mainnet` | policy installed against the pinned interpreter on both networks; permitted call succeeds, forbidden call denied `#100` |

## Findings

### 1. `paste` 1.0.15 unmaintained - RUSTSEC-2024-0436 (ACCEPTED)

Transitive through `soroban-sdk`. The advisory is "no longer maintained", not a
vulnerability. Not actionable without an SDK change; `cargo audit` reports 0
vulnerabilities across 202 crate dependencies.

### 2. Scout MEDIUMs - reviewed, no change

- *unbounded operations* x3: the walks are bounded by the 32 KB byte cap
  plus `MAX_DEPTH` 5 / `MAX_LEAVES` 200 / `MAX_IN_OPERAND_COUNT` 32.
- *dynamic types in persistent storage* x2: the master signer set is a
  `Vec<Signer>` by necessity - it mirrors OZ's own rule shape - and is capped
  at `MAX_SIGNERS` 16.
- *Vec/Map parameter without validating contents* x2: both are validated.
  `enforce`'s `authenticated_signers` is checked non-empty and the rule's
  signer set is re-hashed against the hash stored at install;
  `rotate_master_signer_set`'s `new_set` is checked non-empty, capped, and
  refused if it contains an `External` signer.
- *unsafe Map access* x1 and *storage op without access control* x1: the
  storage writes sit after `require_auth` / `require_master` on every path.

### 3. Stellar Security Portal corpus - 832 findings cross-checked

Pulled from the portal's open API: 832 findings, 150 critical or high. Access
control dominates that set, so each of this contract's five entry points was
checked against it.

| Entry point | Control |
| --- | --- |
| `install` | `smart_account.require_auth()` on every install (including the first, so a rule id cannot be pre-seeded), plus `require_master` and a matching signer set on re-install, plus a strictly incrementing `install_nonce` |
| `enforce` | `smart_account.require_auth()`, non-empty authenticated-signer set, live signer hash must equal the hash stored at install |
| `uninstall` | `require_master` |
| `rotate_master_signer_set` | `require_master` on the *old* set |
| `grammar_version` | read-only, touches no state |

`require_master` refuses an empty set rather than treating zero `require_auth`
calls as satisfied - the corpus's "authorization that silently no-ops" class.
The nonce covers its double-spend/replay class.

### 4. End-to-end enforcement on both networks

Static analysis says nothing about whether the deployed contract enforces
anything. `scripts/e2e-network.ts` deploys a fresh OZ smart account, installs
`eq(call_fn, "transfer")` against the pinned interpreter, and exercises both
verdicts through submitted transactions. Mainnet and testnet both pass; two
independent mainnet runs produced the same outcome against different accounts.

Three conditions make the result a claim about the KEY rather than about one
call:

- **The deny is attributed.** The harness fails unless the refusal names the
  interpreter contract and carries `#100 ArgMismatch`. A test asserting only
  that a call failed passes for any reason.
- **The forbidden call is otherwise valid.** `approve` is given an expiration
  ledger ahead of the current one, so the token has no reason of its own to
  reject it and the predicate is the only thing that can.
- **The deny is unroutable.** An account resolves a call against the rule the
  caller NAMES, taking the maximum authority over the named rules rather than
  the intersection, so a predicate constrains a key only when the policed rule
  is the only rule that key is on. The constrained agent is a signer on the
  policed rule and nowhere else, and the harness asserts that its forbidden
  call routed through the unpoliced admin rule is rejected on membership.

The permit is not vacuous because the deny is its control: both calls go through
the same account, rule and policy, so an unbound policy would have let the
`approve` through.

The admin key retains full authority through the unpoliced rule by design. A
policy constrains the keys placed under it, not the account's owner, and any
deployment putting a constrained key on a second unpoliced rule has no
constraint at all.

### 5. Install-time authority overlap

`install/authority-overlap` compares the rule being installed against every
other rule on the account and reports each one a signer could name instead,
classified as `bypass` (the neighbour constrains nothing), `unknown` (policed by
a contract whose semantics cannot be read) or `not-restricting` (ours, but
wider). It matches on shared signers intersected with shared
`(contract, function)` selectors, both being necessary for the signer to have a
choice, and over-approximates what a predicate permits, so a non-intersecting
result is a sound proof that two rules cannot collide. Narrowing would be the
fail-open direction.

Exposed as `findAuthorityOverlaps` from `@crediolabs/policy-synth/install`;
`install_policy` returns it as `authorityScan`.

**Limit:** the scan runs only when the caller supplies `existingRules`.
`install_policy` does not read the account itself, so a caller that omits them
gets `authorityScan: null`, which means not checked rather than nothing found.

### 6. On-chain spec resolution widens the RPC trust boundary

The recorder reads an unrecognised contract's interface off chain and raises
confidence when every recorded call matches it, so a decision that depended only
on compiled-in data now depends on a network response.

An attacker controlling the RPC endpoint can serve a fabricated spec whose types
match the recorded call, turning a refusal into a `parseConfidence` of 1.0 for a
contract nobody understands. The synthesised predicate still pins only the
contract address and method observed, so what the attacker gains is the removal
of a warning, not a wider policy.

Bounds:

- The spec is read from the same endpoint the transaction was fetched from, so
  no new trusted party is added; the blast radius of an existing one widens.
- Recognition is all-or-nothing per contract and only ever adds. A missing spec,
  an unreachable endpoint or a call the interface does not describe leaves the
  recording unchanged, so the failure direction is refusal.
- `resolveContractSpecs: false` restores registry-only behaviour.

Nothing pins or attests the fetched spec. Verifying it against the deployed wasm
hash would close this.

## Reproducing the Scout run

`cargo-scout-audit` 0.3.16 cannot analyse a `soroban-sdk` 27 crate unpatched, and
reports a build that never compiled as `Analyzed` with 0 findings. Confirm a
compiled artifact exists under `target/dylint/` before quoting any Scout number;
this run produced 11.

```sh
rustup target add wasm32v1-none --toolchain nightly-2025-08-07
cargo scout-audit --manifest-path ./Cargo.toml --exclude storage-change-events -- \
  -Ztarget-applies-to-host -Zhost-config \
  --config 'host.rustflags=["-Zcrate-attr=feature(round_char_boundary)"]'
```

`storage-change-events` is excluded because it overflows the rustc stack.
