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
| [solana.md](solana.md) | the custody gate and the seat program beside a Squads Smart Account |

The contracts' own READMEs hold the interfaces and test detail:
[contracts/README.md](../contracts/README.md) (sizes, hashes, CI),
[policy-interpreter](../contracts/stellar/policy-interpreter/README.md),
[custody gate](../contracts/stellar/custody-gate/README.md),
[execution adapter](../contracts/stellar/execution-adapter/README.md),
[Prime seat](../contracts/stellar/prime-seat/README.md),
[EVM seat](../contracts/evm/prime-seat/README.md),
[Solana seat](../contracts/solana/prime-seat/README.md). The Solana design
record and the setup guide are
[README-architecture.md](../contracts/solana/README-architecture.md) and
[SETUP-AND-RECOVERY.md](../contracts/solana/SETUP-AND-RECOVERY.md).

## Packages

The three TypeScript packages are published to npm at version 4.1.0 as
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp`, the same code as this repository at tag
`v4.1.0`. The [repository README](../README.md) has the install lines.

## What runs where

Every Stellar contract runs on Stellar testnet.

| Contract | Testnet |
|---|---|
| Policy interpreter | instance `CD46LN75…` (wasm `810f53f1…`, this tree's build), the pin of the TypeScript packages; it replaced `CDZV4AG4…` (`69cad1d5…`), which they no longer trust |
| Custody gate | code `b01024f3…`; each custody account deploys its own gate |
| Execution adapter | code `4985cd12…`, recorded in `deployments/execution-testnet.json` in place of `3dd675c0…`; each Prime deploys its own adapter, bound to a gate or to none |
| Prime seat | code `393f0e5d…`, one instance per seat owner and account |
| OpenZeppelin smart account | code `91a2cd56…`, the Prime account |

The records are in [`deployments/`](../deployments) and
[`contracts/build-hashes.json`](../contracts/build-hashes.json).
[stellar.md](stellar.md#deployments) has the full addresses and how each was
checked.

The EVM and Solana contracts run on test networks only and are outside the
audit scope.

| Contract | Network |
|---|---|
| EVM seat, `PrimeSeat` | fork-tested against Base Sepolia, no persistent deployment ([evm-testnet.json](../deployments/evm-testnet.json)); an app deploys one per seat owner and Safe from the creation code `4d355864…` |
| Solana custody gate | Solana devnet, program `6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz` (`a5d19edb…`), final ([solana-devnet.json](../deployments/solana-devnet.json)) |
| Solana seat, `prime-seat` | Solana devnet, program `7ygNrKpK3GYoNLMCkAa4e3mznGPF2KVGbKZsJcq8wSCb` (devnet build `a389f4a1…`), final |

[evm.md](evm.md#deployed) and [solana.md](solana.md#deployed) have the detail.
