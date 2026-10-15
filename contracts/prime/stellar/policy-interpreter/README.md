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
| `install` | Store a predicate for a `(smart account, context rule)` pair. Refuses a grammar version it does not speak, an oversized predicate (byte cap, `207`, before any parse work), any payload whose sha256 does not match the supplied hash, a rule that reaches the admin surface (`Default`-scoped, or scoped to the smart account or to this interpreter: `218`; **only those two addresses** - a rule scoped to another policy contract, such as a second interpreter instance or OZ's `spending_limit`, still installs and exposes that contract's own admin calls, so never scope a rule to a policy contract), and a signer set (the rule's operators or the master set) that is empty, over 16, holds an `External` signer, or holds this interpreter's own address (`219`: nobody can authorise as it, so an operator set holding it could never authorise a call and a master set holding it could never uninstall or rotate). A contract address in a master set bricks the rule just the same unless that contract itself calls `uninstall`/`rotate_master_signer_set`; only the interpreter's own address is checked, because the others cannot be enumerated. |
| `enforce` | The policy hook the smart account calls on every guarded operation: decode, evaluate, permit or deny. |
| `bind_executor` | Bind a rule to an execution adapter, whose own authorisation of the exact account and context `enforce` then also requires. Needs the smart account's authorisation and the master set's; kept across a re-install. |
| `uninstall` | Remove the stored predicate for a rule. |
| `rotate_master_signer_set` | Update the master signer set an installation is bound to. |
| `grammar_version` | The predicate grammar version this build speaks (`SELF_VERSION`). |

Evaluation fails closed: an undecodable predicate, an unsupported node, or a
selector the call cannot answer all deny. Which reason is reported does not
depend on the side an operand is written on: an ordering over `call_contract` or
`call_fn` is `UNSUPPORTED_NODE` (103), and a missed `eq` against `call_contract`
is `CONTRACT_SCOPE` (101), whichever side they are on.

## What the predicate can say

The grammar is version 7 (`SELF_VERSION`); this contract accepts grammar-7
predicates only. Most leaves are answered from the authorized call itself, and
`enforce` writes no value. A permit bumps the rule's stored entry's TTL when
fewer than 100 ledgers remain on it; it creates nothing and alters no value, and
a deny is rolled back with the frame. The exception is `read`, below: **in grammar 7 `enforce`
calls other contracts**, so the grammar-6 property "`enforce` reads only the
authorized call" no longer holds.

| Leaf | Resolves to |
| --- | --- |
| `call_contract`, `call_fn` | The contract and function being authorized |
| `call_arg(i)` | Argument `i` of that call |
| `call_arg_len(i)` | Length of a vec-typed argument - pins the element count so an extra entry cannot be appended |
| `call_arg_field(i, element, field)` | A field of a map element inside a vec-typed argument |
| `call_path(step, ...)` | A walk into the arguments, one to eight steps: a `u32` indexes a vec, a constant keys a map (a bare symbol, or `lit(x)` for any other key), a final `true` takes the length. The three leaves above are shorthand for it, and the decoder lowers them to it |
| `now` | The ledger timestamp (seconds), a `u64`. A clock is normally bounded, not matched: write `gte`/`lte` |
| `read(contract, fn, args, path)` | A value read from another contract: call `fn(args)` on `contract`, then walk `path` (zero to eight steps, the same steps as `call_path`) into the result. `contract` and `fn` are fixed fields of the predicate, so its hash pins them. Each of `args` is a constant, a `call_path` (or `call_arg`...), `call_contract`, `call_fn` or `now`. The result is any value but void |
| `scaled(src, num, den, add)` | `src * num / den + add`. `src`, `num` and `add` are any value leaf, `scaled` included; `den` is an `i128` constant (a `u32` is refused) and must be positive, and a literal `src` or `num` must be too. Multiplies first, divides second (truncating toward zero), adds third, every step checked |
| `lit(x)` | A constant of ANY type: a string, bytes, bool, `u64`, `i64`, `i32`, `u128`, `Timepoint`, `Duration`, a map, a vec that starts with a symbol (an enum value: Reflector's `Asset::Stellar(addr)` is `lit([Stellar, addr])`), and so on. Taken as data, never as a selector, and not inspected. A bare address, symbol, number or vec of plain values is the same constant without the tag |
| `elem(step, ...)` | The current element of the enclosing `all`/`any`, walked by the steps; no steps is the element itself. Only a quantifier body may hold one |
| `sum(vec, step, ...)` | The sum of what the steps reach in each element of the vec `vec` resolves to: a number (`i128`), checked. It walks up to `MAX_ELEMS` elements, so it weighs that many leaves toward the leaf cap |

Nodes: `and`, `or`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `nin`, `all`,
`any`. Constants: `lit(x)`, or a bare address, symbol, number or vec (a map
only inside `lit`). Both
sides of a comparison are resolved, so any value leaf can stand on either side.

**Numbers compare as numbers.** `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in` and
`nin` treat any integer by value, whatever its type: `u32`, `i32`, `u64`,
`i64`, `i128`, `Timepoint`, `Duration`, and a `u128` that fits in an `i128`
(an integer of up to 128 bits; `u256` and `i256` are not widened and are not
numbers here). A `Timepoint` of 300, a `Duration` of 300 and a `u64` 300 are
equal.
`eq(call_arg(0), 5)` holds for a 5 of any of them, and a `u32` constant matches
an `i128` argument. A `u128` above `i128::MAX` is not a number: it fails an
ordering and a `scaled`, equals nothing numeric, and equals only an identical
`u128` (`lit` it to match one). A bool is not a number (`eq(x, lit(true))`
never matches a 1).
An ordering (`lt`, `lte`, `gt`, `gte`) over a constant that is not a number (an
address, symbol, string, bytes, bool, vec, map, an oversized `u128`), and such
a constant as a `scaled` operand, are refused at
install (201): they could never permit. Use `eq`, `ne` or `in` to match them.
Widening is top-level only: numbers inside a vector compare
exactly, type included (`lit([Amt, 5u32])` never matches an `[Amt, 5i128]`
payload, and `[u32 5]` never matches `[i128 5]`); pin a nested number with
`call_path` to the element instead. Everything else compares exactly: values
of different types are unequal, and addresses, symbols, strings, bytes, bools,
vecs and maps equal only their own kind and value (bytes, strings, vecs and maps
by the host's own compare, the rest by canonical XDR), and never equal a number. The type each
leaf yields: `call_contract` an address; `call_fn` a symbol; `call_arg`,
`call_arg_field`, `call_path` and `elem` whatever the call (or element) carries; `now` a `u64`;
`read` the value found, anything but void (an ordering or `scaled` then needs
a number, or the leaf denies); `scaled` and `sum` an `i128`; a constant what it
was written as.

`src` and `num` multiply, so a constant in either is held to the same rule:
anything made of literals alone (a literal, or a `scaled` of literals, checked at
decode; the tree keeps the `scaled` and recomputes it on every `enforce`) must
come out above zero. `-99/100` would turn a floor into a ceiling
that permits a zero output, and `0` cancels the selector. Grammar 6 had one
literal factor, `num`, so the same rule is stricter here (it also covers `src`
and nested constants); a factor that comes from the call, the clock or a read
cannot be judged at install and stays the rule author's to guard. `den` is
positive and at most `MAX_DEN` (10^18). The cap stops an `i128::MAX`-style `den`
only; it does not stop a tiny `num / den` ratio (`99 / 10^18` still floors at
zero for ordinary amounts), which the rule author has to avoid. A constant `src * num`, or a
`scaled` of constants, that overflows is refused at install rather than
installing a rule that always denies (an overflow that depends on the call's
own arguments still denies at `enforce`). Division truncates toward zero, which loosens a floor by less
than one unit (`gte(out, scaled(in, 99, 100, 0))` permits `out = 99` for
`in = 101`, a floor of 99.99) and a negative bound the other way; write an exact
bound cross-multiplied, `gte(scaled(out, 100, 1, 0), scaled(in, 99, 1, 0))`. Write a subtraction by moving the term
across the comparison (`ts >= now - 300` is `ts + 300 >= now`, which is
`gte(scaled(ts, 1, 1, 300), now)`); `add` is any value and may be a negative
literal. A negative factor can still be built from a variable (`num = scaled(call_arg(1), 1, 1, -100)`), the same class as comparing a selector with itself: install cannot tell a deliberate rule from a bad one. `in` haystacks and literal vectors hold constants only: a selector,
`read`, `scaled` or `now` in one is refused at decode, as it could never be
compared.

#### Constants, `ne`/`nin`, map keys

- **`lit(x)`** is a constant of any ScVal type, wherever a constant is allowed:
  an operand, an `in`/`nin` entry, a `read` argument, a map-key step. The
  payload is data: a vec that starts with a symbol inside `lit` is that vec, not
  a selector, and it is not inspected (decoding is one host value, whatever its
  size). A *bare* vec is its own constant too, but it is CHECKED element by
  element: every element must be a plain value or a non-empty plain vec, so a
  selector, an empty vec, a map or a `lit(..)` inside one is refused (201). A
  bare map is refused too, at any position (a map is stored as written, so a
  `lit` inside it would stay wrapped). Write `lit([...])` or `lit({...})` around
  the whole constant when it holds an enum value, a map or anything a bare vec
  cannot. `lit` takes exactly one operand. There is no
  separate enum-variant leaf: `lit([Name, payload...])` is the value.
- **`ne(a, b)`** permits only when both sides resolve and differ, by the same
  equality as `eq` (numbers by value). A side that cannot resolve (a missing
  argument, a failed or void read, a bad path, an overflow) DENIES: an
  unresolvable value is not "different". A difference of kind counts: `ne` of a
  string and a number permits. `ne` accepts `call_contract` and `call_fn` as
  `eq` does (`ne(call_contract, X)` is a one-address denylist); a miss against
  `call_contract` is `CONTRACT_SCOPE` (101), otherwise `ARG_MISMATCH` (100).
- **`nin(needle, [entries])`** permits only when the needle resolves and equals
  no entry (each compared as `ne` compares). The needle is resolved ONCE, so a
  needle that is a `read` spends one call slot however many entries there are
  (a registry-backed denylist installs), and each entry is one leaf: a 32-entry
  denylist is 33 of the 200 leaves, as for `in`. An unresolvable needle denies.
  Every `nin` miss is `ARG_MISMATCH` (100), whichever leaf the needle is
  (`in` reports `NOT_IN_ALLOWLIST`, 105). A denylist keeps only what you list:
  prefer an allowlist (`in`) wherever the permitted set is known.
- **Muxed addresses.** A SEP-41 / SAC `transfer(from, to: MuxedAddress, amount)`
  credits `M(G, id)` to `G`. So `ne` and `nin` also differ only after de-muxing
  both sides: a denylist entry `G`, or `M(G, 7)`, denies `G` and every
  `M(G, id)`. `eq` and `in` stay EXACT: a pinned `M(exchange, 12345)` matches
  that id and no other, and a plain `G` matches no muxed form of itself, so a
  muxed recipient fails an `in` allowlist of plain addresses (fail closed).
  The de-muxing applies to a value that IS an address: a muxed address inside a
  vec is not de-muxed, so `nin(arg, [[G_BAD]])` passes `[M(G_BAD, 1)]`; write the
  whole denylist over the argument the token takes (`to`), not a wrapper of it.
  And a `read` registry that takes a `MuxedAddress` and keys on it raw is
  bypassable the same way: pass the registry a plain address (a muxed one is not
  on a list of plain addresses, which fails closed).
- **No general `not`.** `ne`/`nin` need both operands to resolve, so they cannot
  turn an unresolvable leaf into a permit; `not` could, which is why it stays out.
- **Map keys.** A path step is a `u32` (index into a vec), `true` (the length,
  last only) or a constant key into a map: a bare symbol (the common case,
  and what `call_arg_field` uses) or `lit(x)` for any other key - an address, a
  number, a string. A numeric key needs `lit`, since a bare `u32` is an index
  and would never match a map; a key's type is part of it (`lit(u32 7)` and
  `lit(i128 7)` are different keys). A step that is a selector is refused (201).

`scaled` replaces grammar 6's `call_arg_scaled(i, num, den)`, which is now
`scaled(call_arg(i), num, den, 0)` (equal under every comparison, `eq` included,
since numbers compare by value). Because it resolves to a plain number, a
comparison against it is an ordinary comparison: a miss denies `ARG_MISMATCH`
(there is no separate slippage reason), and two `scaled` leaves compare with
each other. Nesting gives sums, differences, products and small integer powers:
`debt + B` is `scaled(debt, 1, 1, B)`, and `x^3` is
`scaled(x, scaled(x, x, 1, 0), 1, 0)`.

#### Quantifiers: `all`, `any`, `elem`, `sum`

A batch, a payout list or a swap route has a length the rule author does not
know in advance. Quantifiers state a property of every element, or of at least
one, without a rule per length.

- **`all(vec, P)`** permits iff `P` holds for every element of the vec `vec`
  resolves to. **`any(vec, P)`** permits iff `P` holds for at least one. `vec` is
  any leaf (usually a `call_path`; a `read` result works too) and `P` is any
  node. Inside `P`, `elem(step...)` reads from the current element (`elem()` is
  the element itself) and every other leaf means what it means outside.
- **Empty vector:** `all` of nothing PERMITS (nothing violates it) and `any` of
  nothing DENIES. Pair an `all` with `call_arg_len` or an `any` where the batch
  must be non-empty.
- **Fail-safe per element.** `vec` must resolve to a vec, or the quantifier
  denies. A vec of more than `MAX_ELEMS` (32) elements denies, `all`, `any` and
  `sum` alike, so a batch cannot be padded past what was priced. In `all`, an
  element where `P` cannot resolve (a missing field, a failed read) makes `P`
  false, and the rule denies. In `any`, an element where `P` cannot resolve
  simply does not count. Both stop at the first deciding element, and `or`
  inside `P` still runs lazily.
- **`sum(vec, step...)`** adds what the steps reach in each element (no steps:
  the elements are the numbers). Every element must resolve to a number (an
  integer of up to 128 bits), or the leaf is unresolved and the comparison
  denies; an overflow denies `ARITHMETIC_OVERFLOW` (102), and so does a quantifier
  over a `sum` that overflows. The sum of nothing is 0. It
  is a number anywhere a value is: a comparison operand, a `scaled` operand (a
  `read` argument takes only a plain leaf, below).
- **Install-time limits (all 201).** Evaluating a body costs up to `MAX_ELEMS`
  times what one evaluation costs, so decode counts EVERY leaf of a body 32 times
  toward `MAX_LEAVES` (200), and a `sum` (which walks that many elements) as 32
  leaves itself, so the leaf budget bounds the work. A body may have at most six
  leaves, an `in` entry counts as a leaf, and so does the needle (a body `in` or
  `nin` needs an allowlist of 5 or fewer: needle and 5 entries are 6 leaves; long
  per-element lists do not fit a body, and a body `read` cannot take the element,
  below). A rule holds at most six `sum`s (a `sum` with its vec is 33 leaves). A quantifier or a `sum` inside a quantifier body is refused (no
  nesting: the cost would multiply). `elem` outside a body is refused, and so is
  `elem` as the vec of its own quantifier or as a `read` argument.
- **A rule still has to constrain the call.** A quantifier over a `call_path`
  does (the path is a selector); a leaf of its body that reads the call does too.
  A quantifier over a constant or a read alone does not.
- **External calls stay at four.** A `read` in a body must not take `elem` as an
  argument, so its resolved arguments are the same for every element and the
  memo makes it once, however many elements. The cap of four distinct calls per
  rule therefore bounds the external calls per `enforce`, quantifiers
  included (see "Caps" below for the count).

- **Cost.** Measured in the Soroban host with the real wasm (CPU instructions of
  one `enforce`; the limits are 400M instructions and 41,943,040 bytes of
  memory per transaction). The four-check PayFi rule: 4.49M, 6.18 MB (4 reads).
  A 32-element payout (the rule below, 195 leaves): 4.6M. A six-leaf body over
  32 elements whose fields sit eight steps deep: 8.3M. A body that also makes
  one `read` (made once, not 32 times): 5.1M and one external call. Install
  stores the rule bytes (about 0.17 XLM of rent per KB), so a quantifier costs
  what its bytes cost, not what its length would.
- **Worst case.** `tests/worst_case.rs` installs the largest rules each audit lens
  could build into the real wasm and asserts `enforce` (and install) stay under
  both limits. The measured worst case without reads is **48M instructions
  (12% of the limit)**: a 31.8 KB bare vec constant of 7,900 elements costs 47M
  (each element is checked, about 6k instructions apiece), an `in` over 32 bare
  vecs of 246 elements 48M, and a 7,800-element bare vec as a map-key step 47M;
  then 28M for 100 compares over 8-step map-key paths and 25M for 198 leaves of
  8-step vec paths;
  quantifier bodies over a 31 KB constant cost 4-8M, and six `sum`s over 32
  elements 10M. The worst memory without reads is **1.7 MB (4% of the limit)**.
  Memory is spent only where a value is serialised to be compared, and the
  compare is not that for the values an agent can make large: two values of
  different types are unequal without it, and bytes, strings, vectors and maps
  are compared by the host in place. So six `in` over 32 addresses cost the same
  1.4 MB against a 30 KB or a 100 KB `Bytes` argument, a 100 KB string, a
  12,000-element vec or a 4,000-entry map (all in `worst_case.rs`; the old
  compare cost 0.8 MB per KB of the argument, 78 MB for 100 KB). What still
  scales with a caller's own argument is what the host spends holding and
  decoding it before `enforce` runs, and a value that serialises (an address, a
  wide number) is small. Add about 1.2 MB per distinct read (at most four): the
  worst case with four reads is about 6.5 MB (several contexts: see "Memory is
  the limit that binds"). Both fail closed.
  `worst_case.rs` also asserts that every shape INSTALLS: a refused install
  would measure 0 and pass any limit.

Notation below: a bare name is a symbol (a map key), `elem(to)` is
`[elem, to]` on the wire, and `call_path(0)` is `[call_path, 0]`.

```text
# every payout goes to an approved recipient, none is negative (so one cannot
# lower the total of another), and the total is at most 1000: 195 of 200 leaves
# (the body 5 x 32, the vec 1, the sum 32 + its vec 1 + the constant 1).
# Without the guard a -600 payment would let +1500 through (the sum is 900).
and(
  all(call_path(0), and(in(elem(to), [A, B]), gte(elem(amount), 0))),
  lte(sum(call_path(0), amount), 1000))

# an adapter batch of 1 to 32 calls: every target approved, at least one a repay
# (the execution adapter's Call has target, function_name, args and
# executor_authorizations; 162 leaves)
and(all(call_path(0), in(elem(target), [T1, T2])),
    any(call_path(0), eq(elem(function_name), repay)))

# a swap route: every hop is on the list, it starts at call_arg(0), at most 3 hops
and(all(call_path(1), in(elem(), [A, B, C])),
    eq(call_path(1, 0), call_arg(0)),
    lte(call_path(1, true), 3))
```

#### Time windows

`now` and `scaled` already express the clock; no new leaf is needed. `now` is the
ledger timestamp in seconds (UTC).

```text
day_start = scaled(scaled(now, 1, 86400, 0), 86400, 1, 0)      # floor(now / 86400) * 86400

# 09:00:00 <= time of day < 17:00:00 UTC (a half-open window)
and(gte(now, scaled(day_start, 1, 1, 32400)),
    lt(now,  scaled(day_start, 1, 1, 61200)))

# Monday to Friday: 1970-01-01 was a Thursday, so (day + 3) counts from Monday.
# There is no modulo: x mod 7 = x - 7 * floor(x / 7), and "mod <= 4" is
# moved across the comparison: x <= 7 * floor(x / 7) + 4.
x = scaled(now, 1, 86400, 3)
lte(x, scaled(scaled(x, 1, 7, 0), 7, 1, 4))
```

The windows hold at 09:00:00 and 16:59:59 and refuse at 08:59:59 and 17:00:00;
`tests/grammar7.rs` checks those four instants (and midnight and 23:59:59) on
several days, and each weekday boundary across two weeks.
The window is on the ledger clock, which validators set to within seconds of
real time, so do not rely on it to the second; a window with no selector leaf
still needs one elsewhere in the rule (a window alone is refused at install).

### Cross-contract reads

Read this before writing a rule with a `read`.

- **`enforce` performs a call into each contract a `read` names, when the
  evaluation reaches it** (`or(eq(call_fn, advance), gte(read(feed), 0))`
  permits without calling the feed, so a rule's footprint depends on the branch
  that runs). Soroban has
  no read-only call: the host runs whatever function was named, with the same
  rights as any other call. A `read` target must therefore be a contract the
  policy owner trusts, and ideally one that cannot be upgraded, because a
  target that changes behaviour changes what the rule permits and what `enforce`
  costs. The target and function are fixed in the predicate; the call being
  authorized cannot change WHICH function of WHICH contract runs, but it can
  choose the ARGUMENTS when a rule passes it through (below), so the target must
  be safe for every value of them: never read a function that calls, or prices
  from, a contract or path named by a call-derived argument (a token helper that
  asks `token.unit_value()` of the token passed in, a router's
  `get_amounts_out(path)`, a vault-of-argument converter), or the agent steers
  the read into code it chose. Bind such an argument to the exact value the
  authorised call uses, or take it from a constant. Whatever state the target changes
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
- **Arguments: constants, or taken from the call.** Each argument of a `read` is a
  constant (`lit(x)`, an address, a symbol, a number, or a bare vec of plain
  values) or a plain leaf resolved at `enforce`: a `call_path` / `call_arg`, `call_contract`,
  `call_fn` or `now`. A `scaled`, another `read`, a `sum` or an `elem` as an
  argument is refused at install (201). The contract and function are always
  fixed fields. An argument that cannot be resolved (no such call argument)
  makes the read unresolved, without making the call, and the leaf denies.
  The motivating use is a registry the rule consults, so a list can change
  without reinstalling the rule: `eq(read(REGISTRY, contains, [call_arg(1)]),
  lit(true))` permits only a receiver that is on the registry's list (a muxed
  receiver is not a plain address, so it is not on a list of plain addresses:
  fail closed). A Soroban enum value is the vec `[name, payload...]`, and a bare
  vec that begins with a symbol is read as a selector, so an enum value is
  written with `lit`: Reflector's `lastprice(Asset::Stellar(addr))` takes
  `lit([Stellar, addr])`. A `read`
  whose only link to the call is an argument of its own counts as constraining
  the call; one whose arguments are constants or `now` does not.
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
- **A read result is any value but void.** `eq`, `ne`, `in` and `nin` compare a
  bool, an address, a symbol, a string, bytes, a vec or a map as they compare
  anything (`eq(read(...), lit(true))`); an ordering and `scaled` still need a
  number (anything else denies).
- **Failure denies.** A read that panics, hits a missing function or contract,
  returns void, or finds no field at `path` resolves to
  nothing, and the comparison denies (`ARG_MISMATCH`). That includes `eq` and
  `ne`: two failed reads are never "equal" and never "different". An argument that
  gets the wrong type (a number for an address parameter) is a failed call, and a
  failed call is remembered like any other. As the needle of an `in`, every failure
  (a failed read, a missing argument, an overflow) denies `NOT_IN_ALLOWLIST`
  (105) instead: a needle that cannot be resolved cannot be on the allowlist.
- **Caps, enforced at decode.** At most four DISTINCT `read` calls per
  predicate. With constant arguments a call is `(contract, fn, args)`: reads that
  differ only in `path` are one call, and `enforce` makes it once and reuses the
  result for every leaf (a failed call is remembered too, so each leaf that
  uses it denies). So one price feed read for a floor, an LTV and a freshness
  bound is one call, and the full PayFi set (feed, debt, collateral, custody
  balance) is exactly four. A read with ANY call-derived argument (a call path,
  `call_contract`, `call_fn`, `now`) counts as its own call at decode, even if
  two such leaves would resolve to the same arguments: decode cannot know
  that. At `enforce` the memo is keyed by the RESOLVED
  `(contract, fn, args)`, so two such leaves that do resolve alike make one
  call. **At most four external calls per `enforce`**: a leaf's arguments
  depend only on the call and the clock, which do not change during an
  `enforce`, so each counted call has one resolved key and is made at most
  once; and a read in a quantifier body cannot take the element as an argument
  (it is refused), so the 32 iterations of a body resolve it identically and
  share that one call. Reads count inside `scaled` and inside quantifiers too; the fifth distinct call is refused at install as
  `MALFORMED_PREDICATE`, every decoder cap surfaces as 201, except the byte cap at install, which is 207),
  `read` paths and `call_path`s of at most eight steps, and leaf nesting
  (`scaled` operands, bare vec elements, `read` arguments, `sum` sources) of at
  most `MAX_DEPTH` (5) levels. The 200-leaf cap counts `scaled` operands,
  `read` arguments, `sum` sources and `in`/`nin` needles and entries, each leaf of a
  quantifier body 32 times (`MAX_ELEMS`) and each `sum` as 32. A constant
  (`lit`, or a bare vec) is ONE leaf whatever its size: its size is bounded by the
  32 KB byte cap, and the work it costs is made proportional to its bytes, not to
  how often it is compared (a vec or a map is compared by the host without
  copying it, so a 31 KB constant in a quantifier body is not re-serialised per
  element). `tests/worst_case.rs` runs the largest rules every audit found on
  the real wasm against the 400M-instruction and 41,943,040-byte limits.
  Each distinct `read` runs at most once per `enforce`.
- **A rule still has to constrain the call.** `install` refuses a predicate with
  no leaf over the authorized call (`call_contract`, `call_fn`, `call_arg*`,
  `call_path`), seen through `scaled`, `sum`, `read` arguments, quantifier vecs
  and bodies. `now` and a `read` of constants do not
  count, so a rule made only of those is refused
  (`SELECTOR_LEAF_REQUIRED`). `elem` does not count either. The check is that one such leaf exists somewhere,
  as before; it does not prove every branch of an `or` constrains the call.
- **Simulate with real signatures.** A read's ledger entries are part of the
  transaction's footprint. A simulation that skips authorization may not reach
  `enforce`, and so not the reads, and the submitted transaction then fails on
  a footprint it did not declare. Simulate the signed transaction, and remember
  that which reads run depends on which branch of an `or` permits.
- **Cost.** Each read is a contract call inside the account's authorization
  check and spends the transaction's budget; a slow or heavy target makes every
  call it guards slow or heavy.
- **Memory is the limit that binds.** Each distinct read instantiates the target
  in its own VM, about 1.2 MB of the transaction's 40 MiB memory whatever the
  target's size, and the memo is per `enforce`, so the same read in two contexts
  runs twice. Measured through the OpenZeppelin account: the four-read PayFi
  rule costs about 6.2 MB, a `__check_auth` that authorises N such contexts
  costs about 7.5 MB for one and 6.2 MB more for each further one, and the
  seventh breaks the limit (44.7 MB). Plan for at most about five read-rule
  contexts in one transaction, fewer when the authorised calls themselves run in
  the same budget (an adapter `execute` batch whose inner calls each hit a read
  rule). The transaction aborts with `Budget ExceededLimit`, so it fails closed;
  a batch that passes with two calls can fail with six. CPU is not the limit: the
  PayFi rule is about 5.5M of the 400M instruction budget (1.4%).
- **An agent can trap its own call.** An argument is the agent's to size, and a
  transaction up to the network's size limit (about 132 KB) can carry one that
  uses most of the memory budget in the host before `enforce` (or anything else)
  runs. The transaction then aborts with `Budget ExceededLimit`: it fails closed
  and costs only the agent's own call, since the memory is its own argument's.
  No rule makes this worse, and no rule can prevent it.
- **Limits the host decides, not the contract.** A predicate nested deeper than
  about 47 levels cannot be parsed: the host's XDR reader traps
  (`Error(Context, InvalidAction)`) before `install` sees it, so the failure is
  a trap rather than a contract code. A `read` whose target or storage is
  outside the transaction's footprint aborts the whole transaction with a
  storage `ExceededLimit` that no rule can catch (not even inside an `or`), which
  is why you simulate the signed transaction. The builder that emits predicates
  must warn about both, and about the memory figure above. It must also refuse
  as a rule's scope any known policy contract address (the pinned grammar-6 and
  grammar-7 interpreters, OZ policies), which the contract does not. Those checks
  are off-chain and belong to the TypeScript side (the M3 gate). A claimable-balance
  or liquidity-pool address anywhere in a predicate also traps in the host's XDR
  reader (`Error(Context, InvalidAction)`) rather than returning 201.
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
  the divide, the add) denies `ARITHMETIC_OVERFLOW` (`NOT_IN_ALLOWLIST` inside an
  `in` needle); it never wraps. A `den`
  of zero or less or above `MAX_DEN`, or a constant `src` or `num` that folds to zero or less, is refused at install
  as `MALFORMED_PREDICATE`, and the
  evaluator still refuses to divide by zero if that gate ever regresses.

The grammar carries only what a policy needs and no more. `not` is absent by
design: it inverts a deny into a permit, so a leaf the evaluator could not
resolve - a missing argument index, an operand of the wrong type, a failed
read - would come back as PERMIT rather than as the deny everything else in the
grammar produces. In a deny-by-default evaluator that is the one construct that
can turn the default inside out. `ne` and `nin` are the negations that stay
safe: both operands must resolve before either permits, so an unresolvable leaf
still denies.

`or` carries no such hazard - an unresolvable leaf still denies its own branch -
and it is what lets one rule permit either of two token pairs. Its children are
canonically sorted like `and`'s by the encoder (the contract does not check the
order, and evaluates in wire order), so authoring order is not preserved; an
empty `or`, `and` or literal vector is refused at install. When every
branch denies, the reported reason is the first branch's in wire order.

Deliberately absent, because the interpreter sees one authorized call and no
history (`read` shows it a contract's state, not the transaction's moves): what a
transaction actually moved (`amount`), rolling per-window spend totals and
call-frequency caps. Rolling spend caps and approval thresholds belong to the
OpenZeppelin account layer, not here. A cap on value is expressed instead
against the call's own amount argument (`call_arg(i) <= limit`). Expiry IS
expressible: `now` is the ledger clock, so `lte(now, T)` beside a selector
permits until `T` and denies (`ARG_MISMATCH`) after it, and the context rule's
own `valid_until` is the account-level alternative. The synthesiser reports each
of the absent ones as uncovered rather than emitting a constraint that would
never bind.

Retired deny codes: `107` (`SLIPPAGE_FLOOR`) and `214`
(`INVALID_SCALED_RATIO`) are not emitted by grammar 7 and are not reused. New in
grammar 7: `219` (`SIGNER_IS_INTERPRETER`); `218` also covers a rule scoped to
the account or the interpreter, not only `Default`. The constructs above add no
code. A `nin` miss is `ARG_MISMATCH` (100) whatever its needle; a quantifier that
denies is `ARG_MISMATCH` (100) whatever its body reported (an `in` miss, a
`call_contract` miss and an overflow inside a body all read 100), except that
a failure resolving the quantifier's own vector keeps its code (102 for a `sum`
that overflows); a `sum` overflow is `ARITHMETIC_OVERFLOW` (102); every decode
refusal is 201.

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
