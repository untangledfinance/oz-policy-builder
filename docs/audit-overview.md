# Audit overview

Prime keeps an institution's funds in its own custody on Stellar and lets an
agent move part of them under rules the account's owners install. The Prime
account is an OpenZeppelin smart account. Each of its rules delegates the
per-call decision to the policy interpreter, a contract that evaluates a
predicate stored as data. A custody gate and an execution adapter let the
agent draw custody's funds only to listed addresses.

This repository holds three components: the on-chain contracts, the off-chain
policy synthesiser that writes the rules, and the CLI and MCP wrappers around
it. Every size below was measured on this tree.

## Components and size

| Component | Path | Language | sLOC | Tests | Audit scope |
|---|---|---|---|---|---|
| Policy interpreter | `contracts/stellar/policy-interpreter/src` | Rust, soroban-sdk 27.0.2 | 881 | 440 (173 unit, 267 in 15 suites, of which the 18 conformance cases also run in release), 26 against OpenZeppelin's 0.8.0 account | in |
| Execution adapter | `contracts/stellar/execution-adapter/src` | Rust | 277 | 67 | in |
| Custody gate | `contracts/stellar/custody-gate/src` | Rust | 53 | 3 | in |
| Prime seat | `contracts/stellar/prime-seat/src` | Rust | 97 | 21 | in |
| Policy synthesiser, `@crediolabs/policy-synth` | `packages/policy-synth/src` | TypeScript | 4,646 | 25 test files | in |
| CLI, `@crediolabs/policy-builder-cli` | `packages/policy-builder-cli/src`, `bin` | TypeScript | 76 | 1 test file | in |
| MCP server, `@crediolabs/policy-builder-mcp` | `packages/policy-builder-mcp/src`, `bin` | TypeScript | 133 | 3 test files | in |
| `test-blend-pool` | `contracts/stellar/test-blend-pool/src` | Rust | 22 | none | out: a Blend-shaped stub for tests |

sLOC counts the non-blank, non-comment lines of the formatted source (`rustfmt`,
`biome format`; CI checks both), with test files and `#[cfg(test)]` module
declarations left out. To reproduce:

```sh
# from the repository root; a contract (here the interpreter):
( cd contracts/stellar/policy-interpreter &&
  ls src/*.rs | grep -v -E '/(tests?|dsl_tests|dsl_ext_tests)\.rs$' | xargs cat \
  | grep -v -E '^\s*(//|$)|^\s*#\[cfg\(test\)\]$|^\s*mod (tests?|dsl_tests|dsl_ext_tests);$' | wc -l )
# the synthesiser:
( cd packages/policy-synth &&
  find src -name '*.ts' ! -name '*.test.ts' | xargs cat | grep -v -E '^\s*(//|/\*|\*|$)' | wc -l )
# a wrapper (here the CLI; the MCP server the same way):
( cd packages/policy-builder-cli &&
  find src bin -name '*.ts' ! -name '*.test.ts' | xargs cat | grep -v -E '^\s*(//|/\*|\*|$)' | wc -l )
```

## In scope and out of scope

**In scope (the code submitted for audit):** this repository at tag `v5.1.0`, the
current release: the `src/` of the
interpreter, the adapter, the gate and the Prime seat
(`contracts/stellar/prime-seat/src`), test modules excluded; the `src/` of
`policy-synth`; and the `src/` and `bin/` of the CLI and the MCP server. The
same package code is published to npm at version 5.1.0 as
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp`.

**Out of scope, each with what Prime assumes of it:**

| Part | Assumption |
|---|---|
| OpenZeppelin smart account and its `simple_threshold`, `weighted_threshold` and `spending_limit` policies | third-party code. It selects the rule a call cites, authenticates the rule's signers, calls each policy's `enforce`, and refuses to leave a rule with no signer and no policy |
| Soroban host and RPC | the host builds each authorisation context from what was really called, and refuses re-entry into a contract already on the stack |
| Custody account | a classic Stellar account whose own signers and thresholds decide what it approves |
| Owners' wallets and the owner key of a Prime seat | sign only what their holder means to sign. A seat's owner key raw-signs the 32-byte grant hash; a NEAR-routed MPC holds it in the reference integration |
| The Prime app (separate repository) | builds transactions and refuses dangerous rule shapes before any wallet signs; an extra control, never one the contracts rely on |
| `scripts/`, `deployments/`, `evidence/`, fixtures | deployment and test tooling |

## What the contracts enforce

**Policy interpreter:** `enforce` fails closed. An undecodable predicate, an
unknown node or a selector the call cannot answer denies with a specific code.
`install` checks the grammar version, the byte cap, the predicate's hash, the
scope (no `Default` rule, none scoped to the account or the interpreter) and
the signer sets, and stores a hash of the rule's signers that `enforce`
compares on every call (204). Each instance fixes its limits at deployment,
and a predicate can call contracts it names through `read`.

**Keyless rules bound to an executor:** a rule may list no signer and be bound
to an execution adapter with `bind_executor`. No key signs under it; the
binding and the predicate carry its authority.

- `enforce` accepts a call with no authenticated signer only when the rule lists
  no signer, the interpreter is its only policy and a binding exists (else 210).
- A bound rule needs the adapter's own authorisation of the exact account and
  context. The one exception is the adapter's `run` under a rule scoped to
  that adapter: only the adapter's code can ask the account for that context.
  An `execute` or a `cancel` still needs a grant from the adapter.
- A rule scoped to its bound adapter must pin, on every path, `call_fn == run`
  or an immediate `execute` of a fixed batch: `call_fn == execute`, a wait of
  0, the number of calls, and each call's target and function name.
  `bind_executor` checks it against the scope `install` recorded, a re-install
  checks it under a kept binding, and `enforce` checks it again against the
  rule OpenZeppelin passes, which no install argument can misstate (221).
- OpenZeppelin's `remove_policy` refuses to leave a rule with no signer and no
  policy (3004), so a keyless rule with one policy keeps its predicate.
- OpenZeppelin's 0.8.0 account refuses a delegated signer that is also a
  contract called in the operation (3017). A rule signed by the adapter fails
  that check at first use. A keyless rule lists no signer, so a stored batch
  still runs with no key.

**Custody gate:** pays only addresses on the list fixed at construction, only
when its one caller asks, and only while that caller runs the approved build.
No admin, no setter, no upgrade.

**Execution adapter, with a gate:** checks every call target, every call
argument at any depth (strkey, raw-key and address-XDR spellings compared;
muxed M-strkeys refused), every executor authorization and every batch grant --
including nested sub-invocations -- against one list: the gate's allowed
addresses plus the gate. A batch naming an address the gate does not list is
refused; grants are NOT refused wholesale -- a grant whose addresses are all
listed is accepted (the Prime's own payout legitimately carries grants), and
deploy-type entries are refused (`Uncheckable`). The walk is ABI-blind, so a
256-bit value could carry 32 key bytes and pass (a limit noted in the source).
A batch can wait; the adapter's address commits to the gate and both wait
numbers, and only the gate's custody can `rebind` it.

> **Gated-adapter residual (E-36 analogue; auditor, please confirm).** A keyed
> rule on a gated adapter whose predicate leaves its call list open could, like
> finding H-1 on a no-gate adapter, let a keyed holder vouch a keyless inner
> rule beyond its root pin. The containment here is NOT grant refusal: it is the
> root pins on the full call list and the grants count, exact-context grants (a
> smuggled grant is inert when no pinned call asks for that context), and the
> gate's address list. An independent 27/27 on-chain PoC found no such path in
> the Prime rule set. A `policy-synth` check that warns on a keyed execute rule
> bound to a gated adapter without a pinned call count, targets and functions is
> a planned follow-up.

**Execution adapter, with no gate:** checks no address, so the Prime can
bundle its own calls atomically. The flow is narrow:

- every batch runs at once: a wait or a `min_wait` above 0 is refused
  (`NoWait`), nothing is stored, and `run` finds nothing (`NotScheduled`);
- the adapter hands a callee no authorisation (`Uncheckable`). In an immediate
  `execute` it accepts one kind of grant, its word to the Prime's policy:
  `enforce(prime, context)` on a contract the batch names, for its own Prime,
  with nothing nested; anything else is refused (`Uncheckable`). To each
  contract named it adds the same word for the `execute` it is running. It
  hands them out just before it asks the Prime, and the host keeps them for
  that one approval, each matched once;
- so a rule bound to the adapter passes for a context the batch names, and a
  keyless rule scoped to the adapter passes for its `execute` only if its
  predicate pins the whole batch shape (221): this is how anyone can run a
  liquidation the Prime's keyless rules permit;
- a batch with no grants hands out nothing, so keyed rules (the agent's, or the
  owners' rule 0) work as before: the agent needs one rule for `execute` and
  one for each token it moves, each with its own cap. A keyed batch that
  carries words now passes the adapter, and the Prime's rules decide;
- **invariant (STRIDE E-36, High; residual Medium with the mitigations):** no
  keyed rule scoped to a no-gate adapter may omit `call_arg_len(1) == 0` (no
  words). Without that pin, an agent's door rule plus one word lets the agent
  cite the account's keyless inner rules (each bounds one call; the
  liquidation's cross-call guards are in the root rule, which the agent never
  cites) and move every balance they cover. Preferred: a dedicated no-gate
  adapter for keyless rules, its own `run_window` and so its own address, with
  no keyed rule scoped to it. `policy-synth` refuses the dangerous
  configuration; nothing on chain does, because the interpreter sees one rule
  at a time;
- with no address list, those predicates are the whole constraint. Pin each
  recipient (`eq` or `in` on the destination argument), bind a payer to the
  receiver across calls, and bound each amount from both sides. Send the
  adapter no funds and no allowance.

A custody gate never pays a no-gate adapter: the gate pins its caller's
address and build, and custody derives that address from the gate itself.

> **Known finding H-1 (reviewer, accepted).** STRIDE E-36, High; residual
> Medium with the containment below. See
> [stride-threat-model.md](../evidence/stride-threat-model.md), section 6.7
> and the E-36 row in section 8.
>
> - **The scenario.** An account runs keyless liquidation rules bound to a
>   no-gate adapter N. It also gives an agent a keyed rule that permits
>   `N.execute` without pinning the number of grants to 0
>   (`call_arg_len(1) == 0`). The agent can then put one word,
>   `enforce(prime, context)`, in its batch. That word vouches for a keyless
>   INNER rule (an asset transfer out of the account, say) outside any
>   liquidation, and the agent moves the whole balance that rule covers. The
>   inner rules each bound one call only. The liquidation's cross-call guards
>   (payer equal to receiver, amounts tied to the debt, fresh prices) live in
>   the pinned ROOT rule, and the agent's batch never cites it. The reviewer
>   confirmed this on the real wasms against OpenZeppelin's 0.8.0 account, and
>   `oz08/tests/nogate.rs` (`e36_…`) keeps it as a regression test with both
>   mitigations. This is the class of hole OpenZeppelin 0.8's 3017 closed for
>   rules signed by the adapter. The no-gate word reopens it for an account
>   that lets a keyed rule approve the same adapter its keyless rules are
>   bound to.
> - **Why it is not a contract guard.** The interpreter evaluates one rule at
>   a time. It never sees the account's other rules. At install it also cannot
>   tell whether the executor a rule is bound to is a gated or a no-gate
>   adapter. A contract-level refusal would therefore have to refuse keyed or
>   keyless rules on every executor, which breaks legitimate gated designs.
>   The adapter cannot tell a keyed caller from a keyless one either: it only
>   sees the account's approval.
> - **Containment, accepted by the team:**
>   1. *Operational.* Use a DEDICATED no-gate adapter for the keyless rules.
>      It gets its own `run_window`, so its own address. No rule of any kind
>      approves its `execute` except the keyless liquidation rules: no keyed
>      rule scoped to it, no Default-scoped keyed rule, no plain OpenZeppelin
>      rule. The owners' rule 0 is the one Default rule an account has, and
>      its quorum already holds full authority over the account. The
>      interpreter refuses to install on a Default-scoped rule (218), so no
>      Default rule carries a predicate. Agents' keyed rules go on another
>      adapter. The keyless rules' binding never accepts that adapter's word,
>      and the regression test shows the refusal.
>   2. *Tooling.* `policy-synth` hard-refuses the dangerous configuration,
>      with no override: a keyed rule scoped to a no-gate adapter that does
>      not hold the grants to none on every branch, and a keyless rule bound
>      to a no-gate adapter while such a keyed rule is scoped to it. It also
>      refuses when the account's rules cannot all be read. Default-scoped
>      and plain OpenZeppelin rules are not inspected there; they are part of
>      the operational invariant.
>   3. *Documentation.* This note and the STRIDE entry.
> - **Ask to the auditor.** Please confirm:
>   - (a) The Soroban host keeps an invoker contract grant
>     (`authorize_as_current_contract`) only for the invoker's next sub-call,
>     here the account's single `__check_auth` for this `execute`. Each entry
>     matches once. While that authorisation tree is active, the host refuses
>     a second, disjoint entry for the same account. Together these make the
>     words ephemeral and confine every request of the account in the batch to
>     that one approval.
>   - (b) The dedicated-adapter invariant above, with `policy-synth`'s
>     refusal, is sufficient containment for H-1.

> **Known finding E-38 (trust assumption, accepted).** STRIDE E-38, Medium.
> See [stride-threat-model.md](../evidence/stride-threat-model.md), section 6.8,
> the testnet proof in section 7.2, and the E-38 row in section 8. The contracts
> are unchanged between `v5.0.0` and `v5.1.0`; `v5.1.0` adds only the
> `policy-synth` warning and this note.
>
> - **The pattern.** A rule of account B may follow another rule `(A, id)`
>   instead of carrying a predicate of its own (a referenced, or "shared",
>   rule). B reads A's predicate live at `enforce`; only the predicate is
>   shared, and A changes it by A's own normal two-party re-install, with no
>   action by B. This is deliberate: an issuer A governs a borrower B's fence
>   and can tighten or loosen it without B re-signing.
> - **The assumption.** When B's following rule is **keyless** and bound to an
>   adapter with no gate, that predicate is B's *entire* fence. A alone can
>   widen it (A's master set, A's account, no re-consent from B), and anyone who
>   then satisfies it moves B's funds through B's no-gate adapter. The shape pin
>   (`221`) holds only the call targets and functions, not the amounts, so a
>   loosened value bound takes effect for a stranger at once. Demonstrated on
>   testnet (section 7.2, E38-1 to E38-4): a stranger with no key of B's moves
>   5 XLM under A's cap, is refused 20 XLM over it, and moves 20 XLM once A
>   widens the cap, with B idle throughout.
> - **Why it is not a bug, and not a contract guard.** This is the intended
>   issuer-governed-keyless design. The interpreter evaluates one rule at a time
>   and cannot tell a keyless follower from a keyed one at A's legitimate
>   re-install; refusing it would break the pattern. A **keyed** follower is
>   unaffected: its own signer still authorises every `enforce`.
> - **Containment, accepted by the team:** (1) `policy-synth` raises an E-38
>   warning (not a refusal) whenever a keyless rule follows another rule, at
>   `install_policy`, `bind_policy` and in the review, naming the followed rule
>   and its admins (PR #60, release `v5.1.0`); (2) this note and the STRIDE
>   entry. A borrower who wants A to only *tighten* the fence keeps the rule
>   **keyed**.
> - **Ask to the auditor.** Please confirm that live predicate propagation to a
>   keyless follower, with the followed owner able to loosen the fence, is an
>   acceptable trust assumption for the issuer-governed-keyless use, given the
>   warning and that a keyed follower is safe.


**Prime seat:** one seat serves one account and one owner key, both fixed at
construction. No admin, no setter, no upgrade. The owner key signs only grants
and ends. A grant needs `start <= now <= end`, at most 604,800 seconds, and an
end later than the stored one. An end stores 0 for the key, which refuses every
later grant for it while the entry lives. The entry sits in temporary storage
at the maximum TTL, about 180 days; once it expires, a grant the owner signed
for that key can be valid again (STRIDE D-11). Each proof carries the
preimage of the account's digest, from which the seat reads the rule ids:

- `verify`, the `External` signer interface, used in rule 0 only: `key_data`
  must be the account's id, every rule id must be 0, and the proof is a live
  session key's signature over `sha256(seat ‖ hash)`.
- `__check_auth`, the `Delegated` signer interface, used in rules other than
  rule 0: the first context must be a call on the stored account whose first
  argument is the account's digest, with only non-zero rule ids, and a live
  session key signs `sha256(seat ‖ payload)`.

## Known behaviours

- `uninstall` needs only the policy admins and deletes the rule's document
  with its binding. A keyless rule then refuses every call (206 with no
  document, 210 once one is installed again, since the new install stores no
  binding); a keyed
  bound rule runs without the adapter's check once a document is installed
  again.
- The keyless shape is verified against an OpenZeppelin 0.8.0 account (built
  from the `v0.8.0` tag `ddc327e`; it builds the same wasm, `8286422f…`, as
  the earlier commit `8e25220`, which differs only in release notes and
  version strings) in the
  interpreter's `oz08/` test crate. The Prime accounts on testnet run
  `91a2cd56…`, the older 0.7.2-line account; re-checking the keyless shape on
  that build is open.
- The synthesiser builds keyed rules, keyless rules for an execution adapter
  (`install_policy` with `executor`) and their binding (`bind_policy`, the
  interpreter's `bind_executor`). It refuses the configuration of Known
  finding H-1, with no override.
- A batch that names the Prime as a target is refused in both modes
  (`PrimeTarget`).
- A seat sees only its account's frame, so it cannot limit the calls of a
  rule that lists it as `Delegated` with no policy. Installing such a rule
  takes a decision that carries a native owner's signature, and the Prime
  app must refuse to build one (residual R7 in the seat's README).
- A seat checks the digest form of the account build the Prime app deploys
  (`91a2cd56…`, `sha256(payload ‖ XDR(rule ids))`). On an account build that
  hashes differently, every seat signature fails.
- A Prime seat removed from rule 0 keeps acting in the `Delegated` rules that
  still list it: the seat reads nothing about the owner list, and the Prime
  app rewrites the rules that list a removed seat (STRIDE E-23, open, Low).

## Builds and testnet

Each crate's `build-wasm.sh` gives the hash CI compares
(`contracts/build-hashes.json` and `deployments/`):

| Contract | sha256 of the Linux build | Testnet |
|---|---|---|
| Policy interpreter | `6704996f626904a4e33b95bda17b73963fc9cf502ffdfdbe9d85b4b10288e0d4` (referenced rules and the batch pin; `v4.1.0` built `810f53f1…`) | instance `CDER6P73…`, the policy-synth pin; it replaced `CD46LN75…` (`810f53f1…`) and `CDZV4AG4…` (`69cad1d5…`), which policy-synth does not trust |
| Execution adapter | `bf85432c859f1ee543c14e9cc9b2c150c12753cc9580053b8d27a41eee85b4a0` (the no-gate word; `v4.1.0` built `4985cd12…`) | code uploaded (`deployments/execution-testnet.json`, which lists `4985cd12…` as superseded) |
| Custody gate | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` | code uploaded |
| Prime seat | `393f0e5d340ed25ef1aa9beb2a5b6446b84247f75c5d858113779c9fa11baa87` | code uploaded |

## Read next

- [stellar.md](stellar.md): every contract in detail, with the flows and limits.
- [architecture.md](architecture.md): the use case, the trust boundaries and the design choices.
- [contracts/README.md](../contracts/README.md): builds, tests and CI.
- [packages/policy-synth/README.md](../packages/policy-synth/README.md): the synthesiser's checks.
- [evidence/README.md](../evidence/README.md): how each logged claim was produced.
