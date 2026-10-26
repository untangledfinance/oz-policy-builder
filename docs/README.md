# Prime docs

Prime keeps an institution's funds in its own custody and lets an agent move
part of them under rules the institution's owners set, on Stellar. This
repository holds the contracts behind it and the OZ Policy Builder that writes
the rules.

## Pages

| Page | What it covers |
|---|---|
| [audit-overview.md](audit-overview.md) | the three components with their size, what is in and out of audit scope, and what each contract enforces |
| [architecture.md](architecture.md) | the use case, the components, trust boundaries, owners and Prime seats, the main flows and why each part is built the way it is |
| [stellar.md](stellar.md) | the custody gate, execution adapter, policy interpreter and Prime seat on an OpenZeppelin smart account; the policy builder's checks |

The contracts' own READMEs hold the interfaces and test detail:
[contracts/README.md](../contracts/README.md) (sizes, hashes, CI),
[policy-interpreter](../contracts/stellar/policy-interpreter/README.md),
[custody gate](../contracts/stellar/custody-gate/README.md),
[execution adapter](../contracts/stellar/execution-adapter/README.md),
[Prime seat](../contracts/stellar/prime-seat/README.md).

## Packages

The three TypeScript packages are published to npm at version 5.2.0 as
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp`, the same code as this repository at tag
`v5.2.0`. The code submitted for the external audit is tag `v5.2.0`
([audit-overview.md](audit-overview.md) has the scope). The [repository README](../README.md) has the install lines.

## What runs where

Every contract runs on Stellar testnet.

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
