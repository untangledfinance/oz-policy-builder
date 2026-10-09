# Prime contracts

This folder holds every contract behind a Prime account, one folder per chain. The Stellar folder has the OctoGate contracts (custody gate, execution adapter, policy interpreter) and the Stellar session signer. The EVM, Solana and NEAR folders hold the session contracts that let a wallet start a session key on each chain. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design, and [spike/](spike/) is the evidence bundle with the harnesses, logs and testnet records behind it.

## Layout

```
contracts/prime/
  README.md
  ARCHITECTURE.md
  spike/                        evidence bundle: harnesses, logs, testnet records
  stellar/
    prime-session/              session signer on an OZ smart account (new code)
    custody-gate/               OctoGate: the custody account's gate
    execution-adapter/          OctoGate: per-Prime batcher, bound to one gate
    policy-interpreter/         OctoGate: grammar 6, evaluates the mandate on every call
    test-blend-pool/            Blend-shaped stub, testnet only
  evm/prime-session/            PrimeSession.sol, a Roles member of Safe 1.4.1 and Zodiac Roles v2
  solana/prime-session/         session PDA that acts inside a Squads Smart Account
  solana/custody-gate/          gate-owned custody gate (line-cut build), plus app-checks/
  near/prime-near-signer/       pass-through signer that checks a wallet signature, then asks NEAR MPC to sign
```

## Audit scope

sLOC counts the non-blank, non-comment lines of the contract source, test files excluded. The same count gave the figures in the refinement reports.

| Chain | Contract | sLOC | Scope |
|---|---|---|---|
| EVM | `evm/prime-session` | 32 | new code |
| NEAR | `near/prime-near-signer` | 20 | new code |
| Solana | `solana/custody-gate` | 84 | new code |
| Solana | `solana/prime-session` | 33 | new code |
| Stellar | `stellar/prime-session` | 37 | new code |
| Stellar | `stellar/custody-gate` | 55 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/execution-adapter` | 221 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/policy-interpreter` | 1,082 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/test-blend-pool` | 22 | test double, testnet only |

Per chain, the new code to audit is 32 on EVM, 20 on NEAR, 84 + 33 = 117 on Solana and 37 on Stellar. The OctoGate contracts have their own external audit.

## Build and test

Every result below was measured on 9 October 2026 after the move into this folder. Commands run from the contract's own folder.

| Contract | Command | Result |
|---|---|---|
| `stellar/prime-session` | `stellar contract build` | wasm sha256 `e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3` |
| | `./build-wasm.sh` | `d9eb29efa629a4fc4974d2f43410d4e4996cadda98dbc7a9cd273e53d72ce887` (path-remapped build) |
| | `cargo test` | 11 passed |
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` |
| | `cargo test` | 3 passed |
| `stellar/execution-adapter` | `./build-wasm.sh` | `68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd` |
| | `cargo test` | 33 passed |
| `stellar/policy-interpreter` | `./build-wasm.sh` | `5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126` |
| | `cargo test`, then `cargo test --release --test conformance` | 151 passed (82 unit, 69 in the integration suites, 18 of them conformance); the release conformance run passes 18 |
| `stellar/test-blend-pool` | `cargo test` | builds, no tests |
| `evm/prime-session` | `~/.foundry/bin/forge build`, then `forge test` | build clean, 6 passed; creation and runtime bytecode equal the earlier build (3,996 bytes of runtime code) |
| `solana/prime-session` | `PRIME_CLUSTER=localnet cargo-build-sbf` | `.so` sha256 `be6ade02a14b495d528d69d4f4632a0ffb9c9c83a9165ac8d2e0b1dbac102e13`, equal to the round 9 localnet build |
| | `PRIME_CLUSTER=devnet cargo-build-sbf` | `8db245ab5ba25a6b8585bfd193be5d9241e5df0f331792437c34f1ac888b7b76` |
| `solana/custody-gate` | `cargo-build-sbf` | `.so` sha256 `00d6a5c4d7f04be1b23c635bc3cd8c952354404bb799875fcaf0c9346b7f7871` (47,304 bytes), equal to the line-cut build measured in the Solana optimisation round |
| `solana/custody-gate/app-checks` | `tsc --strict --noEmit setup-checks.ts`, then `bun test setup-checks.test.ts` | clean, 43 passed |
| `near/prime-near-signer` | `RUSTUP_TOOLCHAIN=stable cargo-near near build non-reproducible-wasm --no-abi` | wasm sha256 `8f90ea67e5202105b3ebec4c902d48dc72120262b193d97a1d06b8a9576510ce`, code hash `AfRTxyBpBmUDYi88xxytL5z4yfPn3tBa1SYawt4Jzh3b`, the hash deployed at `signer.prime-spike-muwguc60.testnet` |

### Stellar

`stellar contract build` and `build-wasm.sh` give different hashes because the script remaps the crate and registry paths. The script is the build behind the deployed hashes and the hashes CI pins. Compare hashes from a Linux build: macOS gives other bytes from the same source. Tools: stellar 27.1.0, Rust 1.97.1 from the repo's `rust-toolchain.toml`.

### EVM

Foundry 1.8.4, Solidity 0.8.28 with the optimizer at 200 runs. The contract imports three OpenZeppelin Contracts 5.4.0 files (`ECDSA`, `MessageHashUtils`, `Strings`), mapped by `foundry.toml` to `lib/oz/`. `lib/` stays out of git, as in the spike bundle. Unpack the package once:

```sh
npm pack @openzeppelin/contracts@5.4.0
tar xzf openzeppelin-contracts-5.4.0.tgz
mkdir -p lib/oz && cp -r package/utils package/interfaces lib/oz/
```

### Solana

Both programs build with the Solana CLI on `PATH` (4.3.0, `cargo-build-sbf` with platform tools v1.57 and rustc 1.95.0). `PRIME_CLUSTER` is a compile-time string that goes into the grant text a wallet signs, so each cluster gets its own `.so`. `custody-gate` is the gate-owned custody gate in its line-cut form (84 sLOC, standard `solana_program`).

`app-checks/` holds the checks an app runs before funds move: mint extensions, the gate read-back and the setup transactions. It needs `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15. The root `bunfig.toml` limits `bun test` to `packages/`, so run these tests from `app-checks/` after `bun add` of both libraries.

### NEAR

`non-reproducible-wasm` embeds the path of the Rust standard library, so the hash depends on the toolchain directory name. It matches under the `stable` toolchain (rustc 1.98.1), which the `RUSTUP_TOOLCHAIN=stable` prefix selects. The repository's `rust-toolchain.toml` pins 1.97.1 and gives another hash. The build used `cargo-near` 0.22.0.

## Stellar hashes before and after the move

The five Stellar crates moved from `contracts/<name>` and `contracts/prime-session` to `contracts/prime/stellar/<name>`. Each wasm was built the way the repo builds it before the move and again after.

| Contract | Before | After | Recorded |
|---|---|---|---|
| `policy-interpreter` | `5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126` | same | grammar 6 testnet record and mainnet record |
| `custody-gate` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` | same | execution testnet record and mainnet record |
| `execution-adapter` | `68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd` | same | execution testnet record and mainnet record |
| `prime-session` (`build-wasm.sh`) | `d9eb29efa629a4fc4974d2f43410d4e4996cadda98dbc7a9cd273e53d72ce887` | same | none |
| `prime-session` (`stellar contract build`) | `e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3` | same | Stellar testnet instances |
| `test-blend-pool` (remapped paths) | `7ba261ed4d1320ceabc47abcbe6819824c27529d0ae7e55ce2fc363555418e76` | same | none |

The records are `deployments/grammar6-testnet.json`, `deployments/execution-testnet.json` and `deployments/prime-mainnet.json`. They stay where they were, and CI reads them from `../../../../deployments/`.
