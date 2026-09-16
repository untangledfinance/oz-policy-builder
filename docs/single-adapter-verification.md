# Single-adapter implementation and verification

Date: 2026-09-16. Owner: this implementation session; Prime session performs independent verification next.

## Result
Implemented and testnet-verified: one small ExecutionAdapter, the existing OZ account unchanged, and execution support inside a new version of the existing PolicyInterpreter. No separate ExecutionPolicy is used by this implementation.

**Deployment implication:** a new interpreter v6 instance is required alongside adapter v2. This is one new contract TYPE, not one total WASM upload. Existing v5 instances are immutable and are not silently upgraded. V6 still accepts ordinary v5 documents; execution_v1 documents require v6. No existing rules or positions are migrated.

Adapter: 78 source lines including imports/types/test declaration, 2,095-byte optimized WASM. Binds Prime + interpreter immutably. Constructor takes (prime, interpreter); execute(prime,calls) ABI stays unchanged. Salt namespace is prime-execution:v2.

## How authorization works
Adapter opens a scope in the interpreter using its contract authorization, requests Prime authorization of the whole batch, invokes every call, and closes the scope.
The interpreter validates an exact ordered plan and every recursive adapter-authorization node. Generic equality links enforce matching pull/supply/transfer amounts. Scoped child contexts must match a validated call and consume its slot. Different documents/operator sets cannot consume the scope.
The entire scope is explicitly removed on success, including unused/no-auth slots. Failure propagates and rolls scope creation back. Temporary storage is ledger-backed; this design does NOT assume transaction-local storage.

The production Blend builder permits [pull, supply] or [withdraw], with positive strict amount caps, pinned Prime/recipient/asset/pool and exact authorization shapes. No partial-funding-only plan is installed by the production builder. The test harness explicitly adds fixture-only and rollback plans for testing; those are not production Blend templates.

## Evidence
- 146 interpreter Rust tests passed, including 10 execution tests; 5 adapter tests passed.
- 7 targeted builder tests passed; policy-synth typecheck passed.
- 26 SDK execution tests passed; SDK typecheck passed.
- 18 testnet execution checks passed with actual OZ WASM/delegated authorization and real Blend v2.
- 13 activation checks passed, including actual Prime-authorized CreateContractV2, separate fee payer, immutable interpreter binding and rejected tampering.
- Read-only receipt verification confirmed transfer events: custody → adapter → Blend; withdrawal Blend → custody. Prime token balance remained zero.
- Submitted late-failure transaction FAILED after the token pull, with no committed events and unchanged custody, allowance, Prime balance, adapter balance, position, fixture state and inactive scope.
- Agent allowance was revoked at the end.
- SDK-generated activation bytes exactly match the actual deployment; SDK inspection verifies address, Prime binding, interpreter binding and both WASM hashes.
- A repeat optimized build reproduced both hashes below.

Receipts and simulation denials are distinguished in the JSON evidence. Most adversarial denials are real authorization-enforcing RPC simulations, not submitted failed transactions. The late rollback is a submitted ledger failure.
Standalone withdrawal was rejected by missing adapter authorization before Prime policy evaluation; this is not misreported as an interpreter #903 denial.

### Artifacts
| Artifact | Value |
| --- | --- |
| Adapter WASM | 719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c |
| Interpreter WASM | 67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a |
| Testnet interpreter v6 | CASWUYJKTCLMMOQ5R36EEWX6GHI2TCPCTWWJTCODBQ632ODAWNWMDPZP |
| Verification Prime | CARTYEXSQGOHDAS2RB7V4TNKGISDALJR3ZLR4T44MPBUV4SAP3ZYXNSD |
| Deterministic adapter v2 | CD6MAW454J3XXEADNGF26DXCU4RMJRTEIYH3BY2IF5RX5JTGC6R2TZHJ |
| Activation tx | cc6727a7cd2440823a3d378ed957d7f81961a2bda23502f72e39b50abc32cdd8 |
| Supply tx | 0eb60f15dbcf96d43931b4811ec8f4db1279de417fa8aa86292a2f7b5a94acc6 |
| Withdraw tx | 0bc70d693c517e89714fe562ff5c770dbe5370d4e29fbd988318d96f7e32b366 |
| Submitted rollback tx | c70ab47c23045525aeb14868668040e57491813c9513091934ae6167cdc1ddcc |

Supply/withdraw execution used a separate instance of the same verified adapter artifact and bindings, CB2ZF5NVLDHKS4IFGRRQEFHMNPFC4MOUFC7ISEPGKDBH4TDKAZR3NKDB. Deterministic activation was then verified separately. Do not claim a trade through the deterministic instance yet.

## Reproduction
Working tree: /home/ubuntu/work/prime-executor-testnet, branch feat/single-adapter-scoped-execution.
SDK tree: /home/ubuntu/work/prime-sdk-scoped, branch feat/scoped-execution-v2.

```bash
cargo test --manifest-path contracts/policy-interpreter/Cargo.toml
cargo test --manifest-path contracts/execution-adapter/Cargo.toml --lib
bun test packages/policy-synth/src/install/scoped-execution.test.ts packages/policy-synth/src/install/venue-execution-mandate.test.ts
bunx tsc --noEmit -p packages/policy-synth/tsconfig.json
stellar contract build --manifest-path contracts/policy-interpreter/Cargo.toml
stellar contract build --manifest-path contracts/execution-adapter/Cargo.toml
bun scripts/single-adapter-receipts.ts
bun scripts/single-adapter-activation.ts --verify
PRIME_SCOPED_SDK=/home/ubuntu/work/prime-sdk-scoped bun scripts/single-adapter-sdk-verify.ts
```
For fresh execution, set EXECUTOR_TESTNET_STATE to a NEW /tmp path and EXECUTOR_BUILD_DIR to the release artifact directory, then run scripts/single-adapter-testnet.ts. Also build execution-test-venue for the harness. Never reuse state with different WASMs; the runner rejects that.
Public evidence JSON contains no keys. Disposable private state stays in /tmp, mode 0600, outside Git.
Use distinct Cargo target directories for independent crate jobs. Reusing one target while switching the interpreter between primary crate and dev-dependency produced a stale-artifact SDK type mismatch; cleaning that package resolved it.

## Prime's independent verification and remaining integration
1. Review scope begin/end authentication, exact plan/auth matching, equality links, operator/document binding, rollback/cleanup, reentrancy and deliberately unconsumed slots. Reproduce tests rather than treating this report as approval.
2. Reproduce WASMs/hashes and public receipts. Test an end-to-end action through the deterministic v2 instance. Stress hostile nested auth and same-transaction multi-batch/reentry cases.
3. Integrate the corrected format into octopos only after review. Its old ExecutionPolicy UI remains disabled. Existing venue templates must use the v6 execution envelope, not install a separate policy ABI/card. Preserve Activate-before-Apply, inputs, owner/admin semantics and exact address+both-code+both-binding checks. Adapt display/discovery so execution_v1 documents are recognized. SDK V2_TESTNET manifest is explicit; legacy default V1 remains unchanged to avoid silent migration.
4. Mainnet is NOT verified or deployed by this session. Use the previously authorized dedicated account/minimal own-funds procedure after independent review, publish exact network pins, and verify actual UI/SDK activation → policy install → venue operation → allowance cleanup.
5. Existing independently authorized agent rules can still authorize their own operations. Account-wide batch-only claims require reviewing/explicitly retiring overlapping rules; no silent rule migration.
6. This is internal verification, not an external audit. Unknown venue semantics remain a policy-authoring responsibility. Generic batch atomicity does not prove economic safety.

SDK build warning: Soroban spec generation reports the SDK-native InvokerContractAuthEntry as missing from the contract spec. Explicit XDR builders work and are exercised here; generic autogenerated bindings need this checked before relying on them.
