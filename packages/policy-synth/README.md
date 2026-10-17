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
npm install @crediolabs/policy-synth@next @stellar/stellar-sdk
```

`next` is 2.0.0, for grammar 7. `latest` is still 1.3.0, for the grammar-4
interpreters. `@stellar/stellar-sdk` (^14.4.0) is a peer dependency; npm 7 and
later install it on their own.

## The pipeline

```
recording (hash | xdr) --\
declaration (intent)  ----+-> Intent -> wire expression -> install transaction
template (mandate)    --/    (calls + per-argument constraints)   (unsigned XDR)
```

- **The predicate is its wire shape:** an expression is JSON in the contract's own
  form. A node is a tagged list (`["lte", ["call_arg", 2], {"i128": "100"}]`), a
  symbol or address is a string, a `u32` a number, and every other ScVal type a
  one-key object (`{"i128": "5"}`, `{"bytes": "ab"}`, `{"map": [[k, v]]}`). One
  structural codec (`encode`, `decode`, `hashOf` in `src/wire.ts`) goes JSON <->
  ScVal <-> base64 XDR. It has no per-operator code and keeps the order of
  `and`/`or` as written, because order matters with reads. Two corpora hold it to
  the contract's own bytes: `fixtures/parity/grammar7.json`, which the contract's
  `tests/parity.rs` writes from the ScVal side, and `fixtures/parity/accuracy.json`
  (106 cases at the edges: every value type, map keys in the host's order, string
  bytes that are no valid text, the caps). Every case checks byte equality, the
  JSON round trip, and the same accept or refuse verdict as `check`. `validate`
  accepts and refuses exactly what the contract's decoder does (operators, arity,
  index types, `scaled` operands and constant folds, depth, the weighted leaves,
  the distinct reads, `in` entries, path steps, the byte size), so a rule that
  passes here installs.
- **An Intent** is `{ calls: [{ contract, fn, where: [constraints] }] }`. A constraint is one
  of `pin`, `not`, `allow`, `deny`, `cap`, `floor`, `length`, `minOut`, `each`,
  `some`, `total`, `read`, `until`, `from`, lowered by a table (`src/intent.ts`),
  so batches and vector arguments use `all`/`any`/`sum` in place of a pin per
  element. A recording becomes an Intent through the registry (protocols as data,
  `src/registry.ts`): who is pinned, what is capped, what is asked. Templates
  (`adapter_batch`, `blend_venue`) return an Intent from parameters.
- **There is one evaluator, the contract:** `simulate_policy` and `verify_policy`
  call the interpreter's `check(predicate, context)` through RPC simulation. `check`
  always fails, and the contract error is the verdict (`#0` permits, any other
  number is the deny code). So a verdict is what the contract would do, and a read
  can never commit anything.
  Verify turns each leaf of the rule against a permitted call (deny cases are
  derived from the leaf) and drops each conjunct in turn (minimality), at most
  64 calls in all, eight at a time. It also lists what it could not examine.
  Every branch of an `or` needs a call that takes it, and `unexamined` branches
  keep the result from `ok`. `untested` lists the conjuncts nothing could be tried
  against (a read, the clock), and those whose need is unclear because another
  conjunct is about the same argument or also refuses the case. A conjunct is
  `redundant` only when an exact copy of it stays in the branch.

## Limits

Each grammar-7 interpreter is deployed with its own `Limits`, under the
contract's field names (`max_reads`, `max_leaves`, `max_predicate_bytes`,
`max_elems`, `max_in_operands`, `max_depth`). The constructor stores them once.
There is no setter and the contract cannot be upgraded, so a different limit
means a new instance at a new address. `limits()` returns them.

| Field | Floor | Ceiling | Testnet pin |
| --- | --- | --- | --- |
| `max_reads` | 1 | 8 | 8 |
| `max_leaves` | 4 | 400 | 400 |
| `max_predicate_bytes` | 256 | 40,960 | 24,576 |
| `max_elems` | 2 | 64 | 32 |
| `max_in_operands` | 1 | 64 | 32 |
| `max_depth` | 2 | 8 | 5 |

The constructor refuses a value outside its floor and ceiling with error 220.
This package exports the same bounds as `FLOORS` and `CEILINGS`, and refuses an
instance whose `limits()` fails, falls outside them, or has a field it does not
know. The interpreter README ("Limits") has the measurements. In short:

- **40 KiB byte ceiling:** an install transaction carries the predicate twice.
  The install transaction as this package builds it, with 15 operators and 16
  admins (the interpreter's maximum, one more admin than the tool accepts), is
  91,548 bytes at 40 KiB, 69% of the 132,096-byte transaction limit. At 48 KiB
  it was 108,112 bytes (82%), over the 80% margin.
- **Memory per transaction:** each distinct read of a wasm contract costs about
  1.4 MB, in every authorised context. With 8 such reads the first context costs
  about 12.7 MB and each further one about 11.4 MB. A transaction of 41,943,040
  bytes holds 2 such contexts inside the 80% margin (57%) and 3 with no margin
  (84%). A fourth breaks the limit (111%) and the transaction fails closed.
- **Read targets must be kept alive:** a read of an archived contract restores it
  inside the transaction and can push it past the write limit.
- **Rent:** a permit that finds the rule's entry within 100 ledgers of expiry
  extends it to 518,400 ledgers (about 30 days) inside the agent's own
  transaction. At testnet rates that is about 0.35 XLM per KB of rule. A
  keep-alive should extend the entry first, and an instance's
  `max_predicate_bytes` should fit the real rules.

The tools that check a rule against an interpreter read its limits once per
address and hold the rule to them. Where they come from:

| Tool | Limits used | Field |
| --- | --- | --- |
| `synthesize_policy` | the pin's, read live; the pin's recorded limits when the RPC does not answer within 5 s; `DECODE_LIMITS` on a network with no pin | `heldTo` |
| `simulate_policy` or `verify_policy` with calls, `install_policy` | the live limits of the interpreter that checks the rule | |
| `simulate_policy` with a predicate only (explain) | the given or pinned interpreter's, else `CEILINGS` | `heldTo` |
| `get_interpreter_info` | the instance's, read live, or the recorded ones when the RPC does not answer | `limitsFrom` (`live` or `recorded`) |

`INTERPRETER.testnet` records the limits of the pin. A test holds them equal to
`deployments/grammar7-testnet.json`, and a live answer that differs is refused
(`INTERPRETER_MISMATCH`). `DECODE_LIMITS` (4, 200, 32,768, 32, 32, 5) are the
limits compiled into the first grammar-7 build, the stricter choice.

## Offline and live

`synthesize_policy` from an intent or a template works with no RPC. It uses the
pin's recorded limits, and the review falls back to "argument N" where a name
could not be read. A `hash` source reads the transaction, so it needs the RPC.
`get_interpreter_info` without `verifyLive` also answers offline, from the
recorded limits. `install_policy`, `verify_policy`, `simulate_policy` with
calls and `verifyLive` always need the live interpreter; an explain-only
`simulate_policy` needs it only when the network has a pin or the call gives
`interpreterAddress`.

The RPC endpoint is the operator's: `POLICY_BUILDER_RPC_URL_TESTNET` /
`POLICY_BUILDER_RPC_URL_MAINNET`, else the network default. It must be https, or
http on loopback. No tool input takes an endpoint.

## The seven tools

| Tool | What it does |
| --- | --- |
| `record_transaction` | Decode a transaction (hash over RPC, or base64 XDR) into the calls it authorises, nested ones included. |
| `synthesize_policy` | Source (hash, xdr, recording, intent, template) -> rules, one per contract: predicate, encoding, hash and review. `ambiguities` are questions to answer with `limit`/`limits`/`allow`. Names come from a best-effort read of each contract (2 s, display only): a name never changes what a rule does. |
| `simulate_policy` | A predicate against calls: permit, or the deny code. With a predicate and no calls it only explains it. |
| `verify_policy` | Permitted call(s), derived deny cases, minimality; `ok`, `complete`, `unexamined`, `untested`. **`ok` without `complete: true` does not prove every limit** (`untested` conjuncts were not tried): read `complete`. |
| `install_policy` | Unsigned `add_context_rule`: the account authorises it, and the interpreter installs the predicate in the same transaction. Verifies the interpreter live, reads every rule on the account, and applies the guardrails below. |
| `revoke_policy` | Unsigned `remove_context_rule`. The rule is read and returned as `removes`, with its review when the account runs a known OpenZeppelin build. |
| `get_interpreter_info` | The pin, its `limits` and the `ceilings`. `verifyLive` adds what is deployed now. `explainAccount` (a smart account) reads its rules and explains each one this interpreter polices; only a known OpenZeppelin account build is read. |

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

## Install guardrails

`install_policy` refuses with `INSTALL_BUILD_FAILED` unless stated otherwise.

| Guardrail | What is refused | Override |
| --- | --- | --- |
| Threshold | Several `signers` with no `threshold`, or a threshold one signer meets alone (n of 1, or a weight of at least n): that rule is satisfied by any ONE signer. `anyOne` beside a threshold that needs more is a contradiction. A threshold that can never be met (n above the signers, or weights that do not cover exactly the signers or total less than n) is refused too. | `anyOne: true` installs 1-of-n on purpose |
| Spending-limit guard | A `spendingLimit` unless every branch of the predicate pins `call_fn` to `transfer` (OpenZeppelin's `spending_limit` refuses every other function, so those calls would always fail). It is also refused on a scope that is not shown to be a token (a Stellar Asset Contract, or `transfer(from, to, amount: i128)` in its spec) | none |
| Read safety (`READ_UNSAFE`) | A `read` of a target and function outside the safe list. The list holds the three testnet Reflector oracles (`lastprice`, `price`) and the operator's `POLICY_BUILDER_SAFE_READS_TESTNET` / `_MAINNET` (`C…:function,C…:function`; one malformed entry refuses the whole value). A listed read needs constant arguments. The review marks any other read "(live value, movable within one transaction)". | `POLICY_BUILDER_ALLOW_SPOT_READS=1`, environment only |
| Authority overlap | A rule a shared signer could bypass through a looser or unpoliced neighbour, a rolling total that would not bind, a neighbour it cannot read or judge, or an account whose rules could not all be read | `allowOverlap: true` |
| Amounts | An amount with no cap; a swap's least output with no floor | `allowUnboundedAmount`, `allowOpenSlippage` |
| Scope | A rule scoped to a policy contract (`POLICY_CONTRACTS`) or to the account itself | none |

The overlap scan reads every live rule on the account. It reads the account's
`NextId`, asks which ids below it still hold a rule (200 keys per
`getLedgerEntries` call), and simulates `get_context_rule` for each live one.
`authorityScan.complete` is true only when the rules read match the account's
own count. An absent or malformed `NextId`, an archived entry, a count that
disagrees, or more than 512 ids handed out makes it `false`, and the install is
refused.

The overrides `allowOverlap`, `allowUnboundedAmount`, `allowOpenSlippage` and
`revoke_policy`'s `allowAdminRule` are tool inputs, and no field names them.
`allowOverlap` shows only indirectly: a successful install whose
`authorityScan` lists a `refuse` overlap or has `complete: false`.
`allowAdminRule` shows in `removes` (rule 0, a Default scope, or a scope on the
account itself). `allowUnboundedAmount` and `allowOpenSlippage` leave no trace.
Keep the request with the response.

## What the tools return

The review is a policy tree: `review` (box-drawn text) and `reviewTree` (nodes
`{ label, op, value, raw, index?, children? }`, `raw` the wire value each came
from). It sits in `rules[n]` for `synthesize_policy`, at the top level for
`simulate_policy` and `verify_policy`, in `rule` for `install_policy`, in
`removes` for `revoke_policy`, and in `account.rules[n]` for `explainAccount`.
Addresses are shortened to 6 + 6 characters. `raw: true` shows full addresses,
raw values and the wire index of each name.

The install review opens with an **Authority** node. Its lines:

| Line | Says |
| --- | --- |
| `legend` | `[…] the package's roles; «…» labels given in the request` |
| `signer` | one per signer, `contract` before a C-address, with its weight under a weighted threshold |
| `to act` | "the signer acts alone", "any ONE of these n signers acts alone", "any m of these n signers must approve", or "signers whose weights total at least n must approve" |
| `admins` | the policy admins and what they can do |
| `expires` | "never expires" or "valid through ledger N" |
| `total` | the rolling `spendingLimit`, or "no total limit: each call may move up to its own cap" |
| `interpreter` | the interpreter and the limits it was deployed with |

`[role]` marks are the package's own names: `[smart account]`, `[source account]`,
`[admin]` and `[signer]` from the request's roles, and `[interpreter]` and
`[spending limit]` for the pinned addresses. `«label»` marks are names from the
request's `allow` keys. A label is plain words (a letter, then up to 23 letters,
digits, spaces, `_`, `.` or `-`), so it can never hold a bracket and read as a
role. A role wins over a label on the same address. Only `install_policy` has the
header: `revoke_policy` and `explainAccount` cannot read the threshold or the
total from the account.

`install_policy` also returns:

- `authority`: `{ signers, threshold, admins, validUntil, total, interpreter, limits }`,
  the facts the header renders. `signers` and `admins` are address lists,
  `threshold` is `{ n, weights?, raw }` or absent, `validUntil` a ledger or `null`,
  `total` the `spendingLimit` or `null`, `limits` the interpreter's.
- `authorityScan`: `{ complete, overlaps[] }`.
- `interpreter`: the live fingerprint (grammar, code hash, limits).
- `unsignedXdr` with its length and sha256, and `writtenTo` when `outFile` is set.

Install inputs for authority:

- `threshold`: `{ simple: n }` (any n of the signers) or
  `{ weighted: { weights: { <address>: <weight> }, n } }` (signers whose weights
  total at least n). It attaches OpenZeppelin's `simple_threshold` or
  `weighted_threshold` beside the interpreter.
- `anyOne: true`: install a rule any one signer can use alone.
- `spendingLimit: { amount, periodLedgers }`: attach OpenZeppelin's
  `spending_limit`, a rolling total over `periodLedgers` ledgers (about five
  seconds each).

## Security model

- Enforcement is on chain; this package is the convenience layer.
- **The interpreter is trusted by its build:** `INTERPRETER_WASM` in
  `src/config.ts` lists the reproducible wasm hashes this package trusts. Any
  contract can answer `grammar_version() = 7`, so every address used must also
  run one of those code hashes. On testnet only the pin is accepted
  (`INTERPRETER_MISMATCH` for any other address). `install_policy` fingerprints
  it live; simulate and verify trust it as it stands, since it cannot change.
  Mainnet has no grammar-7 pin: pass `interpreterAddress`, and it is accepted
  only if it runs a trusted build. Any in-range limits are then accepted, so the
  instance passed sets its own limits. Pin mainnet once an instance is deployed.
- The RPC endpoint and the output directory are the operator's. `outFile` is a
  bare file name, written (never over an existing file) into
  `POLICY_BUILDER_OUT_DIR`.
- Every input is validated at the boundary, an unknown key included. The install
  refusals all live in `planInstall` (`src/install.ts`); see "Install guardrails".
- `check` always fails with its verdict, so even a `read` that calls a token's
  `transfer` as the interpreter commits nothing (see the interpreter's README).
- The grammar-7 STRIDE threat model, with what is done and open at 2.0.0, is
  `evidence/stride-threat-model-g7.md` in the repository.

## Tests

`bun test` runs offline. Tests that talk to the network replay recorded JSON-RPC
(`fixtures/rpc`) through the real SDK against a local server; `OPB_LIVE=1 bun
test` runs them against testnet and records them again. The testnet interpreter
and the test account are in `deployments/grammar7-testnet.json`.

## License

MIT
