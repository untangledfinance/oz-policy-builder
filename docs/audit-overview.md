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
| Policy interpreter | `contracts/stellar/policy-interpreter/src` | Rust, soroban-sdk 27.0.2 | 1,080 | 451 (the 18 conformance cases also run in release), 29 against OpenZeppelin's 0.8.0 account | in |
| Execution adapter | `contracts/stellar/execution-adapter/src` | Rust | 340 | 76 | in |
| Custody gate | `contracts/stellar/custody-gate/src` | Rust | 74 | 8 | in |
| Prime seat | `contracts/stellar/prime-seat/src` | Rust | 131 | 29 | in |
| Policy synthesiser, `@crediolabs/policy-synth` | `packages/policy-synth/src` | TypeScript | 5,244 | 32 test files (1,836 tests) | in |
| CLI, `@crediolabs/policy-builder-cli` | `packages/policy-builder-cli/src`, `bin` | TypeScript | 76 | 1 test file | in |
| MCP server, `@crediolabs/policy-builder-mcp` | `packages/policy-builder-mcp/src`, `bin` | TypeScript | 133 | 3 test files | in |
| `test-blend-pool` | `contracts/stellar/test-blend-pool/src` | Rust | 22 | none | out: a Blend-shaped stub for tests |

sLOC counts the non-blank, non-comment lines of the formatted source (`rustfmt`,
`biome format`; CI checks both), with test files and `#[cfg(test)]` module
declarations left out. The Rust figures were measured on the 6.0.0 tree,
events included. To reproduce:

```sh
# from the repository root; a contract (here the interpreter):
( cd contracts/stellar/policy-interpreter &&
  ls src/*.rs | grep -v -E '/(tests?|dsl_tests|dsl_ext_tests|keyless_accept)\.rs$' | xargs cat \
  | grep -v -E '^\s*(//|$)|^\s*#\[cfg\(test\)\]$|^\s*mod (tests?|dsl_tests|dsl_ext_tests|keyless_accept);$' | wc -l )
# the synthesiser:
( cd packages/policy-synth &&
  find src -name '*.ts' ! -name '*.test.ts' | xargs cat | grep -v -E '^\s*(//|/\*|\*|$)' | wc -l )
# a wrapper (here the CLI; the MCP server the same way):
( cd packages/policy-builder-cli &&
  find src bin -name '*.ts' ! -name '*.test.ts' | xargs cat | grep -v -E '^\s*(//|/\*|\*|$)' | wc -l )
```

## In scope and out of scope

**In scope (the code submitted for audit):** this repository at tag `v6.0.0`, the
current release: the `src/` of the
interpreter, the adapter, the gate and the Prime seat
(`contracts/stellar/prime-seat/src`), test modules excluded; the `src/` of
`policy-synth`; and the `src/` and `bin/` of the CLI and the MCP server. The
same package code is published to npm at version 6.0.0 as
`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp`.

`v6.0.0` changes all four contracts, in answer to the auditor's preliminary
review (the changes are in scope for the files below). The OpenZeppelin `Policy` shapes of the
interpreter's `install`, `enforce` and `uninstall` are unchanged.

- **Interpreter:** a rule scoped to its own executor must pin the grants count
  (`call_arg_len(1)`) as well as the batch shape (221); `bind_executor` refuses
  the account and the interpreter as an executor (`InvalidExecutor`, 222) and
  takes a `version` argument; one persistent version counter per rule is shared
  by `install`, `bind_executor` and `uninstall` and survives an uninstall (the
  admins authorise `uninstall` for the next version); a self-scoped keyless
  follower is committed at `bind_executor` to the call targets and functions the
  followed predicate pins (221 on a mismatch); the read-target contract check
  runs once at install; comment corrections (TTL bump threshold, limits, error
  descriptions).
- **Custody gate:** a `payees` list, a subset of `allowed`, is the only set
  `pull` pays; the constructor refuses a payee that is not allowed (3).
- **Execution adapter:** call targets, call arguments and a grant's inner
  arguments are held to `payees`, and only a grant's context contract may be
  allowed-but-not-payee, so the interpreter is named only as a policy; a no-gate
  word that follows another contract's `execute` or `run` is refused; a rebind
  floors the stored batches so a previous custody is not bound to batches
  stored before it; redundant host work and the unused `hazmat-address` feature
  are gone; comment corrections.
- **Prime seat:** a per-key generation (persistent, bumped by each end) is part
  of the grant message once above zero, so an old end or an old grant no longer
  verifies; the seven-day window is a named constant; an empty rule-id list and
  a short proof or preimage are refused without a trap; header comments match
  the code.
- **Policy synthesiser:** pins and requires the grants count, builds
  `bind_executor` with the version it reads, refuses the account or the
  interpreter as an executor, reads the three-argument bind in the review.
- **Events:** the interpreter (`Installed`, `ExecutorBound`, `Uninstalled`,
  `MasterSetRotated`), the adapter (`BatchStored`, `Ran`, `Cancelled`,
  `Rebound`), the gate (`Pulled`) and the seat (`Granted`, for a grant and an
  end) publish an event as the last statement of the call, after every check,
  authorisation and storage write. A watcher reads state changes from events
  instead of storage and transaction history. Topics and data are in each
  crate's README and [stellar.md](stellar.md#events).

The CHANGELOG entry for 6.0.0 lists the rest.

**Out of scope, each with what Prime assumes of it:**

| Part | Assumption |
|---|---|
| OpenZeppelin smart account and its `simple_threshold`, `weighted_threshold` and `spending_limit` policies | third-party code. It selects the rule a call cites, authenticates the rule's signers, calls each policy's `enforce`, and refuses to leave a rule with no signer and no policy. Two account builds: the 0.7.2-line `91a2cd56…` (the Prime accounts) and `v0.8.0` `8286422f…` (the testnet reference account); the policies are built from `v0.8.0` on testnet and `v0.7.2` on mainnet (`deployments/`) |
| Soroban host and RPC | the host builds each authorisation context from what was really called, and refuses re-entry into a contract already on the stack |
| Custody account | a classic Stellar account whose own signers and thresholds decide what it approves |
| Owners' wallets and the owner key of a Prime seat | sign only what their holder means to sign. A seat's owner key raw-signs the 32-byte grant hash; a NEAR-routed MPC holds it in the reference integration |
| The client application (separate repository) | builds transactions and refuses dangerous rule shapes before any wallet signs; an extra control, never one the contracts rely on |
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
  0, the number of grants (`call_arg_len(1)`, `eq` a non-negative constant), the
  number of calls, and each call's target and function name.
  `bind_executor` checks it against the scope `install` recorded, a re-install
  checks it under a kept binding, and `enforce` checks it again against the
  rule OpenZeppelin passes, which no install argument can misstate (221). The
  grants pin fixes how many grants the batch carries, not what they name: the
  rule's author pins the exact count the flow raises (see the finding H-1
  note below).
- `bind_executor` refuses the account itself and the interpreter as an executor
  (`InvalidExecutor`, 222): the account calls the interpreter on every rule
  check and a rule scoped to its own account skips the batch pin, so either
  would stand in for an adapter's grant.
- One persistent version counter per rule, shared by `install` (its
  `install_nonce` must be the counter plus one), `bind_executor` (its `version`
  argument) and `uninstall`, which the policy admins authorise for the next
  version, and which an uninstall does not remove. A signed bind or uninstall
  that was held back is refused once the rule has moved on, and a re-install
  after an uninstall keeps climbing.
- OpenZeppelin's `remove_policy` refuses to leave a rule with no signer and no
  policy (3004), so a keyless rule with one policy keeps its predicate.
- OpenZeppelin's 0.8.0 account refuses a delegated signer that is also a
  contract called in the operation (3017). A rule signed by the adapter fails
  that check at first use. A keyless rule lists no signer, so a stored batch
  still runs with no key.

**Custody gate:** pays only addresses on `payees`, a list fixed at construction
that is a subset of `allowed` (the constructor refuses a payee that is not
allowed), only when its one caller asks, and only while that caller runs the
approved build. The policy interpreter is on `allowed` (a grant names it as the
policy to ask) and must not be on `payees`: it must never hold value, because a
`read` leaf runs its target as the interpreter and keeps the effects. The
constructor cannot tell which address is the interpreter, so that the
interpreter is off `payees` is a property of the gate's configuration that the
contract does not enforce, and the control for finding E-10; `policy-synth`'s
`bind_policy` warns when a gated executor's gate pays the interpreter or its
payees cannot be read. No admin, no setter, no upgrade.

**Execution adapter, with a gate:** checks every call target, every call
argument at any depth (strkey, raw-key and address-XDR spellings compared;
muxed M-strkeys refused), every executor authorization and every batch grant --
including nested sub-invocations -- against the gate's lists: call targets,
call arguments and everything inside a grant against `payees` plus the gate,
and a grant's context contract against `allowed` plus the gate. So the
interpreter is accepted only as a grant's context contract, never as a target,
an argument or a destination buried in a grant. A batch naming an address the
gate does not list is refused; grants are NOT refused wholesale -- a grant whose
addresses are all listed is accepted (the Prime's own payout legitimately
carries grants), and deploy-type entries are refused (`Uncheckable`). The walk is ABI-blind, so a
256-bit value could carry 32 key bytes and pass (a limit noted in the source).
A batch can wait; the adapter's address commits to the gate and both wait
numbers, and only the gate's custody can `rebind` it. A rebind floors the stored
batches: one stored before it is refused at `run` (`NotScheduled`), so a
previous custody, which can no longer cancel, is not bound to a batch that
still draws on its old allowance. A zeroed allowance only pauses a batch.

> **Gated-adapter residual (E-36 analogue; auditor, please confirm).** A keyed
> rule on a gated adapter whose predicate leaves its call list open could, like
> finding H-1 on a no-gate adapter, let a keyed holder vouch a keyless inner
> rule beyond its root pin. The containment here is NOT grant refusal: a grant
> whose addresses are all on the gate's list is accepted, and a gated batch may
> carry grants. It is the root pins on the full call list and the grants count
> (`call_arg_len(1)` pinned to the number the flow raises), exact-context grants
> (a smuggled grant is inert when no pinned call asks for that context), and the
> gate's address list, which a grant's addresses must also satisfy. An
> independent 27/27 on-chain PoC found no such path in the Prime rule set. Unlike
> the keyless rules of a no-gate adapter, the interpreter does not make a keyed
> rule on a gated adapter pin its grants: that pin is the rule author's, and
> nothing refuses a keyed rule that omits it. The interpreter is also never a
> payee of the gate (see the custody gate above) and, in a gated batch, appears
> only as a grant's context contract. A `policy-synth` check that warns on a
> keyed execute rule bound to a gated adapter without a pinned call count,
> targets, functions and grants count is a planned follow-up.

**Execution adapter, with no gate:** checks no address, so the Prime can
bundle its own calls atomically. The flow is narrow:

- every batch runs at once: a wait or a `min_wait` above 0 is refused
  (`NoWait`), nothing is stored, and `run` finds nothing (`NotScheduled`);
- the adapter hands a callee no authorisation (`Uncheckable`). In an immediate
  `execute` it accepts one kind of grant, its word to the Prime's policy:
  `enforce(prime, context)` on a contract the batch names, for its own Prime,
  with nothing nested, and whose followed context is not another contract's
  `execute` or `run` (so a second no-gate adapter of the same Prime cannot
  vouch for a rule scoped to the first one's `execute`); anything else is
  refused (`Uncheckable`). To each
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
- **invariants (STRIDE E-35 and E-36, High; residual Medium with the
  mitigations).** First, every keyless rule scoped to the adapter pins the
  number of grants (`call_arg_len(1)`) to the exact number of contexts its
  batch raises, which the interpreter enforces (221). Without it, any caller
  could add a word for a context the batch's own payer raises, and a keyless
  inner rule would vouch for it (see the H-1 note). Second, no
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

> **Known finding H-1 (reviewer, accepted).** STRIDE E-35 and E-36, High;
> residual Medium with the containment below. See
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
> - **The keyless variant (closed by the grants pin).** The same word can be
>   used with no keyed rule at all. A keyless liquidation rule that pinned the
>   wait, the number of calls and each call's target and function, but not the
>   number of grants, let ANY caller add a word. The caller chooses the payer
>   of the first pinned call. A contract account as payer, whose
>   `__check_auth` calls `xlm.transfer(account, payer, X)`, raises one more
>   context inside the batch, one matching word vouches for it, and the inner
>   XLM rule permits it: the caller takes the whole balance the inner rule
>   covers for one repayment. The interpreter now refuses a keyless rule scoped
>   to its own executor unless every `execute` branch pins `call_arg_len(1)` `eq`
>   a non-negative constant (221, at `bind_executor`, at a re-install and at
>   `enforce`), and refuses the account or the interpreter as an executor (222),
>   so the batch pin cannot be skipped by scoping a rule to the account. With
>   the grants pinned, the same batch is refused. Every keyless liquidation
>   rule pins the exact count its flow raises (the reference liquidation rule
>   pins 5 grants in one `or` branch and 3 in the other), and a rule without the
>   pin is refused.
> - **What the pin does not do.** The interpreter cannot know how many
>   contexts a batch unconditionally raises. A pin above that number admits
>   that many extra contexts (a smuggled word per spare slot), an `or` pins only
>   when every branch does, and a batch whose nested contexts vary with state
>   cannot be secured by a count at all. The author pins the exact number;
>   `policy-synth` writes the count the author states (`count` at `[1]`) and
>   refuses a keyless self-scoped rule that states none.
> - **Why the rest is not a contract guard.** The interpreter evaluates one
>   rule at a time. It never sees the account's other rules. At install it also
>   cannot tell whether the executor a rule is bound to is a gated or a no-gate
>   adapter. A contract-level refusal of keyed rules would therefore have to
>   refuse keyed or keyless rules on every executor, which breaks legitimate
>   gated designs. The adapter cannot tell a keyed caller from a keyless one
>   either: it only sees the account's approval.
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
>   4. *The grants pin, on chain.* The interpreter refuses a keyless rule
>      scoped to its own executor that leaves the grants count unpinned (221),
>      so the keyless variant above cannot be installed or bound.
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
>
>   **Answer (preliminary review, applied).** It is not sufficient on its own:
>   the invariant covers keyed rules, and a keyless rule that leaves the grants
>   unpinned lets an anonymous caller smuggle a word. The grants pin above is
>   the added control. The residual, stated openly: a pin larger than the
>   number of contexts the batch raises, and batches whose nested contexts vary
>   with state, are the rule author's to avoid. Please confirm that the
>   interpreter's pin together with the dedicated-adapter invariant is the
>   intended containment.

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
>   re-install; refusing it would break the pattern.
> - **A keyed follower is widened too.** A re-install by A widens EVERY follower
>   at once, a keyed one included. A keyed follower keeps its own signers as
>   the authentication of each call, but what those signers may do is A's
>   predicate: an agent signer of B who is not among B's owners gains whatever
>   A's new predicate allows, with no action by B and B's stored bytes
>   unchanged. Only B's owners, who can install any rule through rule 0, are
>   unaffected. A predicate that carries a `read` also widens through A's
>   oracle with no re-install at all. Pinning the predicate's hash does not
>   help, because a follower's install hash commits to the reference, not to
>   the bytes. To keep a keyed follower's agents inside a cap of B's own, give
>   the rule a second policy that holds that cap: a second interpreter
>   instance with an inline cap (the same instance cannot be attached twice,
>   OpenZeppelin refuses `DuplicatePolicy`, 3009) or OpenZeppelin's
>   `spending_limit`. Every policy on a rule must permit, so the cap stays B's.
>   A **keyless** follower cannot carry a second policy (the interpreter
>   refuses it, 210), so its only fence is A's predicate: follow only a rule
>   whose admins hold B's trust, or use a keyed rule with its own cap.
> - **Containment, accepted by the team:** (1) `policy-synth` raises an E-38
>   warning (not a refusal) whenever a keyless rule follows another rule, at
>   `install_policy`, `bind_policy` and in the review, naming the followed rule
>   and its admins (PR #60, release `v5.1.0`); (2) this note and the STRIDE
>   entry; (3) for a keyed follower, the second policy with B's own cap above;
>   (4) since 6.0.0, a follower scoped to its own executor is committed at
>   `bind_executor` to the call targets and functions A's predicate pinned then,
>   and `enforce` refuses (221) when A's live predicate pins others, so A keeps
>   control of amounts but cannot retarget the follower (STRIDE E-41).
>   A borrower who wants A to only *tighten* the fence keeps the rule **keyed**
>   and gives it that second policy: a keyed rule alone is not enough, because
>   its agent signers follow A's predicate.
> - **Ask to the auditor.** Please confirm that live predicate propagation to a
>   follower, with the followed owner able to loosen the fence, is an
>   acceptable trust assumption for the issuer-governed use, given the warning
>   (keyless followers) and the second policy that holds a keyed follower's own
>   cap.


**Prime seat:** one seat serves one account and one owner key, both fixed at
construction. No admin, no setter, no upgrade. The owner key signs only grants
and ends. A grant needs `start <= now <= end`, at most 604,800 seconds, and an
end later than the stored one. An end stores 0 for the key, which refuses every
later grant for it while the entry lives. The entry sits in temporary storage
at the maximum TTL, about 180 days; once it expires, a grant the owner signed
for that key can be valid again (STRIDE D-11). Each proof carries the
preimage of the account's digest, from which the seat reads the rule ids:

- `verify`, the `External` signer interface, used in rule 0 only: `key_data`
  must equal the account id stored at construction, every rule id must be 0,
  and the proof is a live session key's signature over `sha256(seat ‖ hash)`.
  This is a view. Its only tie to a caller is that equality, and `key_data`
  comes from the caller's own rule, so any account whose rule 0 lists
  `External(seat, that stored id)` counts the seat's session-key votes in its
  own rule 0. The binding to one account is not cryptographic on the
  0.7.2-line digest, which carries no account field; the `Delegated` path below
  is bound to the account by its own frame. No authority over the first account
  is gained, the key still signs each proof, and the reference client application lists a seat
  only for the account it serves (SEAT-01).
- `__check_auth`, the `Delegated` signer interface, used in rules other than
  rule 0: the first context must be a call on the stored account whose first
  argument is the account's digest, with only non-zero rule ids, and a live
  session key signs `sha256(seat ‖ payload)`.

**Ends and the per-key generation.** Each end bumps a per-key generation, a
`u32` in persistent storage that never expires and only grows, and the grant
message carries it (big-endian, after `end`) once it is above zero. Until a
key's first end the message is byte-identical to the recorded vectors. An end
is therefore valid for one generation only: re-submitting the same end bytes
fails its signature (so a relayer can no longer replay an end), and an old end
cannot revoke a key the owner granted again after the end entry expired. The
same holds for a grant signed in advance with a future start: it was signed
over an older generation and fails once the key has been ended. A grant the
owner signs after the end entry expires must be signed over the current
generation. Replaying an end no longer
keeps the end marker alive (SEAT-02): the end entry can lapse after about 180
days, after which only a grant signed under the current generation brings the
key back (STRIDE D-11).

Two statements in the seat crate's own docs still do not match this behaviour,
and are corrected here: the owner key signs over `sha256(seat ‖ payload)`, the
seat's own authorisation payload, where `lib.rs` calls it the account digest;
and an end is accepted with any `start`, where the README expects `start = 0`.
Empty rule-id lists are refused by both entry points, a `verify` proof under 96
bytes returns false, and a preimage under 32 bytes is read as no rule ids and
refused, none of them a trap (the rule split needs a non-empty list).

## Known behaviours

- `uninstall` needs only the policy admins, authorising `(rule, next version)`,
  and deletes the rule's document with its binding; the version counter stays,
  so a re-install needs the next one and an old signed install, bind or
  uninstall cannot be replayed. A keyless rule then refuses every call (206 with no
  document, 210 once one is installed again, since the new install stores no
  binding); a keyed
  bound rule runs without the adapter's check once a document is installed
  again.
- A rule that another rule follows keeps being read after the account removes
  it with rule-0 signatures only (the interpreter's entry stays when `uninstall`
  fails): its followers' permits renew it, and its master set can re-install it
  with a wider predicate. Only `uninstall` with the master set revokes the
  followers. A permit extends an entry only in its last 100 ledgers, so a
  keep-alive job must cover every rule, every followed source and the version
  counters.
- The keyless shape is verified against an OpenZeppelin 0.8.0 account (built
  from the `v0.8.0` tag `ddc327e`; it builds the same wasm, `8286422f…`, as
  the earlier commit `8e25220`, which differs only in release notes and
  version strings) in the
  interpreter's `oz08/` test crate. Resolved: the deployed testnet reference
  account now runs 0.8.0 (`8286422f…`), where the keyless shape also ran live
  on 26 October 2026; the same rows passed on a 0.7.2-line account
  (`91a2cd56…`), the build the Prime accounts on testnet run
  (`evidence/oz-0.8.0-migration-testnet.log`).
- The synthesiser builds keyed rules, keyless rules for an execution adapter
  (`install_policy` with `executor`) and their binding (`bind_policy`, the
  interpreter's `bind_executor`). It refuses the configuration of Known
  finding H-1, with no override.
- A batch that names the Prime as a target is refused in both modes
  (`PrimeTarget`).
- A seat sees only its account's frame, so it cannot limit the calls of a
  rule that lists it as `Delegated` with no policy. Installing such a rule
  takes a decision that carries a native owner's signature, and the client
  application must refuse to build one (residual R7 in the seat's README).
- A seat checks the digest form of the account build the client application deploys
  (`91a2cd56…`, `sha256(payload ‖ XDR(rule ids))`). On an account build that
  hashes differently, every seat signature fails, so a Prime with seats stays
  on `91a2cd56…`. OpenZeppelin's 0.8.0 account (`8286422f…`) has its signers
  commit to `AuthDigestPreimage { account, context_rule_ids,
  signature_payload }`; the synthesiser signs either form, chosen from the
  account's live code (release 5.2.0), and refuses any other build.
- A Prime seat removed from rule 0 keeps acting in the `Delegated` rules that
  still list it: the seat reads nothing about the owner list, and the client
  application rewrites the rules that list a removed seat (STRIDE E-23, open, Low).

## Builds and testnet

Each crate's `build-wasm.sh` gives the hash CI compares
(`contracts/build-hashes.json` and `deployments/`):

| Contract | sha256 of the Linux build (size) | Testnet |
|---|---|---|
| Policy interpreter | `c6273cb1880233c541e67592a687d01b309b15ce2c41158d043f50cce96955e5` (84,280 bytes) | uploaded, and a fresh verification instance `CADKAYWU…` deployed, on 2 November 2026, and a second fresh instance on 3 November 2026 ([evidence](../evidence/README.md#the-600-fixes-preliminary-review-2-november-2026)). Instance `CDER6P73…` (wasm `6704996f…`) is the policy-synth pin; policy-synth does not trust the superseded instances recorded in `deployments/interpreter-testnet.json` |
| Execution adapter | `eafcd011a3c2e0aae08402e9fbd5f39e65d1feb370e45035ee20a25d4c95b725` (31,667 bytes) | uploaded, fresh no-gate and gated adapters deployed for verification; `deployments/execution-testnet.json` records the build and its upload |
| Custody gate | `89e48fcb5c9f037f1d702d2cb6ed3be99f24a7794c0f5df712b7ba887db50dbb` (13,205 bytes) | uploaded, fresh gates deployed for verification (two on 2 November 2026, two on 3 November 2026); recorded in `deployments/execution-testnet.json` |
| Prime seat | `f39587ad8a190e31955a6fab1c274372fa724180c4ab1bad72846e08f1f2bd51` (19,758 bytes) | uploaded, a fresh seat deployed for verification |

All four are under the network's `CONTRACT_MAX_SIZE_BYTES` of 131,072.

## Read next

- [stellar.md](stellar.md): every contract in detail, with the flows and limits.
- [architecture.md](architecture.md): the use case, the trust boundaries and the design choices.
- [contracts/README.md](../contracts/README.md): builds, tests and CI.
- [packages/policy-synth/README.md](../packages/policy-synth/README.md): the synthesiser's checks.
- [evidence/README.md](../evidence/README.md): how each logged claim was produced.
