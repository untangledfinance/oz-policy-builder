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
  the Prime itself, hands a callee no authorisation as itself, and runs every
  batch at once. The one grant it hands out is its word to the Prime's policy
  (below), which lets a keyless rule bound to it answer an immediate batch:
  that is how anyone can run a liquidation the Prime's rules permit.

## The word of an adapter with no gate

In an immediate `execute` (wait 0), and only there, an adapter with no gate
accepts in `grants` entries of exactly one shape: `enforce(prime, context)` on
a contract the batch names, for its own Prime, with nothing nested under it.
Any other grant is refused (3). To each contract named that way it adds the
same entry for the `execute` it is running, which no batch can spell because
the batch is inside it. It hands all of them out just before it asks the Prime,
and the host keeps them for that one approval of the Prime, each matched once.
Nothing is stored, so none outlives the call.

The interpreter's `enforce` asks a bound executor for exactly that
(`require_auth_for_args((account, context))`), so a rule the Prime's admins
bound to this adapter with `bind_executor` passes for the contexts the batch
names, and a keyless rule scoped to this adapter passes for its `execute`
only if its predicate pins the whole batch: `call_fn == execute`, a wait of 0,
the number of calls and every call's target and function (221 otherwise). The
entry authorises no move: a token, a venue or the Prime asks this adapter for
nothing named `enforce`. A batch with no grants hands out nothing, as before.

**Do not share it between keys and keyless rules.** A keyed rule an agent
holds on this adapter's `execute` lets the agent pass words too, and the
account's keyless inner rules bound to this adapter then answer the agent's
batch, outside the liquidation whose root rule held their cross-call guards.
Every keyed rule scoped to an adapter with no gate must pin
`call_arg_len(1) == 0`; better, keep one no-gate adapter (its own
`run_window`, so its own address) for keyless rules only, with no keyed rule
scoped to it (STRIDE E-36).

The design is in [docs/stellar.md](../../../docs/stellar.md#execution-adapter),
with the wait under [The wait](../../../docs/stellar.md#the-wait) and the null
mode under [No gate](../../../docs/stellar.md#no-gate).

## The address walk refuses by length

A gated adapter guards addresses by COMPARING each listed address's spelling.
For every `Bytes` or `String` in a call argument (at any depth) or a grant, it
picks the address encoding its length would be and refuses the value with
`AddressNotAllowed` unless it equals exactly how a listed address spells.
Comparing avoids a decode, which has no fallible form inside a contract and
would trap the whole batch on a value that turned out not to be an address. The lengths it checks are
32 (a raw account key or contract id), 56 (a `G`/`C` strkey), 40, 44 and 48 (the
XDR of a contract, an account and a muxed address) and 69 (a muxed `M` strkey).

The trade-off is that the refusal is by length, not only for values that really
are addresses. A non-address value of one of these lengths is refused even to a
listed venue: a 32-byte hash, salt, pool index or commitment, a 32-character
identifier, or a 40-, 44-, 48- or 56-character memo or string cannot pass
through a gated adapter. It fails closed, with no fund risk. This refusal is
deliberate and stays: it is what stops a venue decoding a stranger's raw key,
strkey or XDR back into an address and paying it. Vet a venue that legitimately
takes an argument of one of these lengths (for example a `BytesN<32>` pool
index) before configuring a gate; the safe way to admit one is a per-venue
argument allowlist in the gate, never a looser walk. Data of any other length
passes untouched, and an adapter with no gate does not scan at all.

## Entry points

| Function | Purpose |
| --- | --- |
| `__constructor` | Bind the adapter to its Prime account and to a gate or to none, with `min_wait` (the fewest ledgers any batch waits) and `run_window` (how long a ready batch stays runnable). Refuses an address other than the one derived from those three values, so custody can name the adapter on the gate before it exists. With no gate, refuses a `min_wait` above 0. |
| `execute` | Check a batch of calls and grants. With `wait` 0 it runs at once; above 0 it is stored and its number returned, if there is a gate. The Prime approves `(calls, grants, wait)` together. With no gate, the grants may only be the adapter's word to the Prime's policy (above). |
| `run` | Run a stored batch from its ready ledger to the end of its run window. Anyone may submit it. The Prime approves through its run rule: scoped to this adapter, listing no signer, bound to this adapter with the interpreter's `bind_executor`, and pinned to `call_fn == run` (see [The run rule](../../../docs/stellar.md#the-run-rule)). The batch is checked again against the gate bound now, and runs once. |
| `cancel` | Drop a stored batch, waiting, ready or lapsed. `by` must be the Prime or the custody account the gate answers to, and must approve. With no gate, `by` must be the Prime. |
| `rebind` | Move the adapter to a successor gate. Only the current gate's custody account may call it, and the successor must answer `custody()`. An adapter with no gate cannot be bound, and an adapter with a gate cannot be moved to none. |

## Error codes

| Code | Name | Means |
| --- | --- | --- |
| 1 | `PrimeTarget` | A call targets the Prime account itself |
| 2 | `AddressNotAllowed` | The batch names an address outside the gate's list |
| 3 | `Uncheckable` | A grant authorises deploying a contract; or the adapter has no gate and the batch hands a callee an authorisation, or carries a grant other than `enforce(prime, context)` with nothing nested |
| 4 | `WaitTooShort` | `wait` is below `min_wait` |
| 5 | `NotScheduled` | Nothing is stored under that batch number |
| 6 | `NotRunnable` | The batch is before its ready ledger or past its run window |
| 7 | `NotACanceller` | `by` is neither the Prime nor the custody account |
| 8 | `NotWhereAgreed` | The adapter is at an address other than the one derived from its gate and wait numbers |
| 9 | `NoGate` | `rebind` on an adapter created with no gate |
| 10 | `NoWait` | A batch with a wait, or a `min_wait` above 0, on an adapter with no gate |

## The address

`deployer(prime, sha256("prime.execution.adapter.v5" + XDR((gate, min_wait,
run_window))))`, where "no gate" is a void in the tuple and the salt text is a
fixed domain constant. The Prime deploys its own adapter: a G
account signs the deployment as the transaction source or by an
address-credential entry; an OpenZeppelin account approves it through a rule.

## Build and test

```sh
./build-wasm.sh   # reproducible wasm32v1-none release build; prints its sha256
cargo test        # 67 tests
```

On Linux, `build-wasm.sh` gives
`bf85432c859f1ee543c14e9cc9b2c150c12753cc9580053b8d27a41eee85b4a0` (28,003
bytes), the hash in `contracts/build-hashes.json` (`stellar/execution-adapter`).
Its code is uploaded on testnet (`deployments/execution-testnet.json`). CI
rebuilds this source and compares it with that record. The interpreter's
`oz08/tests/nogate.rs` runs this wasm against OpenZeppelin's 0.8.0 account: a
liquidation by anyone under keyless rules bound to an adapter with no gate.
