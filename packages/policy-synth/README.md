# @crediolabs/policy-synth

Off-chain core of the OZ Policy Builder, for the **grammar-7** policy interpreter
on Stellar. It turns a transaction you recorded, or a mandate you can state as
data, into the rule that permits exactly that, checks the rule against the
interpreter itself, and returns an unsigned transaction that installs it on an
[OpenZeppelin Stellar smart account](https://docs.openzeppelin.com/stellar-contracts).

The on-chain half is the `policy-interpreter` contract in
[untangledfinance/oz-policy-builder](https://github.com/untangledfinance/oz-policy-builder).

## Install

```sh
npm install @crediolabs/policy-synth
```

## The pipeline

```
recording (hash | xdr) --\
declaration (intent)  ----+-> Intent -> wire expression -> install transaction
template (mandate)    --/    (calls + per-argument constraints)   (unsigned XDR)
```

- **The predicate is its wire shape.** An expression is JSON in the contract's own
  form: a node is a tagged list (`["lte", ["call_arg", 2], {"i128": "100"}]`), a
  symbol or address is a string, a `u32` a number, and every other ScVal type a
  one-key object (`{"i128": "5"}`, `{"bytes": "ab"}`, `{"map": [[k, v]]}`). One
  structural codec (`encode`, `decode`, `hashOf` in `src/wire.ts`) goes JSON <->
  ScVal <-> base64 XDR with no per-operator code and no reordering of `and`/`or`
  (order matters with reads). It is held to the contract's own bytes by
  `fixtures/parity/grammar7.json`, which the contract's `tests/parity.rs` writes
  from the ScVal side, and by `fixtures/parity/accuracy.json` (106 shapes at the
  edges: every value type, map keys in the host's order, string bytes that are
  not text, the caps): byte equality, JSON round trip, and the same accept/refuse
  verdicts as `check`, for every case. `validate` accepts and refuses exactly
  what the contract's decoder does (operators, arity, index types, `scaled`
  operands and constant folds, depth, the weighted leaves, the distinct
  reads, `in` entries, path steps, the byte size), so a rule that leaves here installs.
  The caps are the **instance's**: an interpreter is deployed with its own `Limits`
  (reads, leaves, bytes, elems, `in` entries, depth, each from 1 to a hard ceiling),
  `limits()` returns them, and the tools that check a rule against an interpreter read
  them from it (once per address) and hold the rule to those. A tool that only
  explains a predicate, and a network with no interpreter pinned, use the grammar-7
  defaults (`DECODE_LIMITS`: reads 4, leaves 200, bytes 32 KiB, elems 32, in 32,
  depth 5). An instance whose `limits()` fails or exceeds the ceilings (`CEILINGS`:
  8, 400, 48 KiB, 64, 64, 8) is refused.
- **An Intent** is `{ calls: [{ contract, fn, where: [constraints] }] }`. A constraint is one
  of `pin`, `not`, `allow`, `deny`, `cap`, `floor`, `length`, `minOut`, `each`,
  `some`, `total`, `read`, `until`, `from`, lowered by a table (`src/intent.ts`),
  so batches and vector arguments use `all`/`any`/`sum` instead of a pin per
  element. A recording becomes an Intent through the registry (protocols as data,
  `src/registry.ts`): who is pinned, what is capped, what is asked. Templates
  (`adapter_batch`, `blend_venue`) return an Intent from parameters.
- **There is one evaluator: the contract.** `simulate_policy` and `verify_policy`
  call the interpreter's `check(predicate, context)` through RPC simulation. `check`
  always fails, and the contract error is the verdict (`#0` permits, any other
  number is the deny code), so a verdict is what the contract would do and nothing
  a read does can ever commit.
  Verify turns each leaf of the rule against a permitted call (deny cases are
  derived from the leaf) and drops each conjunct in turn (minimality), at most
  64 calls in all, eight at a time. It says what it did not examine: every
  branch of an `or` needs a call that takes it (`unexamined` branches make it not
  `ok`), and `untested` lists conjuncts nothing could be tried against (a read,
  the clock) or whose need cannot be told because another conjunct is about the
  same argument or whose case another conjunct also refuses. A conjunct is `redundant` only when an exact copy of it stays in the branch; whenever something else could be refusing its case, its need is `untested`, never called redundant.

## The seven tools

| Tool | What it does |
| --- | --- |
| `record_transaction` | Decode a transaction (hash over RPC, or base64 XDR) into the calls it authorises, nested ones included. |
| `synthesize_policy` | Source (hash, xdr, recording, intent, template) -> rules, one per contract: predicate, encoding, hash, a policy tree (`review` text, `reviewTree` nodes with the wire `raw` each came from; names come from a best-effort read of each contract, so it is no longer offline, and a name never changes what a rule does); `ambiguities` to answer with `limit`/`limits`/`allow`. |
| `simulate_policy` | A predicate against calls: permit, or the deny code. |
| `verify_policy` | Permitted call(s), derived deny cases, minimality; `ok`, `complete`, `unexamined`, `untested`. **`ok` without `complete: true` does not prove every limit** (`untested` conjuncts were not tried): read `complete`. |
| `install_policy` | Unsigned `add_context_rule` (the account authorises it; the interpreter installs the predicate in the same transaction). Verifies the interpreter live, always reads the account, **refuses** a rule a shared signer could bypass or a neighbour it cannot judge (`allowOverlap` overrides). |
| `revoke_policy` | Unsigned `remove_context_rule`. |
| `get_interpreter_info` | The pin, its `limits` (read from the instance) and the `ceilings`, and with `verifyLive` what is deployed now. |

`TOOLS` (also `@crediolabs/policy-synth/run`) is the table the MCP server and the
CLI register from. Each tool validates its input strictly, never throws, and
returns `{ ok: true, data }` or `{ ok: false, error: { code, message, severity,
retryable } }`. Nothing here holds key material: install and revoke return
*unsigned* XDR and the wallet's signature is the confirmation.

```ts
import { run } from '@crediolabs/policy-synth/run'

const s = await run('synthesize_policy', { network: 'testnet', hash: '<tx hash>', limit: '5000000' })
const rule = s.ok && s.data.rules[0]
await run('verify_policy', { network: 'testnet', encodedPredicate: rule.encodedPredicate, hash: '<tx hash>' })
```

## Security model

- Enforcement is on chain; this package is the convenience layer. **The
  interpreter is a build, not an address**: `INTERPRETER_WASM` in `src/config.ts`
  lists the reproducible wasm hashes this package trusts, and whatever address is
  used, its live `grammar_version()` and code hash must match (any contract can
  answer `grammar_version() = 7`). The pinned address is trusted as it stands (an
  immutable contract); `install_policy` fingerprints it live too, and simulate and
  verify check any other address live before asking it anything. Only
  a testnet interpreter is pinned; on mainnet name one with `interpreterAddress`
  and it is accepted only if it runs a trusted build.
- The RPC endpoint is the operator's, never a tool's input: the network's own, or
  `POLICY_BUILDER_RPC_URL_TESTNET` / `POLICY_BUILDER_RPC_URL_MAINNET` (https, or
  loopback http for a recorded server). Nor does a tool take a path: `outFile` is a
  bare file name, written (never over an existing file) into the operator's
  `POLICY_BUILDER_OUT_DIR`.
- A `read` is a live value an agent can move within one transaction, so an install of
  one is refused (`READ_UNSAFE`) unless it is on the safe list: the testnet Reflector
  oracles, plus the operator's own `POLICY_BUILDER_SAFE_READS_TESTNET` /
  `POLICY_BUILDER_SAFE_READS_MAINNET` (`C…:function,C…:function`, environment only; one
  malformed entry refuses the whole value). Any listed read needs constant arguments
  and is not marked "movable" in the review; `POLICY_BUILDER_ALLOW_SPOT_READS=1` allows all.
- Every input is validated at the boundary, an unknown key included; an install
  that cannot bind its signers is refused by default, and so is an unanswered amount
  cap (recordings, intents and templates alike), a rule scoped to a policy contract
  or to the account, a neighbour the scan cannot read or judge (an interpreter of
  another grammar, a rule with only a spending limit), and an account whose rules
  cannot all be read. All refusals live in `planInstall` (`src/install.ts`).
- `check` always fails with its verdict, so even a `read` that calls a token's
  `transfer` as the interpreter commits nothing (see the interpreter's README).

## Tests

`bun test` runs offline. Tests that talk to the network replay recorded JSON-RPC
(`fixtures/rpc`) through the real SDK against a local server; `OPB_LIVE=1 bun
test` runs them against testnet and records them again. The testnet interpreter
and the test account are in `deployments/grammar7-testnet.json`.

## License

MIT
