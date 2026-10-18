# Prime contracts

This folder holds every contract behind a Prime account, one folder per chain. The Stellar folder has the OctoGate contracts (custody gate, execution adapter, policy interpreter) and the Stellar seat. The EVM folder has the EVM seat. The Solana folder has the seat program and the custody gate. The NEAR folder has the two signers that turn a wallet's signature into a NEAR MPC signature.

On every chain, an owner's session key exists only through a seat (on Stellar and EVM since 12 October 2026, on Solana since Tuan's decision of 18 October 2026). An owner whose wallet signs through NEAR has a seat contract instead of a key. That owner grants a session key for at most 7 days, and the seat lets the key vote for the owner, always beside a native owner's signature, and act inside the rules that list the seat. On Solana the seat votes as a settings signer, and a native owner writes every transaction. An owner whose wallet signs on the chain itself holds its seat as a plain key and has no session. The round-9 design record ([ARCHITECTURE.md](https://github.com/untangledfinance/oz-policy-builder/blob/archive/spike-final/contracts/prime/ARCHITECTURE.md)) and the evidence bundle behind it ([spike/](https://github.com/untangledfinance/oz-policy-builder/tree/archive/spike-final/contracts/prime/spike), with the harnesses, logs and testnet records) are kept at tag `archive/spike-final`.

## Layout

```
contracts/
  README.md
  build-hashes.json             build hashes that CI compares against
  check-build-hash.sh           the comparison CI runs
  stellar/
    custody-gate/               OctoGate: the custody account's gate
    execution-adapter/          OctoGate: per-Prime batcher, bound to one gate
    policy-interpreter/         OctoGate: grammar-7 source (testnet only); grammar 6 runs on mainnet
    test-blend-pool/            Blend-shaped stub, testnet only
  solana/README-architecture.md Solana design: Squads, the seat and the custody gate
  solana/SETUP-AND-RECOVERY.md  step-by-step guide: set up the custody gate and recover custody funds
  solana/custody-gate/          gate-owned custody gate (line-cut build with the multisig length check), plus app-checks/
  near/prime-near-signer/       pass-through signer that checks a wallet signature, then asks NEAR MPC to sign
  stellar/prime-seat/           seat of a NEAR-routed owner on an OZ smart account
  evm/prime-seat/               PrimeSeat.sol, a Safe owner for a NEAR-routed owner (ERC-1271)
  solana/prime-seat/            seat PDA of a NEAR-routed owner in a Squads Smart Account
  near/prime-near-signer-v2/    signer of the NEAR-routed owners' session grants (grants and ends only)
  near/vectors/                 shared vectors of v2 and the generator that writes them
```

The seats and v2 came from `feat/near-seats` (`a9531b9`) and `feat/near-seats-signer` (`cc6da45`) unchanged. Each one's README has its build, tests and the reviews behind it; the [seats section](#seats-of-near-routed-owners) below has the hashes.

## Contract size

sLOC counts the non-blank, non-comment lines of the contract source after the formatter (`rustfmt` for Rust, `forge fmt` for Solidity), test files excluded. Formatted sLOC is the official metric from 9 October 2026; the figures before that date counted the files as written. The Stellar, Solana and NEAR v2 sources are formatter output, and CI checks them. The EVM contract is `forge fmt` clean and checked in CI. The first NEAR signer packs several statements per line (22 as written), so its count is the figure after `rustfmt`.

| Chain | Contract | sLOC | Scope |
|---|---|---|---|
| EVM | `evm/prime-seat` | 72 | new code |
| NEAR | `near/prime-near-signer` | 42 | new code |
| NEAR | `near/prime-near-signer-v2` | 323 | new code |
| Solana | `solana/custody-gate` | 126 | new code |
| Solana | `solana/prime-seat` | 75 | new code |
| Stellar | `stellar/prime-seat` | 99 | new code |
| Stellar | `stellar/custody-gate` | 55 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/execution-adapter` | 238 | OctoGate, outside the new-code budget; on mainnet too (see below) |
| Stellar | `stellar/policy-interpreter` | 757 | OctoGate, outside the new-code budget; this grammar-7 source is on testnet only, and mainnet runs the grammar-6 build |
| Stellar | `stellar/test-blend-pool` | 22 | test double, testnet only |

Per chain, the new code is 72 on EVM, 42 + 323 = 365 on NEAR, 126 + 75 = 201 on Solana and 99 on Stellar, 737 in all. The OctoGate contracts have their own external audit.

## Build and test

Every hash and test count below was measured again on 18 October 2026 at the paths in this folder. The custody gate's harness and mutation rows ran on 9 October 2026 against the same build. Commands run from the contract's own folder. The seats and NEAR signer v2 are in [their own section](#seats-of-near-routed-owners).

| Contract | Command | Result |
|---|---|---|
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` |
| | `cargo test` | 3 passed |
| `stellar/execution-adapter` | `./build-wasm.sh` | `3dd675c06a1f9b27b336347d7c7745d20845b6c1f35acfe4cd2ca93ab1db49c3`, the testnet record. Its code is on mainnet too (read back on 18 October 2026), and new setups use it there. The mainnet setups of 1 October 2026 run the earlier build `68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd`, recorded in `deployments/prime-mainnet.json` |
| | `cargo test` | 45 passed |
| `stellar/policy-interpreter` | `./build-wasm.sh` | grammar 7: `69cad1d5ce9aeaa0dad6980fd030e528935a0ebdd290111f393e9fd0564a68b0`, the testnet pin. The grammar-6 build on mainnet is `5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126` |
| | `cargo test` (after `./build-wasm.sh`, which `tests/worst_case.rs` loads) | 397 passed: 173 unit and 224 in 12 integration suites, 18 of them conformance |
| `stellar/test-blend-pool` | `cargo build --release --target wasm32v1-none` with the remaps of `build-wasm.sh` | `7ba261ed4d1320ceabc47abcbe6819824c27529d0ae7e55ce2fc363555418e76`, the hash this README records |
| | `cargo test` | builds, no tests |
| `solana/custody-gate` | `cargo-build-sbf` | `.so` sha256 `a5d19edb879e75d054f1025d710753ce5150726130c3dd74887236fbdbdc94e2` (47,472 bytes), 126 sLOC. The build the independent review tested is `6d196cab5b6c6d29bc6cf650a1526b4be56c0550bed479b55090364d7a04dfd7` (47,160 bytes, 84 as written, 241 after `rustfmt`); the 9 October 2026 pass reached the same behaviour with the formatted source (12 million differential scenarios with no mismatch). The line cut without the multisig length check (`00d6a5c4d7f04be1b23c635bc3cd8c952354404bb799875fcaf0c9346b7f7871`, 47,304 bytes) is the build before the fix |
| | harnesses on a local validator (mainnet feature set, mainnet Squads and Token-2022 builds): `gate-a4.ts`, `venues-a4.ts`, `trustee-a4.ts`, `probe-fakems.ts`, run against the new build | 345/345 mock venue, 53/53 real Orca and Kamino, 9/9 trustee, 4/4 forged multisig refused |
| | `mutants3.py` (the 63 checks of the earlier pass plus 15 on the new helpers) | 78/78 gate mutants killed, including the one that removes the multisig length check |
| `solana/custody-gate/app-checks` | `tsc --strict --noEmit setup-checks.ts`, then `bun test setup-checks.test.ts` | clean, 43 passed |
| `near/prime-near-signer` | `RUSTUP_TOOLCHAIN=stable cargo-near near build non-reproducible-wasm --no-abi` | wasm sha256 `c27904a329814b6ee92e8b37cc99490c8edbc9bbd3fd86a926b38e7d05b793c8`, code hash `E6986kfXDAec5nZvuYiBiC3fmonHCrynwRCtd33s1U5u` (110,145 bytes), the code hash deployed at `signer.prime-spike-muwguc60.testnet` since 9 October 2026 (transaction `82Cj53AxZjzodX4DKba2eyhgcDVBHb6USAKcHtytLdwf`; the previous build was `8f90ea67…`, code hash `AfRTxyBpBmUDYi88xxytL5z4yfPn3tBa1SYawt4Jzh3b`) |

### Stellar

`stellar contract build` and `build-wasm.sh` give different hashes because the script remaps the crate and registry paths. The script is the build behind the deployed hashes and the hashes CI pins. Compare hashes from a Linux build: macOS gives other bytes from the same source. Tools: stellar 27.1.0, Rust 1.97.1 from the repo's `rust-toolchain.toml`.

### EVM

Foundry 1.8.4, Solidity 0.8.28 with the optimizer at 200 runs. `PrimeSeat` imports one OpenZeppelin Contracts 5.4.0 file (`ECDSA`), mapped by `foundry.toml` to `lib/oz/`. `lib/` stays out of git. Unpack the package once:

```sh
npm pack @openzeppelin/contracts@5.4.0
tar xzf openzeppelin-contracts-5.4.0.tgz
mkdir -p lib/oz && cp -r package/utils package/interfaces lib/oz/
rm -r package openzeppelin-contracts-5.4.0.tgz
```

### Solana

The two programs build with the Solana CLI on `PATH` (4.3.0, `cargo-build-sbf` with platform tools v1.57 and rustc 1.95.0). `PRIME_CLUSTER` is a compile-time string that goes into the seat's grant hash, so each cluster gets its own `prime_seat.so`. `custody-gate` is the gate-owned custody gate in its line-cut form (126 sLOC formatted, standard `solana_program`, Pinocchio not adopted) with the multisig length check, which refuses a token account posing as custody's multisig. The design and the setup guide are in [README-architecture.md](solana/README-architecture.md) and [SETUP-AND-RECOVERY.md](solana/SETUP-AND-RECOVERY.md).

The gate harnesses are in the spike bundle at tag `archive/spike-final`, in [`spike/matrix/near-minimal/opt/gate/`](https://github.com/untangledfinance/oz-policy-builder/tree/archive/spike-final/contracts/prime/spike/matrix/near-minimal/opt/gate). `run-validator.sh` there starts a local validator with its own ledger, the mainnet feature set, the mainnet Squads and Token-2022 builds and every gate build in `so/`. The mainnet dumps and fixture programs it loads stay out of git. The logs of the length-check run are in [`spike/matrix/near-minimal/round9/opt/gate/msfix/`](https://github.com/untangledfinance/oz-policy-builder/tree/archive/spike-final/contracts/prime/spike/matrix/near-minimal/round9/opt/gate/msfix), and the independent review of the line-cut build of 9 October 2026 is [`gate-linecut-review.md`](https://github.com/untangledfinance/oz-policy-builder/blob/archive/spike-final/contracts/prime/spike/matrix/near-minimal/round9/opt/gate-linecut-review.md) (archived).

`app-checks/` holds the checks an app runs before funds move: mint extensions, the gate read-back and the setup transactions. It has its own `package.json` and lockfile (`@solana/web3.js` 1.99.0, `@solana/spl-token` 0.4.15). The root `bunfig.toml` limits `bun test` to `packages/`, so run `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` from `app-checks/`.

### NEAR

`non-reproducible-wasm` embeds the path of the Rust standard library, so the hash depends on the toolchain directory name. It matches under the `stable` toolchain (rustc 1.98.1), which the `RUSTUP_TOOLCHAIN=stable` prefix selects. The repository's `rust-toolchain.toml` pins 1.97.1 and gives another hash. The build used `cargo-near` 0.22.0.

CI builds the same wasm on any runner. It pins Rust 1.98.1 (what `stable` was on 9 October 2026) with `rust-src`, and passes two `--remap-path-prefix` flags through `cargo-near --env RUSTFLAGS` that write the registry and toolchain paths in the form the deployed build had. The result is the hash recorded in `build-hashes.json` (`c27904a3…`).

## Deployed builds

These are the shared instances on test networks, each running a build above. The Stellar and EVM seats have none: the Prime app deploys one per owner and account (see the seats section).

| Chain | Deployed build | State |
|---|---|---|
| NEAR testnet | `signer.prime-spike-muwguc60.testnet`, code hash `E6986kfXDAec5nZvuYiBiC3fmonHCrynwRCtd33s1U5u` | redeployed with the new build; the derived MPC keys are unchanged, `signer-neg.ts` passed 12/12 and the Solana session matrix 133/133 with real NEAR |
| Solana devnet | gate [`6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz`](https://explorer.solana.com/address/6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz?cluster=devnet), and the removed `prime-session` at [`6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba`](https://explorer.solana.com/address/6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba?cluster=devnet) | both run the 9 October 2026 builds (`a5d19edb…` and `c8836361…`), each deployed with `--final` and `--max-len` equal to its size, and the on-chain code equals the `.so`. The session matrix passed 145/145 and the gate flow 84/84 on devnet, with a second session program id `GLabPwsshHoaXMrHM6nHsHEkf51MFkKP86WCdRpXg3SD` for the two-program checks ([`round9/solana-devnet-sloc2/`](https://github.com/untangledfinance/oz-policy-builder/tree/archive/spike-final/contracts/prime/spike/matrix/near-minimal/round9/solana-devnet-sloc2)). The first devnet builds are previous builds, and both are final too: gate `58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx` (`6d196cab…`, 84/84) and session `4tXCkZW255iZNT4gPHDuAbqR3eG8Zs3tRsgLRc1BoPRa` (`8db245ab…`, 136/136) |

The 9 October 2026 size pass, which changed sources on every chain and kept their behaviour, is documented in [`spike/matrix/near-minimal/round9/sloc2/`](https://github.com/untangledfinance/oz-policy-builder/tree/archive/spike-final/contracts/prime/spike/matrix/near-minimal/round9/sloc2): the mutation scripts, the differential harnesses and the logs.

## Seats of NEAR-routed owners

A seat is the on-chain owner entry of a wallet that signs through NEAR. The owner signs one readable grant through `prime-near-signer` v2, and the seat lets the session key in that grant act until its end. The hashes below are the builds in `build-hashes.json`, measured again on 18 October 2026 at the paths in this folder; none changed.

| Contract | sLOC | Build | Hash | Tests |
|---|---|---|---|---|
| `stellar/prime-seat` | 99 | `./build-wasm.sh` | `393f0e5d340ed25ef1aa9beb2a5b6446b84247f75c5d858113779c9fa11baa87` (17,599 bytes) | `cargo test`: 21 |
| `evm/prime-seat` | 72 | `forge build` (Foundry 1.8.4, OpenZeppelin 5.4.0) | runtime `3b4402d5…38d6` (4,434 bytes), creation `4d355864…0de7` (4,703 bytes) | `forge test`: 51, and 7 more with `FORK_URL` set to a Base Sepolia fork |
| `solana/prime-seat` | 75 | `PRIME_CLUSTER=localnet cargo-build-sbf -- --locked` (Solana CLI 4.3.0) | localnet `4428191f…7e3e`, devnet `a389f4a1…9bb2` (35,248 bytes each) | `PRIME_CLUSTER=devnet cargo test`: 36 |
| `near/prime-near-signer-v2` | 323 | `RUSTFLAGS="-C link-arg=-s --cfg near" cargo build --release --target wasm32-unknown-unknown` (Rust 1.97.1) | `4b98d6d3c6a6ae15b11daa6e0a28b19f5764f028fd64440572e58904a17df7de` (157,934 bytes) | `cargo test`: 4, over 12 accepted vectors and 42 refusals |

The deployed copies are the devnet program `7ygNrKpK3GYoNLMCkAa4e3mznGPF2KVGbKZsJcq8wSCb` (final, its bytes equal the devnet build) and `seats.prime-spike-muwguc60.testnet` (code hash `666kSs8zNUkMMfJ39hDne3UqV9AqE5Dw2deTTZPsnJjF`, the v2 build). A Stellar seat and an EVM `PrimeSeat` are deployed per account by the Prime apps, which pin the wasm and the masked runtime code.

The Stellar seat and the policy interpreter: the interpreter refuses an `External` signer in its rules (212), so a seat enters a policed rule as `Delegated`, the form it serves outside rule 0. The interpreter keeps a hash of the rule's signers, so `remove_signer` on a policed rule leaves that rule refusing every signer (204). To take a seat out of such a rule, add the rule again without the seat and remove the old one. `remove_context_rule` can leave the interpreter's entry for the removed rule behind, because `uninstall` needs the policy admins' own authorisation. All three hold for every interpreter version, grammar 4, 6 and 7. A seat cannot be a policy admin: it authorises only through its account's `__check_auth`. [docs/stellar.md](../docs/stellar.md#changing-who-signs-a-policed-rule) has the detail.

## Hashes before and after the move to `contracts/`

On 18 October 2026 every contract moved from `contracts/prime/<chain>/<name>` to `contracts/<chain>/<name>`. Each one was built at the new path the way CI builds it, and compared with the hash recorded before the move.

| Contract | Build | Recorded before the move | At the new path |
|---|---|---|---|
| `stellar/policy-interpreter` | `./build-wasm.sh` | `69cad1d5…` (`deployments/grammar7-testnet.json`) | same |
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f3…` (`deployments/execution-testnet.json`) | same |
| `stellar/execution-adapter` | `./build-wasm.sh` | `3dd675c0…` (`deployments/execution-testnet.json`) | same |
| `stellar/test-blend-pool` | release build with the same remaps | `7ba261ed…` (this README) | same |
| `stellar/prime-seat` | `./build-wasm.sh` | `393f0e5d…` (`build-hashes.json`) | same |
| `evm/prime-seat` | `forge build` | runtime `3b4402d5…`, creation `4d355864…` (`build-hashes.json`) | same; the creation code equals the Prime app's copy byte for byte, and the runtime with its immutables zeroed hashes (keccak-256) to the app's template `bf34aaa2…` |
| `solana/custody-gate` | `cargo-build-sbf` | `a5d19edb…` (`build-hashes.json`, deployed) | same |
| `solana/prime-seat` | `cargo-build-sbf` | localnet `4428191f…`, devnet `a389f4a1…` (`build-hashes.json`, deployed) | same |
| `near/prime-near-signer` | `cargo-near` with the CI remaps | `c27904a3…` (`build-hashes.json`, deployed) | same |
| `near/prime-near-signer-v2` | `cargo build --cfg near` with the CI remap | `4b98d6d3…` (`build-hashes.json`, deployed) | same |

`solana/prime-session` matched as well at the new path (localnet `181013d2…`, devnet `c8836361…`) before it was removed the same day.

No build embeds the crate's own path. The Stellar scripts remap it to `/src`, and cargo, `cargo-build-sbf`, `cargo-near` and Foundry pass sources to the compiler relative to the crate.

The records are `build-hashes.json`, `deployments/grammar7-testnet.json` and `deployments/execution-testnet.json`. CI reads the last two from `../../../deployments/`.

## CI

`.github/workflows/ci.yml` builds and tests every contract in this folder.

| Job | What it runs |
|---|---|
| `Contracts (<stellar crate>)` | `cargo fmt --check` (every crate), `cargo clippy -D warnings`, `cargo test`; for `policy-interpreter` also the release conformance run, `cargo audit` and the `build-wasm.sh` hash against `deployments/grammar7-testnet.json`; for `custody-gate` and `execution-adapter` the hash against `deployments/execution-testnet.json` |
| `Contracts (solana/<crate>)` | Solana CLI v4.3.0 installed from `release.anza.xyz` and cached, `cargo fmt --check`, `PRIME_CLUSTER=localnet cargo-build-sbf`, the `.so` hash against `build-hashes.json` |
| `Contracts (near/prime-near-signer)` | Rust 1.98.1, `cargo-near` 0.22.0, the build described under NEAR, the wasm hash against `build-hashes.json` |
| `Contracts (prime-seat)`, in the Stellar matrix | as the other Stellar crates, and the `build-wasm.sh` hash against `build-hashes.json` |
| `Contracts (evm/prime-seat)` | Foundry 1.8.4, the OpenZeppelin fetch from the EVM section, `forge fmt --check src`, `forge build`, `forge test`, then the runtime and creation hashes against `build-hashes.json` |
| `Contracts (solana/prime-seat)`, in the Solana matrix | as the custody gate |
| `Contracts (near/prime-near-signer-v2)` | the repo's Rust, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, the wasm build with the registry path remapped to the deployed build's form, the hash against `build-hashes.json` |
| `TypeScript (near/vectors)` | Bun 1.4.2 (the generator's lockfile needs it), `bun gen.ts`, and the output against `requests.json` byte for byte |
| `TypeScript (solana/custody-gate/app-checks)` | `bun install --frozen-lockfile`, `tsc --strict`, `bun test` |

`build-hashes.json` holds the hashes CI compares. Change an entry in the same commit as the source it covers. The NEAR signer has no format check: its source packs several statements per line, and the sections above state its size after `rustfmt` (42 lines, 22 as written).
