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
| "N per day" - a rolling total | Not expressible as a predicate. The interpreter is handed ONE call and keeps no state. A rolling total is an OpenZeppelin `spending_limit` policy on the same rule, which this server does not install. Say which control the user is actually getting |

Pass both handle forms rather than retyping structures: `transactionHash` for a
recording, `encodedPredicate` for a predicate you already hold. Retyping a
nested payload loses field types, and the call then fails on a payload the
server had already built correctly.

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
  repeatedly, forever. Never let it stand in for "N per day" without saying so.

- **`verify_policy: ok` is not "this does what you asked".** It generates deny
  cases only for the dimensions the predicate actually bounds, so a MISSING
  constraint produces no test that could fail. It means the predicate is
  internally consistent, not that it expresses the intent.

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

The unsigned XDR runs to several thousand characters. Hand over the path to a
file, never the value re-typed through a model - re-emitting truncates it and
the signer then fails with `XDR Read Error: invalid padding`.

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
| `#3221` | An OpenZeppelin `spending_limit` was exceeded |

A failed simulation surfaces the contract error code; act on the code, not on
the sentence around it.
