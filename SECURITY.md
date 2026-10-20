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
| `policy-interpreter`, `custody-gate`, `execution-adapter` (Stellar) | Soroban contracts on Stellar testnet (addresses in `packages/policy-synth/src/config.ts` and `deployments/`) |
| `prime-seat` (Stellar) | Stellar testnet |
| `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` | Published on npm, run off-chain |

`test-blend-pool` is a testnet-only fixture and is out of scope.

## Audit status

**An external audit is in progress:** it covers the policy interpreter, the
custody gate, the execution adapter and the three npm packages (the scope
Untangled gave the auditor on 10 October 2026).
[docs/audit-overview.md](./docs/audit-overview.md) lists the code in scope, its
size and the assumptions about everything outside it. `prime-seat` is outside
the audit; it has had internal reviews and mutation testing, listed in its own
README. The contracts have also been through internal adversarial review and
STRIDE threat models, and each finding was either fixed or documented as an
accepted trust assumption. The pages in [docs/](./docs/README.md) state what
each piece enforces; treat anything they do not claim as unenforced.

## Supported versions

Only the latest published version of the npm packages and the contract
builds pinned in `packages/policy-synth/src/config.ts`, `deployments/` and
`contracts/build-hashes.json` are supported.
