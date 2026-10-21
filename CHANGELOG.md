# Changelog

The three npm packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) share one version number. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [4.0.0] - 2026-10-21

The three packages at 4.0.0 are this repository at tag `v4.0.0`, the tree the
external audit covers; it replaces 3.0.0 as the audit target. `policy-synth`
is slimmer: 4,433 to 3,876 source lines, counted as in
`docs/audit-overview.md`. Three refusals the chain already makes (in the
build's own simulation or at submission) are left to it, and the
spending-limit token check no longer filters on parameter names (see
"Changed"). Every other refusal stays in the package. The version is a major bump: the
changes below break callers that send the removed inputs, read the removed
outputs, call the removed exports or match on the review text. The CLI and the
MCP server pin `@crediolabs/policy-synth` at exactly 4.0.0. As in 3.0.0, the
packages pin testnet interpreter instance `CDZV4AG4…` on wasm `69cad1d5…`. The
contract sources and their five build hashes are those of 3.0.0; one
interpreter test now pins the error codes it expects.

### Removed (breaking)

- **Inputs:** the `template` source of `synthesize_policy` and the other tools
  (`adapter_batch`, `blend_venue`; send the `intent` they lowered to),
  `install_policy`'s `outFile` together with the operator's
  `POLICY_BUILDER_OUT_DIR`, and `get_interpreter_info`'s `explainAccount`
  (with the `raw` flag that went with it on that tool).
- **Outputs:** `describes`, `unsignedXdrLength`, `unsignedXdrSha256` and
  `writtenTo` from `install_policy` and `revoke_policy` (`review_unsigned`
  reads the same bytes), and `severity` and `remediation` from the error
  envelope.
- **Library:** `describeRules` is gone from `@crediolabs/policy-synth/run`, and
  `explain` there is now synchronous and takes one item in place of a list.
- **Review text:** the review no longer prints contract names or token units:
  it reads neither a contract's interface nor a token's name and decimals. An
  operand reads as where it is on the wire (`argument 2 › amount`), an amount
  as its integer, a time as unix seconds, and a header as the address with its
  role or label. Escaping, the role and label marks, the live-value mark, the
  never-matches note and the Authority and Overrides nodes stay.
- `record_transaction` no longer says when a hash exists on the other network.

### Changed

- **Three refusals moved to the chain:** more than 15 signers (OpenZeppelin's
  `add_context_rule`, #3010), an empty admin set (the interpreter's `install`,
  #209) and a negative resource fee (stellar-core refuses the transaction as
  `txMALFORMED`). The first two come back from the build's own simulation as
  `INSTALL_BUILD_FAILED` before any bytes are handed out. `review_unsigned`
  still flags a negative resource fee. A tool caller never reaches the first
  two: the `install_policy` schema still takes 1 to 15 `signers` and, when
  `admins` is given, 1 to 15 admins, and refuses anything else with
  `INVALID_INPUT`. Only a library caller of `ruleArgs` meets #3010 and #209.
  A rule with no signer and a signer listed twice are still refused by the
  package, before the network is asked.
- **`ruleArgs`** (exported from the package root) no longer throws for more
  than 15 signers or an empty admin set. It still throws for a rule with no
  signer. A caller that submits what it builds meets the two chain refusals
  above.
- **Limits:** `synthesize_policy` and `get_interpreter_info` hold a rule to
  the limits recorded for the pin and ask no RPC for them (`limitsFrom:
  "recorded"`). Install, simulate and verify still read `limits()` live.
- **Spending-limit token check:** a rule's contract counts as a token when it
  is a Stellar Asset Contract, or a wasm whose spec has exactly one
  `transfer(address, address or muxed address, i128)`. An `Option`-wrapped
  parameter no longer counts. The parameter names and the 128 KiB wasm size
  cap no longer count either: a contract that passes still exposes that
  `transfer`, and OpenZeppelin's `spending_limit` caps its third argument.
  So one refusal is gone: 3.0.0 refused as "not a token" a contract whose
  `transfer` has those types under other parameter names, and 4.0.0 builds
  the rule. The chain accepts that contract as a token, so the old refusal
  was a false one.

## [3.0.0] - 2026-10-21

The three packages at 3.0.0 are this repository at tag `v3.0.0`, the tree the
external audit covers. The version is a major bump because of the changes under
"Changed (breaking for callers that rely on the old behaviour)".

### Packages

- **policy-synth:** turns a recorded Soroban transaction, or a mandate stated as
  data, into a policy-interpreter rule that permits exactly that. It checks the
  rule with the interpreter's own `check`, simulates it against a set of deny
  cases, and builds the unsigned transaction that installs or removes it on an
  OpenZeppelin smart account. `review_unsigned` reads an unsigned install back
  from its bytes alone, so the owner can see what they are about to sign.
- **policy-builder-cli** and **policy-builder-mcp:** the same eight tools
  (`record_transaction`, `synthesize_policy`, `simulate_policy`,
  `verify_policy`, `install_policy`, `revoke_policy`, `get_interpreter_info`,
  `review_unsigned`) from a command line, and from an MCP server over stdio and
  loopback HTTP. Both pin `@crediolabs/policy-synth` at exactly 3.0.0.
- The packages pin one interpreter instance on Stellar testnet, `CDZV4AG4…`,
  which runs wasm `69cad1d5…`. The keyless rules below are in the interpreter
  source of this tree (`810f53f1…`); a new testnet instance from it will replace
  the pin.

### Changed (breaking for callers that rely on the old behaviour)

- **Overrides outside testnet:** a request that sets `allowOverlap`,
  `allowUnboundedAmount`, `allowOpenSlippage`, `anyOne` or `allowAdminRule` to
  `true` is refused before the network is asked, unless the operator sets
  `POLICY_BUILDER_ALLOW_OVERRIDES=1`. 2.0.1 honoured these flags on every
  network. Testnet still honours them.
- **Refusal texts:** no refusal names the flag that would waive it, so a caller
  matching on "Set allowOverlap" or "`anyOne: true`" no longer matches. Twelve
  diagnostic messages were also reworded.
- **Environment values:** a malformed `POLICY_BUILDER_AUTH_LEDGERS` or
  `POLICY_BUILDER_MAX_RESOURCE_FEE` (anything but a whole number in range)
  refuses every install and revoke with `INVALID_INPUT` (and the new
  `review_unsigned`, which reads both). An empty value means the default.
- **Resource fee ceiling:** a build whose resource fee is above 10 XLM is
  refused unless the operator raises `POLICY_BUILDER_MAX_RESOURCE_FEE`. 2.0.1
  built it.
- **New refusals under "Fixed":** some fixes below also refuse requests that
  2.0.1 built. These are a contract signer that is not deployed, an execution
  adapter with no gate as a signer, an adapter with a gate signing a rule scoped
  to itself whose predicate does not pin `run`, an RPC auth tree that is not
  the built call, and a recording whose envelope hashes to another transaction.
  The MCP server also answers a `tools/call` with more than 10,000 input
  elements with `isError`. Those are all the refusals of requests 2.0.1 served
  that we found in the changes since 2.0.1, beyond the four above.

### Coming from 1.x

npm's `latest` moves from 1.3.0 to 3.0.0. 2.0.0 and 2.0.1 went out under the
`next` tag only, and 2.0.1 is older than this release, so move straight to
3.0.0. The 1.x packages build rules in an older predicate format for an older
interpreter. The interpreter 3.0.0 pins refuses an install in a format version
it does not speak, and 3.0.0 refuses any testnet interpreter but its pin, so
record or declare each rule again and synthesise, verify and install it with
3.0.0. Rules already installed through 1.x stay with the interpreter instance
they were installed on. The package API also changed in 2.0.0: the eight tools
above and the exports of the package root are the surface.

### Added

- **policy-synth, `review_unsigned`:** a tool, a CLI command (`review`), an MCP
  tool and `reviewUnsigned` from the package root, which reads an unsigned
  install or removal from its bytes alone, with no RPC, and lists the problems it finds
  in them (`problems`, `signable`): a shape the builder never makes, a digest
  that does not match, an interpreter other than the pin, a predicate whose
  hash does not match its bytes, a fee or time bound out of range, an
  authorisation from an execution adapter with no gate, a signed envelope. The
  transaction, the Authority node and the predicate follow, read back from the
  bytes. `signable` does not mean safe: a consistent rewrite of the unsigned
  bytes comes back signable, so the owner reads the Authority node against what
  they meant.
- **policy-synth, `overrides` in install and revoke answers:** one
  `{ flag, waived }` per flag set to `true`, `waived` being the refusal it
  waived or `null`. The review opens with them, before the Authority node.
- **policy-synth, `fee` and `validBefore` in build answers.**

### Fixed

- **policy-synth, install and revoke sign only the built call:** the smart
  account's auth tree came from the RPC's simulation as reported, so a lying RPC
  could add a sub-invocation (a transfer out) that the review never showed.
  `install_policy` and `revoke_policy` now refuse (`INSTALL_BUILD_FAILED`,
  `REVOKE_BUILD_FAILED`) unless the simulated root invocation is the built
  contract call, with the same contract, function and arguments, and nothing
  under it.
- **policy-synth, signed expiry and resource fee:** both rested on the RPC (a
  lying RPC moved the expiry about four months out, and had a 200 XLM fee
  built). The expiry is still the recording pass's ledger plus a window, which
  the operator now sets with `POLICY_BUILDER_AUTH_LEDGERS` (default 300, at
  most 17,280). New: the two simulations must agree on that ledger within 20,
  and the transaction carries a time bound from the builder's clock, so an RPC
  that moves both ledgers still cannot stretch how long the signed transaction
  is valid. A resource fee above `POLICY_BUILDER_MAX_RESOURCE_FEE` (default
  10 XLM), or below zero, is refused.
- **policy-synth, contract signers:** `install_policy` refuses a rule that an
  execution adapter with no gate signs: an agent allowed to call that adapter's
  `execute` could cite the rule and move funds past its own caps. The check
  reads each contract signer's instance off the ledger, whatever its code hash. It also
  refuses an adapter with a gate signing a rule scoped to itself unless every
  branch of the predicate pins `call_fn = run`, and a contract signer that is
  not deployed. No override waives these refusals.
- **policy-synth, recordings:** `record_transaction` hashes the envelope the
  RPC returns under the network's passphrase and refuses (`RECORDING_FAILED`)
  unless it is the hash asked for; a fee bump also answers to its inner
  transaction's hash.
- **policy-builder-mcp, tool input cap:** the server passes
  `maxToolInputElements: 10_000` to the MCP SDK, so a `tools/call` whose input
  holds more array elements and object members than that gets a short
  `isError` answer before schema validation. A 1 MiB call cost about 480 MB of
  memory and drew a 26 MB error before; with the cap, 111 MB and 230 bytes.
- **policy-builder-mcp, a body over 1 MiB** gets 413 under Bun 1.3 too. The
  HTTP transport read the body with `for await`, and leaving that loop early
  made Bun 1.3.14 answer 200 with an empty body.
- **Dependencies:** `@modelcontextprotocol/sdk` 1.31.0 to 1.32.1, with
  overrides `follow-redirects` `^1.16.1` and `hono` `^4.13.11`. `bun audit`
  reports no vulnerability. GHSA-46jr-4wx8-v453 needs the SDK version and the
  tool input cap above. GHSA-rvq5-wwqv-78pq concerns bearer authentication,
  which the server does not use. The repository's root `overrides` (which
  also pin `toml` `^4.2.0`) apply to this workspace only. A consumer's
  `npm audit` still reports `toml` up to 4.1.2 (GHSA-82x6-q7mm-w9cf,
  GHSA-v5mp-jgw5-2x6j) through `@stellar/stellar-sdk` 14.x, as it did for
  2.0.1. The packages never parse TOML, so that code path is unreachable from
  them; see `SECURITY.md`.

### Contracts

The contracts are never published to npm; their reproducible build hashes are
in `contracts/build-hashes.json`.

- **policy-interpreter, keyless rules bound to an executor:** a rule may list
  no signer and be bound to an execution adapter with `bind_executor`. `enforce`
  accepts a call with no authenticated signer only when the rule lists no
  signer, the interpreter is its only policy and a binding exists (else 210). A
  bound rule needs the adapter's own authorisation of the exact account and
  context, except for the adapter's `run` under a rule scoped to it, and such a
  rule must pin `call_fn == run` on every path (221). OpenZeppelin's 0.8.0
  smart account (upstream commit `8e25220`) refuses a delegated signer that is
  also a contract called in the operation (3017), so a run rule signed by the
  adapter fails at first use. A keyless rule lists no signer and keeps working.
  The interpreter's `oz08/` test crate runs these cases against that account.
  The synthesiser builds keyed rules only.
- **execution-adapter:** created bound to one custody gate or with no gate. A
  no-gate adapter runs every batch at once, stores nothing and hands out no
  grant, so no keyless rule works through it.
- **The tree holds the Stellar contracts only:** `policy-interpreter`,
  `custody-gate`, `execution-adapter`, `prime-seat` and the testnet fixture
  `test-blend-pool`.

## [2.0.1] - 2026-10-17

Published to npm under the `next` dist-tag. `latest` stayed 1.3.0.

- **policy-synth:** `readsOf`, `ruleArgs` and the `RuleDraft` type are exported
  from the package root, so a consumer no longer imports them from
  `node_modules/.../src`. No behaviour change.
- **policy-builder-cli** and **policy-builder-mcp:** seven tools, the eight
  above without `review_unsigned`. Both depend on policy-synth 2.0.1 exactly.
