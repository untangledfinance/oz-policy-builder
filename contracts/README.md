# Prime contracts

This folder holds every contract behind a Prime account, one folder per chain.
The Stellar folder has the policy interpreter, the custody gate, the execution
adapter and the Prime seat. The EVM folder has the EVM seat, `PrimeSeat`; the
rest of the EVM design runs on unmodified Safe, Zodiac Roles and OpenZeppelin
contracts. The Solana folder has the custody gate and the seat program.

A Prime seat is an owner's entry on a Prime account for an owner who signs with
an owner key in place of an account of its own on that chain: an ed25519 key on
Stellar and Solana, a secp256k1 key on EVM. Its holder must produce a raw
signature over the 32-byte grant hash. Any signer that can raw-sign that hash
can serve, such as an MPC, a server-held keypair or a custody service
configured for raw signing. Interactive wallets that sign only transactions or
prefixed messages produce signatures the seat refuses. The owner grants a
session key for at most 7 days, and the seat lets that key vote for the owner
and act inside the rules that list the seat.

The Stellar contracts are the ones in the external audit's scope
([docs/audit-overview.md](../docs/audit-overview.md)). The EVM and Solana
contracts are outside that scope and run on test networks only: Base Sepolia
and Solana devnet.

## Layout

```
contracts/
  README.md
  build-hashes.json             build hashes that CI compares against
  check-build-hash.sh           the comparison CI runs
  stellar/
    policy-interpreter/         evaluates a rule's predicate on every call the rule authorises
      oz08/                     the interpreter wasm against OpenZeppelin's 0.8.0 account
    custody-gate/               the custody account's gate
    execution-adapter/          per-Prime batcher, bound to one gate or to none
    prime-seat/                 the Prime seat: an owner's seat on an OZ smart account
    test-blend-pool/            Blend-shaped stub, testnet only
  evm/
    prime-seat/                 PrimeSeat.sol, a Safe owner for one seat owner (ERC-1271)
  solana/
    README-architecture.md      Solana design: Squads, the seat and the custody gate
    SETUP-AND-RECOVERY.md       step-by-step guide: set up the custody gate and recover custody funds
    custody-gate/               gate-owned custody gate, plus app-checks/
    prime-seat/                 seat PDA of a seat owner in a Squads Smart Account
```

## Contract size

sLOC counts the non-blank, non-comment lines of the contract source after the
formatter (`rustfmt` for Rust, `forge fmt` for Solidity), with test files and
`#[cfg(test)]` module declarations left out. The sources are formatter output,
and CI checks them.
[docs/audit-overview.md](../docs/audit-overview.md#components-and-size) has the
command.

| Contract | sLOC | Audit scope |
|---|---|---|
| `stellar/policy-interpreter` | 881 | in |
| `stellar/execution-adapter` | 277 | in |
| `stellar/custody-gate` | 53 | in |
| `stellar/prime-seat` | 97 | in |
| `stellar/test-blend-pool` | 22 | test double, testnet only |
| `evm/prime-seat` | 72 | out, Base Sepolia only |
| `solana/custody-gate` | 126 | out, Solana devnet only |
| `solana/prime-seat` | 75 | out, Solana devnet only |

## Build and test

Commands run from the contract's own folder.

| Contract | Command | Result |
|---|---|---|
| `stellar/policy-interpreter` | `./build-wasm.sh` | `6704996f626904a4e33b95bda17b73963fc9cf502ffdfdbe9d85b4b10288e0d4`, pinned in `build-hashes.json` |
| | `cargo test` (after `./build-wasm.sh`, which `tests/worst_case.rs` loads) | 440: 173 unit and 267 in 15 integration suites |
| | `cargo test --release --test conformance` | 18 |
| `stellar/policy-interpreter/oz08` | `cargo test --locked` (after the interpreter's and the adapter's `./build-wasm.sh`) | 26: 14 in `oz08.rs`, 12 in `nogate.rs` (a liquidation by anyone through an adapter with no gate, and the E-36 hazard with both mitigations) |
| `stellar/execution-adapter` | `./build-wasm.sh` | `bf85432c859f1ee543c14e9cc9b2c150c12753cc9580053b8d27a41eee85b4a0`, pinned in `build-hashes.json` |
| | `cargo test` | 67 |
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab`, recorded in `deployments/` |
| | `cargo test` | 3 |
| `stellar/prime-seat` | `./build-wasm.sh` | `393f0e5d340ed25ef1aa9beb2a5b6446b84247f75c5d858113779c9fa11baa87` (17,599 bytes), pinned in `build-hashes.json` |
| | `cargo test` | 21 |
| `stellar/test-blend-pool` | `cargo build --release --target wasm32v1-none` with the remaps of `build-wasm.sh` | `7ba261ed4d1320ceabc47abcbe6819824c27529d0ae7e55ce2fc363555418e76` |
| | `cargo test` | builds, no tests |
| `evm/prime-seat` | `forge build` | runtime `3b4402d54f28ef3eb23bc14e9ac1e44c4aa946da42c4c3cea46cd76970c438d6` (4,434 bytes), creation `4d3558643131eebbbb8087fc65ed8c52581e0c48619adcf60cdc756cb83a0de7` (4,703 bytes), pinned in `build-hashes.json` |
| | `forge test` | 51, and 7 more with `FORK_URL` set to a Base Sepolia fork |
| `solana/custody-gate` | `PRIME_CLUSTER=localnet cargo-build-sbf -- --locked` | `a5d19edb879e75d054f1025d710753ce5150726130c3dd74887236fbdbdc94e2` (47,472 bytes), pinned in `build-hashes.json`; the gate does not read `PRIME_CLUSTER` |
| `solana/prime-seat` | `PRIME_CLUSTER=localnet cargo-build-sbf -- --locked` | `4428191fcb70aeb9230ff1706edaa0cdee853c75ee99aae0fa1c347d25177e3e` (35,248 bytes), pinned in `build-hashes.json` |
| | `PRIME_CLUSTER=devnet cargo-build-sbf -- --locked` | `a389f4a1cbf67bee9be5170e2199e3fc4c02e596fe4fbab0406ecdeb8f5e9bb2` (35,248 bytes), the deployed build, pinned in `build-hashes.json` |
| | `PRIME_CLUSTER=devnet cargo test` | 36 |
| `solana/custody-gate/app-checks` | `bun run typecheck`, then `bun test` | clean, 43 |

The interpreter instance on testnet and the policy-synth pin run
`6704996f…`, this source (with referenced rules and the batch pin): instance
`CDER6P73…`, recorded in `deployments/interpreter-testnet.json`. The no-gate
liquidation run (`evidence/nogate-liquidation-testnet.log`) deployed that
instance and ran on it; the pin moves with `policy-synth`. `CDER6P73…` replaced
`CD46LN75…`, which runs `810f53f1…` (this source before referenced rules), and
that one replaced `CDZV4AG4…`, which runs `69cad1d5…`, the source before the
keyless executor rules.

### Reproducible builds

`stellar contract build` and `build-wasm.sh` give different hashes because the
script remaps the crate and registry paths. The script is the build behind the
deployed hashes and the hashes CI pins. Compare hashes from a Linux build:
macOS gives other bytes from the same source. No build embeds the crate's own
path. Tools: stellar 27.1.0, Rust 1.97.1 from the repo's `rust-toolchain.toml`.

### EVM

Foundry 1.8.4, Solidity 0.8.28 with the optimizer at 200 runs and `via_ir`
off. The hashes are of the runtime and creation code in
`out/PrimeSeat.sol/PrimeSeat.json`; `check-build-hash.sh` reads that file for an
`evm/…:runtime` or `evm/…:creation` entry. The code ends in solc's metadata
hash, which covers the source text, so a comment change in `PrimeSeat.sol`
changes both hashes. `PrimeSeat` imports one OpenZeppelin Contracts 5.4.0 file
(`ECDSA`), mapped by `foundry.toml` to `lib/oz/`. `lib/` stays out of git.
Unpack the package once:

```sh
npm pack @openzeppelin/contracts@5.4.0
tar xzf openzeppelin-contracts-5.4.0.tgz
mkdir -p lib/oz && cp -r package/utils package/interfaces lib/oz/
rm -r package openzeppelin-contracts-5.4.0.tgz
```

### Solana

The two programs build with the Solana CLI on `PATH` (4.3.0, `cargo-build-sbf`
with platform tools v1.57 and rustc 1.95.0). The `.so` files carry only relative
source paths (`src/lib.rs` and the standard library's), so the hashes hold
across checkouts and machines with the same toolchain. `PRIME_CLUSTER` is a compile-time string that goes into the seat's
grant hash, so each cluster gets its own `prime_seat.so`, and a build without
it fails. Run the build with `RUSTUP_TOOLCHAIN=stable`: `cargo-build-sbf` asks
cargo for package metadata first, and the repository's `rust-toolchain.toml`
would otherwise pull in Rust 1.97.1 for that call. The design and the setup
guide are in [README-architecture.md](solana/README-architecture.md) and
[SETUP-AND-RECOVERY.md](solana/SETUP-AND-RECOVERY.md).

`app-checks/` holds the checks an app runs before funds move: mint extensions,
the gate read-back and the setup transactions. It has its own `package.json`
and lockfile (`@solana/web3.js` 1.99.0, `@solana/spl-token` 0.4.15). The root
`bunfig.toml` limits `bun test` to `packages/`, so run `bun install
--frozen-lockfile`, `bun run typecheck` and `bun test` from `app-checks/`.

## Deployed builds on EVM and Solana

| Chain | Deployed build | State |
|---|---|---|
| Base Sepolia | none shared | the Prime app deploys one `PrimeSeat` per seat owner and Safe, and pins its runtime code with the 11 immutable slots zeroed (keccak-256 `bf34aaa2…`) |
| Solana devnet | `prime-seat` at `7ygNrKpK3GYoNLMCkAa4e3mznGPF2KVGbKZsJcq8wSCb`, custody gate at `6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz` | the devnet seat build `a389f4a1…` and the gate build `a5d19edb…`, each deployed with `--final` and `--max-len` equal to its size; the on-chain code equals the `.so`. The gate passed 84 of 84 gate-flow checks on devnet |

[docs/evm.md](../docs/evm.md#deployed) and
[docs/solana.md](../docs/solana.md#deployed) have the detail.

## The Prime seat and the policy interpreter

The interpreter refuses an `External` signer in its rules (212), so a seat
enters a policed rule as `Delegated`, the form it serves outside rule 0. The
interpreter keeps a hash of the rule's signers, so `remove_signer` on a
policed rule leaves that rule refusing every signer (204). To take a seat out
of such a rule, add the rule again without the seat and remove the old one.
`remove_context_rule` can leave the interpreter's entry for the removed rule
behind, because `uninstall` needs the policy admins' own authorisation. A seat
cannot be a policy admin: it authorises only through its account's
`__check_auth`. [docs/stellar.md](../docs/stellar.md#changing-who-signs-a-policed-rule)
has the detail, and [prime-seat/README.md](stellar/prime-seat/README.md) the
Prime seat's interface.

## CI

`.github/workflows/ci.yml` builds and tests every contract in this folder.

| Job | What it runs |
|---|---|
| `Contracts (<stellar crate>)` | `cargo fmt --check` (every crate), `cargo clippy -D warnings`, `cargo test`; for `policy-interpreter` also the release conformance run, `cargo audit`, the `build-wasm.sh` hash against `build-hashes.json` and the `oz08/` suite of that wasm against OpenZeppelin's 0.8.0 account; for `custody-gate` the hash against its record in `deployments/`; for `execution-adapter` and `prime-seat` the hash against `build-hashes.json` |
| `Contracts (evm/prime-seat)` | `forge fmt --check src`, `forge build`, `forge test`, and the runtime and creation hashes against `build-hashes.json` |
| `Contracts (solana/<crate>)` | `cargo fmt --check`, `PRIME_CLUSTER=devnet cargo test`, the `cargo-build-sbf` localnet build against `build-hashes.json`, and for `prime-seat` also the devnet build |
| `TypeScript (solana/custody-gate/app-checks)` | `bun install --frozen-lockfile`, the strict typecheck and `bun test` |

`build-hashes.json` holds the hashes CI compares. Change an entry in the same
commit as the source it covers.
