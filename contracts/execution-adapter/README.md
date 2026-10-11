# execution-adapter

The per-Prime batcher, bound to one custody gate. Soroban allows one
host-function invocation per transaction, so the adapter makes several calls
atomically. It has one rule: a batch may not name an address the gate does not
list. It checks every call target, every argument at any depth and every
authorisation it hands out before any call runs. A batch can wait a number of
ledgers before it runs.

The detailed design is in [docs/stellar.md](../../docs/stellar.md#execution-adapter),
with the wait under [The wait](../../docs/stellar.md#the-wait).

## What the address rule covers

The rule is a walk over the batch. It cannot read a venue's ABI, so it checks
every shape an address can take when a venue passes it as an argument:

| Value in the batch | What the walk does |
| --- | --- |
| An address | Must be on the gate's list, or be the gate. |
| A vector or a map | Each element, key and value is walked. |
| Bytes or text of 32 or 56 bytes | Must equal the raw key or the strkey of a listed address. |
| Bytes or text of 40, 44 or 48 bytes | Must equal the XDR of a listed address. The 48-byte length is the XDR of a muxed address, which never matches. Text of these lengths is refused unless its bytes equal that XDR. |
| Bytes or text of 69 bytes | Refused. That is the length of a muxed `M` strkey. |
| Numbers, times and symbols | Pass. |
| Any other host object, a muxed address among them | Refused with `Uncheckable`. A later protocol's new object type is refused the same way until the walk learns it. |
| Bytes or text of any other length | Pass, so signatures, memos and identifiers still work. |

The 32-, 56- and 69-byte rows apply to any value of that length. A venue
argument that is a 32-byte hash, and is not a listed address's raw key, is
refused with `AddressNotAllowed`.

### What the rule cannot see

The walk reads values and cannot read the venue that receives them. Two shapes
reach an address without the walk recognising it:

- **A number that carries a key:** a `U256` can hold 32 key bytes. A listed
  venue that turns the number back into bytes and then into an address pays the
  account behind it.
- **An address inside a larger encoding:** a listed venue that decodes a
  `Vec<Address>` or an `(Address, u32)` out of bytes reaches an address in data
  whose length the walk does not compare (52 bytes for a one-element vector of
  a contract, 60 and 64 for the pair). The walk compares the XDR of a single
  address only.

Both need a listed venue that decodes values this way. The rule assumes a
listed venue reads an address from an argument shaped like one. Custody
chooses the venues on the gate's list, so that list is where these limits are
managed.

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
| 2 | `AddressNotAllowed` | The batch names an address outside the gate's list, in any of the spellings above |
| 3 | `Uncheckable` | A grant authorises deploying a contract, or an argument is a host object the walk cannot read (a muxed address) |
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
rebuilds it and compares it with the testnet record.

## Builds

| Build | Where | Address rule |
| --- | --- | --- |
| `3dd675c0…` (24,118 bytes) | Testnet. This is what `main` builds. New gates on testnet pin it. | Deny by default; the XDR lengths are compared. |
| `eefcfdd7…` (24,027 bytes) | Testnet, an interim build with the first fix. No gate uses it. | Deny by default; passes 40-, 44- and 48-byte XDR of any address. |
| Earlier builds | Gates set up before the fix. The earlier v4 builds and the v3 builds share the old walk. | Pass a muxed address and the XDR route; the fix is in `3dd675c0…`. |

A deployed build can lag `main`: each network's record in `deployments/` says
which build it runs.
