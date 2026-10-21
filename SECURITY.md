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
| `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` | Off-chain packages in `packages/`, published to npm at version 4.0.0 from this repository at tag `v4.0.0` |

`test-blend-pool` is a testnet-only fixture and is out of scope.

## Audit status

**An external audit is in progress:** it covers the policy interpreter, the
custody gate, the execution adapter and the three TypeScript packages (the scope
Untangled gave the auditor on 10 October 2026).
[docs/audit-overview.md](./docs/audit-overview.md) lists the code in scope, its
size and the assumptions about everything outside it. `prime-seat` is outside
the audit; it has had internal reviews and mutation testing, listed in its own
README. The contracts have also been through internal adversarial review and
STRIDE threat models, and each finding was either fixed or documented as an
accepted trust assumption. The pages in [docs/](./docs/README.md) state what
each piece enforces; treat anything they do not claim as unenforced.

## Supported versions

Only the latest release is supported: version 4.0.0 of
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp` on npm, the same code as this repository at tag
`v4.0.0`, and the contract builds pinned in
`packages/policy-synth/src/config.ts`, `deployments/` and
`contracts/build-hashes.json`. Every npm version before 4.0.0 (0.x, 1.x,
2.0.0, 2.0.1 and 3.0.0) is unsupported.

**Advisories a consumer may see:** `npm audit` in a project that installs the
packages reports `toml` up to 4.1.2 (GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j),
which `@stellar/stellar-sdk` 14.x depends on. The packages never parse TOML (they
use no `StellarToml` or `Federation` code), so the path is unreachable from
them. The repository's root `overrides` pin a fixed `toml` for this workspace,
and npm applies them to this workspace only, so they do not reach a consumer's
install. 2.0.1 carried the same chain. Pin `toml` `^4.2.0` in your own
`overrides` to clear the report.
