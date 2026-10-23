# Prime contracts

This folder holds every contract behind a Prime account, all on Stellar: the
policy interpreter, the custody gate, the execution adapter and the Prime seat.

A Prime seat is an owner's entry on a Prime account for an owner who signs with
an ed25519 owner key in place of a Stellar account of its own. Its holder must
produce a raw ed25519 signature over the 32-byte grant hash. In the reference
integration a NEAR-routed MPC holds the key; any signer that can raw-sign that
hash, such as a server-held keypair or a custody service configured for raw
ed25519 signing, can serve. Interactive wallets that sign only transactions or
prefixed messages produce signatures the seat refuses. The seat verifies only
ed25519 signatures. The owner grants a session key for at most 7 days, and the
seat lets that key vote for the owner in rule 0 and act inside the rules that
list the seat.

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
```

## Contract size

sLOC counts the non-blank, non-comment lines of the contract source after
`rustfmt`, with test files and `#[cfg(test)]` module declarations left out. The
sources are formatter output, and CI checks them.
[docs/audit-overview.md](../docs/audit-overview.md#components-and-size) has the
command.

| Contract | sLOC | Audit scope |
|---|---|---|
| `stellar/policy-interpreter` | 800 | in |
| `stellar/execution-adapter` | 226 | in |
| `stellar/custody-gate` | 53 | in |
| `stellar/prime-seat` | 97 | in |
| `stellar/test-blend-pool` | 22 | test double, testnet only |

## Build and test

Commands run from the contract's own folder.

| Contract | Command | Result |
|---|---|---|
| `stellar/policy-interpreter` | `./build-wasm.sh` | `810f53f129514c5cd15f90c9a8fcb2267169c9457cd950644b1d69f2bfbf127c`, pinned in `build-hashes.json` |
| | `cargo test` (after `./build-wasm.sh`, which `tests/worst_case.rs` loads) | 416: 173 unit and 243 in 13 integration suites |
| | `cargo test --release --test conformance` | 18 |
| `stellar/policy-interpreter/oz08` | `cargo test --locked` (after the interpreter's `./build-wasm.sh`) | 12 |
| `stellar/execution-adapter` | `./build-wasm.sh` | `4985cd123baddd9f21c4c7eab63e79121d499029b0a514a0258b4846eb28313b`, pinned in `build-hashes.json` |
| | `cargo test` | 62 |
| `stellar/custody-gate` | `./build-wasm.sh` | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab`, recorded in `deployments/` |
| | `cargo test` | 3 |
| `stellar/prime-seat` | `./build-wasm.sh` | `393f0e5d340ed25ef1aa9beb2a5b6446b84247f75c5d858113779c9fa11baa87` (17,599 bytes), pinned in `build-hashes.json` |
| | `cargo test` | 21 |
| `stellar/test-blend-pool` | `cargo build --release --target wasm32v1-none` with the remaps of `build-wasm.sh` | `7ba261ed4d1320ceabc47abcbe6819824c27529d0ae7e55ce2fc363555418e76` |
| | `cargo test` | builds, no tests |

The interpreter instance on testnet and the policy-synth pin run
`810f53f1…`, this source: instance `CD46LN75…`, recorded in
`deployments/interpreter-testnet.json`. It replaced `CDZV4AG4…`, which runs
`69cad1d5…`, this source before the keyless executor rules.

### Reproducible builds

`stellar contract build` and `build-wasm.sh` give different hashes because the
script remaps the crate and registry paths. The script is the build behind the
deployed hashes and the hashes CI pins. Compare hashes from a Linux build:
macOS gives other bytes from the same source. No build embeds the crate's own
path. Tools: stellar 27.1.0, Rust 1.97.1 from the repo's `rust-toolchain.toml`.

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

`build-hashes.json` holds the hashes CI compares. Change an entry in the same
commit as the source it covers.
