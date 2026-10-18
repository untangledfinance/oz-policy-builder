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
| `policy-interpreter`, `custody-gate`, `execution-adapter` (Stellar) | Soroban contracts on Stellar mainnet and testnet; the grammar-7 interpreter source on this branch runs on testnet only (addresses in `packages/policy-synth/src/config.ts` and `deployments/`) |
| `prime-seat` (Stellar), `PrimeSeat` (EVM), `prime-seat` and `custody-gate` (Solana) | Stellar testnet, Base Sepolia and Solana devnet |
| `prime-near-signer` v1 and v2 | NEAR testnet |
| `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` | Published on npm, run off-chain |

`test-blend-pool` is a testnet-only fixture and is out of scope.

## Audit status

**An external audit is in progress:** it covers the policy interpreter, the
custody gate, the execution adapter and the three npm packages on `main`. Its
report is still to come. The seats, the Solana programs and the NEAR signers
are outside it; they have had internal reviews and mutation testing, listed in
[contracts/README.md](./contracts/README.md) and their own READMEs.
The contracts have also been through internal adversarial review and STRIDE
threat models, and the findings that came out of them were either fixed or
documented as accepted trust assumptions. The pages in [docs/](./docs/README.md)
are specific about what each piece does and does not enforce; treat anything
they do not claim as unenforced.

## Supported versions

Only the latest published version of the npm packages and the contract
builds pinned in `packages/policy-synth/src/config.ts`, `deployments/` and
`contracts/build-hashes.json` are supported.
