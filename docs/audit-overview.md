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
| Policy interpreter | `contracts/stellar/policy-interpreter/src` | Rust, soroban-sdk 27.0.2 | 800 | 416 (173 unit, 243 in 13 suites, of which the 18 conformance cases also run in release), 12 against OpenZeppelin's 0.8.0 account | in |
| Execution adapter | `contracts/stellar/execution-adapter/src` | Rust | 226 | 62 | in |
| Custody gate | `contracts/stellar/custody-gate/src` | Rust | 53 | 3 | in |
| Prime seat | `contracts/stellar/prime-seat/src` | Rust | 97 | 21 | in |
| Policy synthesiser, `@crediolabs/policy-synth` | `packages/policy-synth/src` | TypeScript | 3,876 | 21 test files | in |
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

**In scope:** this repository at tag `v4.1.0`: the `src/` of the
interpreter, the adapter, the gate and the Prime seat
(`contracts/stellar/prime-seat/src`), test modules excluded; the `src/` of
`policy-synth`; and the `src/` and `bin/` of the CLI and the MCP server. The
same package code is published to npm at version 4.1.0 as
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

**Execution adapter, with a gate:** refuses any batch that names an address
the gate does not list, in a call target, an argument at any depth, raw bytes
or strkey data, or a grant. A batch can wait; the adapter's address commits to
the gate and both wait numbers, and only the gate's custody can `rebind` it.

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
  carries words now passes the adapter, and the Prime's rules decide; it only
  matters on an account whose admins bound rules to this adapter;
- with no address list, those predicates are the whole constraint. Pin each
  recipient (`eq` or `in` on the destination argument), bind a payer to the
  receiver across calls, and bound each amount from both sides. Send the
  adapter no funds and no allowance.

A custody gate never pays a no-gate adapter: the gate pins its caller's
address and build, and custody derives that address from the gate itself.

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
- The synthesiser builds keyed rules only. It refuses a rule with no signer
  and builds no `bind_executor` call, so a keyless rule and its binding are
  installed through the contract calls directly.
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
| Policy interpreter | `810f53f129514c5cd15f90c9a8fcb2267169c9457cd950644b1d69f2bfbf127c` | instance `CD46LN75…`, the policy-synth pin; it replaced `CDZV4AG4…` (`69cad1d5…`, this source before the keyless rules), which policy-synth does not trust |
| Execution adapter | `4985cd123baddd9f21c4c7eab63e79121d499029b0a514a0258b4846eb28313b` at `v4.1.0`; this branch builds `bf85432c859f1ee543c14e9cc9b2c150c12753cc9580053b8d27a41eee85b4a0` (the no-gate word) | code uploaded (`deployments/execution-testnet.json`) |
| Custody gate | `b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab` | code uploaded |
| Prime seat | `393f0e5d340ed25ef1aa9beb2a5b6446b84247f75c5d858113779c9fa11baa87` | code uploaded |

## Read next

- [stellar.md](stellar.md): every contract in detail, with the flows and limits.
- [architecture.md](architecture.md): the use case, the trust boundaries and the design choices.
- [contracts/README.md](../contracts/README.md): builds, tests and CI.
- [packages/policy-synth/README.md](../packages/policy-synth/README.md): the synthesiser's checks.
- [evidence/README.md](../evidence/README.md): how each logged claim was produced.
