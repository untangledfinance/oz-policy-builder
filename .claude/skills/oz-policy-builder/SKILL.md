---
name: oz-policy-builder
description: Drive the policy-builder MCP server (2.x, grammar 7) to turn an intent into an on-chain policy on an OpenZeppelin smart account on Stellar. Covers the install flow, the interpreter checks, the install guardrails, and the failure modes that look like success.
user-invocable: true
when_to_use: "Invoke when working with the policy-builder MCP server: recording a Soroban transaction, synthesizing or verifying a policy, installing or revoking a context rule on an OZ smart account, explaining an account's rules, or diagnosing an install failure (READ_UNSAFE, INSTALL_BUILD_FAILED, #100, #201, #202, #207, #209, #218, #3002, #3014, #3221)."
category: other
keywords: [stellar, soroban, mcp, policy, openzeppelin, smart-account, predicate, interpreter, context-rule, credio, oz]
argument-hint: "[smart-account-address]"
---

# policy-builder MCP: operating manual

Which tool to call for which intent, and how to read what it returns. The server
holds no key material: everything it produces is an unsigned transaction for a
wallet to sign.

## Setup

Register version 2 (`@next`, grammar 7). Plain `@crediolabs/policy-builder-mcp`
resolves npm's `latest`, which is still 1.3.0 and speaks grammar 4.

```json
{ "mcpServers": { "policy-builder": {
  "command": "npx", "args": ["-y", "@crediolabs/policy-builder-mcp@next"],
  "env": { "POLICY_BUILDER_OUT_DIR": "/absolute/dir/for/envelopes" } } } }
```

From a checkout of this repository, build the packages and run
`node packages/policy-builder-mcp/dist/bin/server.js`.

Only the operator sets the environment. No tool input can set any of these:

| Variable | Effect |
| --- | --- |
| `POLICY_BUILDER_RPC_URL_TESTNET`, `POLICY_BUILDER_RPC_URL_MAINNET` | The RPC endpoint (https, or http on loopback). Default: the network's public endpoint |
| `POLICY_BUILDER_OUT_DIR` | Absolute directory that `outFile` writes into. Unset, `outFile` is refused |
| `POLICY_BUILDER_SAFE_READS_TESTNET`, `POLICY_BUILDER_SAFE_READS_MAINNET` | Extra `read` targets to trust, as `C…:function,C…:function`. One bad entry refuses the whole value |
| `POLICY_BUILDER_ALLOW_SPOT_READS=1` | Lets an install carry any `read`, safe-listed or not |

If the user asks you to trust a read target or allow spot reads, tell them it is
the operator's setting. Do not look for a tool argument that does it.

## The interpreter and its limits

Testnet has one pinned grammar-7 interpreter, `CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT`.
Any other `interpreterAddress` on testnet is refused (`INTERPRETER_MISMATCH`).
Mainnet has no grammar-7 pin: every mainnet call that reaches an interpreter
must pass `interpreterAddress`, and it is accepted only if its live code hash is
a build the package trusts (`trustedWasmSha256` in `get_interpreter_info`).

Limits are per instance. Each interpreter is deployed with its own `limits`,
which never change; a different limit is a new instance at a new address.

| Field | Floor | Ceiling | Testnet pin |
| --- | --- | --- | --- |
| `max_reads` (distinct `read` calls) | 1 | 8 | 8 |
| `max_leaves` (weighted leaves) | 4 | 400 | 400 |
| `max_predicate_bytes` | 256 | 40,960 | 24,576 |
| `max_elems` (elements a quantifier or `total` visits) | 2 | 64 | 32 |
| `max_in_operands` (`allow`/`deny` entries) | 1 | 64 | 32 |
| `max_depth` | 2 | 8 | 5 |

A body leaf of `each`/`some` and every `total` count `max_elems` times toward
`max_leaves`, so a per-element rule must stay short. `get_interpreter_info`
returns the instance's `limits` and the `ceilings`.

## What needs the network

| Call | Without RPC |
| --- | --- |
| `synthesize_policy` from an `intent`, `template` or `recording` | Works. It holds the rules to the pin's live limits, or to the limits recorded for the pin if the RPC does not answer within 5 s (on a network with no pin, to the package defaults). `heldTo` says which. Contract and argument names are read best-effort (within 2 s, display only); unread, the review says "argument N" |
| `synthesize_policy` or `record_transaction` from a `hash` | Needs RPC to fetch the transaction. An `xdr` source decodes locally |
| `get_interpreter_info` on testnet, without `verifyLive` | Works. `limitsFrom` is `live` or `recorded` |
| `install_policy`, `verify_policy`, `simulate_policy` with calls, `explainAccount` | Need RPC and the live interpreter: they read its `limits()` and refuse a build the package does not trust |
| `revoke_policy` | Needs RPC (it reads the rule and the account's code); no interpreter check |
| `verifyLive` | Needs RPC; reports `live.matches` (false for an untrusted build or another grammar) instead of refusing. It still refuses an address other than the pin on a pinned network (`INTERPRETER_MISMATCH`) and an address that is not a wasm contract |
| `simulate_policy` with only a predicate (explain) | Held to the limits of the given or pinned interpreter, read live, so testnet needs RPC. With no interpreter (mainnet without `interpreterAddress`) it is held to the ceilings and works offline. `heldTo` says which |

## Intent -> tool

Seven tools: `record_transaction`, `synthesize_policy`, `simulate_policy`,
`verify_policy`, `install_policy`, `revoke_policy`, `get_interpreter_info`.
Every verdict from `simulate_policy` and `verify_policy` is the interpreter's own
`check` (a dry run that always fails with its verdict), so it is what the
contract would do, with its deny code.

| User intent | Call |
| --- | --- |
| Cap a key, built from a transaction they point at | `synthesize_policy` with `hash` (or `xdr`). Its `ambiguities` ask for the cap: answer with `limit` (every amount) or `limits` (`{ "amount": "..." }`, by argument name or position), and `allow` (`{ "to": ["G…"] }`) for an allowlist. Then `verify_policy` with the same source, then `install_policy` with that source, `signers` and the same answers |
| State a constraint outright, with no transaction | `synthesize_policy` with an `intent`: `{ calls: [{ contract, fn, where: [constraints] }] }`. A constraint is `{ "constraint": "cap", "at": [2], "max": "100" }`; the `constraint` key takes one of `pin`, `not`, `allow`, `deny`, `cap`, `floor`, `length`, `minOut`, `each`, `some`, `total`, `read`, `until`, `from`. `at` is a path into the arguments (`[2]` the third argument, `[3, 0, "amount"]` the `amount` of the first element of the fourth) |
| A mandate with parameters | `synthesize_policy` with `template: { name: "adapter_batch" \| "blend_venue", params }` |
| Check a policy before installing it | `verify_policy` with `encodedPredicate` (or `expr`) and the call that must be permitted (`call`, or `calls` one per `or` branch, or `hash`/`xdr`) |
| Ask what one call would do | `simulate_policy`: the predicate and `calls` |
| Explain a predicate | `simulate_policy` with only `expr` or `encodedPredicate` |
| Show what an account already allows | `get_interpreter_info` with `explainAccount: "<C… smart account>"`. It reads every rule and reviews each one this interpreter polices. Only a known OpenZeppelin account build (`91a2cd56…`) is read; any other account is refused |
| Remove a rule | `revoke_policy` with `ruleId` |
| Check the interpreter | `get_interpreter_info` with `verifyLive: true`: `live.matches` says whether the deployed code is a trusted grammar-7 build. `install_policy` checks it again before building |
| "at least N out": a slippage floor on a swap | `minOut`: `{ constraint: "minOut", at: [1], of: [0], num, den }` bounds the output argument against the call's own input (`out >= in * num / den`), so one rule covers every trade size. Ask the user for the ratio. A recorded rate is a price at one moment, and freezing it as policy denies ordinary trades later |
| A price or balance check | `read` calls a fixed function of a fixed contract at enforce time. The install refuses it with `READ_UNSAFE` unless the target is on the safe list (below) |
| Every element of a batch or payout | `each` (every element satisfies the rules), `some` (at least one does), `total` (a field's sum is at most `max`), `length` (at most `max` elements). One rule covers any length up to the instance's `max_elems` (32 on the testnet pin); a longer vector denies |
| "N per day": a rolling total | `install_policy` with `spendingLimit: { amount, periodLedgers }`. It attaches OpenZeppelin's `spending_limit` beside the predicate on the same rule; both must permit. A predicate cannot express it (the interpreter sees one call and keeps no state), so a per-call cap alone lets N through again and again. `periodLedgers` counts LEDGERS (about 5 s each). See the guard below |
| "M of these N keys must approve" | `install_policy` with `threshold: { simple: m }`, or `{ weighted: { weights: { "<address>": w }, n } }` for weights that must total at least n |

## Reading a result

Every tool that returns a rule includes `review` (box-drawn text) and
`reviewTree` (nodes `{ label, op, value, raw, index?, children? }`, `raw` the
wire value each came from). It sits in `rules[n]` for `synthesize_policy`, at the
top level for `simulate_policy` and `verify_policy`, in `rule` for
`install_policy`, in `removes` for `revoke_policy` (on an account build the package does not
know, `reviewSkipped` says why there is none), and in `account.rules[n]`
for `explainAccount`.

- **The text is injective:** two rules that differ never read alike. Constants
  carry their type where needed (symbols `'quoted'`, strings `"quoted"`,
  `5 (u256)`, numbers in a vector typed, bytes `0x..`). A path step says `[0]` for
  an index, and a field is `the item › x`.
- **Addresses are shortened** to 6 + 6 characters. Pass `raw: true` for full
  addresses, raw values and the wire index of each name. Quote the full address
  to the user before they sign.
- **`[role]` marks are the package's own names:** `[smart account]`,
  `[source account]`, `[admin]` and `[signer]` from the request, `[interpreter]`
  and `[spending limit]` for the pinned addresses.
- **`«label»` marks are the request's words:** the keys of `allow`. A label is
  plain words (a letter, then up to 23 letters, digits, spaces, `_`, `.` or `-`),
  so it cannot hold a bracket and pass for a role. A role wins over a label on
  the same address.
- **A read off the safe list** reads "(live value, movable within one
  transaction)".

`install_policy`'s review opens with an **Authority** header. Its first line is
the `legend` (`[…] the package's roles; «…» labels given in the request`), then
one `signer` line per signer (`contract` before a C-address, with its weight
under a weighted threshold), `to act` (who acts alone, or how many must
approve), `admins`, `expires` ("never expires" or "valid through ledger N"),
`total` (the rolling limit, or "no total limit: each call may move up to its own
cap") and `interpreter` with its limits. Read the header back to the user
before they sign. Only `install_policy`'s review has it; the reviews from
`revoke_policy` and `explainAccount` show the predicate alone.

`install_policy` also returns `authority`
(`{ signers, threshold, admins, validUntil, total, interpreter, limits }`, the
facts the header renders), `authorityScan` (`{ complete, overlaps[] }`),
`interpreter` (the live fingerprint), `unsignedXdr` with `unsignedXdrLength` and
`unsignedXdrSha256`, `authValidUntilLedger`, and `writtenTo` when `outFile` was
set.

Pass handles in place of retyped structures: a `hash` for a recording,
`encodedPredicate` for a predicate you already hold. Predicates and call
arguments are JSON in the contract's own shape: a node is a tagged list
(`["lte", ["call_arg", 2], {"i128": "100"}]`), a symbol or address is a string, a
`u32` a number, and every other type a one-key object (`{"i128": "5"}`,
`{"u64": "5"}`, `{"bytes": "ab"}`, `{"string": "x"}`, `{"map": [[k, v]]}`).
Amounts in a rule are decimal STRINGS. A validation error gives the failing
path: read it as "this field is the wrong type". An unknown key is refused.

## The failure modes that look like success

Each of these installs cleanly, verifies cleanly, and enforces less than the
user thinks. Read every result in full.

- **A rule with no policy constrains nothing:** the caller picks which rule
  authorises a call, so any signer on an unpoliced rule routes around every
  policed rule it also sits on.

- **Adding a rule never tightens a key; it widens it:** a key on several rules
  is only as limited as the loosest one that matches. When a user asks to lower
  an existing limit, installing a second rule does the opposite of what they
  asked. See "Authority overlap" below.

- **Attaching a policy makes a rule any-of-N:** unpoliced, ALL of a rule's
  signers must authorise. With any policy attached (the interpreter included),
  ANY ONE can act alone. `install_policy` refuses several `signers` with no
  `threshold` for this reason. Ask the user how many must approve and pass
  `threshold`; pass `anyOne: true` only when they say one signer alone is
  intended.

- **The constrained key must not sit on rule 0:** rule 0 is unpoliced by
  construction, so a policy on a rule-0 signer installs cleanly and constrains
  nothing. Put the agent key on a new rule and constrain that.

- **A per-call cap is no budget:** `limit` lets that amount through again and
  again, forever. When the user means a total, pass `spendingLimit` as well. If
  you install only the per-call bound, say which control they got.

- **`verify_policy: ok` only says the interpreter agrees with the predicate:**
  its deny cases are derived from the predicate's own constraints, so a
  constraint the user wanted and the predicate lacks produces no test that could
  fail. `ok` without `complete: true` leaves limits unproven: `untested` lists
  the conjuncts nothing was tried against (a read, the clock, or a swap's spend
  cap beside a floor on the same amount), so read `complete` and treat anything
  `untested` as unchecked. `ok` also needs every branch of an `or` (nested ones
  included) taken by a call you gave; `unexamined` lists the branches nothing
  took, so pass `calls`, one per branch, or a recording. `minimal: false` means
  `redundant` lists exact duplicate conjuncts, and nothing else goes there.

- **A call that moves tokens needs a rule for the MOVEMENT too, and that rule
  is where the bypass hides:** when a venue PULLS the asset, the account is asked
  to authorise two contexts: the venue call, and a `transfer` from the account to
  the venue. A Blend supply is `pool.submit` plus `SAC.transfer`; a DEX swap is
  `router.swap_*` plus `SAC.transfer`. Cover only the venue and the account
  refuses the whole call with `#3014`, identically for the call you wanted and
  the call you meant to block. That reads like a policy denial and is an
  incomplete set of rules. Install a rule per context and pass one rule id per
  context.

  **Pin the transfer arm as tightly as the venue arm:** a transfer rule that
  bounds only the amount lets the key send the treasury ANYWHERE up to that
  amount, a worse permission than the one being granted. Pin the destination to
  the venue as well. A withdrawal is the other way round: the venue is the
  sender, so it needs only one rule.

  **Two rules means two installs, ONE AT A TIME:** each is its own transaction
  binding its own sequence number. Built together, the first submission consumes
  the sequence number and the second is refused with `TxBadSeq`, after the user
  has already signed it. Build the first, let it be signed and submitted,
  confirm it succeeded, and only then build the second.

  **READ the destination off the venue; never derive it by reasoning:** the
  destination is a pool or pair contract, and its address is data the venue
  holds. It cannot be worked out from the token addresses. A guess produces a
  well-formed `C...` string with no contract behind it, and the only symptom is
  `Storage, MissingValue` on a call that looks correct. Ask the venue:

  ```
  # SoroSwap: the factory maps a token pair to its pool contract
  stellar contract invoke --network testnet --id <FACTORY> --send=no \
    -- get_pair --token_a <TOKEN_A> --token_b <TOKEN_B>
  ```

  Testnet SoroSwap factory `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY`,
  router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`. Other venues
  expose the same shape under another function name. If the venue cannot give
  you the address, say so and stop. Install no rule pinned to an address you
  cannot show is deployed.

## Amounts

- **SAC assets are 7 decimals on Stellar, including USDC:** USDC is 6
  elsewhere, so a cap written at 6 decimals is a 10x mistake that still passes a
  boundary check. Read decimals on chain and quote both forms back
  ("2 USDC = 20000000") so the user can check the basis.
- **A bare ticker identifies no token:** a SAC address derives from the asset
  code AND its issuer, and anyone can issue an asset called USDC. Produce only
  addresses you can derive; otherwise say you cannot.
- **`limit` is in the smallest unit:** convert explicitly and say what you
  converted.

## What the server refuses, and why

`install_policy` refuses with `INSTALL_BUILD_FAILED` unless a code is given here.

- **A rule that governs no key:** synthesis leaves the signer set empty. It
  reads a transaction, and which keys a rule binds is a security decision for the
  user. Pass them in `signers` (G… or C…, up to 15, each installed as a delegated
  signer). The package does not check a C… signer's code, so use one only
  when the user vouches for it. `admins` (default: `sourceAccount`) are the
  Policy Signer role that may later re-install or remove the rule; keep them
  apart from `signers`, the keys the rule restricts. `sourceAccount` must be a
  signer of the account's rule 0.
- **Threshold:** several `signers` and no `threshold`, or a threshold one signer
  meets alone (`{ simple: 1 }`, or one weight of at least n), make the rule 1-of-n and are
  refused unless `anyOne: true`. Also refused: a signer listed twice, a threshold
  that can never be met (n above the signers, or weights that do not cover
  exactly the signers or total less than n), and `anyOne` beside a threshold
  that needs more than one.
- **Spending-limit guard:** `spendingLimit` is refused unless every branch of the
  predicate pins `call_fn` to `transfer` (OpenZeppelin's `spending_limit` fails
  every other function, so those calls would always be refused), and unless the
  rule's contract is shown to be a token (a Stellar Asset Contract, or
  `transfer(from, to, amount: i128)` in its spec). The token check reads the
  spec; on a slow network, retry.
- **Read safety (`READ_UNSAFE`):** a `read` of a target and function outside the
  safe list. The list holds the three testnet Reflector oracles (`lastprice`,
  `price`) and the operator's `POLICY_BUILDER_SAFE_READS_<NETWORK>` entries;
  mainnet has none built in. A listed read must take constant arguments. Any
  other read is a live value the agent can move within the same transaction,
  just before the call the rule judges. Only the operator's
  `POLICY_BUILDER_ALLOW_SPOT_READS=1` lets it through.
- **Authority overlap:** the install reads every live rule on the account (its
  `NextId`, then each id below it that still holds a rule) and judges each one
  that shares a signer and some of the same calls. It refuses when that rule has
  no policy, permits calls the new rule forbids (the shared signer names it
  instead and the new rule never runs), lacks the rolling total the new rule
  adds (with `spendingLimit`, any overlapping neighbour is refused, capped or
  not, since a cap is per rule), or cannot be judged (its predicate is
  unreadable, it is policed by an interpreter other than the one the new rule
  uses, of any grammar, or it carries only other policies). It also refuses
  when the account's rules could not all be read (`authorityScan.complete:
  false`: an absent or malformed `NextId`, a count that disagrees, or more than
  512 ids handed out). `authorityScan.overlaps` lists every rule the key could pick;
  `severity: review` marks one that is provably tighter on the shared calls,
  listed for information. Fix the cause: remove the shared signer from that
  rule, or attach a policy to it.
- **An amount with no cap:** answer the question with `limit` / `limits`. Such a
  rule would install, verify cleanly and cap nothing.
- **A swap whose least output nothing sets:** `amount_out_min` left open permits
  a trade at any price. Declare a `minOut` ratio (or a `floor`) on it in an
  intent. A tiny floor (1 stroop, or a `minOut` of 1/10^18) counts as an answer:
  the tool cannot judge a price, so the author must choose a real one.
- **Removing rule 0, a Default-scoped rule, or a rule scoped to the account
  itself** (`REVOKE_BUILD_FAILED`): `revoke_policy` reads the rule and returns it
  as `removes`; removing one of these can lock the account out of its own
  administration for good.
- **A rule scoped to a policy contract or to the account itself:** it would
  expose that contract's admin calls. No override.
- **An interpreter outside the trusted builds** (`INTERPRETER_MISMATCH`): its
  live grammar and code hash must be ones the package lists, whatever address
  you pass.
- **An endpoint or a directory as input:** neither is a tool argument.
  `outFile` is only a file name inside `POLICY_BUILDER_OUT_DIR`.

**Overrides belong to the user:** `allowOverlap`, `allowUnboundedAmount` and
`allowOpenSlippage` on `install_policy`, and `allowAdminRule` on
`revoke_policy`, turn the matching refusal off. A refusal message tells you
which flag to set. Set one only after the user has read the refusal and decided,
and tell them in your reply that you set it: the response does not echo
overrides, so the review and the returned XDR carry no sign of one. Never set
`allowOverlap` to make an overlap error go away; it installs a rule that
constrains nothing.

`installNonce` defaults to 1; do not ask the user for it. The tool builds
`add_context_rule`, the account assigns a NEW rule id, and the interpreter holds
no nonce for a rule that does not exist yet.

## Installing

One signed transaction installs the rule AND turns the predicate on: the smart
account calls the interpreter's `install` itself while running
`add_context_rule`. No second call is outstanding. The rule id the account
assigned is in the transaction result.

**Pass `outFile` and let the server write the envelope:** this is the one
reliable way to get it onto disk. Give `install_policy` a file NAME (no
directory): the server writes it into `POLICY_BUILDER_OUT_DIR`, creates it fresh
(an existing file is never overwritten), reads it back to confirm it persisted
intact, and returns `writtenTo`. Hand that path to the signer.

Do NOT carry the envelope yourself. It runs to several thousand characters, and
moving it through your own output or a shell argument corrupts it. Observed
repeatedly: silent truncation, and files of exactly the right length whose bytes
no longer parse (`xdr padding contains non-zero bytes`). Both look like a
malformed TRANSACTION at the signer, which sends you debugging the wrong thing.
Hashing what you wrote helps only if you compare it with `unsignedXdrSha256`
from the same response.

**If you must write it, write it exactly as returned:** base64 text, one line,
nothing else. Wallets and `stellar tx sign` read base64. Decoding it to binary,
wrapping it in JSON or line-wrapping it each produce a file that looks written
and fails at the signer as `failed to decode XDR: xdr value invalid`. Then check
it before handing it over: its length must equal `unsignedXdrLength` and its
SHA-256 must equal `unsignedXdrSha256`. If either differs, write it again; do
not ask the user to sign it.

Soroban allows one host-function invocation per transaction, so a multi-step
sequence is one signature per step. Do not pre-build step 2: the XDR binds a
sequence number, and the account's authorisation in it lapses at
`authValidUntilLedger`, 300 ledgers (about 25 minutes) after it was built.

## Error codes

From the interpreter (`contracts/prime/stellar/policy-interpreter/src/storage.rs`):

| Code | Name | Means |
| --- | --- | --- |
| `#100` | `ArgMismatch` | An argument bound was not satisfied. An over-cap amount fails here: the cap working |
| `#101` | `ContractScope` | The call went to a contract the predicate does not pin |
| `#102` | `ArithmeticOverflow` | A `scaled` step overflowed `i128` (the multiply, the divide or the add) |
| `#103` | `UnsupportedNode` | An ordering over `call_contract` or `call_fn` |
| `#105` | `NotInAllowlist` | The value is not on the allowlist |
| `#200` | `VersionMismatch` | The install parameters carry a grammar other than the interpreter's |
| `#201` | `MalformedPredicate` | The decoder refused the predicate: an unknown operator, the arity, or one of the instance's limits (leaves, depth, reads, elements, `in` entries) |
| `#202` | `NonceReplay` | `install_nonce` must equal `stored_nonce + 1` |
| `#204` | `RuleSignersChanged` | The signer set changed since install. The interpreter stored a hash of it and denies: the rule stops working, the safe direction |
| `#207` | `PredicateTooLarge` | The predicate is over the instance's `max_predicate_bytes` (24,576 bytes on the testnet pin), checked before any parse |
| `#208` | `PredicateHashMismatch` | The blob does not match the hash installed beside it |
| `#209` | `EmptySignerSet` | The rule governs no key |
| `#216` | `SelectorLeafRequired` | No leaf reads the call: the rule would constrain nothing |
| `#218` | `DefaultContextNotSupported` | A Default-scoped rule, or one scoped to the account or the interpreter |
| `#219` | `SignerIsInterpreter` | A signer set holds the interpreter's own address |

From the OpenZeppelin account layer (outside this interpreter):

| Code | Name | Means |
| --- | --- | --- |
| `#3002` | `UnvalidatedContext` | The rule id passed for a context does not validate it, for example the pool rule passed for the token `transfer` |
| `#3014` | `ContextRuleIdsLengthMismatch` | The call passed a different number of rule ids than it has contexts. Usually the token `transfer` a venue call performs, when only the venue was covered: install the rule for it and pass one id per context |
| `#3221` | `SpendingLimitExceeded` | An OpenZeppelin `spending_limit` refused the amount over its period |

A failed simulation surfaces the contract error code. Act on the code; the
sentence around it can mislead.
