# Prime contracts

This folder holds every contract behind a Prime account, all on Stellar: the OctoGate contracts (custody gate, execution adapter, policy interpreter) and the seat.

An owner whose wallet does not sign on Stellar has a seat contract instead of a key. Its owner key is an ed25519 key that the NEAR MPC signs with, outside this repository. That owner grants a session key for at most 7 days, and the seat lets the key vote for the owner, always beside a native owner's signature, and act inside the rules that list the seat. An owner whose wallet signs on Stellar holds its place as a plain key and has no session. The round-9 design record ([ARCHITECTURE.md](https://github.com/untangledfinance/oz-policy-builder/blob/archive/spike-final/contracts/prime/ARCHITECTURE.md)) and the evidence bundle behind it ([spike/](https://github.com/untangledfinance/oz-policy-builder/tree/archive/spike-final/contracts/prime/spike), with the harnesses, logs and testnet records) are kept at tag `archive/spike-final`.

## Layout

```
contracts/
  README.md
  build-hashes.json             build hashes that CI compares against
  check-build-hash.sh           the comparison CI runs
  stellar/
    custody-gate/               OctoGate: the custody account's gate
    execution-adapter/          OctoGate: per-Prime batcher, bound to one gate or to none
    policy-interpreter/         OctoGate: grammar-7 source (testnet only); grammar 6 runs on mainnet
    test-blend-pool/            Blend-shaped stub, testnet only
    prime-seat/                 seat of an owner who signs through NEAR, on an OZ smart account
```

The seat came from `feat/near-seats` (`a9531b9`) unchanged. Its README has its build, tests and the reviews behind it; the [seat section](#the-seat) below has the hash.

## Contract size

sLOC counts the non-blank, non-comment lines of the contract source after `rustfmt`, test files excluded. Formatted sLOC is the official metric from 9 October 2026; the figures before that date counted the files as written. The sources are formatter output, and CI checks them.

| Contract | sLOC | Scope |
|---|---|---|
| `stellar/prime-seat` | 99 | new code |
| `stellar/custody-gate` | 55 | OctoGate, on mainnet, outside the new-code budget |
| `stellar/execution-adapter` | 226 | OctoGate, outside the new-code budget; the v4 build (238) is on mainnet too (see below), and this v5 source with an optional gate is on testnet only |
| `stellar/policy-interpreter` | 806 | OctoGate, outside the new-code budget; this grammar-7 source is on testnet only, and mainnet runs the grammar-6 build. 757 before the keyless executor rules for OpenZeppelin 0.8.0 (Option A, 20 October 2026) |
| `stellar/test-blend-pool` | 22 | test double, testnet only |

The OctoGate contracts have their own external audit.

## Build and test

Every hash and test count below was measured again on 18 October 2026 at the paths in this folder. Commands run from the contract's own folder. The seat is in [its own section](#the-seat).

| Contract | Command | Result |
|---|---|---|
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` |
| | `cargo test` | 3 passed |
| `stellar/execution-adapter` | `./build-wasm.sh` | `4985cd123baddd9f21c4c7eab63e79121d499029b0a514a0258b4846eb28313b`, the v5 build with an optional gate, pinned in `build-hashes.json` and uploaded on testnet only. The v4 build `3dd675c06a1f9b27b336347d7c7745d20845b6c1f35acfe4cd2ca93ab1db49c3` (`deployments/execution-testnet.json`, source at `a86a496`) is on mainnet too, and new setups use it there. Gates set up on mainnet before 11 October 2026 run the earlier build `68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd`, recorded in `deployments/prime-mainnet.json` |
| | `cargo test` | 62 passed |
| `stellar/policy-interpreter` | `./build-wasm.sh` | grammar 7: `810f53f129514c5cd15f90c9a8fcb2267169c9457cd950644b1d69f2bfbf127c` (20 October 2026, with the keyless executor rules for OpenZeppelin 0.8.0), pinned in `build-hashes.json`. The testnet instance in `deployments/grammar7-testnet.json` and the policy-synth pin still run the earlier build `69cad1d5ce9aeaa0dad6980fd030e528935a0ebdd290111f393e9fd0564a68b0` until the next redeploy. The grammar-6 build on mainnet is `5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126` |
| | `cargo test` (after `./build-wasm.sh`, which `tests/worst_case.rs` loads) | 415 passed: 173 unit and 242 in 13 integration suites, 18 of them conformance (measured 20 October 2026) |
| `stellar/test-blend-pool` | `cargo build --release --target wasm32v1-none` with the remaps of `build-wasm.sh` | `7ba261ed4d1320ceabc47abcbe6819824c27529d0ae7e55ce2fc363555418e76`, the hash this README records |
| | `cargo test` | builds, no tests |

### Reproducible builds

`stellar contract build` and `build-wasm.sh` give different hashes because the script remaps the crate and registry paths. The script is the build behind the deployed hashes and the hashes CI pins. Compare hashes from a Linux build: macOS gives other bytes from the same source. Tools: stellar 27.1.0, Rust 1.97.1 from the repo's `rust-toolchain.toml`.

## The seat

The seat is the on-chain owner entry of a wallet that signs through NEAR. The owner signs one readable grant, and the seat lets the session key in that grant act until its end. The hash below is the build in `build-hashes.json`, measured again on 18 October 2026 at the path in this folder.

| Contract | sLOC | Build | Hash | Tests |
|---|---|---|---|---|
| `stellar/prime-seat` | 99 | `./build-wasm.sh` | `393f0e5d340ed25ef1aa9beb2a5b6446b84247f75c5d858113779c9fa11baa87` (17,599 bytes) | `cargo test`: 21 |

The Prime app deploys one seat per owner and account, and pins the wasm.

The Stellar seat and the policy interpreter: the interpreter refuses an `External` signer in its rules (212), so a seat enters a policed rule as `Delegated`, the form it serves outside rule 0. The interpreter keeps a hash of the rule's signers, so `remove_signer` on a policed rule leaves that rule refusing every signer (204). To take a seat out of such a rule, add the rule again without the seat and remove the old one. `remove_context_rule` can leave the interpreter's entry for the removed rule behind, because `uninstall` needs the policy admins' own authorisation. All three hold for every interpreter version deployed so far, grammars 3 to 7. A seat cannot be a policy admin: it authorises only through its account's `__check_auth`. [docs/stellar.md](../docs/stellar.md#changing-who-signs-a-policed-rule) has the detail.

## Hashes before and after the move to `contracts/`

On 18 October 2026 every contract moved from `contracts/prime/<chain>/<name>` to `contracts/<chain>/<name>`. Each one was built at the new path the way CI builds it, and compared with the hash recorded before the move.

| Contract | Build | Recorded before the move | At the new path |
|---|---|---|---|
| `stellar/policy-interpreter` | `./build-wasm.sh` | `69cad1d5…` (`deployments/grammar7-testnet.json`) | same |
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f3…` (`deployments/execution-testnet.json`) | same |
| `stellar/execution-adapter` | `./build-wasm.sh` | `3dd675c0…` (`deployments/execution-testnet.json`) | same |
| `stellar/test-blend-pool` | release build with the same remaps | `7ba261ed…` (this README) | same |
| `stellar/prime-seat` | `./build-wasm.sh` | `393f0e5d…` (`build-hashes.json`) | same |

No build embeds the crate's own path. The build scripts remap it to `/src`.

The records are `build-hashes.json`, `deployments/grammar7-testnet.json` and `deployments/execution-testnet.json`. CI reads the last two from `../../../deployments/`. Since the optional gate (v5), CI compares the adapter with `build-hashes.json`; `deployments/execution-testnet.json` keeps the v4 build the Prime app pins.

## CI

`.github/workflows/ci.yml` builds and tests every contract in this folder.

| Job | What it runs |
|---|---|
| `Contracts (<stellar crate>)` | `cargo fmt --check` (every crate), `cargo clippy -D warnings`, `cargo test`; for `policy-interpreter` also the release conformance run, `cargo audit`, the `build-wasm.sh` hash against `build-hashes.json` and the `oz08/` suite of that wasm against OpenZeppelin's 0.8.0 account; for `custody-gate` the hash against `deployments/execution-testnet.json`; for `execution-adapter` and `prime-seat` the hash against `build-hashes.json` |
| `Contracts (prime-seat)`, in the Stellar matrix | as the other Stellar crates, and the `build-wasm.sh` hash against `build-hashes.json` |

`build-hashes.json` holds the hashes CI compares. Change an entry in the same commit as the source it covers.
