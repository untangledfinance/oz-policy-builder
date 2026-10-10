# execution-adapter

The per-Prime batcher, bound to one custody gate. Soroban allows one
host-function invocation per transaction, so the adapter makes several calls
atomically. It has one rule: a batch may not name an address the gate does not
list. It checks every call target, every argument at any depth and every
authorisation it hands out before any call runs. A batch can wait a number of
ledgers before it runs.

The detailed design is in [docs/stellar.md](../../docs/stellar.md#execution-adapter),
with the wait under [The wait](../../docs/stellar.md#the-wait).

## Entry points

| Function | Purpose |
| --- | --- |
| `__constructor` | Bind the adapter to its Prime account and gate, with `min_wait` (the fewest ledgers any batch waits) and `run_window` (how long a ready batch stays runnable). Refuses an address other than the one derived from the Prime, the gate and those two numbers, so custody can name the adapter on the gate before it exists. |
| `execute` | Check a batch of calls and grants against the gate. With `wait` 0 it runs at once; above 0 it is stored and its number returned. The Prime approves `(calls, grants, wait)` together. |
| `run` | Run a stored batch from its ready ledger to the end of its run window. Anyone may submit it; the Prime approves through a rule this adapter signs, whose predicate permits `run` only. The batch is checked again against the gate bound now, and runs once. |
| `cancel` | Drop a stored batch, waiting, ready or lapsed. `by` must be the Prime or the custody account the gate answers to, and must approve. |
| `rebind` | Move the adapter to a successor gate. Only the current gate's custody account may call it, and the successor must answer `custody()`. |

## Error codes

| Code | Name | Means |
| --- | --- | --- |
| 1 | `PrimeTarget` | A call targets the Prime account itself |
| 2 | `AddressNotAllowed` | The batch names an address outside the gate's list |
| 3 | `Uncheckable` | A grant authorises deploying a contract |
| 4 | `WaitTooShort` | `wait` is below `min_wait` |
| 5 | `NotScheduled` | Nothing is stored under that batch number |
| 6 | `NotRunnable` | The batch is before its ready ledger or past its run window |
| 7 | `NotACanceller` | `by` is neither the Prime nor the custody account |
| 8 | `NotWhereAgreed` | The adapter is at an address other than the one derived from its Prime, gate and wait numbers |

## Build and test

```sh
cargo test
./build-wasm.sh   # reproducible wasm32v1-none release build; prints its sha256
```

`build-wasm.sh` gives the hash pinned in `deployments/` only on Linux. CI
rebuilds it and compares.
