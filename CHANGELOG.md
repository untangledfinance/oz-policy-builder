# Changelog

Notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the three npm
packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) version together.

## [0.5.0] - 2026-08-22

### Added

- Grammar version 4: the boolean combinator `or`, the ordering operators `lt`,
  `gt` and `gte`, and the `call_arg_scaled(i, num, den)` leaf. Version 3 could
  express a ceiling but not a floor, a strict bound or a disjunction, so a rule
  permitting either of two token pairs needed two rules, and "at least" could
  not be said at all.
- Slippage floors. `call_arg_scaled` evaluates to `args[i] * num / den`
  truncating toward zero, and is the only selector permitted on the right of a
  comparison, which is what lets a swap bound its output against its own input:
  `call_arg(out) >= call_arg_scaled(in, 99, 100)`. A constant cannot express
  this - it would pin the policy to a single trade size. Reachable through
  `declare_policy` / `policy-builder declare --min-out-ratio 99/100 --in-arg 0
  --out-arg 1`; it is never inferred from a recording, because a recorded rate
  is a price at one moment and freezing it as policy would deny ordinary trades
  later.
- `read-account-rules.ts`: `install_policy` now READS the smart account's
  context rules to build its `authorityScan`, instead of only reporting on rules
  the caller passed in. Rule ids are not contiguous - OpenZeppelin never reuses
  an id after a removal - so the scan walks ids upward until it has accounted
  for `Count` live rules; iterating `0..Count-1` would skip live rules at higher
  ids, and a skipped rule is a missed overlap. `authorityScan: null` still means
  NOT CHECKED, and now also covers a failed or incomplete read: reporting `[]`
  there would turn "could not check" into "nothing to worry about".

### Changed

- The pinned interpreter moves to grammar version 4. New instances on both
  networks from one reproducible build:
  mainnet `CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52`,
  testnet `CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5`,
  wasm sha256 `b5ba1e35ccf20cd8c13c3a2c3098bf337033a92bcaf475d63c03ddc0cba0fcae`.
  A version-3 document still decodes under 4 - the grammar only widened - so
  the version gate is the only thing refusing it, and it does.
- Deny code 102 (`ARITHMETIC_OVERFLOW`) returns to its original meaning, which
  `call_arg_scaled` needs again. It is a restoration, not a recycle: a consumer
  that remembers `102 = ARITHMETIC_OVERFLOW` stays right. New in this version:
  107 `SLIPPAGE_FLOOR` and 214 `INVALID_SCALED_RATIO`.
- The review card renders a disjunction as ONE line. A line per branch would
  read as "all of these are required", which is both wrong and the dangerous
  direction - it makes a policy look tighter than it is.

### Security

- Install refuses a `call_arg_scaled` whose ratio is zero or non-positive
  (`INVALID_SCALED_RATIO`, 214). A negative ratio silently INVERTS the
  comparison, so a floor would permit exactly the trades it was written to
  refuse, and at evaluate that is indistinguishable from a policy working
  normally. The same shapes are refused by `encodePredicate` off chain and by
  `declare_policy` at the point the ratio is stated.
- `call_arg_scaled` arithmetic is `checked_mul`/`checked_div` throughout;
  overflow and a zero denominator deny rather than wrapping or panicking the
  frame. The TypeScript reference evaluator applies the same i128 bounds so the
  two layers agree at the boundary.

## [0.4.0] - 2026-08-22

### Added

- A DECLARATIVE front-end: `policy-builder declare` and the `declare_policy`
  MCP tool. `synthesize` infers a predicate from a transaction that happened
  and hard-required `--recorded-tx`, so a contract the registry did not
  recognise had no path at all. `declare` takes the constraint stated outright
  - the method to pin, and optionally the contract, a per-call amount cap and a
  recipient allowlist - with no RPC and no parseConfidence, so a registry miss
  cannot refuse it. It is the surviving half of the removed `MandateSpec` and
  deliberately not the rest: the input schema is strict, so naming
  `spendingLimit` or `approvalThreshold` is an error rather than a silent
  no-op. A defaulted argument index emits a warning naming the index assumed.
- The cross-rule authority check is back, adapted to grammar 3:
  `findAuthorityOverlaps` from `@crediolabs/policy-synth/install`, and
  `authorityScan` on the `install_policy` result. It reports every rule already
  on the account that a signer of this install could name INSTEAD - including an
  unpoliced one, against which the installed predicate never runs. A predicate
  only constrains a key when the policed rule is the only rule that key is on,
  and that mistake was made in this project's own end-to-end harness. Pass
  `existingRules` to turn it on; omitting them returns `null`, meaning NOT
  CHECKED rather than nothing found. It was published in 0.2.0 and lost when the
  npm lineage moved from `octogate` to this repository.
- The recorder now reads a contract's own interface OFF CHAIN when the
  compiled-in registry does not recognise it, and verifies every recorded call
  against it. A Soroban contract embeds a typed spec in its wasm, so the
  recorder had been refusing calls whose interface was one RPC round-trip
  away. Recognition is all-or-nothing per contract and only ever ADDS: a
  missing spec, an unreachable endpoint or a call the interface does not
  describe leaves the recording exactly as it was. Set
  `resolveContractSpecs: false` for registry-only behaviour.

## [0.3.1] - 2026-08-22

### Fixed

- `install_policy` and `revoke_policy` were testnet-ONLY over MCP. Their tool
  shape omitted `network`, and a field absent from a tool shape is stripped
  before the tool body runs, so the input schema's `testnet` default always
  won and no MCP client could reach the mainnet interpreter pin. It presented
  as a deliberate testnet pin rather than a missing parameter, so integrators
  built the install by hand instead of reporting it. Shipped 0.3.0 with this
  defect, alongside the mainnet pins it makes unreachable.
- The build no longer ships compiled files for deleted source. `tsc` writes
  into `dist/` without clearing it, so a module removed from `src/` left its
  old output behind and every later release packed it. 0.3.0 shipped a
  `dist/mandate/` built from source deleted in 50a2aa4 - unreachable, since
  nothing exports it, but present in the tarball and readable as a feature
  that exists. All three builds now clear `dist/` and `dist-cjs/` first.
- The remediation for an unrecognised contract no longer tells the caller to
  supply an ABI. There is no input that accepts one, and the reason code
  `no-abi` names a miss against this package's compiled-in registry rather
  than a contract without an interface - most Soroban contracts publish a
  typed spec on chain, which this package does not read. The text now says
  what happened and points at `confidenceOverride` and re-capture. The reason
  code itself is unchanged: it is a published enum value, so renaming it
  would break callers matching on it.

## [0.3.0] - 2026-08-22

Version 0.2.0 was published from the `octogate` repository, which carries its
own copy of these packages pinned to the grammar-1 interpreter. This release
takes the packages back to `oz-policy-builder` and jumps past that version
rather than reusing it.

### Changed - BREAKING

- The pinned interpreter moves to grammar version 3. New instances on both
  networks, both created from one uploaded wasm:
  mainnet `CBZXLSTQUITBFZHQH6XRXF3XIVRQR4RHRI64Q5WELS5KGY3ZKJPFWDPF`,
  testnet `CCL336TCK2Y5OFNRCMN2M3HVPBCEX4PW5H6EQ5VW5NPMXOCP4ESB5XR4`,
  wasm sha256 `a2b36e8ac5a61caf3757af26aa79e83f2995b451099f44772383806a55fe3414`.
  The grammar-1 instances this package used to pin are still on chain, so
  policies already installed against them keep working; anything installed
  through this release goes to the new interpreter.
- The predicate grammar is reduced to what the synthesiser emits: node kinds
  `and`, `eq`, `lte`, `in`, five selector leaves and five literal leaves. The
  `or`, `not`, `lt`, `gt`, `gte` and `now` variants are gone, as is the
  `oz_builtin` policy-ref kind.
- The `time-window` deny dimension is removed. A rolling per-window total needs
  state the interpreter does not keep, and supplying a window produced a
  byte-identical predicate with no warning, so the guarantee was never enforced.

### Removed

Capabilities present in the published 0.2.0 and NOT in this release. They were
never part of this repository: 0.2.0 came from `octogate`, which carries its own
copy of these packages, so moving the npm lineage here drops them. Anyone
upgrading 0.2.0 -> 0.3.0 loses them, which is why they are listed as removals
rather than left implicit in the lineage note above.

- `install/authority-overlap`, and the `authorityScan` report `install_policy`
  returned with it. It compared the rule being installed against every other
  rule on the account and flagged the ones a signer could name instead,
  classifying each as `bypass` (the neighbour constrains nothing), `unknown`
  (policed by a contract whose semantics we cannot read) or `not-restricting`.
  **Nothing in this release warns an integrator that the key they just policed
  also sits on an unpoliced rule**, which leaves that key unconstrained. See
  `docs/audit/README.md` finding 5.
- `install/read-account-rules` and `install/build-install-predicate`.
- `install/build-merge-policy`, `install/plan-merge-policy`, and with them the
  `merge_policy` MCP tool - 7 tools here against 0.2.0's 8. There is no tighten
  path on this version: adding a second rule WIDENS authority rather than
  narrowing it, because a caller may name whichever rule is more permissive.

### Fixed

- `PolicyDocument.grammarVersion` was pinned to the literal `2` while the
  contract had moved to `3`, so every proposed policy advertised a version the
  contract refuses at install. One `GRAMMAR_VERSION` constant now feeds the
  document, the XDR builder and the pin, and a parity test ties it to the
  contract's `SELF_VERSION`.

### Added

- `contracts/policy-interpreter/build-wasm.sh` produces a reproducible wasm.
  A bare `cargo build` bakes in the crate and registry paths, so the same source
  hashed differently on every machine and the deployed bytecode could not be
  checked against it. Builds through this script are byte-identical across
  machines, and CI compares the result against the pinned hash.

## [0.1.18] - 2026-08-13

### Security

Hardening from internal adversarial review:

- The Streamable HTTP transport refuses to bind a non-loopback host unless
  the embedding caller explicitly opts out.
- RPC pinning on `get_interpreter_info` live reads, matching the install
  path.
- Stricter schema validation at tool boundaries: strkey format checks on
  account inputs, leaf value validation in the predicate encoder, and the
  removal of a test-only field from the published options type.
- Deny-reason parity with the on-chain interpreter, asserted by the
  conformance harness.

### Added

- Per-package READMEs (rendered on the npm package pages from this release
  on), contributing guide, security policy, and release process
  documentation.

### Changed

- Repository restructured: Soroban crates now live under `contracts/`, the
  npm packages under `packages/`; `repository.directory` in each manifest
  updated accordingly. Package contents and APIs are unchanged.
- Zero-warning lint baseline (biome and clippy) enforced in CI.

## [0.1.17] - 2026-08-06

Current published release of the three npm packages:

- Off-chain policy synthesis from a recorded transaction or a mandate spec,
  static minimality verification, simulation with a deny-case battery, and
  unsigned install/revoke transaction building.
- MCP server exposing the seven policy tools over stdio and Streamable HTTP.
- CLI with `record` and `synthesize` commands.

Releases before 0.1.17 predate this changelog.
