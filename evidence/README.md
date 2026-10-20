# Audit evidence

Most logs in this folder were produced against the 1.x tree (the grammar-4 and
grammar-6 interpreters and the 1.x off-chain package). Nine files come from the
grammar-7 tree on `feat/grammar-v7`: `oz-threshold-g7-live.log`,
`worst-case-ceilings-2026-10-16.txt`, `soroban-network-limits-2026-10-16.txt`,
`stride-threat-model-g7.md`, `g7-stride-2026-10-18.log`,
`g7-stride-final-2026-10-19.log` and the three `execution-*` logs of the v5
adapter (`execution-wait-testnet-v5.log`,
`execution-address-rule-testnet-v5.log`, `execution-null-gate-testnet.log`).

**Reproducing the four 1.x `oz-*` logs and the `e2e-network` log:** their scripts drove the 1.x
package API and were deleted with it in 2.0.0. They are in git at `9c93592`
(`packages/policy-synth/scripts/e2e-network.ts`, `oz-policy-composition.ts`,
`oz-spending-limit-binding.ts`, `oz-threshold-binding.ts`, `oz-two-rule-blend-cap.ts`).
Run them from a worktree of that commit, which has the matching package:

```
git worktree add /tmp/opb-1x 9c93592 && cd /tmp/opb-1x && bun install
bun packages/policy-synth/scripts/e2e-network.ts --network testnet
```

Each `scripts/<name>.ts` below that is one of those five means that path under
`packages/policy-synth/` at `9c93592`. The current off-chain evidence is the test
suite (`bun test`, and `OPB_LIVE=1 bun test` against the testnet interpreter in
`deployments/interpreter-testnet.json`).

All ten were regenerated on 2026-08-27 against `5bae0a8`, including both
live-network legs. **`offchain-gate.log` was regenerated on 2026-08-30 against
the `v1.2.0` release tree (`2b14ec6`)**, because the off-chain source changed
after `5bae0a8` (three releases, the `spending_limit` composition, the handle
refactor, `outPath`, and the cross-rule install refusal).

**The other nine describe the interpreter as of `5bae0a8`, and we checked
that:** they all exercise the Rust interpreter, which had not changed
since then when the logs were made (grammar 7 has since replaced it in source; it is
not what these logs ran against):

```
git diff --stat 5bae0a8..HEAD -- contracts/policy-interpreter/   # empty
```

The only Rust change since is a new `test-swap-router` stub crate, which nothing
in those logs runs. `contract-gate-recheck-e2d2a95.log` corroborates it: `cargo
fmt --check`, `clippy -D warnings` and `cargo test` re-run at `e2d2a95` give the
same **125 tests, 0 failed**. That re-check is narrower than `contract-gate.log`
- it omits the conformance regeneration, the wasm rebuild and the hash-pin
parity - so it supplements that log and leaves it standing, and the wasm and
pin results hold because the source producing them is byte-identical.

The three live-network legs were deliberately NOT re-run. They prove properties
of the deployed interpreter, which is unchanged, and re-running them spends
mainnet and testnet funds for a result that cannot differ.

`offchain-gate.log` is generated from a clean `git archive` export, so what it
measures is exactly what a reviewer gets from a clone and nothing that only
exists on the author's disk.

That distinction used to matter and was hiding a defect. The export was
originally adopted as a workaround: `biome check .` reads untracked files, and
the tree carried 21 untracked scripts whose lint errors were not the repo's. But
four of those scripts were the ones this report's own reproduction commands tell
you to run, so the artefact best placed to notice they were absent was the one
built to look past them. They are committed as of `370734d`; the working tree
now holds no untracked scripts, `bun run check` passes in place, and the export
and the working tree agree.

Reproducing it needs one step worth stating: build `@crediolabs/policy-synth`
before `typecheck`, since the CLI and MCP packages resolve its types through the
gitignored `dist/`.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm rebuild, hash pin parity | clean; 125 tests across 6 binaries, 18 of them conformance; rebuilt wasm matches the pin |
| `offchain-gate.log` | `biome check .`, build, `bun run typecheck`, `bun test` | clean; 144 files checked, 750 pass, 1 skip, 0 fail across 751 tests in 49 files (`v1.2.0`) |
| `contract-gate-recheck-e2d2a95.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` per crate | clean; same 125 tests, 0 failed, confirming the interpreter is unchanged since `5bae0a8`. Narrower than `contract-gate.log`: no conformance, wasm rebuild or pin parity |
| `cargo-audit.log` | `cargo audit` | 0 vulnerabilities across 202 crates; 1 unmaintained-crate warning |
| `bun-audit.log` | `bun audit` | 0 vulnerabilities |
| `clippy-pedantic.log` | `clippy -W clippy::pedantic -W clippy::nursery` | 191 style warnings, 0 security; all 8 cast warnings are in test files |
| `scout-audit.log` | `cargo scout-audit` | Analyzed: 0 Critical, 9 Medium, 0 Minor, 1 Enhancement |
| `oz-policy-composition.log` | `scripts/oz-policy-composition.ts` | two interpreter policies on ONE rule, disagreeing about the same call: the refusing one is decisive. OZ composes attached policies as ALL-OF |
| `oz-spending-limit-binding.log` | `scripts/oz-spending-limit-binding.ts --network testnet` and `--network mainnet` | OZ's own `spending_limit` beside the interpreter denies an over-cap transfer `#3221` on both networks; control rule without the cap permits the same transfer |
| `oz-threshold-binding.log` | `scripts/oz-threshold-binding.ts --network testnet` and `--network mainnet` | OZ's own `simple_threshold(2)` beside the interpreter denies a lone signer `#3202` and permits the two-signer call on both networks; control rule without the threshold permits that same lone signer |
| `e2e-network.log` | `scripts/e2e-network.ts --network testnet` and `--network mainnet` | policy installed against the pinned interpreter on both networks; permitted call succeeds, forbidden call denied `#100`, and the agent's attempt to route the forbidden call through the unpoliced rule is refused on membership. Both networks re-run for this generation |
| `stride-threat-model.md` | STRIDE re-run, 2026-10-01 (mainnet deployment) | grammar-6 threat model for the interpreter, the gate, the v4 adapter and the toolchain, with the app's stored-move flow as one adjacent data flow. Supersedes the 2026-09-25 report (at `d89e17b:docs/stride-threat-model.md`). |
| `stride-threat-model-g7.md` | STRIDE run on grammar 7 at `9ff281a`, 2026-10-15 and 16, validated; rerun on the final `feat/grammar-v7` tree at `46e4c6a5`, 2026-10-18; final rerun at `3624e930`, 2026-10-19 | grammar-7 threat model. The first run covers the interpreter, policy-synth, the cli and the MCP server, with validated severities and the P0/P1/P2 list. The rerun adds every contract in the final tree (seats, gates, adapter, NEAR signers), a status for every earlier item and the G7S findings. The final rerun derives the v5 adapter's threats again, gated and with no gate, with the packages after #25 and #27, and reconciles every earlier item. Mainnet grammar-7 installs stay blocked on every open P0 |
| `g7-stride-2026-10-18.log` | the live harnesses of the 2026-10-18 rerun, run from the agents' VM with throwaway keys (the harnesses and keys stay off-repo) | one line per on-chain check with its transaction id, 382 PASS lines and no failure: Stellar testnet (seat, interpreter, execution contracts, the G7S-12 owner-made gate), Solana devnet, NEAR testnet; the EVM fork (58/58) and the local Solana validator (345/345) appear as suite totals |
| `g7-stride-final-2026-10-19.log` | the live harness of the final rerun, run from the agents' VM with throwaway keys made in memory (the harness stays off-repo) | one line per check with its transaction id, 158 PASS lines of 159. The one FAIL, G2d, is the harness's own criterion (sent again at once, an applied envelope gets `TRY_AGAIN_LATER` from the RPC, and about 45 s later `txBadSeq`), and the separate G2d run at the end of the file shows that envelope moves nothing. The rows cover the v5 adapter on fresh instances: gated and with no gate (caps, re-entry, rules cited across adapters, rebind, grants, waits, cancel, resubmission, the Prime binding, custody's gate) and `policy-synth`'s contract-signer refusals, the null-gate one and, after review-opb28, the G7S-16 rows L to O |
| `g7-app-2026-10-20.log` | the testnet transactions the Prime app section of `stride-threat-model-g7.md` cites, read back from Horizon testnet on 20 October 2026 | 14 rows with full hashes: the bind, the two routes that detach a binding and the agent's payments after each, a rule removed, and seven shapes that passed earlier octopos heads and are refused since #228 and #229 |
| `execution-wait-testnet.log` | `scripts/verify-execution-wait-testnet.ts` | 45 of 45 against the Linux builds: waits, stored moves, run, cancel, the run rule's refusals, revocation, pause and a stored move's measured lifetime |
| `execution-address-rule-testnet.log` | `scripts/verify-execution-address-rule-testnet.ts` | 35 of 35 against the Linux builds: the adapter's address rule, run with no wait |
| `execution-wait-testnet-v5.log` | `scripts/verify-execution-wait-testnet.ts`, 2026-10-18 | 45 of 45 against the v5 adapter build `4985cd12…` (optional gate), with a gate: the same rows as the v4 run |
| `execution-address-rule-testnet-v5.log` | `scripts/verify-execution-address-rule-testnet.ts`, 2026-10-18 | 35 of 35 against the v5 adapter build, with a gate: the same rows as the v4 run |
| `execution-null-gate-testnet.log` | `scripts/verify-execution-null-gate-testnet.ts`, 2026-10-18 | 69 of 69 against the v5 adapter build with no gate, for a G and an OpenZeppelin Prime, and the cost of 1, 3 and 10 calls: null, gated v5 and gated v4 |
| `execution-wait-testnet-reproducible-interpreter.log` | `scripts/verify-execution-wait-testnet.ts` in a worktree of `5969f12`, 2026-10-01 | 45 of 45, the rows of `execution-wait-testnet.log`, against the testnet rehearsal of the mainnet deployment: the reproducible Linux build of the grammar-6 interpreter, `5143e641…` (the build mainnet runs), at `CBRRKTVU…`, with the gate and adapter built at that commit (the adapter is 22,753 bytes, the size of `68d012e7…`) |
| `execution-address-rule-testnet-reproducible-interpreter.log` | `scripts/verify-execution-address-rule-testnet.ts`, same worktree and date | 35 of 35, the rows of `execution-address-rule-testnet.log`, against the same rehearsal interpreter and builds |
| `oz-two-rule-blend-cap.log` | `packages/policy-synth/scripts/oz-two-rule-blend-cap.ts --network testnet` at `a460634` (removed in `441340d`), 2026-08-31 | a rolling cap on a Blend-shaped supply. OZ's `spending_limit` sits on a second rule, scoped to the token, and meters the supply's nested `transfer`: over the cap the supply is denied `#3221` while a rule with no cap permits the same supply, declaring rule ids `[1,1]` is refused `#3002` and `[1]` `#3014`, and with the cap raised to 50,000,000 stroops the same supply goes through. The pool is the `test-blend-pool` stub: Blend's authorisation shape with no reserve accounting |
| `stateless/execution-testnet.json` | `scripts/stateless-execution-testnet.ts` at `a40ed75` (removed in `d89e17b`), 2026-09-16 | the testnet run of the stateless execution design, built from `47df478`: the grammar-5 interpreter `CBIQGAHI…`, a per-Prime adapter and a test Prime, their wasm hashes and rules, and 30 transactions. A rerun deploys new contracts, so it writes new addresses and transactions |
| `stateless/execution-testnet-verification.json` | `bun scripts/verify-stateless-testnet.ts`, read only and keyless | each of those 30 transactions read back from testnet with its status and ledger, the instances, and balances, allowances and the Blend position at zero. The script asks `soroban-testnet.stellar.org`, which keeps about seven days of transactions, so a rerun now needs an RPC with full history; Horizon still has them (`537b95ee…` succeeded at ledger 4,706,459, read on 19 October 2026) |
| `stateless/mainnet-deployment.json` | `scripts/deploy-stateless-mainnet.ts` at `9aa5038` (removed in `d89e17b`), 2026-09-16 | the mainnet deployment of that design, which the Prime app still uses for grammar 5: the interpreter `CDIMIQDB…` (wasm `cc05ac55…`), the adapter code `57bf132b…` and the deploy transactions. A rerun would pay mainnet fees for a second deployment, so it is kept as the record |
| `stateless/mainnet-verification.json` | `scripts/verify-stateless-mainnet.ts --execute --fee-cap-xlm 10` at `fa78c74` (removed in `2aaf5eb`), 2026-09-16 | agent and owner flows of that design on mainnet against the Blend pool `CAJJZSGM…`, through a dedicated test Prime funded with the deployer's own XLM: 19 transactions and the result of each check. Without `--execute` the script only reads |

## Findings

### 1. `paste` 1.0.15 unmaintained - RUSTSEC-2024-0436 (ACCEPTED)

Transitive through `soroban-sdk`. The advisory is in the "no longer maintained"
class and carries no vulnerability rating. Not actionable without an SDK change; `cargo audit` reports 0
vulnerabilities across 202 crate dependencies.

### 2. Scout MEDIUMs - reviewed, no change

- *unbounded operations* x3: the walks are bounded by the 32 KB byte cap
  plus `MAX_DEPTH` 5 / `MAX_LEAVES` 200 / `MAX_IN_OPERAND_COUNT` 32.
- *dynamic types in persistent storage* x2: the master signer set is a
  `Vec<Signer>` by necessity - it mirrors OZ's own rule shape - and is capped
  at `MAX_SIGNERS` 16.
- *Vec/Map parameter without validating contents* x2: both are validated.
  `enforce`'s `authenticated_signers` is checked non-empty and the rule's
  signer set is re-hashed against the hash stored at install;
  `rotate_master_signer_set`'s `new_set` is checked non-empty, capped, and
  refused if it contains an `External` signer.
- *storage op without access control* x1: reported at `dsl.rs:237`, which is
  `vals.push_back(..)` on a local `SorobanVec` inside `literal_to_val`. `dsl.rs`
  makes no `storage()` call anywhere, so the lint has matched an in-memory push
  and access control does not apply to it. (The contract's real storage writes,
  in `lib.rs` and `storage.rs`, do sit behind `require_auth` / `require_master`
  on every path - but that is not what this finding points at.)
- *unsafe Map access* x1: reported at `dsl.rs:431`, which is `map.get(field)`.
  Soroban's `Map::get` returns `Option`; the panicking variant is
  `get_unchecked`, which this line does not use. That `Option` is `resolve`'s
  return value, so an absent field resolves to "no value" and the call does not trap.

### 3. Stellar Security Portal corpus cross-checked

Pulled from the portal's open API on 2026-08-04: 832 findings, 150 critical or
high. Those counts are carried forward from that pull and were NOT re-verified
for grammar 4 - the portal's API still did not resolve when this tree was
re-audited, retried again on 2026-08-27, so they are given with their date and
are not restated as current.

The cross-check itself is unaffected: it is a claim about this contract's entry
points against the access-control class that dominates the corpus, and grammar 4
added no entry point. There are still five, with the same controls.

| Entry point | Control |
| --- | --- |
| `install` | `smart_account.require_auth()` on every install (including the first, so a rule id cannot be pre-seeded), plus `require_master` and a matching signer set on re-install, plus a strictly incrementing `install_nonce` |
| `enforce` | `smart_account.require_auth()`, non-empty authenticated-signer set, live signer hash must equal the hash stored at install |
| `uninstall` | `require_master` |
| `rotate_master_signer_set` | `require_master` on the *old* set |
| `grammar_version` | read-only, touches no state |

`require_master` refuses an empty set, so zero `require_auth` calls never count
as satisfied - the corpus's "authorization that silently no-ops" class.
The nonce covers its double-spend/replay class.

### 4. End-to-end enforcement on both networks

Static analysis says nothing about whether the deployed contract enforces
anything. `scripts/e2e-network.ts` deploys a fresh OZ smart account, installs
`eq(call_fn, "transfer")` against the pinned interpreter, and exercises both
verdicts through submitted transactions. Mainnet and testnet both pass; five
independent mainnet runs produced the same outcome against different accounts.

Three conditions make the result a claim about the KEY, beyond the one
call:

- **The deny is attributed:** the harness fails unless the refusal names the
  interpreter contract and carries `#100 ArgMismatch`. A test asserting only
  that a call failed passes for any reason.
- **The forbidden call is otherwise valid:** `approve` is given an expiration
  ledger ahead of the current one, so the token has no reason of its own to
  reject it and the predicate is the only thing that can.
- **The deny is unroutable:** an account resolves a call against the rule the
  caller NAMES, taking the maximum authority over the rules it lists (the union
  of their authority), so a predicate constrains a key only when the policed rule
  is the only rule that key is on. The constrained agent is a signer on the
  policed rule and nowhere else, and the harness asserts that its forbidden
  call routed through the unpoliced admin rule is rejected on membership.

The permit is not vacuous because the deny is its control: both calls go through
the same account, rule and policy, so an unbound policy would have let the
`approve` through.

The admin key retains full authority through the unpoliced rule by design. A
policy constrains the keys placed under it and leaves the account's owner alone, and any
deployment putting a constrained key on a second unpoliced rule has no
constraint at all.

### 5. Install-time authority overlap

`install/authority-overlap` compares the rule being installed against every
other rule on the account and reports each one a signer could name instead,
classified as `bypass` (the neighbour constrains nothing), `unknown` (policed by
a contract whose semantics cannot be read) or `not-restricting` (ours, but
wider). It matches on shared signers intersected with shared
`(contract, function)` selectors, both being necessary for the signer to have a
choice, and over-approximates what a predicate permits, so a non-intersecting
result is a sound proof that two rules cannot collide. Narrowing would be the
fail-open direction.

Exposed as `findAuthorityOverlaps` from `@crediolabs/policy-synth/install`;
`install_policy` returns it as `authorityScan`.

`install_policy` READS the account to build it, so the scan describes what is
actually installed on chain, whatever the caller happened to mention. Rule ids are
not contiguous - OZ never reuses an id after a removal - so the walk climbs ids
until it has accounted for `Count` live rules; iterating `0..Count-1` would skip
live rules at higher ids, and a skipped rule is a missed overlap. (1.x let a caller pass
`existingRules` to supply them directly; that input was removed in 2.0.0 because it
switched the refusal off and reported a clean scan.)

**Limit:** `authorityScan: null` means NOT CHECKED, and covers a read that
failed as well as one that could not account for every live rule. In those cases
the scan returns `null`, because reporting `[]` would turn "could not check"
into "nothing found".

### 6. On-chain spec resolution widens the RPC trust boundary

The recorder reads an unrecognised contract's interface off chain and raises
confidence when every recorded call matches it, so a decision that depended only
on compiled-in data now depends on a network response.

An attacker controlling the RPC endpoint can serve a fabricated spec whose types
match the recorded call, turning a refusal into a `parseConfidence` of 1.0 for a
contract that no reviewer understands. The synthesised predicate still pins only the
contract address and method observed, so what the attacker gains is the removal
of a warning. The policy stays as narrow as before.

Bounds:

- The spec is read from the same endpoint the transaction was fetched from, so
  no new trusted party is added; the blast radius of an existing one widens.
- Recognition is all-or-nothing per contract and only ever adds. An absent spec,
  an unreachable endpoint or a call the interface does not describe leaves the
  recording unchanged, so the failure direction is refusal.
- `resolveContractSpecs: false` restores registry-only behaviour.

Nothing pins or attests the fetched spec. Verifying it against the deployed wasm
hash would close this.

### 7. A real OZ `spending_limit` binds beside the interpreter

`oz-policy-composition.log` settled the composition semantics (ALL-OF) using two
instances of OUR interpreter, which leaves open whether a third-party policy
actually holds. `scripts/oz-spending-limit-binding.ts` closes that with OZ's own
policy, on testnet and mainnet. Three calls, each load-bearing:

| Call | Rule | Expected | Result |
| --- | --- | --- | --- |
| 20000000 stroops | interpreter only (control) | permit | permitted |
| 1000000 stroops | interpreter + cap 5000000 | permit | permitted |
| 20000000 stroops | interpreter + cap 5000000 | deny `#3221` | denied `#3221` |

The control is what attributes the deny: the identical transfer passes when the
cap is absent, so the refusal comes from the cap. The interpreter, the amount and
an empty balance are ruled out. The under-cap permit rules out a rule that simply denies
everything. Raising the cap to 50000000 flips the third row to permitted, so the
verdict tracks the cap VALUE. The mere presence of a second policy does not decide it.

The rules are `ContextRuleType::CallContract(SAC)` because `spending_limit`'s
install refuses any other rule type, pinning the cap to one token so every
metered transfer is denominated the same way.

**Provenance of the deployed policy contracts:** these are OZ *example* contracts
that we built and deployed ourselves; they are not ours and we did not audit them.

- Built from `OpenZeppelin/stellar-contracts` at tag `v0.7.2` (`a9c4216`,
  2026-06-09), not `main`. wasm sha256
  `9ce30ea1fe5c2dc5c9c49cf3462adb32e2c11d7dfadb15ef43a51ba56568de2b`, identical
  on both networks. Mainnet `CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A`,
  testnet `CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP`.
- `policies/spending_limit.rs` is byte-identical between `v0.7.0` and `v0.7.2`
  (`git diff --quiet v0.7.0..v0.7.2 -- packages/accounts/src/policies/`), and
  `v0.7.0` is the newest audit in the upstream `audits/` directory. That audit's
  scope list names the file, so the source we deployed is the source that was
  reviewed.
- Two findings in that audit touch this path and both fixes are present in what
  we deployed: L-06 (spend-limit bypass via a negative amount) is answered by the
  `amount < 0` rejection in `enforce`, and H-01 (rule-selection downgrade after
  signature collection) by `do_check_auth` appending `context_rule_ids` to the
  signed preimage - the same binding our `authDigest` reproduces off chain.
- Upstream still ships the disclaimer "This is experimental software and is
  provided on an 'as is' and 'as available' basis" (README). Deploying it beside
  the interpreter inherits that risk; nothing here vouches for the code.

The same provenance covers `simple_threshold`
(`CDOGPGUFGGUDG25P3TG6XIXJKRRYOZ3PXUZIEPVH74KXRZIDKZ5HYEOS` on mainnet, wasm
`01c0be09...`) and `weighted_threshold`, deployed from the same tag at the same
time. All six addresses and all three wasm hashes were read back from chain and
are pinned in `PINNED_OZ_POLICY_ADDRESS_BY_NETWORK` /
`PINNED_OZ_POLICY_WASM_SHA256`, exported from `@crediolabs/policy-synth/run` so
consumers import the pin and do not copy a literal.

### 8. `simple_threshold` restores m-of-n, which a policy otherwise removes

The dangerous default first: a no-policy context rule requires the FULL signer
set, but attaching ANY policy defers signer validation to that policy
(`smart_account/storage.rs:322`), so a policed rule lets any ONE signer act
alone. Adding a second signer "so two people must approve" therefore produces
the opposite of the intent. `simple_threshold` is what counts signatures back:
`authenticated_signers.len() >= threshold` else `#3202`
(`policies/simple_threshold.rs:184-208`).

Two signers on both rules; only the extra policy varies. On testnet and mainnet:

| Call | Rule | Expected | Result |
| --- | --- | --- | --- |
| signer A alone | interpreter only (control) | permit | permitted |
| signer A alone | interpreter + threshold(2) | deny `#3202` | denied `#3202` |
| signers A + B | interpreter + threshold(2) | permit | permitted |

The control does double duty: it attributes the deny to the threshold, and it
demonstrates the any-of-N inversion by running it. Dropping the
threshold to 1 flips the lone-signer call to permitted, so the verdict tracks
the threshold value.

**Carried hazard, from OZ's own module header:** `simple_threshold` validates
the threshold against the rule's signer count AT INSTALL and is not notified
when signers change afterwards. Removing signers can put the threshold out of
reach and permanently block the rule; adding them silently weakens a strict
2-of-2 into 2-of-3, which OZ calls "a false sense of security".

Composing it with the interpreter converts that silent weakening into a loud
failure: the interpreter stores `sha256` of the rule's signer set at install and
re-checks it on every `enforce` (`lib.rs:182-185`), denying `RuleSignersChanged`
on any drift. Under ALL-OF composition that refusal is decisive, so a signer
added behind the threshold's back bricks the rule instead of quietly lowering
the bar. Fail-closed, but still a surprise worth surfacing to whoever edits the
signer set.

## Reproducing the Scout run

`cargo-scout-audit` 0.3.16 cannot analyse a `soroban-sdk` 27 crate unpatched, and
reports a build that never compiled as `Analyzed` with 0 findings. Confirm a
compiled artifact exists under `target/dylint/` before quoting any Scout number;
this run produced 11.

```sh
rustup target add wasm32v1-none --toolchain nightly-2025-08-07
cargo scout-audit --manifest-path ./Cargo.toml --exclude storage-change-events -- \
  -Ztarget-applies-to-host -Zhost-config \
  --config 'host.rustflags=["-Zcrate-attr=feature(round_char_boundary)"]'
```

`storage-change-events` is excluded because it overflows the rustc stack.
