# Changelog

The three npm packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) share one version number. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

On the `feat/primex` branch only. The npm packages stay at 5.2.0, and no
Stellar contract, record or build hash changed.

### Added

- **EVM configuration:** Prime on EVM is configuration on unmodified Safe,
  Zodiac Roles v2.1.1 and OpenZeppelin TimelockController 5.6.0, with no
  contract of ours: a Roles module on custody's own Safe is the custody gate,
  and the Prime account's Roles module holds the agent's bands, with
  `docs/evm.md` and the three-chain `docs/architecture.md`. It runs on a test
  network only and is outside the external audit.
  `deployments/evm-testnet.json` lists the existing contracts it uses on Base
  Sepolia.
- **EVM configuration check:** `scripts/evm-config-check`, a Foundry test that
  builds that configuration on a Base Sepolia fork and checks 55 moves and
  refusals on Safe 1.4.1 and on Safe 1.5.0.
- **Solana and EVM pre-sign checks:** two tools in `@crediolabs/policy-synth`,
  registered for the CLI and the MCP server like the other nine, and
  `reviewSolana` and `reviewEvm` from the package root. `solana_review` reads
  an unsigned Squads Smart Account transaction (a settings change, or an
  execution) and `evm_review` an unsigned Safe transaction (Roles scopings,
  allowances, members, a band, with the EIP-712 hash the owners sign), each
  from its bytes alone with no RPC, in the envelope of `review_unsigned`. They
  flag the configurations the configuration-only design never makes: on
  Solana an empty rule (E-02), a `SettingsChange` policy on custody (E-03), a
  spending limit with no destinations (E-04), an unpinned destination, a
  withdraw without its `has_debt` read, a liquidation without its marked read,
  a repay whose obligation is open; on EVM an open target or argument list, a
  layout that differs from the function's ABI, a recipient not pinned to the
  avatar, trailing calldata, with a warning on a `revokeTarget` without its
  functions (its scopes stay stored and come back on a re-scope). The tests
  read PayFi's own rule bytes and the fork check's two configuration batches,
  with the hashes the live Safe computed. No new dependency.
- **EVM move timelock and reference line:** every EVM move now waits. A
  second OpenZeppelin TimelockController 5.6.0 is the gate's trading member in
  place of the Prime account: the Prime account schedules a move (the agent's
  band scopes the timelock's `schedule`), anyone runs it after the delay, and
  custody or the Prime account can cancel it during the wait. `docs/evm.md`
  describes this design. `scripts/evm-config-check/test/RefLine.t.sol` checks
  it on a Base Sepolia fork, 128 checks on Safe 1.4.1 and on Safe 1.5.0, and
  `script/RefLine.s.sol` with `refline.ts` runs it as a reference line, one
  transaction at a time, checking each refusal's revert data. Its run on
  Base Sepolia (64 transactions, 38 refused, each linked on Basescan) is in
  `evidence/evm-reference-line.md`.
- **Build-hash match of the third-party builds:**
  `evidence/build-hash-match.md` compares each deployed build Prime configures
  with a build of its cited source. On Base Sepolia, Safe 1.4.1 (five
  contracts) and Zodiac Roles v2.1.1 (mastercopy, two libraries, unwrapper)
  match byte for byte. On Solana devnet, neither klend (`e921c64`) nor the
  Squads Smart Account (`0e51082`) matches: devnet's klend is built from
  unpublished source and devnet's Squads build predates the cited commit.
  `docs/solana.md` and `docs/evm.md` state the match, and `docs/solana.md`
  cites the PayFi devnet line by its evidence files.
- **CI:** runs on pushes to `feat/primex`; a contract test step fails when it
  runs no test or skips one; the EVM job runs the configuration check on a
  Base Sepolia fork.

### Removed

- **The Solana programs:** Prime on Solana is now configuration of existing
  third-party programs only: the Squads Smart Account, SPL Token-2022 and the
  venue's programs (Kamino klend and Scope), with off-chain helpers.
  `contracts/solana/custody-gate` (with `app-checks/`), `contracts/solana/prime-seat`,
  `contracts/solana/SETUP-AND-RECOVERY.md`, `deployments/solana-devnet.json`,
  the three `solana/*` entries in `contracts/build-hashes.json`, and the Solana
  and `app-checks` CI jobs are gone. A Squads account owns custody's token
  accounts in place of the gate program, and Prime owners sign as Squads
  signers, with no seat. `docs/solana.md` is rewritten for this design. The two
  programs stay deployed final on devnet, unused; their source is at commit
  `89f7839` of `feat/primex`.
- **`PrimeSeat`, the EVM seat:** `contracts/evm/prime-seat`, its two entries in
  `contracts/build-hashes.json`, its deployment record and its two CI jobs (the
  fork suite and the mutation pass). Prime on EVM has no seats and no session
  keys: each Safe owner signs each decision.

## [5.2.0] - 2026-10-26

A minor release: OpenZeppelin `stellar-contracts` v0.8.0 on testnet. The
builder now signs for OpenZeppelin's 0.8.0 smart account beside the 0.7.2-line
one, and the testnet OpenZeppelin policies it attaches are `v0.8.0` builds.
The contracts are unchanged (interpreter `6704996f…`, adapter `bf85432c…`,
seat `393f0e5d…`, gate `b01024f3…`), and so is everything on mainnet. The CLI
and the MCP server pin `@crediolabs/policy-synth` at exactly 5.2.0.

Why minor: the new account build and its signing form are additive, and
`91a2cd56…` stays trusted and signed for exactly as before. Two refusals are
stricter (below, under Changed); 4.1.0 set the precedent that dropping trust
in a build is a minor change.

### Added

- **Signing for OpenZeppelin's 0.8.0 account (`8286422f…`)**: every build that
  goes through the account's own authorisation (`install_policy`, with or
  without `follow`, `revoke_policy` and `bind_policy`) reads the account's
  code first. For the 0.7.2-line `91a2cd56…` the
  source account authorises `__check_auth` with the digest
  `sha256(sha256(signature payload) ‖ XDR(rule ids))`, as before. For
  `8286422f…` it authorises the struct the 0.8.0 account passes to
  `require_auth_for_args`: `AuthDigestPreimage { account, context_rule_ids,
  signature_payload }`. 5.1.0 signed the 0.7.2-line digest for every account,
  so each of these builds failed on a 0.8.0 account (`Error(Auth,
  InvalidAction)` in the enforcing simulation).
- **`8286422f…` in the trusted account builds**: `revoke_policy` describes the
  rule it removes on a 0.8.0 account (`deployments/oz-accounts.json`, which
  records the build's source tag `v0.8.0`, `ddc327e`, and its reproduction).
- **`review_unsigned` reads either form**: the source's `__check_auth`
  argument must be the digest bytes or the preimage struct, equal byte for
  byte to what the account's entry yields (the struct also names the
  account), and `auth.form` (`'digest'` or `'preimage'`) says which; the
  review's authorisation line names it. With `readContracts: true` the
  account's code is read too, and a form other than its build asks for, a
  build the package does not sign for, or code that cannot be read is a
  problem. `reviewUnsigned` takes the code as `accountCode`.
- **`SUPERSEDED_OZ_POLICIES`, `spendingLimits(network)` and
  `isThreshold(network, address, weighted)`** in `config.ts` (not exported
  from the package root).

### Changed

- **Testnet OpenZeppelin policies**: `SPENDING_LIMIT.testnet` is
  `CCPZW4322JUETOYDKYUFB2AZ2SZVWFV3IATZ3TG4QXZKQXBEOIQM2JQ4` and the testnet
  threshold policies are `CCRCBH3M…` (simple) and `CCJXAUHA…` (weighted),
  built from `v0.8.0` and deployed on 26 October 2026. The `v0.7.2` testnet
  instances (`CDH4KOBR…`, `CAYTIVQO…`, `CCTNRFZC…`) are superseded: no new rule
  attaches them, rules already carrying them are still read (their cap and
  threshold are described), `review_unsigned` flags one in an install as a
  problem, and no rule may be scoped to them. Mainnet keeps its `v0.7.2`
  instances. From `v0.7.2` to `v0.8.0` OpenZeppelin changed the code of
  `spending_limit` only: a transfer of 0 is always permitted, and its history
  holds at most 815 entries (was 1,000). `simple_threshold` and
  `weighted_threshold` change in comments only, and the `Policy` trait is the
  same, so the `v0.8.0` policies serve 0.7.2-line accounts too.
- **`OZ_STELLAR_CONTRACTS_TAG`** is per network: `v0.8.0` on testnet, `v0.7.2`
  on mainnet (not exported from the package root; read by
  `scripts/upstream-drift-check.ts`). `deployments/oz-policies.json` records
  the wasm hashes per network.
- **Stricter: an account that runs no known build is refused.** 5.1.0 built an
  install, a removal or a binding for any account, signed as the 0.7.2-line
  digest; 5.2.0 refuses (`INSTALL_BUILD_FAILED`, `REVOKE_BUILD_FAILED`,
  `BIND_BUILD_FAILED`) when the account's code is not `91a2cd56…` or
  `8286422f…`, since it cannot know how that build's signer authorises.
- **Stricter: unreadable account code refuses the build**, as retryable. In
  5.1.0 `revoke_policy` built the removal and skipped its review.
- Each build makes one more RPC read (the account's code, alongside the
  recording simulation).

## [5.1.0] - 2026-10-26

A minor release: new output fields (`warnings`) carry one new warning. What is
built, refused and accepted is unchanged, and so is `signable`. The CLI and
the MCP server pin `@crediolabs/policy-synth` at exactly 5.1.0.

### Added

- **The E-38 warning for a keyless rule that follows another rule**: with no
  signer, such a rule's predicate is its only fence, and that predicate is
  the followed rule's. The followed rule's admins (its master set) can
  re-install it with that rule's account at will, without this account.
  Through an adapter with no gate the shape pin (`221`) holds only target
  and function, so anyone could then move funds; through a gated adapter the
  gate still limits destinations. Issuers use this pattern on purpose to
  govern a borrower's keyless rule, so it still builds. The text starts with
  `E-38` so it ties to the threat model's finding, names the followed rule
  and its admins (when read), and is worded for the executor's kind. A keyed
  follower, a keyless rule with its own predicate and an inline rule get no
  warning.
- **`warnings` in three results**: `install_policy` and `bind_policy` return
  `warnings: string[]`, and the review opens with a `Warning` node after any
  overrides. `review_unsigned` (and `reviewUnsigned`) adds
  `UnsignedReview.warnings`, with the node after any problems; offline it
  names the followed rule, and with `readContracts` its admins too.
- **`Followed.admins`**: `rule.follows` (and `readFollowed`'s `follows`)
  carries the followed rule's admins, read from the same record as its nonce.

## [5.0.0] - 2026-10-25

The testnet interpreter is now the build with referenced rules and the
immediate-batch pin (`6704996f…`, instance `CDER6P73…`), with the execution
adapter that hands out its word with no gate (`bf85432c…`). `policy-synth`
writes rules that follow another rule, keyless rules for an execution adapter
and their binding (`bind_policy`), and refuses a keyed rule that could hand out
a no-gate adapter's word. The CLI and the MCP server pin
`@crediolabs/policy-synth` at exactly 5.0.0.

### Breaking

A major version, for two reasons, in this order:

- **1. The public types move to zod 4, and the error codes grow.** The
  exported `Tool.shape` and `Tool.schema` are zod 4 types (`Tool.schema` is a
  `z.ZodObject<…, z.core.$strict>`), so code typed against them with zod 3
  no longer compiles. The exported `ErrorCode` gains `BIND_BUILD_FAILED`, so
  an exhaustive switch over it no longer covers every code. The wording of an
  `INVALID_INPUT` message for a malformed input follows zod 4; what is
  accepted and refused is unchanged.
- **2. The trusted interpreter changes:** `policy-synth` pins testnet instance
  `CDER6P73JWMIVD3X6TGGOQIDAH3DLU7OKRTLT4ULPTZ3QJJ3QUGTK7CM` (wasm
  `6704996f…`, referenced rules and the immediate-batch pin; the same
  limits) and trusts only that build. `CD46LN75…` (`810f53f1…`) is recorded
  as superseded in `deployments/interpreter-testnet.json` and is no longer
  trusted: a rule it polices reads as unreadable, and an install naming it is
  refused (`INTERPRETER_MISMATCH`). Following a rule needs a build with
  references, so it works on the pin and is refused on `810f53f1…`. The
  live-test account's rules 6 (`cap-500`) and 7 (following rule 6) are on the
  new instance, and every recorded RPC fixture is re-recorded against it.
  On its own this would be a minor change, as in 4.1.0.

### Added

- **Referenced rules in the policy interpreter**: a rule follows the predicate
  of an existing rule `(account, rule_id)` on the same interpreter when its install payload's
  predicate is the XDR of that pair; the payload hash then commits to the
  reference. The referenced account changes the predicate by its own
  re-install, and every follower evaluates it at its next `enforce`. Only
  the predicate is shared: signers, binding, executor grant, nonce and
  master set stay each follower's. A missing source refuses (`206`), a
  source that is itself a reference refuses (`201`), and a follower's
  permit extends the referenced entry's TTL. No new entry point.
- **Liquidation by anyone through an execution adapter with no gate**
  (adapter wasm `bf85432c…`, interpreter wasm `6704996f…`). In an immediate
  `execute`, an adapter with no gate now accepts one kind of grant, its word
  to the Prime's policy, `enforce(prime, context)` with nothing nested, and
  adds the same word for the `execute` it runs; it hands them out just before
  the Prime is asked, for that one approval. Every other grant, any
  authorisation for a callee and any wait stay refused, and nothing is
  stored. The interpreter's `221` now also accepts, for a rule scoped to its
  own executor, a predicate that pins an immediate batch on every path:
  `call_fn == execute`, a wait of 0, the number of calls, and each call's
  target and function. A keyless rule bound to such an adapter can then
  authorise a liquidation by any address on an OpenZeppelin 0.8.0 account,
  where a rule signed by the adapter is refused (3017). No new error code,
  entry point or storage; grammar 7. Configuration invariant (STRIDE E-36,
  High): a keyed rule scoped to a no-gate adapter must pin
  `call_arg_len(1) == 0`, and keyless rules belong on a no-gate adapter of
  their own with no keyed rule scoped to it. `cargo audit` ignores RUSTSEC-2026-0387
  (crypto-bigint, host-side only, not in either wasm) with the reason in
  `contracts/stellar/policy-interpreter/.cargo/audit.toml`.
- **policy-synth writes and reviews rules that follow another rule.**
  `install_policy` takes `follow: { smartAccount, ruleId }` and emits the
  reference payload (the XDR of `(account, rule_id)`, with its hash); every
  guardrail is judged on the followed predicate as it is at build time, read
  off the interpreter with its nonce. A missing followed rule, one that itself
  follows another, an interpreter build with no references, or an undecodable
  predicate is refused before anything is built. `simulate_policy` and
  `verify_policy` take `follow` too. The review (and `rule.follows`) shows the
  followed rule, its nonce and predicate hash now, and that its admins can
  change it without the follower's signature. `readPredicates` (the overlap
  scan, `revoke_policy`) reads a follower through its source, one level only,
  instead of reporting it unreadable; a source that is missing, a reference or
  undecodable still reads as unreadable. A neighbour that follows is refused
  by the overlap scan, and beside a new rule that follows, so is a tighter
  neighbour (`allowOverlap` waives both). `review_unsigned` recognises a
  reference payload as the interpreter does and flags it unless
  `readContracts: true` reads the followed rule off the pinned interpreter.
  New exports: `readFollowed`, `referenceOf`, `encodeReference`.
- **policy-synth writes keyless rules for an execution adapter, and binds them.**
  `install_policy` takes `signers: []` with `executor` (an execution adapter,
  read off the ledger) and builds `add_context_rule` with no signer; a rule
  scoped to its executor must pin `run` or a whole immediate batch
  (`pinsOwn`, mirroring the interpreter's `pins_own`, 221), and an adapter
  with a gate must be pinned to `run`. A new tool, `bind_policy`, builds the
  interpreter's `bind_executor((account, rule), executor)` after re-reading
  the rule, its predicate and admins (refusals: `BIND_BUILD_FAILED`, a new
  error code). Two intent rows write a whole batch: `count` (exactly n
  elements) and `same` (an argument equal to another, such as a liquidator
  tied to the recipient). The review says what a keyless rule and its
  executor mean (with no gate, anyone may run an immediate batch, so the
  predicate is the only fence), and `review_unsigned` reads a
  `bind_executor` from its bytes. The rule reader returns each rule's bound
  `executor` and `admins`. The CLI and the MCP server serve nine tools.
- **A keyed rule scoped to an execution adapter with no gate must hold its
  grants to none.** Such a rule's signer could otherwise have the adapter
  hand out its word to the account's policy in an immediate `execute`, which
  a keyless rule bound to the adapter accepts in place of a key, and move the
  account's funds. `install_policy` refuses a keyed rule scoped to a no-gate
  adapter whose predicate permits `execute` (or leaves the function open)
  without `call_arg_len(1) == 0` on every branch, or that follows another
  rule's predicate; `install_policy` and `bind_policy` refuse a keyless rule
  or a binding for a no-gate adapter while such a keyed rule is on the
  account (or the account's rules are not all read); `review_unsigned` flags
  it, and asks for `readContracts` when the scope is not read. No override.

### Security

- **Dependency advisories cleared:** `zod` 3.25.76 -> 4.6.7
  (GHSA-mrhx-c7xc-m3w5, no 3.x fix; pinned, and overridden so the MCP SDK
  shares the one copy), `body-parser` `^2.4.0` (GHSA-27r3-jxmh-p828) and
  `fast-uri` `^3.1.9` as overrides. `bun audit` is clean. The tool input
  schemas move to zod 4 (`Tool.shape` and `Tool.schema` are zod 4 types), and
  the text of an `INVALID_INPUT` message for a malformed input changes with it
  (zod 4's wording, for example `Unrecognized key: "x"`); what is accepted and
  refused is the same.

## [4.1.0] - 2026-10-23

The testnet deployments now run this source. The interpreter with the keyless
executor rules (wasm `810f53f1…`) runs as a new testnet instance,
`CD46LN75…`, and the execution adapter whose gate is optional (`4985cd12…`)
is uploaded to testnet. Both are recorded in `deployments/`, and
`policy-synth` pins and trusts the new interpreter instance. The three
packages at 4.1.0 are this repository at tag `v4.1.0`, the tree the external
audit covers; it replaces 4.0.1 as the audit target. The CLI and the MCP
server pin `@crediolabs/policy-synth` at exactly 4.1.0. No contract source
changed: the five build hashes are those of 4.0.1.

### Changed

- **The pinned interpreter:** `policy-synth` pins testnet instance
  `CD46LN75LITN5INQEW3N3BKUK52IFODGCTJS2RWQ44JM74RH6ILIPBJ2`, which runs
  `810f53f1…` with the same deploy-time limits as the instance before it
  (reads 8, leaves 400, bytes 24,576, elems 32, `in` entries 32, depth 5).
  `810f53f1…` is now the only interpreter build the package trusts.
- **The previous instance is not trusted:** `CDZV4AG4…`, which runs
  `69cad1d5…`, is listed with the other interpreters this project deployed
  and this build does not trust. A rule it polices reads as unreadable, and
  no rule may be scoped to it. Instances have no upgrade path, so a rule on
  `CDZV4AG4…` stays there; install it again on the new instance.
- **Still keyed:** the builder installs rules with signers only, as before.
  Only the interpreter has the keyless executor rule.
- **The execution adapter on testnet:** `deployments/execution-testnet.json`
  records `4985cd12…` with its upload, `5b9323ac…`, and lists the earlier
  build `3dd675c0…` as superseded. The custody gate record (`b01024f3…`) is
  unchanged. Neither contract has a shared instance: each custody account
  deploys its own gate and each Prime its own adapter.
- **The records:** `deployments/interpreter-testnet.json` names the new
  instance (upload `e6f0d7f6…`, create `f7a0625a…`, and its TTL extensions)
  and lists `CDZV4AG4…` as superseded, with its transactions and the reason.
  `config.test.ts` holds the pin, the trusted build and the superseded
  instance to that record.
- **Deploy scripts:** `scripts/deploy-interpreter-testnet.ts` takes the
  reason the recorded instance is replaced (`--why`) and records the
  deployer. `scripts/upload-execution-testnet.ts` uploads only the builds given
  on its command line, leaves the other entries as they are, checks the code
  is on chain, and moves a replaced build to `superseded`.
- **Live tests:** the recorded RPC fixtures in
  `packages/policy-synth/fixtures/rpc` replay a run against the new instance.
  The live-test account (`CASJ5GEC…`, OpenZeppelin `91a2cd56…`) gained rule 5,
  `cap-500` on the new instance; rules 1 to 4 sit on earlier instances. The
  removal tests now remove rule 3: the instances behind rules 1 and 2 are
  archived on testnet, and removing either asks a resource fee of about 50 XLM,
  which the builder's 10 XLM ceiling refuses.
- **Dependencies:** the root `overrides` pin `toml` `^5.0.1` (was `^4.2.0`)
  and `ip-address` `^10.7.4`, for advisories published on 22 October 2026
  (`toml` up to 5.0.0, `ip-address` up to 10.7.3). `bun audit` reports none.
  `SECURITY.md` gives consumers the same two pins.
- The install lines, the audited tag and the supported version point at
  4.1.0.

## [4.0.1] - 2026-10-21

Documentation only: the Prime seat contract joins the audit scope, and the
docs call it "Prime seat" in prose. No code or behaviour change. The three
packages at 4.0.1 are this repository at tag `v4.0.1`, the tree the external
audit covers; it replaces 4.0.0 as the audit target. The package code is that
of 4.0.0 with the new version number, which the MCP server reports. The CLI
and the MCP server pin `@crediolabs/policy-synth` at exactly 4.0.1. The
contract sources and their five build hashes are those of 4.0.0, apart from
the first line of the seat's module comment, which now reads "Prime seat"; its
build hash stays `393f0e5d…`.

### Changed

- The Prime seat (`contracts/stellar/prime-seat/src`, test modules excluded)
  is in the audit scope. `docs/audit-overview.md`, `SECURITY.md` and
  `contracts/README.md` list it in scope, and the audit overview states what
  the seat enforces and two known behaviours. The owner key of a seat stays
  out of scope as an assumption, and so does `test-blend-pool`.
- The docs call the seat contract "Prime seat" in prose. Paths, the crate
  name and the build-hash key stay `prime-seat`.
- The install lines, the audited tag and the supported version point at
  4.0.1.

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
  `transfer` has those types but parameter names that are not distinct plain
  identifiers (a filter that kept names safe to print in the review), and
  4.0.0 builds the rule. OpenZeppelin's `spending_limit` works on such a
  contract as on any other.

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
