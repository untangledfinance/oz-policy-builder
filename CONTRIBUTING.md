# Contributing

Thanks for working on the OZ Policy Builder. This document is the short path from a fresh
clone to a green pull request.

## Setup

Two toolchains, both pinned:

- **Bun** for the TypeScript workspace. The version CI uses is pinned in
  `package.json` (`packageManager`).
- **Rust** for the Soroban contracts. The toolchain, `rustfmt`, `clippy` and
  the `wasm32v1-none` target are pinned in `rust-toolchain.toml`; `rustup`
  installs them automatically on first use.

```sh
bun install
```

The [Stellar CLI](https://developers.stellar.org/docs/tools/cli) is only
needed for deploying or exercising contracts on a live network, not for the
test suites.

## Gates

Every pull request must pass the same gates CI runs. Run them locally first:

```sh
# TypeScript
bun run check       # biome lint + format
bun run typecheck   # tsc --noEmit across the three TS packages
bun test            # unit + integration suites

# Per-package builds are stricter than the root typecheck; publishing runs
# them, so CI gates on them too.
bun run --cwd packages/policy-synth build
bun run --cwd packages/policy-builder-cli build
bun run --cwd packages/policy-builder-mcp build

# Contracts (each crate is standalone; no workspace manifest)
for crate in policy-interpreter test-oracle test-blend-pool; do
  ( cd "contracts/$crate" &&
    cargo fmt --check &&
    cargo clippy --all-targets -- -D warnings &&
    cargo test )
done

# Cross-layer conformance: TS-encoded fixtures must evaluate identically
# on the Rust interpreter.
( cd contracts/policy-interpreter && cargo test --release --test conformance )
```

## Style

- TypeScript is formatted and linted by [Biome](https://biomejs.dev)
  (`biome.json` at the root). Do not hand-format around it.
- Rust is formatted by `rustfmt` with default settings.
- Comments earn their place by stating an invariant, a constraint, or a
  deliberate decision the code cannot show on its own. Several files carry
  invariant blocks in their file-level comments (for example
  `contracts/policy-interpreter/src/oracle.rs`); read them before touching
  the code they guard, and do not remove them.

## Changes to the contracts

The on-chain crates hold safety invariants that are documented where they
live. In particular:

- The interpreter's deny codes are stable identifiers; never renumber
  them.
- The interpreter's predicate grammar is versioned. A grammar change means a
  new `SELF_VERSION`, new conformance fixtures, and a coordinated release of
  `@crediolabs/policy-synth` (see [docs/releasing.md](./docs/releasing.md)).
- If you change the TypeScript predicate encoder, regenerate the conformance
  fixtures (`packages/policy-synth/scripts/gen-conformance-fixture.ts`) in
  the same pull request, and run `cargo fmt` afterwards so the regenerated
  Rust file passes the format gate.

## Commits and pull requests

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`, with an optional scope (`fix(policy-synth): ...`).
- Keep pull requests small and single-purpose; a reviewer should be able to
  hold the whole diff in their head.
- Never commit secrets, `.env` files, or private keys. Contract addresses
  and wasm hashes are public on-chain data and are fine.

## Security

Do not open a public issue for a vulnerability. See
[SECURITY.md](./SECURITY.md) for how to report one privately.
