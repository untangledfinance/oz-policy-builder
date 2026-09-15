# Prime generic executor: testnet verification

Experimental prototype on Stellar Testnet, 15 September 2026. This verifies feasibility and the listed controls; it is not production integration or a security audit.

## What was implemented

The executor accepts an ordered list of arbitrary Soroban calls:

```rust
Call {
    target: Address,
    function_name: Symbol,
    args: Vec<Val>,
    executor_authorizations: Vec<InvokerContractAuthEntry>,
}

execute(prime: Address, calls: Vec<Call>) -> Vec<Val>
```

Its constructor permanently binds one Prime address. It checks that binding, requires Prime authorization on the complete call arguments, executes calls in order, and propagates failures. The same WASM supports every protocol; there are no template IDs, protocol branches, mandatory funding step, or upgrade administrator. It caps a batch at eight calls.

A separate experimental OZ policy inspects each actual call and every nested executor authorization with the existing predicate evaluator. The live configuration allows at most three calls, exact token/venue/function/address constraints, and positive amounts strictly below the configured cap. Executor authorization trees are bounded and contract-creation entries are rejected. This bridge is necessary: the current policy interpreter does not itself validate this new arbitrary batch surface.

The implementation lives in an isolated oz-policy-builder worktree:
`/home/ubuntu/work/prime-executor-testnet`, branch `spike/generic-executor-testnet`.
The existing application repositories were not integrated or deployed.

## Funding and ownership

The custody wallet approves a finite allowance to Prime. The executor has no custody allowance.

For supply, one transaction executes:

1. Token `transfer_from(Prime, custody, executor, amount)`.
2. Blend `submit(Prime, executor, custody, requests)`, with exact nested token-transfer authorization from the executor to Blend.

Underlying tokens follow **custody → executor → Blend**. Prime owns the resulting Blend position, but underlying tokens do not pass through Prime's token balance. The executor is a temporary token holder inside the transaction.

For withdrawal, Blend sends underlying tokens directly to custody. A call without funding simply omits the token-transfer call.

## Security finding and correction

The initially proposed unbound executor was unsafe for residual balances: a stranger could select their own authority and transfer tokens out of the shared executor. A native regression test reproduced this against the implemented unbound version.

The minimal correction was an immutable Prime binding per executor instance. The stranger attack now fails before executing any call. This preserves one generic implementation across venues, while preventing one Prime from controlling another Prime's executor.

This does **not** establish an enforced zero-residual-balance invariant. An authorized plan can still pull funds without using them, or mismatch separately allowed amounts. The tested supply plans finish with zero executor balance; enforcing economic completeness requires additional policy constraints or explicit balance postconditions before production use.

## Verification method

- Native tests: four executor tests and seven policy tests. Authorization mocks are confined to native mechanics/configuration tests; live tests use the actual deployed OZ account and delegated signer authentication.
- Live harness: twelve named checks using fresh faucet-funded custody, agent, and stranger accounts.
- Successful flows are submitted to testnet and checked through transaction receipts, balances, allowances, positions, and fixture state.
- Policy denials are tested by an authorization-enforcing RPC simulation with the actual OZ signature payload and source signer, and must return experimental policy error 900. They are not described as failed ledger transactions.
- The authority-substitution and revoked-allowance checks fail during RPC simulation.
- For rollback, a valid agent transaction is simulated and signed first. A separate custody transaction then enables a fixture failure. The unchanged signed batch is submitted and fails on ledger. Before/after snapshots are taken around that failed transaction; the agent pays its fee.
- A read-only receipt verifier checks token-transfer events, archived envelope/result/meta XDR, and the failed transaction's diagnostic ordering: the token pull returns before the fixture traps, and no contract events are committed.

## Scope and limits

- Real venue coverage is Blend v2 Testnet supply and withdrawal with native XLM. Other protocols are not verified by this result.
- The no-funding action and induced final failure use an explicitly deployed test fixture. They establish the mechanism, not a real venue's claim/pause ABI or permissions.
- The above-cap example uses a fresh local owner key and a separate higher-limit rule. Freighter/MetaMask prompts, a UI approval queue, and automatic escalation routing are not tested.
- Amount caps are per call, not aggregate per batch or rolling spend budgets. A finite custody allowance bounds total pulls until it is exhausted, expires, or is changed.
- Immutable configuration is deliberate in this prototype. Production policy administration, uninstall/reinstall semantics, TTL restoration/extension, and account recovery require design and review.
- Whole-plan validation applies to execute invocations. This prototype also installs agent rules for the individually permitted token/pool/fixture contexts. An agent may invoke a permitted custody-to-executor pull directly and leave funds there. Production integration must decide whether to require the batch entry point and examine every authorization path, including owner powers.
- Atomicity covers state changes in this Soroban transaction. Transaction fees are still charged on failure.
- Testnet allowance is revoked at the end. Fresh test keys remain only in an external mode-0600 temporary file for resuming the experiment; no existing wallet keys or environment credentials are imported or committed.

## Reproduce

Prerequisites: Bun, Rust with `wasm32v1-none`, and network access to Stellar Testnet RPC and Friendbot. Rust contract dependencies are locked, with soroban-sdk exactly 27.0.2.

From this worktree:

```bash
bun install --frozen-lockfile
export CARGO_TARGET_DIR="$PWD/target"

cargo test --locked --manifest-path contracts/execution-adapter/Cargo.toml
cargo test --locked --manifest-path contracts/execution-policy/Cargo.toml

cargo build --locked --release --target wasm32v1-none --manifest-path contracts/execution-adapter/Cargo.toml
cargo build --locked --release --target wasm32v1-none --manifest-path contracts/execution-policy/Cargo.toml
cargo build --locked --release --target wasm32v1-none --manifest-path contracts/execution-test-venue/Cargo.toml

EXECUTOR_TESTNET_STATE=/tmp/prime-executor-my-fresh-run.json bun scripts/execution-adapter-testnet.ts
bun scripts/execution-adapter-receipts.ts
```

Use a previously unused state filename for a fresh run. The harness rejects recorded WASM hash mismatches before any network action or report rewrite. It resumes completed steps when the same state file is reused; a resumed completed run does not perform all tests again. Testnet resets, archival, venue availability, or expired allowance may require a fresh run. Public evidence files are replaced by the selected run.

`EXECUTOR_BUILD_DIR` optionally selects another WASM build directory. The network and passphrase are fixed to TESTNET.

## Source provenance

- oz-policy-builder baseline: `f9a6e6077511d6480a481d01d5b1fc103a5a94a2`.
- Existing prime-ts-sdk inspected: `0fcbb0c325d2bebc077fa944a7899c342a0bd29e`. Its OZ authorization helper is copied with attribution into `scripts/execution-oz-auth.ts` so this harness has no absolute external source import.
- Existing octopos inspected: `0bfea99228153b938363a535c52478a9abda8a6e`.
- OZ account WASM comes from the existing policy-interpreter test fixture; its SHA-256 is included in the run evidence.
- The policy includes the baseline interpreter's DSL evaluator and ABI types by source path; original interpreter files are unchanged.

## Final run results

**12/12 testnet checks and 11/11 native tests passed.** Five execution receipts were independently re-read and checked. Four deployed instance hashes (including OZ) were read directly from ledger entries and matched the recorded WASMs. The stale-build runner guard also passed its negative check.

| Check | Evidence |
|---|---|
| initial allowance | Ledger receipt and state checks |
| real Blend atomic supply | Ledger receipt and state checks |
| no-funding action | Ledger receipt and state checks |
| withdraw directly to custody | Ledger receipt and state checks |
| over-cap denial | Authenticated RPC simulation: policy error 900 |
| wrong funding destination denial | Authenticated RPC simulation: policy error 900 |
| unapproved extra call denial | Authenticated RPC simulation: policy error 900 |
| malicious executor authorization denial | Authenticated RPC simulation: policy error 900 |
| different Prime rejected | RPC simulation rejection |
| human-authorized over-cap supply | Ledger receipt and state checks |
| on-ledger late failure rollback | FAILED ledger receipt, pull-before-trap trace, identical before/after state |
| allowance revocation blocks agent | RPC simulation rejection |

### Execution receipts

| Execution | Ledger | Result | Transaction |
|---|---:|---|---|
| agent atomic Blend supply | 4694361 | SUCCESS | [View receipt](https://stellar.expert/explorer/testnet/tx/cf9c1151bf6da1e2d83b8102aaca44015aa65c3734ca5494ffa4d0953fda0b85) |
| agent no-funding fixture action | 4694362 | SUCCESS | [View receipt](https://stellar.expert/explorer/testnet/tx/ccb4646aa5752072df322c1134c273d05b29a0cda12a8fa31c9694ea81081539) |
| agent Blend withdraw to custody | 4694364 | SUCCESS | [View receipt](https://stellar.expert/explorer/testnet/tx/26b95220ecae1f34717113a20e2742f56292b96eb167e7423aa3e85e33d10cb7) |
| human approved above agent cap | 4694369 | SUCCESS | [View receipt](https://stellar.expert/explorer/testnet/tx/a3946601b864a5ce0040b4c1616fa9a86e0b29af45b0d2006a161ef4e2a08788) |
| signed batch fails on ledger after pull | 4694372 | FAILED | [View receipt](https://stellar.expert/explorer/testnet/tx/fc83486820611e553127b0cb1355adcecfa69fe6eff0bfd367308e330a17be8a) |

### Deployed contracts

| Component | Testnet contract |
|---|---|
| prime | `CCNJO6DTS6IMQFJV5ZMMIEKGGIDBSPU45ICVG3V4GVBWGWIKEWD6JBIA` |
| executor | `CDIJJICD27DVP3IHDH35CGYVRLM43IR2JQWBMPV5WWEN2UZ62TPX32QK` |
| policy | `CA6UGOMBLPMMYFRZZFCDP4IIPR3BG4A2MWJKA7S7W7GRRDKHETUTIG26` |
| fixture | `CCFLPM3Z2N33GBQHQYMVYQSADYNJPHGTAYO5JKVHXUFYQTC46WQPURWB` |
| Real Blend pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |

### Verified WASM hashes

- prime: `91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9`
- executor: `8e99693479f7132345d1dc09eecd71e93650d32e0e88a1e5a4ed9c97a01e2028`
- policy: `5e7a3de628129ff8c302770ff88d21d9d1c67c518054db53de69c2b6080e9f97`
- fixture: `16e42f2622e25f1ff06c1e90f0867c278fe8ee28903d3b86c455765e3543f447`

### Failed-batch invariants

| State | Before | After |
|---|---:|---:|
| custody | 99923810912 | 99923810912 |
| prime | 0 | 0 |
| executor | 0 | 0 |
| allowance | 65000000 | 65000000 |
| position | 16254140 | 16254140 |
| fixture | 7 | 7 |

Amounts above use base units (10,000,000 per XLM); position values are Blend supply shares, not underlying XLM. The agent paid the failed transaction fee. The final custody allowance was then explicitly revoked.

### Review and preserved evidence

An independent read-only code review found no Critical issue in the prototype core. Its Important finding (stale-state WASM misattribution) was corrected with a fail-closed startup guard and direct on-ledger hash verification. Its direct-call limitation is documented above. This review did not constitute an audit or production approval.

Public machine-readable files:

- `docs/execution-adapter-testnet-evidence.json`: addresses, rules, all setup/execution transaction hashes, 12 check results and snapshots.
- `docs/execution-adapter-testnet-receipts.json`: five verified receipt envelopes/results/metadata, decoded transfer and diagnostic events, and deployed WASM hash proofs.
- `docs/execution-adapter-local-tests.txt`: native test output.
