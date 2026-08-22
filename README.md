# OZ Policy Builder

[![CI](https://github.com/untangledfinance/oz-policy-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/untangledfinance/oz-policy-builder/actions/workflows/ci.yml)

The OZ Policy Builder turns a constraint you can say in a sentence into a
policy that lives on chain. You record a transaction and it produces a
predicate that an
[OpenZeppelin Stellar smart account](https://docs.openzeppelin.com/stellar-contracts)
enforces on every call. "This key may only call `transfer` on USDC, never
more than 50 at a time, and only to these three addresses" stops being a
promise and becomes something the account checks before it signs.

It is built as two halves:

- **Off chain**, `@crediolabs/policy-synth` records a transaction, lowers it to
  a predicate that pins the contract, method and arguments the recording
  carried, renders a review card describing every leaf, and returns an unsigned
  install transaction for the user's wallet to sign. A CLI and an MCP server
  wrap the same core for shells and agents.
- **On chain**, the `policy-interpreter` Soroban contract evaluates the
  predicate on every guarded call, fail-closed: one audit-once engine, and
  every policy is declarative data fed into it, so a new combination of
  constraints needs no new contract and no re-audit.

## What is actually running

The policy interpreter is deployed on Stellar mainnet and testnet. Policies
built here have been installed on mainnet accounts and shown to permit the
call they were meant to permit and deny the one they were meant to deny.

The deployment is pinned in `packages/policy-synth/src/run/schemas.ts`:

| | Address / hash |
| --- | --- |
| Interpreter (mainnet) | `CDMCYVL64EYQK7URVXQR6TTQ76DBLMTINMM3YHTIP4NH7VR3WZV5E5NF` |
| Interpreter (testnet) | `CACCFGM2CH7ZV7MAZJP3TEZE2DMHJXORFHZUO6AXKGM3CZDBF7KMWPCL` |
| Interpreter wasm sha256 | `2995e398d196669d3828ef1934415255dc59904fba25fc6f9edd1a0bedfeb99a` |
| Grammar version | `3` |

The same wasm hash backs both networks; only the instance address differs.

> [!IMPORTANT]
> **Audit status.** The interpreter contract has not been externally audited.
> It has been through internal adversarial review, and an external review is
> in progress; no audit report has been published yet.
> [docs/architecture.md](./docs/architecture.md) is specific about what the
> policy layer does and does not enforce - treat anything it does not claim
> as unenforced. Report vulnerabilities per [SECURITY.md](./SECURITY.md).

## Where to start

| You want to | Read |
| --- | --- |
| Understand how the pieces fit together | [docs/architecture.md](./docs/architecture.md) |
| Build and install a policy from a shell | `packages/policy-builder-cli` (record + synthesize) |
| Drive it from an agent | `packages/policy-builder-mcp` (MCP over stdio / Streamable HTTP) |

## Layout

| Path | What it is |
| --- | --- |
| `packages/policy-synth` | The synthesiser and the record, verify, install and revoke flow. Published as `@crediolabs/policy-synth`. |
| `packages/policy-builder-cli` | CLI wrapper over the synth core (`@crediolabs/policy-builder-cli`). |
| `packages/policy-builder-mcp` | MCP server exposing the seven policy tools (`@crediolabs/policy-builder-mcp`). |
| `contracts/policy-interpreter` | The Soroban contract that enforces a predicate on chain. |
| `contracts/test-blend-pool` | A Blend-`submit`-shaped stub, for testnet verification only. |

## Build and test

The TypeScript workspace uses [Bun](https://bun.sh):

```sh
bun install
bun test          # unit + integration suites
bun run typecheck # tsc --noEmit across the three TS packages
bun run check     # biome lint + format
```

The Soroban contracts are standalone Cargo crates (soroban-sdk 27, built for
`wasm32v1-none`). There is no workspace manifest, so each is tested from its
own directory:

```sh
( cd contracts/policy-interpreter && cargo test )
( cd contracts/test-blend-pool    && cargo test )
```

## Contributing and security

[CONTRIBUTING.md](./CONTRIBUTING.md) is the short path from a fresh clone to
a green pull request; CI runs the same gates. Vulnerabilities go to
[SECURITY.md](./SECURITY.md), not the issue tracker. Package release notes
live in [CHANGELOG.md](./CHANGELOG.md), and the release procedure in
[docs/releasing.md](./docs/releasing.md).

## License

MIT. See [LICENSE](./LICENSE).
