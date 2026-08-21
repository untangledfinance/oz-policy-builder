# Audit evidence

Every log in `evidence/` was produced against the tree being handed over.
Regenerate them whenever a claim they back changes.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm build | clean; 94 tests + 6 conformance pass |
| `offchain-gate.log` | `biome check .`, `bun run typecheck`, `bun test` | clean; 595 pass, 1 skip, 0 fail |
| `cargo-audit.log` | `cargo audit` | 0 vulnerabilities; 1 unmaintained-crate warning |
| `bun-audit.log` | `bun audit` | 0 vulnerabilities |
| `clippy-pedantic.log` | `clippy -W clippy::pedantic -W clippy::nursery` | 228 style warnings, 0 security |
| `scout-audit.log` | `cargo scout-audit` | Analyzed: 2 Critical, 9 Medium, 1 Enhancement |

## Findings

### 1. `paste` 1.0.15 unmaintained - RUSTSEC-2024-0436 (ACCEPTED)

Transitive through `soroban-sdk`. Advisory is "no longer maintained", not a
vulnerability. Not actionable without an SDK change; `cargo audit` reports 0
actual vulnerabilities across 202 crate dependencies.

### 2. Scout `[CRITICAL] This addition operation could overflow` x2 - FALSE POSITIVE

Both point at `d + 1` in the AST depth walk (`src/dsl.rs:701`, `:704`), where
`d: u32` is the current nesting depth.

Unreachable: `decode_with_byte_cap` rejects anything over `MAX_PREDICATE_BYTES`
(32 KB) *before* parsing, and each nesting level costs at least one byte, so
depth is bounded near 3.2x10^4 - eight orders of magnitude below `u32::MAX`.
Scout's `integer_overflow_or_underflow` reports raw operators without following
the dominating guard.

The same reasoning covers clippy's `casting usize to u32 may truncate` on
`haystack.len() as u32` (`src/dsl.rs:714`): a 32 KB payload cannot encode 2^32
elements.

### 3. Scout MEDIUMs - reviewed, no change

- *unbounded operations* x3: the walks are bounded by the same 32 KB byte cap
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
