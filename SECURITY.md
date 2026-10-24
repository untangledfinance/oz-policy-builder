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
| Prime seat, `prime-seat` (Stellar) | Soroban contract on Stellar testnet, one instance per seat owner and account (code hash in `contracts/build-hashes.json`) |
| `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` | Off-chain packages in `packages/`, published to npm at version 4.1.0 from this repository at tag `v4.1.0` |
| `PrimeSeat` (EVM) | Solidity contract on Base Sepolia, one instance per seat owner and Safe (code hashes in `contracts/build-hashes.json`) |
| `custody-gate`, `prime-seat` (Solana) | Solana programs on devnet, deployed final (program ids in [docs/solana.md](./docs/solana.md#deployed)) |

`test-blend-pool` is a testnet-only fixture and is out of scope. The EVM and
Solana contracts are in scope for reports and outside the external audit
below.

## Audit status

**An external audit is in progress:** it covers the policy interpreter, the
custody gate, the execution adapter, the Prime seat and the three TypeScript
packages. Untangled set the scope on 10 October 2026 and added the Prime seat
on 21 October 2026.
[docs/audit-overview.md](./docs/audit-overview.md) lists the code in scope, its
size and the assumptions about everything outside it. The Prime seat has had
internal reviews and mutation testing; its README has the mutation run. The
contracts have also been through internal adversarial review and STRIDE threat
models, and each finding was either fixed or documented as an accepted trust
assumption. The pages in [docs/](./docs/README.md) state what
each piece enforces; treat anything they do not claim as unenforced.

## Supported versions

Only the latest release is supported: version 4.1.0 of
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp` on npm, the same code as this repository at tag
`v4.1.0`, and the contract builds pinned in
`packages/policy-synth/src/config.ts`, `deployments/` and
`contracts/build-hashes.json`. Every npm version before 4.1.0 (0.x, 1.x,
2.0.0, 2.0.1, 3.0.0, 4.0.0 and 4.0.1) is unsupported.

**Advisories a consumer may see:** `npm audit` in a project that installs the
packages reports `toml` up to 5.0.0 (GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j,
GHSA-4qx8-w7c3-pj3p, GHSA-9j65-hcg3-gc64, GHSA-9qmh-m7c6-f92p), which
`@stellar/stellar-sdk` 14.x depends on. The packages never parse TOML (they
use no `StellarToml` or `Federation` code), so the path is unreachable from
them. It may also report `ip-address` up to 10.7.3 (GHSA-rxp7-6hxx-x8q5),
which the MCP server reaches through `@modelcontextprotocol/sdk` and
`express-rate-limit`. The repository's root `overrides` pin fixed versions of
both for this workspace, and npm applies them to this workspace only, so they
do not reach a consumer's install. Pin `toml` `^5.0.1` and `ip-address`
`^10.7.4` in your own `overrides` to clear the report.
