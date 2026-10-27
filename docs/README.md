# Prime docs

Prime keeps an institution's funds in its own custody and lets an agent move
part of them under rules the institution's owners set, on Stellar, EVM and
Solana. This repository holds the contracts behind it and the OZ Policy Builder
that writes the Stellar rules.

## Pages

| Page | What it covers |
|---|---|
| [audit-overview.md](audit-overview.md) | the three components with their size, what is in and out of audit scope, and what each contract enforces |
| [architecture.md](architecture.md) | the use case, the components, trust boundaries, owners and Prime seats, the main flows and why each part is built the way it is |
| [stellar.md](stellar.md) | the custody gate, execution adapter, policy interpreter and Prime seat on an OpenZeppelin smart account; the policy builder's checks |
| [evm.md](evm.md) | the custody design on Safe, Zodiac Roles and OpenZeppelin's timelock, and the EVM seat `PrimeSeat` |
| [solana.md](solana.md) | Prime on Solana by configuration only: the Squads Smart Account as custody gate and Prime account, Token-2022 for permissioned assets, and the venue's programs |

The contracts' own READMEs hold the interfaces and test detail:
[contracts/README.md](../contracts/README.md) (sizes, hashes, CI),
[policy-interpreter](../contracts/stellar/policy-interpreter/README.md),
[custody gate](../contracts/stellar/custody-gate/README.md),
[execution adapter](../contracts/stellar/execution-adapter/README.md),
[Prime seat](../contracts/stellar/prime-seat/README.md),
[EVM seat](../contracts/evm/prime-seat/README.md). Prime on Solana has no
contract of its own; [solana.md](solana.md) holds its whole design.

## Packages

The three TypeScript packages are published to npm at version 5.2.0 as
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp`, the same code as this repository at tag
`v5.2.0`. The code submitted for the external audit is tag `v5.2.0`
([audit-overview.md](audit-overview.md) has the scope). The [repository README](../README.md) has the install lines.

## What runs where

Every Stellar contract runs on Stellar testnet.

| Contract | Testnet |
|---|---|
| Policy interpreter | instance `CDER6P73…` (wasm `6704996f…`, this tree's build), the pin of the TypeScript packages; it replaced `CD46LN75…` (`810f53f1…`) and `CDZV4AG4…` (`69cad1d5…`), which they no longer trust |
| Custody gate | code `b01024f3…`; each custody account deploys its own gate |
| Execution adapter | code `bf85432c…`, recorded in `deployments/execution-testnet.json` in place of `4985cd12…` and `3dd675c0…`; each Prime deploys its own adapter, bound to a gate or to none |
| Prime seat | code `393f0e5d…`, one instance per seat owner and account |
| OpenZeppelin smart account | code `91a2cd56…` (0.7.2-line), the Prime account; code `8286422f…` (`v0.8.0`), the reference account `CDS2W673…` |
| OpenZeppelin policies | `simple_threshold`, `weighted_threshold`, `spending_limit` built from `v0.8.0` on testnet, `v0.7.2` on mainnet (`deployments/oz-policies.json`) |

The records are in [`deployments/`](../deployments) and
[`contracts/build-hashes.json`](../contracts/build-hashes.json).
[stellar.md](stellar.md#deployments) has the full addresses and how each was
checked.

The EVM contracts run on test networks only and are outside the audit scope.

| Contract | Network |
|---|---|
| EVM seat, `PrimeSeat` | fork-tested against Base Sepolia, no persistent deployment ([evm-testnet.json](../deployments/evm-testnet.json)); an app deploys one per seat owner and Safe from the creation code `4d355864…` |

[evm.md](evm.md#deployed) has the detail. Prime on Solana deploys no
program: it configures the Squads Smart Account, SPL Token-2022 and Kamino's
deployed programs ([solana.md](solana.md#deployments)).
