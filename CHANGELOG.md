# Changelog

The three npm packages (`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`,
`@crediolabs/policy-builder-mcp`) share one version number. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.1]

This entry describes the source in this repository at version 2.0.1. The
builds published to npm under that number are older.

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
  loopback HTTP.

### Contracts

- **policy-interpreter:** decides each call an OpenZeppelin smart account
  delegates to it against the rule's predicate. Each instance fixes its limits
  at deploy time. A rule with no signer runs only while it is bound to an
  executor.
- **execution-adapter:** the per-Prime batcher, created bound to one custody
  gate or with no gate, with an optional wait before a batch runs.
- **custody-gate:** holds an allowance from the custody account and pays only
  to the addresses on its list.
- **prime-seat:** an owner's seat on one Prime account, with that owner's
  session keys.
- **test-blend-pool:** a stub with Blend's `submit` shape, for testnet checks
  only.

The reproducible build hashes are in `contracts/build-hashes.json`. The testnet
interpreter instance is recorded in `deployments/interpreter-testnet.json`.
