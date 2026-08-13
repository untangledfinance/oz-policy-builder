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
| `policy-interpreter` | Soroban contract, deployed on Stellar mainnet and testnet (addresses pinned in `packages/policy-synth/src/run/schemas.ts`) |
| `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` | Published on npm, run off-chain |

`test-oracle` and `test-blend-pool` are testnet-only fixtures and are out of
scope.

## Audit status

**These contracts are unaudited.** They have been through internal adversarial
review, and the findings that came out of it were either fixed or documented
as accepted trust assumptions, but no external audit has been completed.
[docs/architecture.md](./docs/architecture.md) is specific about what each
piece does and does not enforce; treat anything it does not claim as
unenforced.

## Supported versions

Only the latest published version of the npm packages and the contract
builds pinned in `packages/policy-synth/src/run/schemas.ts` are supported.
