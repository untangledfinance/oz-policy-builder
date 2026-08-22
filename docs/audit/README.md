# Audit evidence

Every log in `evidence/` was produced against the tree being handed over.
Regenerate them whenever a claim they back changes.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, reproducible wasm build, hash pin parity | clean; 70 tests + 9 conformance pass; built wasm matches the pin |
| `offchain-gate.log` | `biome check .`, `bun run typecheck`, `bun test` | clean; 612 pass, 1 skip, 0 fail |
| `cargo-audit.log` | `cargo audit` | 0 vulnerabilities; 1 unmaintained-crate warning |
| `bun-audit.log` | `bun audit` | 0 vulnerabilities |
| `clippy-pedantic.log` | `clippy -W clippy::pedantic -W clippy::nursery` | 170 style warnings, 0 security |
| `scout-audit.log` | `cargo scout-audit` | Analyzed: 0 Critical, 9 Medium, 1 Enhancement |
| `e2e-network.log` | `scripts/e2e-network.ts --network testnet` and `--network mainnet` | policy installed against the pinned interpreter on both networks; permitted call succeeds, forbidden call denied `#100` |

## Findings

### 1. `paste` 1.0.15 unmaintained - RUSTSEC-2024-0436 (ACCEPTED)

Transitive through `soroban-sdk`. Advisory is "no longer maintained", not a
vulnerability. Not actionable without an SDK change; `cargo audit` reports 0
actual vulnerabilities across 202 crate dependencies.

### 2. Scout Criticals - none

Earlier runs reported two `[CRITICAL] This addition operation could overflow`
against `d + 1` in the AST depth walk, plus a clippy `casting usize to u32 may
truncate` on `haystack.len() as u32`. Both were genuinely unreachable - the byte
cap rejects anything over 32 KB before parsing - but the guard proving it sat
several frames above the operator, which is why neither tool could follow it.

The depth counter now uses `saturating_add` and the length now goes through
`u32::try_from`, so each bound is local to the operation it protects. Both
findings are gone rather than triaged; there is nothing left to argue about.

### 3. Scout MEDIUMs - reviewed, no change

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

### 4. Stellar Security Portal corpus - 832 findings cross-checked

Pulled from the portal's open API. Of 150 critical/high findings, the dominant
class is a privileged entry point missing an authorization check (53). Each of
this contract's five entry points was checked against that class:

| Entry point | Control |
| --- | --- |
| `install` | `smart_account.require_auth()` on every install (including the first, so a rule id cannot be pre-seeded), plus `require_master` and a matching signer set on re-install, plus a strictly incrementing `install_nonce` |
| `enforce` | `smart_account.require_auth()`, non-empty authenticated-signer set, live signer hash must equal the hash stored at install |
| `uninstall` | `require_master` |
| `rotate_master_signer_set` | `require_master` on the *old* set |
| `grammar_version` | read-only, touches no state |

`require_master` refuses an empty set rather than treating zero `require_auth`
calls as satisfied - the corpus's "authorization that silently no-ops" class.
The nonce covers the corpus's double-spend/replay class.

### 5. End-to-end behaviour on both networks - permit and deny proven

The static tools above say nothing about whether the deployed contract actually
enforces anything. `scripts/e2e-network.ts` closes that: it deploys a fresh OZ
smart account, installs `eq(call_fn, "transfer")` against the PINNED
interpreter, and then exercises both verdicts through real submitted
transactions. Mainnet and testnet both pass, and the run is repeatable - two
independent mainnet runs produced the same outcome against different accounts.

Two things make the deny meaningful rather than decorative:

- **The deny is attributed, not just observed.** The harness fails unless the
  refusal names the interpreter contract AND carries `#100 ArgMismatch`. A test
  that only asserts "the call failed" passes for any reason at all.
- **The forbidden call is otherwise valid.** The first version of this harness
  reported a passing deny that was worthless: `approve` was given an expiration
  ledger in the past, so the token rejected it on its own terms and the
  interpreter was never consulted. The expiration is now set ahead of the
  current ledger, leaving the predicate as the only thing that can reject it.

The permit is not vacuous either, because the deny is its control: both calls go
through the same account, the same rule and the same attached policy, so a
missing or unbound policy would have let the `approve` through.

A third condition was added after review, and it is the one that turns the
result into a security claim. An account resolves a call against the rule the
CALLER NAMES, taking the maximum authority over the named rules rather than the
intersection. An earlier version of this harness put the same key on the
policed rule AND on the unpoliced admin rule, which made the deny true but
weak: it showed the interpreter evaluating its predicate correctly when its
rule was named, NOT that the key was constrained. The same key naming the
unpoliced rule was permitted to do the forbidden thing, confirmed on testnet
before the harness was changed.

The harness now puts the constrained agent on the policed rule and nowhere
else, and asserts the closure: the agent's forbidden call, routed through the
unpoliced rule, is rejected on membership. So the claim is about the key, not
about one routing choice. The admin key retains full authority through the
unpoliced rule by design - a policy constrains the keys placed under it, not
the account's owner - and any deployment that puts a constrained key on a
second, unpoliced rule has no constraint at all.

### 6. Install-time overlap check - restored, and what it does not do

Finding 5 explains that a predicate constrains a key only if the policed rule is
the only rule that key is on. That property is now checked rather than left to
the reader.

`install/authority-overlap` compares the rule being installed against every
other rule on the account and reports each one a signer could name instead,
classified as `bypass` (the neighbour constrains nothing), `unknown` (policed
by a contract whose semantics cannot be read) or `not-restricting` (ours, but
wider). It matches on shared signers INTERSECTED with shared
`(contract, function)` selectors - both conditions being necessary for the
signer to have a choice - and deliberately OVER-approximates what a predicate
permits, so a non-intersecting result is a sound proof that two rules cannot
collide. Narrowing instead would be the fail-open direction.

It ships as `findAuthorityOverlaps` from `@crediolabs/policy-synth/install`,
and `install_policy` returns it as `authorityScan`.

**Two limits an auditor should hold us to.** The scan runs only when the caller
supplies `existingRules`; `install_policy` does not read the account itself, so
an integrator who does not pass them gets `authorityScan: null`. That is
reported as null rather than as an empty list precisely because "not checked"
and "checked, nothing found" are different answers and silence must not read as
safety. Reading the rules on chain inside the tool is the obvious next step and
is not done.

The check was previously published in 0.2.0, from the `octogate` repository,
and was lost when the npm lineage moved here - no commit removed it and the
version number went up. It is restored adapted to grammar 3: the `or` and `not`
cases are gone with those operators, as are the oracle bounds the stored
document used to carry.

### 7. On-chain spec resolution adds an RPC to the trust boundary (NEW this round)

The recorder now reads an unrecognised contract's own interface off chain and
raises confidence when every recorded call matches it. That moves a decision
which used to depend only on compiled-in data onto a network response, and an
auditor should see it stated rather than infer it from the diff.

What an attacker controlling the RPC endpoint gains: the ability to serve a
fabricated spec whose types happen to match the recorded call, turning a
refusal into a `parseConfidence` of 1.0 for a contract nobody understands. The
predicate synthesised from that recording still pins only the contract address
and method actually observed, so the attacker does not gain a wider policy -
they gain the removal of a WARNING the operator would otherwise have seen.

Three things bound it, none of which make it disappear:

- The spec is read from the SAME endpoint the transaction was fetched from. An
  endpoint able to forge a spec can already forge the transaction, so this adds
  no NEW trusted party - it widens what an already-trusted one can influence.
- Recognition is all-or-nothing per contract and only ever ADDS. A missing
  spec, an unreachable endpoint or a call the interface does not describe
  leaves the recording exactly as it was, so the failure direction is refusal.
- `resolveContractSpecs: false` restores registry-only behaviour for a caller
  who wants the decision to depend on nothing but compiled-in data.

Not mitigated, and deliberately not claimed to be: nothing pins or attests the
fetched spec. Verifying it against the deployed wasm hash would close this, and
is the obvious hardening if the trust in the RPC endpoint is ever judged too
broad. Recorded here as an accepted, bounded exposure rather than as solved.

## Reproducing the Scout run

`cargo-scout-audit` 0.3.16 cannot analyse a `soroban-sdk` 27 crate unpatched,
and - worse - reports a build that never compiled as `Analyzed` with 0
findings. Verify a compiled artifact exists under `target/dylint/` before
quoting any Scout number; this run produced 11.

```sh
rustup target add wasm32v1-none --toolchain nightly-2025-08-07
cargo scout-audit --manifest-path ./Cargo.toml --exclude storage-change-events -- \
  -Ztarget-applies-to-host -Zhost-config \
  --config 'host.rustflags=["-Zcrate-attr=feature(round_char_boundary)"]'
```

`storage-change-events` is excluded because it overflows the rustc stack.
