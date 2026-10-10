# Audit evidence

The six local logs (`contract-gate.log`, `offchain-gate.log`, `cargo-audit.log`,
`bun-audit.log`, `clippy-pedantic.log` and `scout-audit.log`) were regenerated
on 2026-10-10 against `0358af5`, the tip of `main` on 2026-10-01. They cover
the three contracts in scope, `policy-interpreter`, `custody-gate` and
`execution-adapter`, and the three npm packages. Each contract's rebuilt wasm
matches the code deployed on mainnet (`deployments/prime-mainnet.json`) and the
record CI compares.

The live-network logs spend testnet and mainnet funds, so they were run once
against deployed contracts, and each row below says which:

- `e2e-network.log` and the `oz-*` logs ran between 2026-08-22 and 2026-08-31
  against the grammar-4 interpreter the npm packages pin (testnet `CCBHVZ…`,
  mainnet `CDN755…`), built from `5bae0a8`. `main` builds grammar 6.
- `execution-wait-testnet.log` and `execution-address-rule-testnet.log` ran on
  2026-09-29 against the gate and adapter builds `b01024f3…` and `68d012e7…`,
  which are the builds `main` produces and mainnet runs.
- The two `-reproducible-interpreter` logs re-ran those checks on testnet with
  the grammar-6 interpreter build mainnet runs (`5143e641…`), before the
  mainnet deployment on 2026-10-01.

`offchain-gate.log` is generated from a clean `git archive` export, so what it
measures is exactly what a reviewer gets from a clone and nothing that only
exists on the author's disk.

That distinction used to matter and was hiding a defect. The export was
originally adopted as a workaround: `biome check .` reads untracked files, and
the tree carried 21 untracked scripts whose lint errors were not the repo's. But
four of those scripts were the ones this report's own reproduction commands tell
you to run, so the artefact best placed to notice they were missing was the one
built to look past them. They are committed as of `370734d`; the working tree
now holds no untracked scripts, `bun run check` passes in place, and the export
and the working tree agree.

Reproducing it needs one step worth stating: build `@crediolabs/policy-synth`
before `typecheck`, since the CLI and MCP packages resolve its types through the
gitignored `dist/`.

| Log | Command | Result |
| --- | --- | --- |
| `contract-gate.log` | per crate: `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm rebuild, record parity | clean; interpreter 151 tests across 7 binaries (18 of them conformance, also run in release), gate 3, adapter 33; each rebuilt wasm matches `deployments/prime-mainnet.json` and the record CI compares |
| `offchain-gate.log` | `biome check .`, build, `bun run typecheck`, `bun test` | passes; biome checks 170 files with 0 errors, 99 warnings and 22 infos (finding 9); 771 pass, 1 skip, 0 fail across 772 tests in 52 files (`v1.3.0`) |
| `cargo-audit.log` | `cargo audit` per crate | 0 vulnerabilities (interpreter 202 crates, gate and adapter 215 each); 1 unmaintained-crate warning |
| `bun-audit.log` | `bun audit` | 2 advisories, both through `@modelcontextprotocol/sdk` 1.30.0 (finding 10) |
| `clippy-pedantic.log` | `clippy -W clippy::pedantic -W clippy::nursery` per crate | style warnings only: interpreter 206, gate 16, adapter 35; all 8 cast warnings are in the interpreter's test files |
| `scout-audit.log` | `cargo scout-audit` per crate | interpreter 2 Critical, 13 Medium; gate 0 Critical, 3 Medium; adapter 3 Critical, 14 Medium; 1 Enhancement each. All reviewed in finding 2 |
| `oz-policy-composition.log` | `scripts/oz-policy-composition.ts` | two interpreter policies on ONE rule, disagreeing about the same call: the refusing one is decisive. OZ composes attached policies as ALL-OF |
| `oz-spending-limit-binding.log` | `scripts/oz-spending-limit-binding.ts --network testnet` and `--network mainnet` | OZ's own `spending_limit` beside the interpreter denies an over-cap transfer `#3221` on both networks; control rule without the cap permits the same transfer |
| `oz-threshold-binding.log` | `scripts/oz-threshold-binding.ts --network testnet` and `--network mainnet` | OZ's own `simple_threshold(2)` beside the interpreter denies a lone signer `#3202` and permits the two-signer call on both networks; control rule without the threshold permits that same lone signer |
| `e2e-network.log` | `scripts/e2e-network.ts --network testnet` and `--network mainnet` | policy installed against the pinned interpreter on both networks; permitted call succeeds, forbidden call denied `#100`, and the agent's attempt to route the forbidden call through the unpoliced rule is refused on membership. Both networks re-run for this generation |
| `stride-threat-model.md` | STRIDE re-run, 2026-09-29 | the threat model for the interpreter, the gate, the v4 adapter and the toolchain, with the app's stored-move flow as one adjacent data flow. Supersedes the 2026-09-25 report (at `d89e17b:docs/stride-threat-model.md`). Its tool table is dated 2026-10-01; for Scout and `bun audit`, the 2026-10-10 logs above are current |
| `execution-wait-testnet.log` | `scripts/verify-execution-wait-testnet.ts` | 44 of 44 against the Linux builds: waits, stored moves, run, cancel, the run rule's refusals, revocation, pause and a stored move's measured lifetime |
| `execution-address-rule-testnet.log` | `scripts/verify-execution-address-rule-testnet.ts` | 35 of 35 against the Linux builds: the adapter's address rule, run with no wait |
| `execution-wait-testnet-reproducible-interpreter.log`, `execution-address-rule-testnet-reproducible-interpreter.log` | the same two scripts | 45 of 45 and 35 of 35 with the reproducible grammar-6 interpreter build that mainnet runs |

## Findings

### 1. `paste` 1.0.15 unmaintained - RUSTSEC-2024-0436 (ACCEPTED)

Transitive through `soroban-sdk`. The advisory is "no longer maintained", not a
vulnerability. Not actionable without an SDK change; `cargo audit` reports 0
vulnerabilities in each crate's lockfile (202 crates for the interpreter, 215
for the gate and the adapter).

### 2. Scout findings - reviewed, no change

The 2026-10-10 run covers all three crates. Line numbers below are from
`0358af5`.

**CRITICAL, all five arithmetic, none reachable as a wrong result.** Every crate
sets `overflow-checks = true` for release, so an overflow traps and the call is
refused.

- `execution-adapter/src/lib.rs:213`, `run_at = sequence + wait`: a wrap
  would put `run_at` in the past; the trap refuses the batch instead, as the
  comment above it states.
- `execution-adapter/src/lib.rs:214`, the batch number `+ 1`: traps after
  4,294,967,295 stored batches.
- `execution-adapter/src/lib.rs:224`, `run_at.saturating_add(window) -
  sequence`: `run_at` is `sequence + wait`, so the left side is never below
  `sequence`.
- `policy-interpreter/src/dsl.rs:927`, `items.len() - 1`: the decoder refuses
  an empty list before this point (`dsl.rs:862`).
- `policy-interpreter/src/dsl.rs:939`, `n + 1`: `n` is below `items.len()`, a
  `u32`.

**MEDIUM, `custody-gate` and `execution-adapter`.**

- *unsafe `unwrap`* x3 in the gate and x9 in the adapter: each reads instance
  configuration the constructor wrote (`cfg`, `PRIME`, `GATE`, `MIN_WAIT`,
  `WINDOW`), which is always present.
- *Vec parameter without validating contents* x2 (`execute`'s `calls` and
  `grants`): `check` walks both before anything runs.
- *storage op without access control* x1 (`lib.rs:292`): `ok.push_back(gate)`
  on a local vector inside `check`.
- *dynamic types in persistent storage* x1 (`lib.rs:217`): the stored batch,
  written only after the Prime approved it and bounded by the transaction size.
- *`extend_ttl` with identical arguments* x1 (`lib.rs:225`): deliberate; it
  keeps a stored batch live until its run window closes.

**MEDIUM, `policy-interpreter`.** The 2026-08-27 run found nine; the dispositions
below carry over with current line numbers, plus four new ones:

- *unsafe `unwrap`* x2 (`lib.rs:182-183`, new, in `bind_executor`): on a rule
  with nothing installed the call traps with a host error where
  `MissingState` (`#206`) would be clearer. The direction is refusal.
- *unbounded operations*: the fourth (`dsl.rs:932`, new) walks a `call_path`,
  capped at `MAX_PATH_STEPS` 8.
- *unsafe Map access*: the second (`dsl.rs:496`, new) is the same `Option`
  returning `get` in the `call_path` walk.


- *unbounded operations* x3 (`dsl.rs:800`, `:845`, `:871`): the walks are bounded by the 32 KB byte cap
  plus `MAX_DEPTH` 5 / `MAX_LEAVES` 200 / `MAX_IN_OPERAND_COUNT` 32.
- *dynamic types in persistent storage* x2: the master signer set is a
  `Vec<Signer>` by necessity - it mirrors OZ's own rule shape - and is capped
  at `MAX_SIGNERS` 16.
- *Vec/Map parameter without validating contents* x2: both are validated.
  `enforce`'s `authenticated_signers` is checked non-empty and the rule's
  signer set is re-hashed against the hash stored at install;
  `rotate_master_signer_set`'s `new_set` is checked non-empty, capped, and
  refused if it contains an `External` signer.
- *storage op without access control* x1: reported at `dsl.rs:281`, which is
  `vals.push_back(..)` on a local `SorobanVec` inside `literal_to_val`. `dsl.rs`
  makes no `storage()` call anywhere, so the lint has matched an in-memory push
  and access control does not apply to it. (The contract's real storage writes,
  in `lib.rs` and `storage.rs`, do sit behind `require_auth` / `require_master`
  on every path - but that is not what this finding points at.)
- *unsafe Map access* x1: reported at `dsl.rs:487`, which is `map.get(field)`.
  Soroban's `Map::get` returns `Option`; the panicking variant is
  `get_unchecked`, which this line does not use. That `Option` is `resolve`'s
  return value, so a missing field resolves to "no value" rather than trapping.

### 3. Stellar Security Portal corpus cross-checked

Pulled from the portal's open API on 2026-08-04: 832 findings, 150 critical or
high. Those counts are carried forward from that pull and were NOT re-verified
for grammar 4 - the portal's API still did not resolve when this tree was
re-audited, retried again on 2026-08-27, so they are dated rather than restated as
current.

The cross-check itself is unaffected: it is a claim about this contract's entry
points against the access-control class that dominates the corpus. Grammar 6
adds one entry point, `bind_executor`, so there are six.

| Entry point | Control |
| --- | --- |
| `install` | `smart_account.require_auth()` on every install (including the first, so a rule id cannot be pre-seeded), plus `require_master` and a matching signer set on re-install, plus a strictly incrementing `install_nonce` |
| `enforce` | `smart_account.require_auth()`, non-empty authenticated-signer set, live signer hash must equal the hash stored at install, and the bound executor's authorisation when one is bound |
| `bind_executor` | `smart_account.require_auth()` plus `require_master` on the stored master set |
| `uninstall` | `require_master` |
| `rotate_master_signer_set` | `require_master` on the *old* set |
| `grammar_version` | read-only, touches no state |

`require_master` refuses an empty set rather than treating zero `require_auth`
calls as satisfied - the corpus's "authorization that silently no-ops" class.
The nonce covers its double-spend/replay class.

### 4. End-to-end enforcement on both networks

Static analysis says nothing about whether the deployed contract enforces
anything. `scripts/e2e-network.ts` deploys a fresh OZ smart account, installs
`eq(call_fn, "transfer")` against the pinned interpreter, and exercises both
verdicts through submitted transactions. Mainnet and testnet both pass; five
independent mainnet runs produced the same outcome against different accounts.

Three conditions make the result a claim about the KEY rather than about one
call:

- **The deny is attributed.** The harness fails unless the refusal names the
  interpreter contract and carries `#100 ArgMismatch`. A test asserting only
  that a call failed passes for any reason.
- **The forbidden call is otherwise valid.** `approve` is given an expiration
  ledger ahead of the current one, so the token has no reason of its own to
  reject it and the predicate is the only thing that can.
- **The deny is unroutable.** An account resolves a call against the rule the
  caller NAMES, taking the maximum authority over the named rules rather than
  the intersection, so a predicate constrains a key only when the policed rule
  is the only rule that key is on. The constrained agent is a signer on the
  policed rule and nowhere else, and the harness asserts that its forbidden
  call routed through the unpoliced admin rule is rejected on membership.

The permit is not vacuous because the deny is its control: both calls go through
the same account, rule and policy, so an unbound policy would have let the
`approve` through.

The admin key retains full authority through the unpoliced rule by design. A
policy constrains the keys placed under it, not the account's owner, and any
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
actually installed rather than what the caller happened to mention. Rule ids are
not contiguous - OZ never reuses an id after a removal - so the walk climbs ids
until it has accounted for `Count` live rules; iterating `0..Count-1` would skip
live rules at higher ids, and a skipped rule is a missed overlap. A caller can
still pass `existingRules` to supply them directly, which keeps the scan usable
offline.

**Limit:** `authorityScan: null` means NOT CHECKED, and covers a read that
failed as well as one that could not account for every live rule. It is never an
empty list in those cases, because reporting `[]` would turn "could not check"
into "nothing found".

### 6. On-chain spec resolution widens the RPC trust boundary

The recorder reads an unrecognised contract's interface off chain and raises
confidence when every recorded call matches it, so a decision that depended only
on compiled-in data now depends on a network response.

An attacker controlling the RPC endpoint can serve a fabricated spec whose types
match the recorded call, turning a refusal into a `parseConfidence` of 1.0 for a
contract nobody understands. The synthesised predicate still pins only the
contract address and method observed, so what the attacker gains is the removal
of a warning, not a wider policy.

Bounds:

- The spec is read from the same endpoint the transaction was fetched from, so
  no new trusted party is added; the blast radius of an existing one widens.
- Recognition is all-or-nothing per contract and only ever adds. A missing spec,
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
cap is absent, so the refusal is not the interpreter's, not the amount's and not
an empty balance. The under-cap permit rules out a rule that simply denies
everything. Raising the cap to 50000000 flips the third row to permitted, so the
verdict tracks the cap VALUE rather than the presence of a second policy.

The rules are `ContextRuleType::CallContract(SAC)` because `spending_limit`'s
install refuses any other rule type, pinning the cap to one token so every
metered transfer is denominated the same way.

**Provenance of the deployed policy contracts.** These are OZ *example* contracts
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
consumers import the pin rather than copying a literal.

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
demonstrates the any-of-N inversion rather than asserting it. Dropping the
threshold to 1 flips the lone-signer call to permitted, so the verdict tracks
the threshold value.

**Carried hazard, from OZ's own module header.** `simple_threshold` validates
the threshold against the rule's signer count AT INSTALL and is not notified
when signers change afterwards. Removing signers can put the threshold out of
reach and permanently block the rule; adding them silently weakens a strict
2-of-2 into 2-of-3, which OZ calls "a false sense of security".

Composing it with the interpreter converts that silent weakening into a loud
failure: the interpreter stores `sha256` of the rule's signer set at install and
re-checks it on every `enforce` (`lib.rs:226-228`), denying `RuleSignersChanged`
on any drift. Under ALL-OF composition that refusal is decisive, so a signer
added behind the threshold's back bricks the rule instead of quietly lowering
the bar. Fail-closed, but still a surprise worth surfacing to whoever edits the
signer set.

### 9. Biome warnings in the verification scripts

`biome check .` passes with 0 errors, 99 warnings and 22 infos. 90 of the 121
are `noExplicitAny` and 22 are `useTemplate`. 112 sit in `scripts/`, the
testnet and mainnet verification scripts; the other 9 are in
`packages/policy-synth`.

### 10. Two advisories through `@modelcontextprotocol/sdk` 1.30.0

- GHSA-6qxp-vccf-f47h (high), in the SDK's OAuth client: it could send
  credentials to an authorisation server the MCP server chose. Fixed in 1.31.0.
- GHSA-jqcg-44mw-7w3h (critical), in `proxy-addr` 2.0.7, which the SDK pulls in
  through `express`: IP spoofing through an IPv4-mapped IPv6 trust subnet.
  Fixed in 2.0.8.

`@crediolabs/policy-builder-mcp` uses the SDK's server side only (the stdio and
Streamable HTTP server transports), and its HTTP transport runs on `node:http`,
so neither the OAuth client nor `express` is on its request path. Status: to
fix by moving to SDK 1.31.0 or later and `proxy-addr` 2.0.8 or later.

## Reproducing the Scout run

`cargo-scout-audit` 0.3.16 cannot analyse a `soroban-sdk` 27 crate unpatched, and
reports a build that never compiled as `Analyzed` with 0 findings. Confirm a
compiled artifact exists under `target/dylint/` before quoting any Scout number;
this run produced 11 per crate. Its `detector-helper` links OpenSSL, so the
machine needs `libssl-dev`, or `OPENSSL_INCLUDE_DIR` and `OPENSSL_LIB_DIR`
pointing at one.

```sh
rustup target add wasm32v1-none --toolchain nightly-2025-08-07
cargo scout-audit --manifest-path ./Cargo.toml --exclude storage-change-events -- \
  -Ztarget-applies-to-host -Zhost-config \
  --config 'host.rustflags=["-Zcrate-attr=feature(round_char_boundary)"]'
```

`storage-change-events` is excluded because it overflows the rustc stack.
