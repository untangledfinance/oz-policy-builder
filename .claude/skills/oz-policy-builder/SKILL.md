---
name: oz-policy-builder
description: Drive the policy-builder MCP server to turn an intent into an on-chain policy on an OpenZeppelin smart account on Stellar. Covers the install flow, the read-only checks, and the failure modes that look like success.
user-invocable: true
when_to_use: "Invoke when working with the policy-builder MCP server: recording a Soroban transaction, synthesizing or verifying a policy, installing or revoking a context rule on an OZ smart account, or diagnosing an install failure (#100, #202, #209, #3002, #3221)."
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

| User intent | Call |
| --- | --- |
| Cap a key, built from a transaction they point at | `record_transaction` (hash), then `verify_policy`, then `install_policy` with `fromHash: { transactionHash, signers: ["G..."], userResponses: { limitAmount } }` |
| State a constraint outright, with no transaction to record | `declare_policy` (method to pin, optionally contract, per-call cap, recipient allowlist, minimum-output ratio), then `install_policy` with `fromPredicate: { encodedPredicate, signers }` |
| Check a policy before installing it | `verify_policy` with `transactionHash` + `smartAccount`, or with `encodedPredicate` for a policy you already hold |
| Ask what one call would do | `simulate_policy`, same inputs as verify |
| Remove a rule | `revoke_policy` with `ruleId`. Master-only: the source must be the master signer set |
| Check the interpreter the rule will point at | `get_interpreter_info` with `verifyLive: true` |
| "at least N out" - a slippage floor on a swap | `declare_policy` with a minimum-output ratio. It bounds the call's OUTPUT against its own INPUT (`out >= in * num / den`), which is what lets one rule cover every trade size. Never infer the ratio from a recording: a recorded rate is a price at one moment, and freezing it as policy denies ordinary trades later. Ask for the ratio |
| "N per day" - a rolling total | `install_policy` with `spendingLimit: { amount, periodLedgers }`. It attaches an OpenZeppelin `spending_limit` beside the predicate on the same rule; both must permit. NOT expressible as a predicate - the interpreter sees one call and keeps no state - so a per-call cap alone lets N through repeatedly. `periodLedgers` counts LEDGERS (~5s each); the rule must be scoped to the token contract whose transfers it meters |

Pass both handle forms rather than retyping structures: `transactionHash` for a
recording, `encodedPredicate` for a predicate you already hold. Retyping a
nested payload loses field types, and the call then fails on a payload the
server had already built correctly.

When you must hand-build a `permitTx` (checking a call that has not happened),
these are the shapes that get mistyped. Every numeric value is a STRING, and
every list is a real array:

```jsonc
{ "type": "i128",   "value": "100000000" }   // NOT 100000000
{ "type": "u64",    "value": "1735689600" }  // NOT a number
{ "type": "vec",    "value": [ /* ScVals */ ] }  // NOT { "item": [...] }
{ "subInvocations": [] }                     // NOT ""
```

The validation error names the failing path but not the expected shape, so read
it as "this field is the wrong TYPE" and check it against the list above rather
than guessing a new nesting.

## The failure modes that look like success

Each of these installs cleanly, verifies cleanly, and enforces less than the
user thinks. They are the reason to read a result rather than skim it.

- **A rule with no policy constrains nothing.** The caller picks which rule
  authorises a call, so any signer on an unpoliced rule routes around every
  policed rule it also sits on.

- **Adding a rule never tightens a key - it widens it.** A key on several rules
  is only as limited as the loosest one that matches. When a user asks to lower
  an existing limit, installing a second rule does the opposite of what they
  asked. `install_policy` returns an `authorityScan` naming every rule the key
  could name instead; `severity: not-restricting` means the new rule is dead
  code. Read it before telling anyone they are protected. `authorityScan: null`
  means NOT CHECKED, never "nothing found".

- **Attaching a policy makes a rule any-of-N.** Unpoliced, ALL of a rule's
  signers must authorise. Policed, ANY ONE can act alone. So adding a second
  signer for "two approvals" gives the opposite. The exception is an
  approval-threshold policy, which is what restores m-of-n.

- **The constrained key must not sit on rule 0.** Rule 0 is unpoliced by
  construction, so a policy on a rule-0 signer installs cleanly and constrains
  nothing. Put the agent key on a new rule and constrain that.

- **A per-call cap is not a budget.** `limitAmount` lets that amount through
  repeatedly, forever. When the user means a total, pass `spendingLimit` as well
  - and if you install only the per-call bound, say which control they got.

- **`verify_policy: ok` is not "this does what you asked".** It generates deny
  cases only for the dimensions the predicate actually bounds, so a MISSING
  constraint produces no test that could fail. It means the predicate is
  internally consistent, not that it expresses the intent.

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
  predicate never runs. `install_policy` refuses this now - it reads the account,
  proves the bypass and fails with the rule id to fix. Fix it at the source:
  remove the shared signer from that rule, or attach a policy to it. Do NOT
  reach for `allowAuthorityOverlap: true` to make the error go away; it installs
  a rule that constrains nothing. A neighbour whose policy the tool cannot decode
  is only reported, not refused - read that advice by hand.

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
- **`limitAmount` is in the smallest unit.** Convert explicitly and say what
  you converted.

## What the server refuses, and why

- **A rule that governs no key.** Synthesis leaves the signer set empty - it
  reads a transaction, and which keys a rule binds is a security decision no
  recording answers. Name them in `signers` as plain `G...` addresses. A
  delegated signer is an account, not a deployed contract; nothing needs
  deploying to name one.
- **A rolling total on a rule that is not scoped to one contract.** The
  primitive meters transfers of a single token; on a wider scope it would
  install and meter nothing.
- **A rule that bounds no amount, when the recording showed a spend.** Supply
  `userResponses.limitAmount`, or `allowUnboundedAmount: true` to do it
  deliberately. This refusal exists because the failure is silent: such a rule
  installs and verifies cleanly and caps nothing.
- **An interpreter that is not the pinned one.** Default-deny; an interpreter
  the caller controls can permit anything.
- **A non-pinned RPC URL.** The auth nonce in the response comes from whichever
  RPC answered.

`installNonce` defaults to 1 and you should not ask the user for it. This tool
builds `add_context_rule`, the account assigns a NEW rule id, and the
interpreter has no stored nonce for a rule that does not exist yet.

## Installing

One signed transaction installs the rule AND turns the predicate on: the smart
account calls the interpreter's `install` itself while running
`add_context_rule`. Do not tell the caller a second call is outstanding. The
rule id the account assigned is in the transaction result.

**Pass `outPath` and let the server write the envelope.** This is the only
reliable way to get it onto disk. Give `install_policy` an absolute path; it
writes the file, reads it back to confirm it persisted intact, and returns
`writtenTo`. Hand that path to the signer.

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

From the interpreter (`contracts/policy-interpreter/src/storage.rs`):

| Code | Name | Means |
| --- | --- | --- |
| `#100` | `ArgMismatch` | An argument bound was not satisfied - an over-cap amount lands here. The cap working |
| `#101` | `ContractScope` | The call went to a contract the predicate does not pin |
| `#105` | `NotInAllowlist` | The recipient is not on the allowlist |
| `#107` | `SlippageFloor` | Output fell below `in * num / den` |
| `#200` | `VersionMismatch` | The package pins grammar 4 |
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
