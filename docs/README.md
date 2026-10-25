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

The three TypeScript packages are published to npm at version 4.1.0 as
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp`, the same code as this repository at tag
`v4.1.0`. The [repository README](../README.md) has the install lines.

## What runs where

Every contract runs on Stellar testnet.

| Contract | Testnet |
|---|---|
| Policy interpreter | instance `CD46LN75…` (wasm `810f53f1…`, this tree's build before shared predicates), the pin of the TypeScript packages; it replaced `CDZV4AG4…` (`69cad1d5…`), which they no longer trust |
| Custody gate | code `b01024f3…`; each custody account deploys its own gate |
| Execution adapter | code `4985cd12…`, recorded in `deployments/execution-testnet.json` in place of `3dd675c0…`; each Prime deploys its own adapter, bound to a gate or to none |
| Prime seat | code `393f0e5d…`, one instance per seat owner and account |
| OpenZeppelin smart account | code `91a2cd56…`, the Prime account |

The records are in [`deployments/`](../deployments) and
[`contracts/build-hashes.json`](../contracts/build-hashes.json).
[stellar.md](stellar.md#deployments) has the full addresses and how each was
checked.
