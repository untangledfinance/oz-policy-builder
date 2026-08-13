# Changelog

Notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the three npm
packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) version together.

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
