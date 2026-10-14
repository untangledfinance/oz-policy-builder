# policy-interpreter

The on-chain half of the OZ Policy Builder: a Soroban contract that evaluates
a predicate supplied at install time, so an
[OpenZeppelin Stellar smart account](https://docs.openzeppelin.com/stellar-contracts)
can delegate its per-call authorization decision to it.

The off-chain half - which synthesises, verifies and packages the predicate -
is [`@crediolabs/policy-synth`](../../../../packages/policy-synth/).

## Entry points

| Function | Purpose |
| --- | --- |
| `install` | Store a predicate for a `(smart account, context rule)` pair. Refuses a grammar version it does not speak, an oversized predicate (byte cap before any parse work), and any payload whose sha256 does not match the supplied hash. |
| `enforce` | The policy hook the smart account calls on every guarded operation: decode, evaluate, permit or deny. |
| `uninstall` | Remove the stored predicate for a rule. |
| `rotate_master_signer_set` | Update the master signer set an installation is bound to. |
| `grammar_version` | The predicate grammar version this build speaks (`SELF_VERSION`). |

Evaluation fails closed: an undecodable predicate, an unsupported node, or a
selector the call cannot answer all deny.

## What the predicate can say

The grammar is version 7 (`SELF_VERSION`); this contract accepts grammar-7
predicates only. Most leaves are answered from the authorized call itself, and
`enforce` writes no value. A permit pays for one TTL bump on the rule's stored
entry; it creates nothing and alters no value, and a deny is rolled
back with the frame. The exception is `read`, below: **in grammar 7 `enforce`
calls other contracts**, so the grammar-6 property "`enforce` reads only the
authorized call" no longer holds.

| Leaf | Resolves to |
| --- | --- |
| `call_contract`, `call_fn` | The contract and function being authorized |
| `call_arg(i)` | Argument `i` of that call |
| `call_arg_len(i)` | Length of a vec-typed argument - pins the element count so an extra entry cannot be appended |
| `call_arg_field(i, element, field)` | A field of a map element inside a vec-typed argument |
| `call_path(step, ...)` | A walk into the arguments, one to eight steps: a `u32` indexes a vec, a symbol keys a map, a final `true` takes the length. The three leaves above are shorthand for it, and the decoder lowers them to it |
| `now` | The ledger timestamp (seconds). Ordering widens it to `i128`; `eq` compares by value, so `eq(now, <i128>)` never holds - write `gte`/`lte` |
| `read(contract, fn, args, path)` | A number read from another contract: call `fn(args)` on `contract`, then walk `path` (zero to eight steps, the same steps as `call_path`) into the result. `contract` and `fn` are fixed fields of the predicate, so its hash pins them. `args` are literals only |
| `scaled(src, num, den, add)` | `src * num / den + add`. `src`, `num` and `add` are any value leaf, `scaled` included; `den` is a constant and must be positive, and a literal `src` or `num` must be too. Multiplies first, divides second (truncating toward zero), adds third, every step checked |
| `variant(name, payload...)` | An enum value as a constant: the vec `[name, payload...]`, for a `read` argument such as Reflector's `Asset::Stellar(addr)`. Payload entries are constants. Also legal wherever another literal is |
| `literal_*` | Constants on either side of a comparison, or inside an `in` allowlist |

Nodes: `and`, `or`, `eq`, `lt`, `lte`, `gt`, `gte`, `in`. Literals:
`literal_address`, `literal_i128`, `literal_symbol`, `literal_u32`,
`literal_vec`. Both sides of a comparison are resolved, so any value leaf can
stand on either side.

`src` and `num` multiply, so a constant in either is held to the same rule:
anything made of literals alone (a literal, or a `scaled` of literals, folded at
decode) must come out above zero. `-99/100` would turn a floor into a ceiling
that permits a zero output, and `0` cancels the selector. Grammar 6 had one
literal factor, `num`, so the same rule is stricter here (it also covers `src`
and nested constants); a factor that comes from the call, the clock or a read
cannot be judged at install and stays the rule author's to guard. `den` is
positive and at most `MAX_DEN` (10^18). The cap stops an `i128::MAX`-style `den`
only; it does not stop a tiny `num / den` ratio (`99 / 10^18` still floors at
zero for ordinary amounts), which the rule author has to avoid. A constant that
overflows is refused at install rather than installing a rule that always
denies. Division truncates toward zero, which loosens a floor by less
than one unit (`gte(out, scaled(in, 99, 100, 0))` permits `out = 99` for
`in = 101`, a floor of 99.99) and a negative bound the other way; write an exact
bound cross-multiplied, `gte(scaled(out, 100, 1, 0), scaled(in, 99, 1, 0))`. Write a subtraction by moving the term
across the comparison (`ts >= now - 300` is `ts + 300 >= now`, which is
`gte(scaled(ts, 1, 1, 300), now)`); `add` is any value and may be a negative
literal. A negative factor can still be built from a variable (`num = scaled(call_arg(1), 1, 1, -100)`), the same class as comparing a selector with itself: install cannot tell a deliberate rule from a bad one. `in` haystacks and literal vectors hold constants only: a selector,
`read`, `scaled` or `now` in one is refused at decode, as it could never be
compared.

`scaled` replaces grammar 6's `call_arg_scaled(i, num, den)`, which is now
`scaled(call_arg(i), num, den, 0)`. Because it resolves to a plain number, a
comparison against it is an ordinary comparison: a miss denies `ARG_MISMATCH`
(there is no separate slippage reason), and two `scaled` leaves compare with
each other. Nesting gives sums, differences, products and small integer powers:
`debt + B` is `scaled(debt, 1, 1, B)`, and `x^3` is
`scaled(x, scaled(x, x, 1, 0), 1, 0)`.

### Cross-contract reads

Read this before writing a rule with a `read`.

- **`enforce` performs a call into each contract a `read` names.** Soroban has
  no read-only call: the host runs whatever function was named, with the same
  rights as any other call. A `read` target must therefore be a contract the
  policy owner trusts, and ideally one that cannot be upgraded, because a
  target that changes behaviour changes what the rule permits and what `enforce`
  costs. The target and function are fixed in the predicate and cannot be
  steered by the call being authorized. Whatever state the target changes
  while being read is committed if the call is permitted and rolled back if it
  is denied, so name only functions that are read-only in fact.
- **The interpreter's address must never hold value, allowances or roles.** A
  read target sees the interpreter as its direct caller, so any
  `require_auth(interpreter)` inside it passes, and a target's state changes
  commit when the authorisation is permitted - even one made by an `or` branch
  that then denied. `or(gte(read(token.transfer(interpreter, ...)), 0), <branch
  that permits>)` would move the interpreter's tokens if it held any. Nothing in
  this repository trusts the interpreter's address, and nothing may: do not fund
  it, do not approve it, do not grant it a role on any contract, and name only
  read-only functions in a `read`.
- **Arguments are literals.** `read` takes an address, a symbol, a `u32` or an
  `i128`, a vec of those that does not begin with a symbol, or an enum variant
  written `variant(name, payload...)`. A selector, `now`, `scaled` or another
  `read` in an argument is refused at install. A Soroban enum value is the vec
  `[name, payload...]`, and a bare vec that begins with a symbol is read as a
  selector, so a variant carries its own tag: Reflector's
  `lastprice(Asset::Stellar(addr))` takes `variant(Stellar, addr)`. Payload
  entries are constants, like every other literal, and a variant is also a
  legal literal anywhere else (an `in` haystack entry, a compare operand, a
  vec element).
- **A read target must be a contract address, and not one already on the call stack.** A G-account target is refused at install (the host would abort the whole `enforce` on it). The host refuses re-entry, so when the authorized call's own target is the read
  target - a token's `transfer` checking that token's `balance` - the read
  fails, and a failed read denies. Read a contract the authorized call does not
  pass through.
- **A read sees the state at the moment the account's authorisation is
  checked, not a protected snapshot.** That is after anything the submitter ran
  earlier in the same transaction (the host accepts non-root authorisation
  entries, so a submitter can wrap the authorised call in its own contract,
  move a value, have the authorisation checked, and move it back), and before
  the calls the authorisation covers. So `read` is only safe against values
  the submitter cannot move cheaply inside one transaction: an oracle-signed or
  admin-set price feed, not a spot AMM price, a pool's utilisation or a
  balance the agent can debit and restore. A balance floor on an address the
  agent cannot debit (a custody account) is safe against the agent and still
  rises with any donation. `tests/grammar7.rs` shows the wrapper defeating a
  spot read.
  Three timings follow from this, and a rule author has to pick the one the
  rule is evaluated at:
  - a direct venue call: the rule is evaluated at the transaction's
    authorisation, before the call;
  - the execution adapter's `execute(calls, grants, wait)` with `wait == 0`:
    one authorisation covers the whole batch, so a rule such as "debt + B stays
    under 92% of collateral" is checked against the state before ANY call of
    the batch (`execute([advance(B), withdraw_collateral(X)])` passes and then
    breaks the bound). Pin the batch shape: its length (`call_path(0, true)`),
    every element (target, function, arguments and its `executor_authorizations`)
    and `grants` (`call_path(1, true)` equal to 0), so nothing can be appended or
    swapped;
  - `execute` with `wait > 0`: the rule is evaluated when the batch is STORED,
    not when it runs, and the run is approved by a separate `run(id)` rule that
    cannot re-check the batch. A read-based rule on `execute` must pin
    `call_arg(2)` (the wait) to 0; put read checks on the venue rules instead,
    which are evaluated when the batch runs, mid-batch, after its earlier calls
    (so a venue read sees the state the batch's earlier calls left). Keep the
    shape pin on `execute` (wait, length, every target, function, arguments and
    `executor_authorizations`, and `grants`) even when the reads move to venue
    rules; `tests/grammar7.rs` pins all of them.
  `tests/grammar7.rs` shows the unpinned batch and the waiting batch that are
  let through and the pinned rule that refuses both. Called directly (not
  through the adapter), a pool the authorised call itself targets is on the call
  stack, so reading it is refused as re-entry. A rule on a direct pool call
  therefore cannot read that pool, and the call's arguments are supplied by the
  agent being policed, so they prove nothing about the pool: route the call
  through the adapter (the pool is then not on the stack), or rely on the pool's
  own on-chain checks.
- **Failure denies.** A read that panics, hits a missing function or contract,
  returns void or a non-number, or finds no field at `path` resolves to
  nothing, and the comparison denies (`ARG_MISMATCH`). That includes `eq`: two
  failed reads are never "equal".
- **Caps, enforced at decode.** At most four DISTINCT `read` calls per
  predicate, a call being `(contract, fn, args)`: reads that differ only in
  `path` are one call, and `enforce` makes it once and reuses the result for
  every leaf (a failed call is remembered too, so each leaf that uses it
  denies). So one price feed read for a floor, an LTV and a freshness bound is
  one call, and the full PayFi set (feed, debt, collateral, custody balance) is
  exactly four. Reads count inside `scaled` too; the fifth distinct call is refused at install as
  `MALFORMED_PREDICATE`, decoder reason `TOO_MANY_LEAVES` - every decoder cap
  surfaces as 201),
  `read` paths and `call_path`s of at most eight steps, and leaf nesting
  (`scaled` operands, literal vecs) of at most `MAX_DEPTH` (5) levels. With the
  existing 200-leaf cap, evaluation work is bounded and each distinct
  `read` runs at most once per `enforce`.
- **A rule still has to constrain the call.** `install` refuses a predicate with
  no leaf over the authorized call (`call_contract`, `call_fn`, `call_arg*`,
  `call_path`), seen through `scaled`. `read` and `now` do not
  count, so a rule made only of reads and the clock is refused
  (`SELECTOR_LEAF_REQUIRED`). The check is that one such leaf exists somewhere,
  as before; it does not prove every branch of an `or` constrains the call.
- **Simulate with real signatures.** A read's ledger entries are part of the
  transaction's footprint. A simulation that skips authorization may not reach
  `enforce`, and so not the reads, and the submitted transaction then fails on
  a footprint it did not declare. Simulate the signed transaction.
- **Cost.** Each read is a contract call inside the account's authorization
  check and spends the transaction's budget; a slow or heavy target makes every
  call it guards slow or heavy.
- **An oracle read is only as good as the oracle.** A stale or manipulable price
  satisfies the rule. Pair a price with a `now` freshness bound
  (`read(...).timestamp >= scaled(now, 1, 1, -300)`).
- **Guard variable operands.** A `num` or a call amount that is not a literal
  cannot be judged at install, so the rule must. Put `gt(read(price), 0)` beside
  a price used as a multiplier (zero or negative makes an upper bound trivial)
  and `gte(call_path(amount), 0)` beside every amount taken from the call (a
  negative advance lowers the debt side and passes the bound). With the guards
  the negative case is refused; `tests/grammar7.rs` shows both.
- **Arithmetic fails closed.** Overflow in any step of a `scaled` (the multiply,
  the divide, the add) denies `ARITHMETIC_OVERFLOW`; it never wraps. A `den`
  of zero or less or above `MAX_DEN`, or a constant `src` or `num` that folds to zero or less, is refused at install
  as `MALFORMED_PREDICATE`, and the
  evaluator still refuses to divide by zero if that gate ever regresses.

The grammar carries only what a policy needs and no more. `not` is absent by
design: it inverts a deny into a permit, so a leaf the evaluator could not
resolve - a missing argument index, an operand of the wrong type, a failed
read - would come back as PERMIT rather than as the deny everything else in the
grammar produces. In a deny-by-default evaluator that is the one construct that
can turn the default inside out.

`or` carries no such hazard - an unresolvable leaf still denies its own branch -
and it is what lets one rule permit either of two token pairs. Its children are
canonically sorted like `and`'s, so authoring order is not preserved; when every
branch denies, the reported reason is the first branch's in wire order.

Deliberately absent, because the interpreter sees one authorized call and no
history: what a transaction actually moved (`amount`), rolling per-window spend
totals, call-frequency caps, and policy expiry. Rolling spend caps and approval
thresholds belong to the OpenZeppelin account layer, not here. A cap on value is
expressed instead against the call's own amount argument (`call_arg(i) <=
limit`); expiry belongs to the context rule's own `valid_until`. The
synthesiser reports each of the absent ones as uncovered rather than emitting a
constraint that would never bind.

Retired deny codes: `107` (`SLIPPAGE_FLOOR`) and `214`
(`INVALID_SCALED_RATIO`) are not emitted by grammar 7 and are not reused.

## Deployments

The live addresses and wasm sha256 are pinned in
[`packages/policy-synth/src/run/schemas.ts`](../../../../packages/policy-synth/src/run/schemas.ts)
and shown in the [repository README](../../../../README.md).

## Build and test

```sh
cargo test                               # unit + integration suites
cargo test --release --test conformance  # fixtures encoded by the TS synthesiser
```

The conformance suite is the cross-layer gate: fixtures generated by
`@crediolabs/policy-synth` must evaluate identically here. The synthesiser and
its TypeScript reference evaluator still speak grammar 6, so
`tests/conformance/_generated_v4.rs` was migrated by hand to the grammar-7 form
of its one scaled leaf; do not regenerate it until the TypeScript side learns
`scaled`, `read` and `now`. `tests/grammar7.rs` covers the new leaves end to end
against mock oracle, token and pool contracts. If you change the grammar, bump
`SELF_VERSION` (`src/version.rs`) and regenerate the fixture:

```sh
bun packages/policy-synth/scripts/gen-conformance-fixture.ts \
  --recording packages/policy-synth/fixtures/recordings/demo-tx-260725/recording-blend.json \
  --out contracts/prime/stellar/policy-interpreter/tests/conformance/_generated.rs
```

Built for `wasm32v1-none` on soroban-sdk 27.
