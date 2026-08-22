# Changelog

Notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the three npm
packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) version together.

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
