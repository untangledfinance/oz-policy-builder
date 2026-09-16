# Deterministic adapter production Blend flow

Date: 2026-09-16. Network: Stellar TESTNET only.

## Result

The prior deterministic activation/execution gap is closed: a fresh disposable OZ Prime deployed its adapter using Prime-authorized CreateContractV2, installed the exact two production `scopedBlendExecutionPlans`, then supplied and withdrew against the real Blend v2 testnet pool through that same deterministic instance.

The original live runner completed 11 checks and 10 successful ledger transactions. The read-only verifier independently fetches and validates activation, all three original policy installations, supply, withdrawal and allowance-revocation receipts, inspects current contract instances, regenerates the production document, and confirms cleanup. Every fetched transaction envelope is hashed and compared with its recorded transaction hash; missing or unsuccessful receipts fail verification.

No fixture-only or pull-only plan was installed. The original run began with a fresh Prime and left exactly its owner default rule and three scoped agent rules (adapter, token, pool).

The same disposable Prime was subsequently reused for the app migration verification. Its original scoped rules 1, 2 and 3 were deliberately removed and replaced by action-specific app policies. Current rule storage is therefore not evidence of the original mandate. The verifier proves the original document from immutable installation receipts, including scope, agent operator, owner administrator, grammar 6, nonce 1 and exact predicate bytes/hash. Current code/binding, zero idle balances, allowance and scope checks remain mandatory. The separate migration history is recorded in `/home/ubuntu/work/octopos-scoped-execution/docs/execution-install-app-testnet.json`; the original evidence JSON and transaction fixtures remain unchanged.

## Exact deployment

| Item | Value |
| --- | --- |
| Fresh Prime | `CA5VDORFDCJJWBGH5D7MFVBFCPQVA6CWFJVZRBYG27NKDGASHWMYURAH` |
| Deterministic adapter | `CCCAO7XWJLLPA3HXQP3BSOJ4NDABXH3GJPNB6LWPASE3NZ24VGFZ3WBW` |
| Interpreter | `CASWUYJKTCLMMOQ5R36EEWX6GHI2TCPCTWWJTCODBQ632ODAWNWMDPZP` |
| Adapter WASM SHA-256 | `719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c` |
| Interpreter WASM SHA-256 | `67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a` |
| OZ account WASM SHA-256 | `91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9` |
| Production predicate hash | `ba7f131a72898bacdeb4ec035d294e61f6ffbbeebd349e48d3b5076c97e54a64` |
| Salt | SHA-256 of `prime-execution:v2` |
| Asset | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Blend pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |

The adapter artifact was fetched from ledger code storage: 2,095 bytes, matching the pinned SHA-256. Instance inspection confirms both immutable bindings and both deployed code hashes. The activation receipt confirms Prime as deployer, the exact salt, both constructor arguments, and a Prime address-credential CreateContractV2 authorization. The owner signed the inner transaction; the distinct disposable agent paid the fee bump.

## Ledger receipts

| Action | Ledger | Transaction hash |
| --- | --- | --- |
| Prime-owned deterministic activation | 4704012 | `09f50d3c913defe86fc613d6cd24bbcd5c4f8fe03ed5a163da6b9b0799540512` |
| Install original adapter rule 1 | 4704013 | `32d2050383c1349e21114e7dfd7fa628757a7055015f10cf77aa40c19e30423d` |
| Install original token rule 2 | 4704014 | `e7c44f9acb70d774cf39c18071a97897ee2dbcb90912dd5b2e08ed26a4ed13aa` |
| Install original pool rule 3 | 4704015 | `639dab3e7616e8002228979e645b0208634879f783816b292373a162a61aa5a5` |
| Supply 10,000,000 base units | 4704017 | `f7057cfeb43fedef86127e319bf1a4543fdc9a250e469200ea0657fb221f9398` |
| Withdraw 2,000,000 base units | 4704019 | `dba11e39e8c05bbf311528105f321fe3d7a28def18f237710424c8673f93c4a9` |
| Revoke allowance | 4704023 | `52953908db609f66a33cebc6ee9dd78fe301273b8afc3c322c3ca8b54221f3f2` |

All seven receipt checks require independently retrieved SUCCESS status. Both venue transaction envelopes target `execute` on the deterministic address above.

Supply receipt token events are exactly custody → deterministic adapter → Blend, each for 10,000,000. Withdrawal token events are exactly Blend → custody for 2,000,000. The custody balance changed by those exact amounts during the agent-funded trades. The Prime and adapter held zero token balance after each trade; each scope was inactive.

The original remaining Blend supply position was intentional after a partial withdrawal: 3,930,177 pool supply-share units, not underlying token units. Subsequent app verification may change that position; this historical figure is not a claim about its current share balance. There is no Prime or adapter token dust. Final custody allowance to Prime is zero; custody allowance to the adapter was never granted. The runner revokes a nonzero allowance in a `finally` block.

## Negative checks and boundaries

Authorization-enforcing RPC simulations rejected the production pull-only batch, unequal pull/supply amounts, and a standalone `transfer_from` naming the scoped token rule. The unchanged-state checks passed. These are simulation denials, not submitted failed transactions. A fresh supply after allowance revocation fails with the token's allowance error; that is not misreported as a policy denial.

This verifies the deterministic adapter plus exact production scoped document through actual on-ledger execution. It does not claim a browser wallet flow, mainnet deployment, or closure of overlapping permissions on other accounts. Those are separate integration/review tasks. The original fresh Prime had no overlapping independent agent rule; later app migration results describe its subsequent authority state.

## Reproduce / inspect

```bash
# No secrets required; reads public evidence and current RPC state.
bun scripts/deterministic-execution-flow.ts --verify

# A new disposable testnet run. Never point at real wallet state.
DETERMINISTIC_EXECUTION_STATE=/tmp/prime-deterministic-new-state.json \
  bun scripts/deterministic-execution-flow.ts
```

Files:
- `scripts/deterministic-execution-flow.ts`: production-only live runner plus read-only verifier.
- `docs/deterministic-execution-flow-evidence.json`: public parameters, 11 checks, snapshots, installation rule XDR, all ledger receipt envelope/result/meta XDR.
- `docs/deterministic-execution-flow-verification.json`: independently refetched receipts and current deployment/cleanup observations.

Disposable keys are confined to `/tmp/prime-deterministic-production-flow-state.json`, verified mode 0600, outside Git. No real-wallet key or existing wallet configuration was accessed; no secret key was printed.
