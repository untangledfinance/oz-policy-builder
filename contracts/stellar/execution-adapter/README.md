# execution-adapter

The per-Prime batcher. Soroban allows one host-function invocation per
transaction, so the adapter makes several calls atomically. It is created
either bound to one custody gate or with no gate, and that choice is fixed for
its life.

- **With a gate**, it has one rule: a batch may not name an address the gate
  does not list. It checks every call target, every argument at any depth and
  every authorisation it hands out before any call runs. A batch can wait
  before it runs, counted in ledgers.
- **With no gate**, it checks no address, so the Prime can bundle its own
  calls, for example a call that must not fail followed by two transfers of
  its own funds, and they all happen or none does. It still refuses a call to
  the Prime itself, hands out no authorisation as itself, and runs every batch
  at once.

The design is in [docs/stellar.md](../../../docs/stellar.md#execution-adapter),
with the wait under [The wait](../../../docs/stellar.md#the-wait) and the null
mode under [No gate](../../../docs/stellar.md#no-gate).

## Entry points

| Function | Purpose |
| --- | --- |
| `__constructor` | Bind the adapter to its Prime account and to a gate or to none, with `min_wait` (the fewest ledgers any batch waits) and `run_window` (how long a ready batch stays runnable). Refuses an address other than the one derived from those three values, so custody can name the adapter on the gate before it exists. With no gate, refuses a `min_wait` above 0. |
| `execute` | Check a batch of calls and grants. With `wait` 0 it runs at once; above 0 it is stored and its number returned, if there is a gate. The Prime approves `(calls, grants, wait)` together. |
| `run` | Run a stored batch from its ready ledger to the end of its run window. Anyone may submit it; the Prime approves through a rule this adapter signs, whose predicate permits `run` only. The batch is checked again against the gate bound now, and runs once. |
| `cancel` | Drop a stored batch, waiting, ready or lapsed. `by` must be the Prime or the custody account the gate answers to, and must approve. With no gate, `by` must be the Prime. |
| `rebind` | Move the adapter to a successor gate. Only the current gate's custody account may call it, and the successor must answer `custody()`. An adapter with no gate cannot be bound, and an adapter with a gate cannot be moved to none. |

## Error codes

| Code | Name | Means |
| --- | --- | --- |
| 1 | `PrimeTarget` | A call targets the Prime account itself |
| 2 | `AddressNotAllowed` | The batch names an address outside the gate's list |
| 3 | `Uncheckable` | A grant authorises deploying a contract, or the adapter has no gate and the batch carries any grant |
| 4 | `WaitTooShort` | `wait` is below `min_wait` |
| 5 | `NotScheduled` | Nothing is stored under that batch number |
| 6 | `NotRunnable` | The batch is before its ready ledger or past its run window |
| 7 | `NotACanceller` | `by` is neither the Prime nor the custody account |
| 8 | `NotWhereAgreed` | The adapter is at an address other than the one derived from its gate and wait numbers |
| 9 | `NoGate` | `rebind` on an adapter created with no gate |
| 10 | `NoWait` | A batch with a wait, or a `min_wait` above 0, on an adapter with no gate |

## The address

`deployer(prime, sha256("prime.execution.adapter.v5" + XDR((gate, min_wait,
run_window))))`, where "no gate" is a void in the tuple. The deployed v4 build
hashed `"prime.execution.adapter.v4"` and the XDR of each part in turn, so no
v5 adapter can sit at a v4 address. The Prime deploys its own adapter: a G
account signs the deployment as the transaction source or by an
address-credential entry; an OpenZeppelin account approves it through a rule.

## Build and test

```sh
./build-wasm.sh   # reproducible wasm32v1-none release build; prints its sha256
cargo test        # 62 tests
```

On Linux, `build-wasm.sh` gives
`4985cd123baddd9f21c4c7eab63e79121d499029b0a514a0258b4846eb28313b` (24,659
bytes), the hash in `contracts/build-hashes.json` (`stellar/execution-adapter`).
It is uploaded on testnet only, where the Prime app's beta names it, with a
gate, for new gates (octopos #231). CI rebuilds this source and compares it
with that record.

The v4 build `3dd675c06a1f9b27b336347d7c7745d20845b6c1f35acfe4cd2ca93ab1db49c3`,
recorded in `deployments/execution-testnet.json`, is the build mainnet runs and
the one the Prime app pins there; its source is this folder at `a86a496`. Gates set up on
mainnet before 11 October 2026 run `68d012e7…` (`deployments/prime-mainnet.json`).
