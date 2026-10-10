# Security Policy

## Reporting a vulnerability

Email **team@untangled.finance** with a description of the issue, the component
affected, and reproduction steps if you have them. Do not open a public
issue for anything you believe is exploitable.

We will acknowledge your report promptly. Please give us a reasonable window
to remediate before any public disclosure.

There is currently no bug bounty programme.

## Scope

| Component | Where it runs |
| --- | --- |
| `policy-interpreter` | Soroban contract on Stellar mainnet and testnet. The npm packages pin the grammar-4 interpreter (addresses in `packages/policy-synth/src/run/schemas.ts`); the Prime mainnet deployment uses the grammar-6 interpreter (address and code hash in `deployments/prime-mainnet.json`). `main` builds grammar 6 (`SELF_VERSION` in `contracts/policy-interpreter/src/version.rs`). See [docs/stellar.md#deployments](./docs/stellar.md#deployments) for current addresses and hashes. |
| `custody-gate` | Soroban contract on Stellar mainnet and testnet, one instance per custody account. The pinned code hashes are in `deployments/prime-mainnet.json` (mainnet) and `deployments/execution-testnet.json` (testnet); see [docs/stellar.md#custody-gate](./docs/stellar.md#custody-gate). |
| `execution-adapter` | Soroban contract on Stellar mainnet and testnet, one instance per custody account. The pinned code hashes are in `deployments/prime-mainnet.json` (mainnet) and `deployments/execution-testnet.json` (testnet); see [docs/stellar.md#execution-adapter](./docs/stellar.md#execution-adapter). |
| `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` | Published on npm, run off-chain |

`test-blend-pool` is a testnet-only fixture and is out of scope.

## Audit status

**An external audit is in progress.** Its report has not been published yet.
The contracts have also been through internal adversarial review and a STRIDE
threat model, and the findings that came out of them were either fixed or
documented as accepted trust assumptions.
[docs/stellar.md](./docs/stellar.md) is specific about what each
piece does and does not enforce; treat anything it does not claim as
unenforced.

## Supported versions

Only the latest published version of the npm packages and the contract
builds pinned in `packages/policy-synth/src/run/schemas.ts` are supported.
