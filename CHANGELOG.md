# Changelog

Notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the three npm
packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) version together.

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
  `docs/audit/README.md` finding 6.
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
