# Audit evidence

Every log in `evidence/` was produced against the tree being handed over.
Regenerate them whenever a claim they back changes.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, reproducible wasm build, hash pin parity | clean; 70 tests + 9 conformance pass; built wasm matches the pin |
| `offchain-gate.log` | `biome check .`, `bun run typecheck`, `bun test` | clean; 567 pass, 1 skip, 0 fail |
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
