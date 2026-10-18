# Prime docs

Prime keeps an institution's funds in its own custody and lets an agent move
part of them under rules the institution's owners set, on Stellar, EVM and
Solana. Owners whose wallets live on another chain take part through seats and
NEAR. This repository holds the contracts of ours behind it, and the OZ Policy
Builder that writes Stellar rules.

## Pages

| Page | What it covers |
|---|---|
| [architecture.md](architecture.md) | the use case, components per chain, trust boundaries, the seat model, the main flows and why each part is built the way it is |
| [stellar.md](stellar.md) | the custody gate, execution adapter, policy interpreter and `prime-seat` on an OpenZeppelin smart account; the policy builder's checks |
| [evm.md](evm.md) | Safe, Zodiac Roles and OpenZeppelin's timelock as custody gate and recovery; `PrimeSeat` |
| [solana.md](solana.md) | the Squads Smart Account, the custody gate program and `prime-seat` |
| [near.md](near.md) | `prime-near-signer` v1 and v2, which turn a wallet signature into a NEAR MPC signature |

The contracts' own READMEs hold the interfaces and test detail:
[contracts/README.md](../contracts/README.md) (sizes, hashes, CI),
[policy-interpreter](../contracts/stellar/policy-interpreter/README.md),
[custody gate](../contracts/stellar/custody-gate/README.md),
[execution adapter](../contracts/stellar/execution-adapter/README.md),
[Stellar seat](../contracts/stellar/prime-seat/README.md),
[EVM seat](../contracts/evm/prime-seat/README.md),
[Solana seat](../contracts/solana/prime-seat/README.md),
[NEAR signer v2](../contracts/near/prime-near-signer-v2/README.md). The Solana
design record and setup guide are
[contracts/solana/README-architecture.md](../contracts/solana/README-architecture.md)
and [contracts/solana/SETUP-AND-RECOVERY.md](../contracts/solana/SETUP-AND-RECOVERY.md).

## What runs where

Mainnet runs only the Stellar custody contracts, with the grammar-6 interpreter
built from `main`. Everything else is on test networks.

| Chain | Contract | Mainnet | Test network |
|---|---|---|---|
| Stellar | policy interpreter | grammar 6, `CAOBQ4ZX…` (wasm `5143e641…`) | grammar 6 `CDPR5VTX…` for the Prime app; grammar 7 `CDZV4AG4…` (wasm `69cad1d5…`) for the 2.x packages |
| Stellar | custody gate | code `b01024f3…` | code `b01024f3…` |
| Stellar | execution adapter | code `3dd675c0…` for new setups, `68d012e7…` for setups of 1 October 2026 | code `3dd675c0…` |
| Stellar | `prime-seat` | none | code `393f0e5d…`, one instance per NEAR-routed owner and account |
| EVM | `PrimeSeat` | none | Base Sepolia, one instance per NEAR-routed owner and Safe |
| Solana | custody gate | none | devnet `6ieR7WUs…` (`a5d19edb…`) |
| Solana | `prime-seat` | none | devnet `7ygNrKpK…` (`a389f4a1…`) |
| NEAR | `prime-near-signer-v2` | none | `seats.prime-spike-muwguc60.testnet` (`4b98d6d3…`) |
| NEAR | `prime-near-signer` v1 | none | `signer.prime-spike-muwguc60.testnet` (`c27904a3…`) |

The records are in [`deployments/`](../deployments) (Stellar) and
[`contracts/build-hashes.json`](../contracts/build-hashes.json) (seats, Solana,
NEAR). Each chain page has the full addresses and how each was checked.

## Grammar 6 and grammar 7

The policy interpreter is versioned by its predicate grammar, and each version
is a new instance. Mainnet Prime runs grammar 6 from the `main` branch: the
Prime app pins `CAOBQ4ZX…` on mainnet and `CDPR5VTX…` on testnet for every
custody setup. This branch, `feat/grammar-v7`, holds the grammar-7 source; its
instance `CDZV4AG4…` runs on testnet only and is the pin of the 2.x npm
packages. Where the two grammars differ,
[stellar.md](stellar.md#policy-interpreter) says which one it describes.

## Files kept for the record

Some files look unused on this branch. Each is kept on purpose.

| File | Why it stays |
|---|---|
| `contracts/near/prime-near-signer` (v1) | deployed and pinned in CI; octopos tests derive NEAR MPC keys under its account. v2 replaced it for the seats |
| `scripts/deploy-prime-mainnet.ts` | the record of how the mainnet custody contracts were deployed on 1 October 2026. It pins the grammar-6 interpreter `5143e641…` and the adapter `68d012e7…`, which this tree does not build, and it checks every hash before it reads a secret or calls the network, so on this branch it stops at the hash check |
| `scripts/deploy-grammar6-testnet.ts`, `deployments/grammar6-testnet.json` | the grammar-6 testnet record the Prime app's testnet setups use. The script reads `SELF_VERSION` and refuses this branch's grammar-7 source before any network call |
| `scripts/upload-execution-testnet.ts` | uploads the gate and adapter builds and writes `deployments/execution-testnet.json`, which CI compares |
| `scripts/verify-stateless-testnet.ts`, `evidence/stateless/` | evidence for the stateless execution receipts in the audit pack |
| `evidence/*.log`, `evidence/stride-threat-model.md` | the 1.x and grammar-6 evidence the audit of `main` reads; `evidence/README.md` says how to reproduce each |
| `packages/policy-synth/scripts/deploy-test-account.ts` | deploys the testnet smart account the live tests use (`CASJ5GEC…`) |
| `packages/policy-synth/scripts/mutate.ts` | a mutation runner for the TypeScript tests, run by hand |
| `contracts/stellar/policy-interpreter/tests/conformance/_generated_v4.rs` | grammar-4 cases compiled into the grammar-7 conformance suite |
| `contracts/solana/README-architecture.md`, `contracts/solana/SETUP-AND-RECOVERY.md` | the Solana design record and walkthrough, with the runs behind each claim; [solana.md](solana.md) is the current summary |
| tag `archive/spike-final` | the spike bundle, the round-9 design record and the removed `prime-session` contracts |
