---
name: oz-policy-builder
description: Drive the policy-builder MCP server to turn an intent into an on-chain policy on an OpenZeppelin smart account on Stellar. Covers the install flow, the interpreter checks, and the failure modes that look like success.
user-invocable: true
when_to_use: "Invoke when working with the policy-builder MCP server: recording a Soroban transaction, synthesizing or verifying a policy, installing or revoking a context rule on an OZ smart account, or diagnosing an install failure (#100, #202, #209, #218, #3002, #3221)."
category: other
keywords: [stellar, soroban, mcp, policy, openzeppelin, smart-account, predicate, interpreter, context-rule, credio, oz]
argument-hint: "[smart-account-address]"
---

# policy-builder MCP - operating manual

Which tool to call for which intent, and what the answer means. This server
holds no key material: everything it produces is an unsigned transaction for a
wallet to sign.

## Setup

Register the server with your MCP client:

```json
{ "mcpServers": { "policy-builder": {
  "command": "npx", "args": ["-y", "@crediolabs/policy-builder-mcp"] } } }
```

From a checkout of this repository, point at the built server instead:
`node packages/policy-builder-mcp/dist/bin/server.js`. Run
`get_interpreter_info` with `verifyLive: true` first - it reports whether the
deployed interpreter matches the pin, which is the one check worth doing before
you build anything.

## Intent -> tool

Seven tools: `record_transaction`, `synthesize_policy`, `simulate_policy`,
`verify_policy`, `install_policy`, `revoke_policy`, `get_interpreter_info`.
Every verdict from `simulate_policy` and `verify_policy` is the interpreter's own
`check` (a dry run that always fails with its verdict), so it is what the contract would do, with its deny code.

| User intent | Call |
| --- | --- |
| Cap a key, built from a transaction they point at | `synthesize_policy` with `hash` (or `xdr`). Its `ambiguities` ask for the cap: answer with `limit` (every amount) or `limits` (`{ "amount": "..." }`, by argument name or position). Then `verify_policy` with the same source, then `install_policy` with that source, `signers` and the same answers |
| State a constraint outright, with no transaction | `synthesize_policy` with an `intent`: `{ calls: [{ contract, fn, where: [constraints] }] }`; each constraint is `{ "constraint": "cap", "at": [2], "max": "100" }`, the `constraint` key naming one of `pin`, `not`, `allow`, `deny`, `cap`, `floor`, `length`, `minOut`, `each`, `some`, `total`, `read`, `until` or `from` (not a `rule` key); `at` is a path into the arguments (`[2]` the third argument, `[3, 0, "amount"]` the `amount` of the first element of the fourth) |
| A mandate with parameters | `synthesize_policy` with `template: { name: "adapter_batch" \| "blend_venue", params }` |
| Check a policy before installing it | `verify_policy` with `encodedPredicate` (or `expr`) and the call that must be permitted (`call`, or `hash`/`xdr`) |
| Ask what one call would do | `simulate_policy`: the predicate and `calls` |
| Remove a rule | `revoke_policy` with `ruleId` |
| Check the interpreter the rule will point at | `get_interpreter_info` with `verifyLive: true`. `install_policy` does it for you before building |
| "at least N out" - a slippage floor on a swap | `minOut` constraint: `{ constraint: "minOut", at: [1], of: [0], num, den }` bounds the output argument against the call's own input (`out >= in * num / den`), so one rule covers every trade size. Never infer the ratio from a recording: a recorded rate is a price at one moment, and freezing it as policy denies ordinary trades later. Ask for it. A `read` rule can bound a price from an oracle, and `until`/`from` bound the clock; `enforce` calls the contracts a rule reads, so those must be trusted ones |
| Every element of a batch or payout | `each` (every element satisfies the rules), `some` (at least one does), `total` (a field's sum is at most `max`), `length` (at most `max` elements). One rule covers any length up to 32, instead of a rule per element |
| "N per day" - a rolling total | `install_policy` with `spendingLimit: { amount, periodLedgers }`. It attaches an OpenZeppelin `spending_limit` beside the predicate on the same rule; both must permit. NOT expressible as a predicate - the interpreter sees one call and keeps no state - so a per-call cap alone lets N through repeatedly. `periodLedgers` counts LEDGERS (~5s each); the rule must be scoped to the token contract whose transfers it meters |

Pass handles rather than retyping structures: a `hash` for a recording,
`encodedPredicate` for a predicate you already hold. Predicates and call
arguments are JSON in the contract's own shape: a node is a tagged list
(`["lte", ["call_arg", 2], {"i128": "100"}]`), a symbol or address is a string, a
`u32` a number, and every other type a one-key object (`{"i128": "5"}`,
`{"u64": "5"}`, `{"bytes": "ab"}`, `{"string": "x"}`, `{"map": [[k, v]]}`).
Amounts in a rule are decimal STRINGS. The validation error names the failing
path: read it as "this field is the wrong type".

## The failure modes that look like success

Each of these installs cleanly, verifies cleanly, and enforces less than the
user thinks. They are the reason to read a result rather than skim it.

- **A rule with no policy constrains nothing.** The caller picks which rule
  authorises a call, so any signer on an unpoliced rule routes around every
  policed rule it also sits on.

- **Adding a rule never tightens a key - it widens it.** A key on several rules
  is only as limited as the loosest one that matches. When a user asks to lower
  an existing limit, installing a second rule does the opposite of what they
  asked. `install_policy` reads the account and REFUSES when a shared signer could name
  a looser or unpoliced rule instead, or one it cannot read or judge (an interpreter of
  another grammar, a rule with only a spending limit); `authorityScan.overlaps` lists
  every rule the key could name, with `severity: review` only for readable rules under
  different conditions, which need a human.
  Read it before telling anyone they are protected.

- **Attaching a policy makes a rule any-of-N.** Unpoliced, ALL of a rule's
  signers must authorise. Policed, ANY ONE can act alone. So adding a second
  signer for "two approvals" gives the opposite. The exception is an
  approval-threshold policy, which is what restores m-of-n.

- **The constrained key must not sit on rule 0.** Rule 0 is unpoliced by
  construction, so a policy on a rule-0 signer installs cleanly and constrains
  nothing. Put the agent key on a new rule and constrain that.

- **A per-call cap is not a budget.** `limit` lets that amount through
  repeatedly, forever. When the user means a total, pass `spendingLimit` as well
  - and if you install only the per-call bound, say which control they got.

- **`verify_policy: ok` is not "this does what you asked".** Its deny cases are
  derived from the predicate's own constraints, so a MISSING constraint produces
  no test that could fail. **`ok` without `complete: true` does not prove every limit**: `untested` lists what nothing was
  tried against (a swap's spend cap can sit there while `ok` is true), so read `complete`, and
  treat anything `untested` as unchecked. It means the interpreter agrees the predicate permits
  the call and refuses each way of breaking each constraint, not that it
  expresses the intent. `ok` also needs every branch of an `or` (nested ones included, which
  have no case of their own and make it not `ok`) to have been taken by a
  call you gave (`unexamined` lists the ones nothing took: pass `calls`, one per branch, or a
  recording). `untested` lists conjuncts nothing was tried against (a read, the clock). 
  `minimal: false` lists conjuncts that were not needed, which means an exact duplicate
  and nothing else: a conjunct whose case another conjunct also refuses (a spend cap
  beside a floor derived from the same amount) is `untested`, not redundant.

- **A call that moves tokens needs a rule for the MOVEMENT too, and that rule is
  where the bypass hides.** When a venue PULLS the asset, the account is asked to
  authorise two contexts: the venue call, and a `transfer` from the account to
  the venue. A Blend supply is `pool.submit` plus `SAC.transfer`; a DEX swap is
  `router.swap_*` plus `SAC.transfer`. Cover only the venue and nothing matches
  the transfer, so the account refuses the whole call with `#3014` - identically
  for the call you wanted and the call you meant to block, which reads like a
  policy denial and is not one. Install a rule per context and pass every rule
  id.

  **A key already on an unpoliced rule cannot be tightened by adding a rule.**
  The account resolves a call against the rule the caller NAMES and takes the
  MAXIMUM authority over the rules that key sits on, never the intersection. So
  if the key also sits on a rule with no policy, it names that one and your
  predicate never runs. `install_policy` refuses this - it reads the account and
  fails with the rule id to fix. Fix it at the source: remove the shared signer
  from that rule, or attach a policy to it. Do NOT reach for
  `allowOverlap: true` to make the error go away; it installs
  a rule that constrains nothing. A neighbour whose policy the tool cannot read or judge
  (an interpreter of another grammar, a rule with only a spending limit or another
  policy) is refused too, and so is any neighbour that permits something the new rule
  forbids; only a tighter readable one is listed for review.

  **Pin the transfer arm as tightly as the venue arm.** A transfer rule that
  bounds only the amount lets the key send the treasury ANYWHERE up to that
  amount, which is a worse permission than the one being granted. Pin the
  destination to the venue as well. A withdraw is the other way round - the
  venue is the sender, so it needs only one rule.

  **Two rules means two installs, ONE AT A TIME.** Each is its own transaction
  binding its own sequence number, so building both up front and handing over
  two files does not work: the first submission consumes the sequence number and
  the second is refused with `TxBadSeq`, after the user has already signed it.
  Build the first, let it be signed and submitted, confirm it landed, and only
  then build the second. See "Installing" below - the pre-build warning applies
  here, and this is the case where it is easiest to forget.

  **READ the destination off the venue; never derive it by reasoning.** The
  destination is a pool or pair contract, and its address is data the venue
  holds, not something you can work out from the token addresses. Guessing
  produces a well-formed `C...` string that simply is not deployed, and the only
  symptom is `Storage, MissingValue` on a call that looks correct - which is
  slow and expensive to diagnose. Ask the venue:

  ```
  # SoroSwap: the factory maps a token pair to its pool contract
  stellar contract invoke --network testnet --id <FACTORY> --send=no \
    -- get_pair --token_a <TOKEN_A> --token_b <TOKEN_B>
  ```

  Testnet SoroSwap factory `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY`,
  router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`. Other venues
  expose the same shape under a different name. If the venue cannot tell you the
  address, say so and stop - do not install a rule pinned to an address you
  cannot verify is real.

## Amounts

- **SAC assets are 7 decimals on Stellar, including USDC.** USDC is 6
  elsewhere, which makes a cap written at 6 decimals a 10x mistake that still
  passes a boundary check. Read decimals on chain and quote both forms back
  ("2 USDC = 20000000") so the user can check the basis.
- **A bare ticker is not a token.** A SAC address derives from the asset code
  AND its issuer, and anyone can issue an asset called USDC. Never produce an
  address you cannot derive; say you cannot.
- **`limit` is in the smallest unit.** Convert explicitly and say what
  you converted.

## What the server refuses, and why

- **A rule that governs no key.** Synthesis leaves the signer set empty - it
  reads a transaction, and which keys a rule binds is a security decision no
  recording answers. Name them in `signers` as plain `G...` addresses. A
  delegated signer is an account, not a deployed contract. `admins` (default:
  `sourceAccount`) are the Policy Signer role that may later re-install or remove
  the rule; keep them apart from `signers`, the keys the rule restricts.
- **A rule that cannot bind a shared signer** (see above): an unpoliced neighbour,
  a looser or equal interpreter rule, one without a spend cap when a rolling
  total is asked for, or one the scan cannot read or judge. `allowOverlap: true` overrides, and so does nothing that
  makes the rule bind. An account whose rules cannot all be read is refused too.
- **Removing rule 0 or a Default-scoped rule.** `revoke_policy` reads the rule and returns it
  as `removes`; these two can leave the account unable to administer itself, for good, so
  they need `allowAdminRule: true`.
- **A rolling total on a rule that is not scoped to one contract.**
- **A rule that bounds no amount, when the call carries one.** Answer the
  question with `limit` / `limits`, or `allowUnboundedAmount: true` to do it
  deliberately: such a rule installs and verifies cleanly and caps nothing.
- **A swap whose least output nothing sets.** `amount_out_min` left open permits a trade at
  any price. Declare a `minOut` ratio (or a `floor`) on it in an intent, or set
  `allowOpenSlippage: true` to do it deliberately. A tiny floor (1 stroop, or a `minOut` of 1/10^18) counts as answering the question: the tool cannot judge a price, so the author must choose a real one.
- **A rule scoped to a policy contract or to the account itself.** It would expose
  that contract's admin calls.
- **An interpreter that is not a trusted build**: its live grammar and code hash
  must be one the package lists (`INTERPRETER_WASM`), whatever address you name.
  Mainnet has no grammar-7 interpreter yet: name one with `interpreterAddress`; it
  is accepted only if it runs a trusted build.
- **An endpoint or a directory as input.** Neither is a tool argument: the RPC
  endpoint (`POLICY_BUILDER_RPC_URL_<NETWORK>`) and the output directory
  (`POLICY_BUILDER_OUT_DIR`) are the operator's; `outFile` is only a name inside it.

`installNonce` defaults to 1 and you should not ask the user for it. This tool
builds `add_context_rule`, the account assigns a NEW rule id, and the
interpreter has no stored nonce for a rule that does not exist yet.

## Installing

One signed transaction installs the rule AND turns the predicate on: the smart
account calls the interpreter's `install` itself while running
`add_context_rule`. Do not tell the caller a second call is outstanding. The
rule id the account assigned is in the transaction result.

**Pass `outFile` and let the server write the envelope.** This is the only
reliable way to get it onto disk. Give `install_policy` a file NAME (no directory):
the server writes it into the directory the operator configured
(`POLICY_BUILDER_OUT_DIR`), creates it fresh (an existing file is never
overwritten), reads it back to confirm it persisted intact, and returns
`writtenTo`. Hand that path to the signer. With no directory configured the input
is refused.

Do NOT carry the envelope yourself. It runs to several thousand characters, and
moving it through your own output - or through a shell argument - corrupts it.
Observed repeatedly: silent truncation, and files of exactly the right length
whose bytes no longer parse (`xdr padding contains non-zero bytes`). Both look
like a malformed TRANSACTION at the signer rather than a malformed FILE, which
sends you debugging the wrong thing. Hashing what you wrote does not help unless
you compare it to `unsignedXdrSha256` from the same response.

**Write it exactly as returned: base64 text, one line, nothing else.** Wallets
and `stellar tx sign` read base64, not raw XDR bytes. Do not "helpfully" decode
it to binary, wrap it in JSON, or line-wrap it - each of those produces a file
that looks written and fails at the signer as
`failed to decode XDR: xdr value invalid`, which reads like a malformed
transaction rather than a malformed FILE. Then check it before handing it over:
its length must equal `unsignedXdrLength` and its SHA-256 must equal
`unsignedXdrSha256` from the same response. If either differs, write it again -
do not ask the user to sign it.

One host-function invocation per Soroban transaction, so a multi-step sequence
is one signature per step. Do not pre-build step 2: the XDR binds a sequence
number and a validity window of roughly eight minutes.

## Error codes

From the interpreter (`contracts/prime/stellar/policy-interpreter/src/storage.rs`):

| Code | Name | Means |
| --- | --- | --- |
| `#100` | `ArgMismatch` | An argument bound was not satisfied - an over-cap amount lands here. The cap working |
| `#101` | `ContractScope` | The call went to a contract the predicate does not pin |
| `#105` | `NotInAllowlist` | The recipient is not on the allowlist |
| `#102` | `ArithmeticOverflow` | A `scaled` step overflowed `i128` (the multiply, the divide or the add) |
| `#103` | `UnsupportedNode` | An ordering over `call_contract` or `call_fn` |
| `#200` | `VersionMismatch` | The package speaks grammar 7 |
| `#201` | `MalformedPredicate` | The decoder refused the predicate (unknown operator, arity, a cap) |
| `#207` | `PredicateTooLarge` | Over 32 KB |
| `#216` | `SelectorLeafRequired` | No leaf reads the call: the rule would constrain nothing |
| `#218` | `DefaultContextNotSupported` | A Default-scoped rule, or one scoped to the account or the interpreter |
| `#219` | `SignerIsInterpreter` | A signer set holds the interpreter's own address |
| `#202` | `NonceReplay` | `install_nonce` must equal `stored_nonce + 1` |
| `#204` | `RuleSignersChanged` | The signer set changed since install. The interpreter stored a hash of it and denies rather than quietly meaning less - the rule stops working, which is the safe direction |
| `#208` | `PredicateHashMismatch` | The blob does not match the hash installed beside it |
| `#209` | `EmptySignerSet` | The rule governs no key |

From the OpenZeppelin account layer, not this interpreter:

| Code | Means |
| --- | --- |
| `#3002` | The signer is not authorised on the rule named |
| `#3014` | A context the call produced matched no rule you named. Usually the token `transfer` a swap performs, when only the venue was covered. Add the missing rule and pass every rule id |
| `#3221` | An OpenZeppelin `spending_limit` was exceeded |

A failed simulation surfaces the contract error code; act on the code, not on
the sentence around it.
