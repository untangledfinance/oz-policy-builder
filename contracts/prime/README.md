# Prime contracts

This folder holds every contract behind a Prime account, one folder per chain. The Stellar folder has the OctoGate contracts (custody gate, execution adapter, policy interpreter) and the Stellar session signer. The EVM, Solana and NEAR folders hold the session contracts that let a wallet start a session key on each chain. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design, and [spike/](spike/) is the evidence bundle with the harnesses, logs and testnet records behind it.

## Layout

```
contracts/prime/
  README.md
  ARCHITECTURE.md
  build-hashes.json             build hashes that CI compares against
  check-build-hash.sh           the comparison CI runs
  spike/                        evidence bundle: harnesses, logs, testnet records
  stellar/
    prime-session/              session signer on an OZ smart account (new code)
    custody-gate/               OctoGate: the custody account's gate
    execution-adapter/          OctoGate: per-Prime batcher, bound to one gate
    policy-interpreter/         OctoGate: grammar 6, evaluates the mandate on every call
    test-blend-pool/            Blend-shaped stub, testnet only
  evm/prime-session/            PrimeSession.sol, a Roles member of Safe 1.4.1 and Zodiac Roles v2
  solana/README-architecture.md Solana design: Squads, prime-session and the custody gate
  solana/SETUP-AND-RECOVERY.md  step-by-step guide: set up the custody gate and recover custody funds
  solana/prime-session/         session PDA that acts inside a Squads Smart Account
  solana/custody-gate/          gate-owned custody gate (line-cut build with the multisig length check), plus app-checks/
  near/prime-near-signer/       pass-through signer that checks a wallet signature, then asks NEAR MPC to sign
```

## Contract size

sLOC counts the non-blank, non-comment lines of the contract source after the formatter (`rustfmt` for Rust, `forge fmt` for Solidity), test files excluded. Formatted sLOC is the official metric from 9 October 2026; the figures before that date counted the files as written. The Stellar contract and the two Solana programs are formatter output, and CI checks them. The EVM contract is `forge fmt` clean and checked in CI. The NEAR signer packs several statements per line (22 as written), so its count is the figure after `rustfmt`.

| Chain | Contract | sLOC | Scope |
|---|---|---|---|
| EVM | `evm/prime-session` | 53 | new code |
| NEAR | `near/prime-near-signer` | 42 | new code |
| Solana | `solana/custody-gate` | 126 | new code |
| Solana | `solana/prime-session` | 64 | new code |
| Stellar | `stellar/prime-session` | 41 | new code |
| Stellar | `stellar/custody-gate` | 55 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/execution-adapter` | 221 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/policy-interpreter` | 1,082 | OctoGate, on mainnet, outside the new-code budget |
| Stellar | `stellar/test-blend-pool` | 22 | test double, testnet only |

Per chain, the new code is 53 on EVM, 42 on NEAR, 126 + 64 = 190 on Solana and 41 on Stellar, 326 in all. The earlier formatted counts were 65, 50, 343 and 50 (508 in all), and the as-written counts were 32, 20, 117 and 37 (206 in all). The OctoGate contracts have their own external audit.

## Build and test

Every result below was measured on 9 October 2026 after the move into this folder. Commands run from the contract's own folder.

| Contract | Command | Result |
|---|---|---|
| `stellar/prime-session` | `stellar contract build` | wasm sha256 `e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3` |
| | `./build-wasm.sh` | `547f67f375ca6baf7878d9eaa26625cd0892eeae7602ad7dc184427d4895b37f` (path-remapped build; `d9eb29ef…` before the 9 October 2026 reformat) |
| | `cargo test` | 12 passed |
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` |
| | `cargo test` | 3 passed |
| `stellar/execution-adapter` | `./build-wasm.sh` | `68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd` |
| | `cargo test` | 33 passed |
| `stellar/policy-interpreter` | `./build-wasm.sh` | `5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126` |
| | `cargo test`, then `cargo test --release --test conformance` | 151 passed (82 unit, 69 in the integration suites, 18 of them conformance); the release conformance run passes 18 |
| `stellar/test-blend-pool` | `cargo test` | builds, no tests |
| `evm/prime-session` | `~/.foundry/bin/forge fmt --check src`, `forge build`, then `forge test` | formatter clean, build clean, 16 passed (6 behaviour tests and 10 binding tests); 3,860 bytes of runtime code without the metadata hash, 82 fewer than before the 9 October 2026 cuts |
| `solana/prime-session` | `PRIME_CLUSTER=localnet cargo-build-sbf` | `.so` sha256 `181013d2d2338f30614fe548661de0753c23e5a78605df49d1b114b7817a3f11` (53,720 bytes); the round 9 build was `be6ade02a14b495d528d69d4f4632a0ffb9c9c83a9165ac8d2e0b1dbac102e13` (54,024 bytes) |
| | `PRIME_CLUSTER=devnet cargo-build-sbf` | `c883636111dfda411ef0dc80e7e73646cb6ee4d1fa9e924f645c0b6c33e68263`; deployed on devnet at [`6JyReewx…`](https://explorer.solana.com/address/6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba?cluster=devnet). The round 9 build was `8db245ab5ba25a6b8585bfd193be5d9241e5df0f331792437c34f1ac888b7b76`, and it stays on devnet at the previous id as a previous build |
| `solana/custody-gate` | `cargo-build-sbf` | `.so` sha256 `a5d19edb879e75d054f1025d710753ce5150726130c3dd74887236fbdbdc94e2` (47,472 bytes), 126 sLOC. The build the independent review tested is `6d196cab5b6c6d29bc6cf650a1526b4be56c0550bed479b55090364d7a04dfd7` (47,160 bytes, 84 as written, 241 after `rustfmt`); the 9 October 2026 pass reached the same behaviour with the formatted source (12 million differential scenarios with no mismatch). The line cut without the multisig length check (`00d6a5c4d7f04be1b23c635bc3cd8c952354404bb799875fcaf0c9346b7f7871`, 47,304 bytes) is the build before the fix |
| | harnesses on a local validator (mainnet feature set, mainnet Squads and Token-2022 builds): `gate-a4.ts`, `venues-a4.ts`, `trustee-a4.ts`, `probe-fakems.ts`, run against the new build | 345/345 mock venue, 53/53 real Orca and Kamino, 9/9 trustee, 4/4 forged multisig refused |
| | `mutants3.py` (the 63 checks of the earlier pass plus 15 on the new helpers) | 78/78 gate mutants killed, including the one that removes the multisig length check |
| `solana/custody-gate/app-checks` | `tsc --strict --noEmit setup-checks.ts`, then `bun test setup-checks.test.ts` | clean, 43 passed |
| `near/prime-near-signer` | `RUSTUP_TOOLCHAIN=stable cargo-near near build non-reproducible-wasm --no-abi` | wasm sha256 `c27904a329814b6ee92e8b37cc99490c8edbc9bbd3fd86a926b38e7d05b793c8`, code hash `E6986kfXDAec5nZvuYiBiC3fmonHCrynwRCtd33s1U5u` (110,145 bytes), the code hash deployed at `signer.prime-spike-muwguc60.testnet` since 9 October 2026 (transaction `82Cj53AxZjzodX4DKba2eyhgcDVBHb6USAKcHtytLdwf`; the previous build was `8f90ea67…`, code hash `AfRTxyBpBmUDYi88xxytL5z4yfPn3tBa1SYawt4Jzh3b`) |

### Stellar

`stellar contract build` and `build-wasm.sh` give different hashes because the script remaps the crate and registry paths. The script is the build behind the deployed hashes and the hashes CI pins. Compare hashes from a Linux build: macOS gives other bytes from the same source. Tools: stellar 27.1.0, Rust 1.97.1 from the repo's `rust-toolchain.toml`. `stellar/prime-session` allows the `clippy::unit_arg` lint in its `Cargo.toml`, because the formatted source ends two functions with `Ok(<call that returns unit>)`.

### EVM

Foundry 1.8.4, Solidity 0.8.28 with the optimizer at 200 runs. The contract imports three OpenZeppelin Contracts 5.4.0 files (`ECDSA`, `MessageHashUtils`, `Strings`), mapped by `foundry.toml` to `lib/oz/`. `lib/` stays out of git, as in the spike bundle. Unpack the package once:

```sh
npm pack @openzeppelin/contracts@5.4.0
tar xzf openzeppelin-contracts-5.4.0.tgz
mkdir -p lib/oz && cp -r package/utils package/interfaces lib/oz/
```

### Solana

Both programs build with the Solana CLI on `PATH` (4.3.0, `cargo-build-sbf` with platform tools v1.57 and rustc 1.95.0). `PRIME_CLUSTER` is a compile-time string that goes into the grant text a wallet signs, so each cluster gets its own `.so`. `custody-gate` is the gate-owned custody gate in its line-cut form (126 sLOC formatted, standard `solana_program`, Pinocchio not adopted) with the multisig length check, which refuses a token account posing as custody's multisig. The design and the setup guide are in [README-architecture.md](solana/README-architecture.md) and [SETUP-AND-RECOVERY.md](solana/SETUP-AND-RECOVERY.md).

The gate harnesses live in the spike bundle, in [`spike/matrix/near-minimal/opt/gate/`](spike/matrix/near-minimal/opt/gate/). `run-validator.sh` there starts a local validator with its own ledger, the mainnet feature set, the mainnet Squads and Token-2022 builds and every gate build in `so/`. The mainnet dumps and fixture programs it loads stay out of git. The logs of the length-check run are in [`spike/matrix/near-minimal/round9/opt/gate/msfix/`](spike/matrix/near-minimal/round9/opt/gate/msfix/), and the independent review is [`gate-linecut-review.md`](spike/matrix/near-minimal/round9/opt/gate-linecut-review.md).

`app-checks/` holds the checks an app runs before funds move: mint extensions, the gate read-back and the setup transactions. It has its own `package.json` and lockfile (`@solana/web3.js` 1.99.0, `@solana/spl-token` 0.4.15). The root `bunfig.toml` limits `bun test` to `packages/`, so run `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` from `app-checks/`.

### NEAR

`non-reproducible-wasm` embeds the path of the Rust standard library, so the hash depends on the toolchain directory name. It matches under the `stable` toolchain (rustc 1.98.1), which the `RUSTUP_TOOLCHAIN=stable` prefix selects. The repository's `rust-toolchain.toml` pins 1.97.1 and gives another hash. The build used `cargo-near` 0.22.0.

CI builds the same wasm on any runner. It pins Rust 1.98.1 (what `stable` was on 9 October 2026) with `rust-src`, and passes two `--remap-path-prefix` flags through `cargo-near --env RUSTFLAGS` that write the registry and toolchain paths in the form the deployed build had. The result is the hash recorded in `build-hashes.json` (`c27904a3…`).

## Deployed builds

The 9 October 2026 size pass changed sources on all four chains. Behaviour stayed the same on every one, and each hash above is the build of the current source.

| Chain | Deployed build | State |
|---|---|---|
| Stellar testnet | wasm `e36d155f…` | the new source builds the same wasm with `stellar contract build`, so the deployed instances run the new code |
| NEAR testnet | `signer.prime-spike-muwguc60.testnet`, code hash `E6986kfXDAec5nZvuYiBiC3fmonHCrynwRCtd33s1U5u` | redeployed with the new build; the derived MPC keys are unchanged, `signer-neg.ts` passes 12/12 and the Solana session matrix passes 133/133 with real NEAR |
| Solana devnet | gate [`6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz`](https://explorer.solana.com/address/6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz?cluster=devnet), session [`6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba`](https://explorer.solana.com/address/6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba?cluster=devnet) | both run the 9 October 2026 builds (`a5d19edb…` and `c8836361…`), each deployed with `--final` and `--max-len` equal to its size, and the on-chain code equals the `.so`. The session matrix passes 145/145 and the gate flow 84/84 on devnet, with a second session program id `GLabPwsshHoaXMrHM6nHsHEkf51MFkKP86WCdRpXg3SD` for the two-program checks ([`round9/solana-devnet-sloc2/`](spike/matrix/near-minimal/round9/solana-devnet-sloc2/)). The first devnet builds are previous builds, and both are final too: gate `58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx` (`6d196cab…`, 84/84) and session `4tXCkZW255iZNT4gPHDuAbqR3eG8Zs3tRsgLRc1BoPRa` (`8db245ab…`, 136/136) |
| EVM | Base Sepolia fork | the new `PrimeSession` passes the 134-check matrix on a fork; the live run waits for relayer funds |

The size pass is documented in [`spike/matrix/near-minimal/round9/sloc2/`](spike/matrix/near-minimal/round9/sloc2/): the mutation scripts, the differential harnesses and the logs.

## Stellar hashes before and after the move

The five Stellar crates moved from `contracts/<name>` and `contracts/prime-session` to `contracts/prime/stellar/<name>`. Each wasm was built the way the repo builds it before the move and again after.

| Contract | Before | After | Recorded |
|---|---|---|---|
| `policy-interpreter` | `5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126` | same | grammar 6 testnet record and mainnet record |
| `custody-gate` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` | same | execution testnet record and mainnet record |
| `execution-adapter` | `68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd` | same | execution testnet record and mainnet record |
| `prime-session` (`build-wasm.sh`) | `d9eb29efa629a4fc4974d2f43410d4e4996cadda98dbc7a9cd273e53d72ce887` | same at the move; `547f67f375ca6baf7878d9eaa26625cd0892eeae7602ad7dc184427d4895b37f` after the 9 October 2026 reformat (the wasm keeps panic line numbers) | none |
| `prime-session` (`stellar contract build`) | `e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3` | same, and the same after the reformat | Stellar testnet instances |
| `test-blend-pool` (remapped paths) | `7ba261ed4d1320ceabc47abcbe6819824c27529d0ae7e55ce2fc363555418e76` | same | none |

The records are `deployments/grammar6-testnet.json`, `deployments/execution-testnet.json` and `deployments/prime-mainnet.json`. They stay where they were, and CI reads them from `../../../../deployments/`.

## CI

`.github/workflows/ci.yml` builds and tests every contract in this folder.

| Job | What it runs |
|---|---|
| `Contracts (<stellar crate>)` | `cargo fmt --check` (every crate, `prime-session` included), `cargo clippy -D warnings`, `cargo test`, and for `prime-session` the `build-wasm.sh` hash against `build-hashes.json` |
| `Contracts (evm/prime-session)` | Foundry 1.8.4, the OpenZeppelin fetch from the EVM section, `forge fmt --check src`, `forge build`, `forge test` |
| `Contracts (solana/<crate>)` | Solana CLI v4.3.0 installed from `release.anza.xyz` and cached, `cargo fmt --check`, `PRIME_CLUSTER=localnet cargo-build-sbf`, the `.so` hash against `build-hashes.json` |
| `Contracts (near/prime-near-signer)` | Rust 1.98.1, `cargo-near` 0.22.0, the build described under NEAR, the wasm hash against `build-hashes.json` |
| `TypeScript (solana/custody-gate/app-checks)` | `bun install --frozen-lockfile`, `tsc --strict`, `bun test` |

`build-hashes.json` holds the four hashes. Change an entry in the same commit as the source it covers. The NEAR signer has no format check: its source packs several statements per line, and the sections above state its size after `rustfmt` (42 lines, 22 as written). The `spike/` folder is archived evidence and sits outside the repo's biome run (`biome.jsonc` says why).
