# Audit evidence

The logs and records behind the claims in the docs and in
[stride-threat-model.md](stride-threat-model.md). Unless a row says otherwise,
each was produced on 20 October 2026 from the tree of that date, with the
contract builds then pinned: policy interpreter `810f53f1…`, custody gate
`b01024f3…`, execution adapter `4985cd12…`, `prime-seat` `393f0e5d…`. This tree
pins interpreter `6704996f…` and adapter `bf85432c…` in
`contracts/build-hashes.json`; the gate and the seat are unchanged.
Every network run is on Stellar testnet with throwaway keys made for that run
and funded by friendbot; the keys never leave the run.

## Index

| File | Command | Result |
| --- | --- | --- |
| `stride-threat-model.md` | STRIDE pass over every component in the tree | threats by component with an ID per threat, the control at file and line, how each was checked, the open items by severity and the residual risks |
| `build-hash-match.md`, `build-hash-match/` | `build-hash-match/solana-check.sh`, `safe-check.cjs` and `roles-check.cjs`, 27 October 2026; reads Solana devnet and Base Sepolia, sends nothing | the third-party builds Prime configures against their cited sources. Base Sepolia: Safe 1.4.1 (5 contracts) and Zodiac Roles v2.1.1 (4) equal a local build byte for byte, and each init code gives its deployed address. Solana devnet: klend (`e921c64`) and the Squads Smart Account (`0e51082`) do not match; each build method reproduces the publisher's own hash |
| `executor-binding-testnet.log` | the executor-binding probe, run from our build host. The probe is not in this repository, so the log cannot be regenerated from the tree; its transaction ids can be read back on testnet. `contracts/stellar/policy-interpreter/oz08/` runs most of the same cases on the 0.8.0 account in the test host: the keyless `run`, the binding, 3017, 3004, 210 and 204. It has neither the no-gate adapter rows (n8a to n8e) nor the misstated scope (n5b, n5c): the adapter's unit tests and `execution-null-gate-testnet.log` cover the adapter with no gate, and `policy-interpreter/tests/keyless.rs` covers the 221 pin at each checkpoint, a misstated scope included | 27 of 27 rows as expected on an OpenZeppelin 0.8.0 account and a fresh interpreter instance: keyless `run` works; a keyless `execute`, `cancel` or direct venue call is refused; adapter-signed rules fail 3017; `remove_policy` on a keyless rule fails 3004; unpinned self-scoped rules fail 221 at `bind_executor`, at an install under a binding and in `enforce`; the venue rule works through the binding; an adapter with no gate satisfies no binding. Every refusal also failed on chain, with its transaction id |
| `execution-wait-testnet.log` | `bun scripts/verify-execution-wait-testnet.ts` | 45 of 45: a Blend supply at once and stored; stored batches run later by an account with no role; the run rule's refusals; an agent's rule demanding its own minimum wait; cancels by the Prime and custody and refusals for anyone else; runs early, twice, after a cancel or after the window refused; the adapter's floor; the Prime creating the adapter at custody's address with other numbers refused |
| `execution-address-rule-testnet.log` | `bun scripts/verify-execution-address-rule-testnet.ts` | 35 of 35: a Blend supply, a withdrawal to custody and an Aquarius swap succeed; a stranger in any argument, nested value, strkey, raw 32 bytes or authorisation, a pull to the gate itself, a token custody never approved, a batch calling the Prime, a deploy authorisation and a Prime-signed rebind are refused; custody rebinding to a non-gate is refused |
| `execution-null-gate-testnet.log` | `bun scripts/verify-execution-null-gate-testnet.ts` | 69 of 69, for a G account and an OpenZeppelin Prime: a bundle of three calls with one authorisation; an agent's bundle at its cap; refusals for a failed call (nothing moves), an expired entry, a call to the Prime, a grant, any wait, `rebind`, a stranger's `cancel`, an agent over its cap or citing its adapter rule for a token, and a pull through custody's gate; then the cost of 1, 3 and 10 calls with and without a gate |
| `nogate-liquidation-testnet.log` | the no-gate liquidation probe, 25 October 2026, run from our build host (probe kept off the repository like the executor-binding probe; `contracts/stellar/policy-interpreter/oz08/tests/nogate.rs` runs the same cases in the test host on the real wasm and account) | 24 of 24 rows as expected on an OpenZeppelin 0.8.0 account (`8286422f…`, OZ `v0.8.0` tag `ddc327e`), a fresh interpreter instance from `6704996f…` and adapters from `bf85432c…`: a stranger liquidates alone through the no-gate adapter under keyless bound rules; every grant that is not the adapter's exact word is refused 3; a missing word, a direct ask after the run and a gated adapter fail at the binding; a replayed entry fails on its nonce; a root rule without the batch shape fails 221 at bind, at an install under the binding and in `enforce`; off-shape batches, an insider, a high y, a large R and a healthy position fail 100; a wait fails 10 and `run` 5; the adapter-signed liquidate rule fails 3017; an agent's keyed batch with no words runs. The E-36 hazard (a keyed door without the grants pin) is shown in `oz08/tests/nogate.rs`, not on testnet. Every refusal also failed on chain, with its transaction id. Section 6.7 of the threat model |
| `nogate-liquidation-mutants.log` | 32 mutants of the no-gate word (adapter) and the batch pin (interpreter), each applied alone and the relevant suites run | 31 killed; the survivor (A5) is equivalent, since the deploy variant is refused twice, and the mutant that removes both (A5b) is killed |
| `oz-0.8.0-migration-testnet.log` | the OpenZeppelin `v0.8.0` migration, 26 October 2026, run from our build host (probe kept off the repository like the executor-binding probe); the builds, deploys and TTL extensions it relies on are in `deployments/oz-accounts.json` and `deployments/oz-policies.json` | 29 of 29 rows as expected (12 on the 0.8.0 account, 5 and then 12 on a 0.7.2-line one), plus the `policy-synth` before and after. On the 0.8.0 testnet reference account (`CDS2W673…`, `8286422f…`) through `CDER6P73…`: every instance runs its recorded code; a keyless rule pair bound to a dedicated no-gate adapter moves 0.5 XLM for a stranger, 2 XLM fails 100, an unbound keyless rule fails 210; the `v0.8.0` `spending_limit` permits 1.5 of 2 XLM and refuses 1 more (3221); `simple_threshold` 2 refuses one signer (3202) and permits two; `weighted_threshold` refuses the weight-1 signer alone (3213) and permits the weight-2 one. The same rows pass on a 0.7.2-line account (`91a2cd56…`), the `v0.8.0` policies included. `install_policy` on the 0.8.0 account fails at 5.1.0 (`Error(Auth, InvalidAction)`: it signed the 0.7.2-line digest) and lands at 5.2.0 (the 0.8.0 preimage), as do the 0.7.2-line control and a `revoke_policy` |
| `oz-threshold-live.log` | `bun packages/policy-synth/scripts/live-threshold.ts`, then with `WEIGHTED=1` | `simple_threshold(2)` beside the interpreter: signer A alone refused 3202, A and B together permitted (transfer sent). With `WEIGHTED=1` (A:2, B:1, threshold 2) `install_policy` refuses the rule before any transaction, because A alone meets the threshold |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` per crate and in `oz08/`, conformance in release, each `build-wasm.sh` and its hash check | every step passed: interpreter 416 tests (its 18 conformance cases again in release), `oz08/` 12, adapter 62, gate 3, `prime-seat` 21; each rebuilt wasm equals its pin, and `test-blend-pool` built with the same path remaps gives `7ba261ed…` |
| `offchain-gate.log` | `bun run check`, the three package builds, `bun run typecheck`, `bun test`, `bun run test:isolated`, 21 October 2026, after the lockfile update and the MCP input cap | every step passed: biome 0 errors (36 warnings), typecheck clean, `bun test` 1,782 pass and 0 fail, isolated 1,758 + 6 + 18 |
| `worst-case-ceilings.txt` | `cargo test --release --test worst_case -- --nocapture` on the interpreter wasm | every rule shape at each limit set stays at or under 80% of the testnet limits; worst case at the ceilings: `install` 64.7M CPU, `enforce` 62.3M CPU and 1.58 MB; 8 wasm reads cost 12.7 MB of memory for one context and about 11.4 MB for each further one |
| `soroban-network-limits-2026-10-16.txt` | `getLedgerEntries` on every `CONFIG_SETTING` key, testnet, 16 October 2026 | the per-transaction limits `tests/worst_case.rs` holds every rule shape to, at 80% |
| `cargo-audit.log` | `cargo audit` in the interpreter crate | no vulnerability across 202 crates on 20 October; since 23 October RUSTSEC-2026-0387 (`crypto-bigint` 0.5.5) is ignored with its reason in `contracts/stellar/policy-interpreter/.cargo/audit.toml`: host-side only, not in the wasm (finding 1); one unmaintained-crate warning |
| `bun-audit.log` | `bun audit`, 21 October 2026, after the lockfile update | no vulnerability (finding 2) |
| `clippy-pedantic.log` | `cargo clippy --all-targets -- -W clippy::pedantic -W clippy::nursery` in the interpreter crate | 352 distinct style warnings, 68 in contract source and 284 in tests; every cast, panic, unwrap, indexing or overflow lint is in test code |
| `scout-audit.log` | `cargo scout-audit` in the interpreter crate (see below) | run on 27 August 2026 at commit `5bae0a8`: 0 critical, 9 medium, 0 minor, 1 enhancement; triage in finding 3. On this tree Scout 0.3.16 stopped while building its own detector helper on our build host, so the August log stays |
| `stateless/execution-testnet.json` | `scripts/stateless-execution-testnet.ts` at `a40ed75` (since removed), 16 September 2026 | a testnet run of an earlier stateless execution design, built from `47df478`: its interpreter `CBIQGAHI…`, a per-Prime adapter and a test Prime, their wasm hashes and rules, and 30 transactions |
| `stateless/execution-testnet-verification.json` | `bun scripts/verify-stateless-testnet.ts`, read only and keyless | each of those 30 transactions read back with its status and ledger, the instances, and balances, allowances and the Blend position at zero. The script asks `soroban-testnet.stellar.org`, which keeps about seven days of transactions, so a rerun now needs an RPC with full history; Horizon still has them (`537b95ee…` succeeded at ledger 4,706,459, read on 19 October 2026) |

**What the testnet runs exercise:** the executor-binding probe deploys its own
interpreter instance from `810f53f1…` and an OpenZeppelin 0.8.0 account
(`8286422f…`, the fixture in `policy-interpreter/tests/fixtures/`). The three
execution scripts deploy fresh gates and adapters from `b01024f3…` and
`4985cd12…` on OpenZeppelin `91a2cd56…` accounts, and install their rules on
the testnet interpreter instance recorded in
`deployments/interpreter-testnet.json`. These logs were recorded on
`CDZV4AG4…`, which runs `69cad1d5…`, this source before the keyless rules;
4.1.0 moved that record to `CD46LN75…` on `810f53f1…`, and since 5.0.0 it names
`CDER6P73…` on `6704996f…`. Their run rule lists the adapter as its
signer, a shape the 0.7.2-line account accepts and the 0.8.0 account refuses
(3017); they test the gate and the adapter. The off-chain suite's live tests
run with `OPB_LIVE=1 bun test` against the same instance.

## Findings from the tools

### 1. `paste` 1.0.15 unmaintained, RUSTSEC-2024-0436 (accepted)

Transitive through `soroban-sdk`. The advisory is in the "no longer
maintained" class and carries no vulnerability rating. It needs an SDK change
to go away; `cargo audit` reports no vulnerability.

### 1b. `crypto-bigint` 0.5.5, RUSTSEC-2026-0387 (accepted, not in the wasm)

Published 23 October 2026: timing variability in operations meant to be
constant-time. The crate reaches this repository only through
`soroban-env-host` (`k256`, `p256`, `elliptic-curve`), which `soroban-sdk`
pulls in for the native test host. `cargo tree --target wasm32v1-none -e
normal` lists no `soroban-env-host`, `k256`, `p256`, `elliptic-curve`,
`crypto-bigint` or `paste` for the interpreter or the adapter, so the deployed
bytes never contain it, and the tests run no secret-dependent arithmetic. The
fix is `crypto-bigint` 0.7.6, which `elliptic-curve` 0.13 cannot take; there is
no fixed 0.5.x, and `soroban-sdk` 27 and 28 both lock 0.5.5. The ignore, with
this reason, is in `contracts/stellar/policy-interpreter/.cargo/audit.toml`,
where CI's `cargo audit` runs; lift it once `soroban-sdk` moves.

### 2. `bun audit`: no vulnerability (resolved)

The earlier lock had seven advisories: four in `@modelcontextprotocol/sdk`
1.31.0, a direct dependency of the MCP server (GHSA-22jm-h49p-29qw,
GHSA-46jr-4wx8-v453, GHSA-6prh-2h8m-c8cw, GHSA-rvq5-wwqv-78pq), two in
`follow-redirects` 1.16.0 through `@stellar/stellar-sdk` (GHSA-q3jh-wrc6-jgq8,
GHSA-8r9p-f939-6h3c) and one in `hono` 4.13.9 through the MCP SDK
(GHSA-5r4p-p66f-jhc7). The lockfile now holds the MCP SDK at 1.32.1, and the
root `overrides` in `package.json` hold `follow-redirects` at 1.16.1 or later
and `hono` at 4.13.11 or later (locked 4.13.13).

The new versions alone fix five of the seven: GHSA-22jm-h49p-29qw,
GHSA-6prh-2h8m-c8cw, the two in `follow-redirects` and the one in `hono`.
GHSA-46jr-4wx8-v453, one large `tools/call` that exhausts the server's memory
during validation, is fixed by the new version together with its opt-in
`maxToolInputElements`, which the server sets to 10,000
(`policy-builder-mcp/src/server.ts`). Without the option, one 1 MiB call
raised the HTTP server's memory by about 480 MB and drew a 26 MB error; with
it the call is refused before validation, peak memory stays near 111 MB and the
error is 230 bytes. `policy-builder-mcp/test/http.test.ts` checks the refusal.
GHSA-rvq5-wwqv-78pq concerns bearer authentication (`expectedResource`), and
the server has none, so it does not apply; a bearer token added later (S-11)
must set it.

`bun audit` finds no vulnerability, and CI runs it on every pull request. It
matches by version range only; the test above is what checks the option.
Threat model row T-27.

### 3. Scout and clippy

**Clippy pedantic and nursery** (`clippy-pedantic.log`, this tree): style
warnings only. Every cast, panic, unwrap, indexing or overflow lint sits in
test code; the contract source has none.

**Scout** (`scout-audit.log`, 27 August 2026, commit `5bae0a8`; its line
numbers are that commit's). The nine medium findings, each reviewed with no
change:

- *Unbounded operations* x3: the walks are bounded by the instance's byte cap,
  depth, leaf and `in`-operand limits, fixed at deployment.
- *Dynamic types in persistent storage* x2: the master signer set is a
  `Vec<Signer>` because it mirrors OpenZeppelin's rule shape, capped at 16.
- *Vec or Map parameters without validating their contents* x2: both are
  validated. `enforce` checks the authenticated set (empty only for a keyless
  bound rule) and re-hashes the rule's signer set against the stored hash;
  `rotate_master_signer_set` checks the new set as `install` does.
- *Storage operation without access control* x1: the line is a `push_back` on a
  local vector inside `literal_to_val`. `dsl.rs` makes no storage call, so the
  lint matched an in-memory push. The contract's storage writes sit behind
  `require_auth` or `require_master` on every path.
- *Unsafe Map access* x1: `map.get(field)` returns an `Option`; the panicking
  variant is `get_unchecked`, which the code does not use. An absent field
  resolves to "no value" and the call does not trap.

On this tree, `cargo scout-audit` 0.3.16 with the command below stopped while
building its detector helper (`scout-driver`, `cargo +nightly-2025-08-07 build`)
on our build host; running it again is a follow-up.

### 4. Entry points against the Stellar Security Portal corpus

Pulled from the portal's open API on 4 August 2026: 832 findings, 150 critical
or high, most of them in the access-control class. The interpreter's entry
points against that class:

| Entry point | Control |
| --- | --- |
| `install` | `smart_account.require_auth()` on every install, the first included, so a rule id cannot be pre-seeded; on a re-install also `require_master`, the same admin set and the next `install_nonce` |
| `bind_executor` | the account's authorisation and `require_master`; a rule scoped to the executor must pin `call_fn == run` or an immediate batch (221) |
| `enforce` | `smart_account.require_auth()`; an empty authenticated set only for a keyless bound rule with one policy (210); the bound executor's authorisation of the exact context; the stored signer hash must equal the live one (204) |
| `uninstall` | `require_master` |
| `rotate_master_signer_set` | the account's authorisation and `require_master` on the current set |
| `check` | always fails, so nothing it reads or calls persists |
| `limits`, `grammar_version` | read only |

`require_master` refuses an empty set, so zero `require_auth` calls never count
as satisfied: the corpus's "authorisation that silently does nothing" class.
The nonce covers its replay class.

### 5. The OpenZeppelin policies the builder pins

`simple_threshold`, `weighted_threshold` and `spending_limit` are OpenZeppelin
example contracts that we built and deployed ourselves: on testnet from
`OpenZeppelin/stellar-contracts` tag `v0.8.0` (`ddc327e`, deployed 26 October
2026), on mainnet from tag `v0.7.2` (`a9c4216`, 9 June 2026). We did not audit
them. Addresses, wasm hashes, the build command and the superseded testnet
`v0.7.2` instances are in `deployments/oz-policies.json`; the addresses are
`SPENDING_LIMIT`, `OZ_THRESHOLD` and `SUPERSEDED_OZ_POLICIES` in
`packages/policy-synth/src/config.ts`.

- From `v0.7.2` to `v0.8.0` the code of `policies/` changes in `spending_limit`
  only: a transfer of amount 0 is always permitted (before, it was refused once
  a lowered limit sat below the total already spent), and the history cap drops
  from 1,000 to 815 entries (the most one ledger entry holds).
  `simple_threshold` and `weighted_threshold` change in comments only, and the
  `Policy` trait is identical, so the `v0.8.0` policies also serve 0.7.2-line
  accounts. Every wasm hash differs because the workspace moved from
  soroban-sdk 26.1.0 to 28.0.0.
- `v0.8.0` ships an upstream diff audit (`audits/Stellar Contracts Library
  v0.8.0 Audit.pdf`, snapshots `fbfde38` to `a5bd8cb`) whose scope names
  `policies/spending_limit.rs` and `smart_account/mod.rs` and `storage.rs`.
  We did not review it further.
- For the mainnet `v0.7.2` builds: `policies/spending_limit.rs` is byte-identical between `v0.7.0` and `v0.7.2`,
  and `v0.7.0` is the newest audit in the upstream `audits/` directory, whose
  scope names the file.
- Two findings of that audit touch this path, and both fixes are in what we
  deployed: L-06 (a negative amount) by the `amount < 0` refusal in `enforce`,
  and H-01 (rule selection changed after signing) by `do_check_auth` adding
  `context_rule_ids` to the signed preimage.
- Upstream ships them "as is". Deploying them beside the interpreter inherits
  that risk.

**Composition:** OpenZeppelin runs every policy on a rule and requires all of
them, so a refusal by any one is decisive. A rule with no policy needs every
signer; a rule with any policy leaves the signer count to its policies, so one
signer can act alone unless a threshold policy counts them.
`oz-threshold-live.log` shows `simple_threshold(2)` refusing one signer (3202)
and permitting two, and `install_policy` refusing a weighted threshold that one
signer meets alone. `simple_threshold` checks the threshold against the signer count at
install only; the interpreter's stored signer hash refuses every call once the
signers change (204), so a signer added behind the threshold breaks the rule
instead of lowering the bar.

## Reproducing the Scout run

`cargo-scout-audit` 0.3.16 cannot analyse a `soroban-sdk` 27 crate unpatched,
and reports a build that never compiled as `Analyzed` with 0 findings. Confirm
a compiled artifact exists under `target/dylint/` before quoting any Scout
number.

```sh
rustup target add wasm32v1-none --toolchain nightly-2025-08-07
cargo scout-audit --manifest-path ./Cargo.toml --exclude storage-change-events -- \
  -Ztarget-applies-to-host -Zhost-config \
  --config 'host.rustflags=["-Zcrate-attr=feature(round_char_boundary)"]'
```

`storage-change-events` is excluded because it overflows the rustc stack.
