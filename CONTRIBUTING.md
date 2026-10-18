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

The [Stellar CLI](https://developers.stellar.org/docs/tools/cli) is needed
only to deploy or exercise contracts on a live network. The test suites run
without it.

## Gates

Every pull request must pass the same gates CI runs. Run them locally first:

```sh
# TypeScript, in the order CI runs it
bun run check       # biome lint + format
# Build before the typecheck: the CLI and MCP packages read policy-synth's
# types from its built dist/. The builds are also what publishing runs.
bun run --cwd packages/policy-synth build
bun run --cwd packages/policy-builder-cli build
bun run --cwd packages/policy-builder-mcp build
bun run typecheck   # tsc --noEmit across the three TS packages
bun test            # every package's suites in one process
bun run test:isolated   # each package's tests alone, as prepublishOnly runs them
bun audit           # dependency advisories

# Contracts (each crate is standalone; no workspace manifest)
for crate in policy-interpreter custody-gate execution-adapter test-blend-pool prime-seat; do
  ( cd "contracts/stellar/$crate" &&
    cargo fmt --check &&
    cargo clippy --all-targets -- -D warnings &&
    cargo test )
done
```

In the interpreter crate, run `./build-wasm.sh` before `cargo test`.
`tests/worst_case.rs` installs the largest rules into the real wasm and fails
without one. Point `G7_WASM` at another build, or set `G7_SKIP_WORST_CASE=1`
to skip it locally. CI also runs the conformance suite in release mode:

```sh
( cd contracts/stellar/policy-interpreter && cargo test --release --test conformance )
```

CI then compares the `build-wasm.sh` hash of the interpreter with
`deployments/grammar7-testnet.json`, and those of the gate and the adapter with
`deployments/execution-testnet.json`. Compare hashes from a Linux build.

The other contracts have a CI job each. From the repository root:

```sh
# EVM seat (Foundry 1.8.4). Fetch OpenZeppelin into lib/ first, as contracts/README.md shows.
( cd contracts/evm/prime-seat && forge fmt --check src && forge build && forge test )

# Solana programs (Solana CLI 4.3.0)
for crate in prime-session custody-gate prime-seat; do
  ( cd "contracts/solana/$crate" &&
    RUSTUP_TOOLCHAIN=stable cargo fmt --check &&
    RUSTUP_TOOLCHAIN=stable PRIME_CLUSTER=localnet cargo-build-sbf -- --locked )
done

# NEAR signer v2 and its shared vectors (the generator needs Bun 1.4)
( cd contracts/near/prime-near-signer-v2 &&
  cargo fmt --check &&
  cargo clippy --all-targets --locked -- -D warnings &&
  cargo test --locked )
( cd contracts/near/vectors/generator &&
  bun install --frozen-lockfile &&
  bun gen.ts /tmp/requests.json && cmp /tmp/requests.json ../requests.json )

# The Solana app checks
( cd contracts/solana/custody-gate/app-checks &&
  bun install --frozen-lockfile && bun run typecheck && bun test )
```

The EVM, Solana and NEAR v2 jobs, and a job for the first NEAR signer, also
build each contract and compare it with `contracts/build-hashes.json`. The
build commands and their path remaps are in `.github/workflows/ci.yml`.

## Style

- TypeScript is formatted and linted by [Biome](https://biomejs.dev)
  (`biome.jsonc` at the root). Do not hand-format around it.
- Rust is formatted by `rustfmt` with default settings.
- Comments earn their place by stating an invariant, a constraint, or a
  deliberate decision the code cannot show on its own. Several files carry
  invariant blocks in their file-level comments (for example
  `contracts/stellar/policy-interpreter/src/dsl.rs`); read them before touching
  the code they guard, and do not remove them.

## Changes to the contracts

The on-chain crates hold safety invariants that are documented where they
live. In particular:

- The interpreter's deny codes are stable identifiers; never renumber
  them.
- The interpreter's predicate grammar is versioned. A grammar change means a
  new `SELF_VERSION`, new conformance fixtures, and a coordinated release of
  `@crediolabs/policy-synth` (see [Releasing](#releasing)).
- The TypeScript codec (`packages/policy-synth/src/wire.ts`) is held to the
  contract's own bytes by `fixtures/parity/grammar7.json`, which the contract's
  `tests/parity.rs` writes. If you change the grammar, regenerate it with
  `PARITY_WRITE=1 cargo test --test parity` (in the interpreter crate) in the
  same pull request; the Rust test fails when it is stale and the TypeScript
  tests fail when the codec disagrees with it. Tests that talk to the network
  replay `packages/policy-synth/fixtures/rpc/*.json`; `OPB_LIVE=1 bun test`
  records them again against testnet.

## Commits and pull requests

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`, with an optional scope (`fix(policy-synth): ...`).
- Keep pull requests small and single-purpose; a reviewer should be able to
  hold the whole diff in their head.
- Never commit secrets, `.env` files, or private keys. Contract addresses
  and wasm hashes are public on-chain data and are fine.

## Releasing

### npm packages

`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp` version together: one release bumps all
three to the same version, because the CLI and the MCP server pin the synth
core to an exact version (no `^` range).

1. Bump `version` in all three `package.json` files, and the
   `@crediolabs/policy-synth` dependency pin in
   `packages/policy-builder-cli/package.json` and
   `packages/policy-builder-mcp/package.json`, to the same new version.
2. Move the `[Unreleased]` entries in [CHANGELOG.md](./CHANGELOG.md) under
   the new version heading.
3. Commit as `chore(release): vX.Y.Z` and make sure CI is green.
4. Publish in dependency order; `prepublishOnly` builds and tests each
   package as part of the publish. A release that should stay off `latest`
   adds `--tag next`, as 2.0.0 did (grammar 7, testnet only):

   ```sh
   ( cd packages/policy-synth       && npm publish --access public )
   ( cd packages/policy-builder-cli     && npm publish --access public )
   ( cd packages/policy-builder-mcp     && npm publish --access public )
   # 2.0.0: npm publish --access public --tag next
   ```

5. Verify: `npm view @crediolabs/policy-synth dist-tags` shows the new
   version under the intended tag, and the package page renders the README.
6. Tag the release commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.
7. Bump the pin in downstream consumers (internal applications pin
   `@crediolabs/policy-synth` to an exact version).

Publishing is deliberately manual. CI has no npm credentials and no publish
job; keep it that way unless the token handling story changes.

### Contracts

The Rust crates are `publish = false`: they are never released to
crates.io. A contract "release" is a deployment:

- The policy interpreter's live addresses and wasm sha256 are pinned in
  `packages/policy-synth/src/config.ts`. Deploying a new interpreter
  build means a new wasm hash, new instance addresses, updating those pins,
  and releasing the npm packages that carry them.
- A predicate grammar change additionally bumps `SELF_VERSION`
  (`contracts/stellar/policy-interpreter/src/version.rs`) and regenerates the
  conformance fixtures; `install` refuses a grammar version it does not
  speak, so old synthesisers cannot install onto a new interpreter.

## Security

Do not open a public issue for a vulnerability. See
[SECURITY.md](./SECURITY.md) for how to report one privately.
