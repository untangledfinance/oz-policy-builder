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
template (mandate)    --/    (calls + per-argument rules)   (unsigned XDR)
```

- **The predicate is its wire shape.** An expression is JSON in the contract's own
  form: a node is a tagged list (`["lte", ["call_arg", 2], {"i128": "100"}]`), a
  symbol or address is a string, a `u32` a number, and every other ScVal type a
  one-key object (`{"i128": "5"}`, `{"bytes": "ab"}`, `{"map": [[k, v]]}`). One
  structural codec (`encode`, `decode`, `hashOf` in `src/wire.ts`) goes JSON <->
  ScVal <-> base64 XDR with no per-operator code and no reordering of `and`/`or`
  (order matters with reads). It is held to the contract's own bytes by
  `fixtures/parity/grammar7.json`, which the contract's `tests/parity.rs` writes
  from the ScVal side: byte equality, JSON round trip, and the same accept/refuse
  verdicts as `check`, for every case. `validate` mirrors the contract's decode
  refusals (operators, arity, depth, the 200 weighted leaves, four distinct
  reads, six sums, path steps, 32 KB).
- **An Intent** is `{ calls: [{ contract, fn, where: [rules] }] }`. A rule is one
  of `pin`, `not`, `allow`, `deny`, `cap`, `floor`, `length`, `minOut`, `each`,
  `some`, `total`, `read`, `until`, `from`, lowered by a table (`src/intent.ts`),
  so batches and vector arguments use `all`/`any`/`sum` instead of a pin per
  element. A recording becomes an Intent through the registry (protocols as data,
  `src/registry.ts`): who is pinned, what is capped, what is asked. Templates
  (`adapter_batch`, `blend_venue`) return an Intent from parameters.
- **There is one evaluator: the contract.** `simulate_policy` and `verify_policy`
  call the interpreter's read-only `check(predicate, context) -> u32` through RPC
  simulation, so a verdict is what the contract would do, with its deny code.
  Verify turns each leaf of the rule against a permitted call (deny cases are
  derived from the leaf) and drops each conjunct in turn (minimality), at most
  64 calls, eight at a time.

## The seven tools

| Tool | What it does |
| --- | --- |
| `record_transaction` | Decode a transaction (hash over RPC, or base64 XDR) into the calls it authorises, nested ones included. |
| `synthesize_policy` | Source (hash, xdr, recording, intent, template) -> rules, one per contract: predicate, encoding, hash, plain-language review; `ambiguities` to answer with `limit`/`limits`/`allow`. |
| `simulate_policy` | A predicate against calls: permit, or the deny code. |
| `verify_policy` | Permit case, derived deny cases, minimality. |
| `install_policy` | Unsigned `add_context_rule` (the account authorises it; the interpreter installs the predicate in the same transaction). Verifies the pinned interpreter live, reads the account, **refuses** a rule a shared signer could bypass (`allowOverlap` overrides). |
| `revoke_policy` | Unsigned `remove_context_rule`. |
| `get_interpreter_info` | The pin, the caps, and with `verifyLive` what is deployed now. |

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

- Enforcement is on chain; this package is the convenience layer. The interpreter
  address and wasm sha256 are pinned in `src/config.ts` and verified live
  (`grammar_version()` and the instance's code hash) before an install is built.
  **Only a testnet interpreter is pinned**; on mainnet name one with
  `interpreterAddress` and the build you expect in `interpreterWasmSha256`.
- The RPC endpoint is the network's own unless `allowUnpinnedRpcUrl` (https only,
  or loopback http for a recorded server).
- Every input is validated at the boundary; an install that cannot bind its
  signers is refused by default, and so is an unanswered amount cap, a rule scoped
  to a policy contract or to the account, and an account whose rules cannot all
  be read.
- `check` is a public view: a `read` in a predicate calls its target as the
  interpreter does, and the interpreter must hold nothing (see its README).

## Tests

`bun test` runs offline. Tests that talk to the network replay recorded JSON-RPC
(`fixtures/rpc`) through the real SDK against a local server; `OPB_LIVE=1 bun
test` runs them against testnet and records them again. The testnet interpreter
and the test account are in `deployments/grammar7-testnet.json`.

## License

MIT
