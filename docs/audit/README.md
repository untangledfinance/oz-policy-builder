# Audit evidence

Every log in `evidence/` was produced against the reduced tree that is being
handed over - not an earlier revision. Regenerate them whenever a claim they
back changes.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm build | clean; 94 tests + 6 conformance pass |
| `offchain-gate.log` | `biome check .`, `bun run typecheck`, `bun test` | clean; 839 pass, 1 skip, 0 fail |
| `cargo-audit.log` | `cargo audit` | 0 vulnerabilities; 1 unmaintained-crate warning |
| `bun-audit.log` | `bun audit` | 0 vulnerabilities |
| `clippy-pedantic.log` | `clippy -W clippy::pedantic -W clippy::nursery` | 228 style warnings, 0 security |
| `scout-audit.log` | `cargo scout-audit` | Analyzed: 2 Critical, 9 Medium, 1 Enhancement |

## Findings

### 1. `@modelcontextprotocol/sdk` 1.18.1 - 3 high advisories (FIXED)

`bun audit` reported GHSA-345p-7cg4-v4c7 (cross-client data leak via shared
server/transport instance reuse), GHSA-w48q-cv73-mx4w (DNS rebinding
protection off by default) and GHSA-8r9q-7v3j-jr4g (ReDoS). All three are
fixed above 1.25.3. Scope was `@crediolabs/policy-builder-mcp` only; nothing
on chain and nothing in `policy-synth` was affected.

The SDK is now pinned at 1.30.0 in both the workspace root `package.json` and
`packages/policy-builder-mcp/package.json`, and `bun audit` reports no
vulnerabilities.

One of the three was more than a version number. GHSA-345p-7cg4-v4c7 describes
reuse of a single server/transport instance across clients, and the HTTP
transport did exactly that: it built one `McpServer` and one
`StreamableHTTPServerTransport` at startup and served every request from them.
The transport is now built per request and torn down when the response closes,
which is the pattern the SDK's own stateless example uses and which 1.30.0
enforces at runtime. `keeps concurrent clients isolated - each response
carries its own id` in `packages/policy-builder-mcp/test/http-transport.test.ts`
pins the invariant: it fails against the shared-instance code and passes
against the current tree.

An earlier revision of this file said the bump was deferred because the SDK is
ESM-only above 1.26. That is not correct for 1.30.0 - it ships both `dist/cjs`
and `dist/esm` - and the dual ESM + CJS build of this package is intact.

### 2. `paste` 1.0.15 unmaintained - RUSTSEC-2024-0436 (ACCEPTED)

Transitive through `soroban-sdk`. Advisory is "no longer maintained", not a
vulnerability. Not actionable without an SDK change; `cargo audit` reports 0
actual vulnerabilities across 202 crate dependencies.

### 3. Scout `[CRITICAL] This addition operation could overflow` x2 - FALSE POSITIVE

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

### 4. Scout MEDIUMs - reviewed, no change

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

### 5. Stellar Security Portal corpus - 832 findings cross-checked

Pulled from the portal's open API. Of 150 critical/high findings, the dominant
class is a privileged entry point missing an authorization check (46). Each of
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
