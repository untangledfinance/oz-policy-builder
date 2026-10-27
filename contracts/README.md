# Prime contracts

This folder holds every contract behind a Prime account, one folder per chain.
The Stellar folder has the policy interpreter, the custody gate, the execution
adapter and the Prime seat. The Solana folder holds no program: Prime on
Solana is configuration of the Squads Smart Account, SPL Token-2022 and the
venue's programs, all deployed by third parties. Prime on EVM has no folder
here either: it is configuration on unmodified Safe, Zodiac Roles and
OpenZeppelin contracts ([docs/evm.md](../docs/evm.md)), checked by
[`scripts/evm-config-check`](../scripts/evm-config-check/README.md).

A Prime seat is an owner's entry on a Prime account for an owner who signs with
an owner key in place of an account of its own on that chain: an ed25519 key on
Stellar. Its holder must produce a raw
signature over the 32-byte grant hash. In the reference integration a
NEAR-routed MPC holds the key; any signer that can raw-sign that hash, such as
a server-held keypair or a custody service configured for raw signing, can
serve. Interactive wallets that sign only transactions or
prefixed messages produce signatures the seat refuses. The owner grants a
session key for at most 7 days, and the seat lets that key vote for the owner
and act inside the rules that list the seat.

The Stellar contracts are the ones in the external audit's scope
([docs/audit-overview.md](../docs/audit-overview.md)).

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
  solana/
    README-architecture.md      why there is no Solana program, and where the design is
```

## Contract size

sLOC counts the non-blank, non-comment lines of the contract source after the
formatter (`rustfmt`), with test files and
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

## Deployed builds on EVM and Solana

Prime on EVM deploys no contract of ours; [docs/evm.md](../docs/evm.md#deployments)
lists the existing contracts it configures on Base Sepolia. Prime on Solana
deploys no program; [docs/solana.md](../docs/solana.md#deployments) lists the
third-party programs it configures.

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
| `EVM configuration check (Base Sepolia fork)` | `forge fmt --check test` and `forge test` in `scripts/evm-config-check` with `FORK_URL` set to Base Sepolia: the configuration of [docs/evm.md](../docs/evm.md) on Safe 1.4.1 and 1.5.0, no contract of ours |

Every contract test step runs through `assert-tests.sh`, which fails when it
ran fewer tests than its minimum (1; 0 for `test-blend-pool`, which has none)
or skipped one. `build-hashes.json` holds the hashes CI compares.
Change an entry in the same commit as the source it covers.
