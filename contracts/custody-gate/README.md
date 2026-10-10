# custody-gate

The custody account's gate on Stellar. It holds no funds: it holds an allowance
the custody account granted it, and pays only to the addresses on its list.
Its configuration is written once by the constructor. There is no admin, no
setter and no upgrade path, so changing the list means deploying another gate.

The detailed design is in [docs/stellar.md](../../docs/stellar.md#custody-gate).

## Entry points

| Function | Purpose |
| --- | --- |
| `__constructor` | Store the configuration: the custody account, the one adapter that may call `pull`, the code hash that adapter must run, and the address list. |
| `allowed` | The address list. Read-only. |
| `custody` | The custody account whose allowance the gate spends. Read-only. |
| `pull` | Pay `amount` of `token` to `to` with `transfer_from`. Requires the adapter's authorisation, checks it runs the approved code hash, and checks `to` is on the list. |

## Error codes

| Code | Name | Means |
| --- | --- | --- |
| 1 | `DestinationNotAllowed` | `to` is outside the list |
| 2 | `WrongCallerCode` | The caller runs a different build from the approved hash |

## Build and test

```sh
cargo test
./build-wasm.sh   # reproducible wasm32v1-none release build; prints its sha256
```

`build-wasm.sh` gives the hash pinned in `deployments/` only on Linux. CI
rebuilds it and compares.
