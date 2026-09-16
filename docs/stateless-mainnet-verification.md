# Stateless execution mainnet verification

This proof exercises the minimal v5 interpreter and stateless per-Prime execution adapter against the real Blend FixedV2 pool. It uses a dedicated test Prime and the deployer's own native XLM. No customer account or position is involved.

## Result

Completed on 2026-09-16: **10 core checks plus the standalone agent-as-source proof**, with 19 successful mainnet receipts. Total charged fees across both fee payers: **3.1712147 XLM**, below the 10 XLM bound.

All final Prime/adapter token balances, wallet allowances to both contracts, and Blend supply/collateral/liability positions are zero. Across three deposits totaling 0.02 XLM, Blend returned 0.0199997 XLM; the 3-stroop difference is conversion rounding. Maximum concurrent principal was 0.01 XLM.

| Action | Mainnet transaction | Ledger |
| --- | --- | --- |
| agent supply | [717fa8841b5f](https://stellar.expert/explorer/public/tx/717fa8841b5fa0f9bfb6cfd98755c077214941ed3497092430fca4ec1b2b742b) | 64454810 |
| owner approved over-cap supply | [ddda13419bb9](https://stellar.expert/explorer/public/tx/ddda13419bb9ed521c6185f70285aced07ca43a433cbc402869600113b4043ca) | 64454840 |
| standalone agent-source supply | [d97d52f06a4a](https://stellar.expert/explorer/public/tx/d97d52f06a4ad9764bbe8d60e7cdbbec3ee604e617e7ebedefb9c4d3cdcc869c) | 64454904 |
| standalone agent-source withdraw all | [563a79cd23b5](https://stellar.expert/explorer/public/tx/563a79cd23b5feaab1d395e9b7052d3f335931662f89d58d2b085a4ba0d07ab4) | 64454922 |

The standalone supply transaction has exactly one envelope signature, cryptographically verified against the agent public key, and the agent is its transaction fee source. Prime authorization selects rules `[3, 1, 2]` and declares only the agent and adapter signers. There is no owner authorization entry or owner transaction signature. The confirmed token events show exactly 50,000 stroops moving wallet → adapter → Blend, and the wallet balance decreased by exactly that amount.

The earlier agent-authorized supply used the deployer as an automatic fee payer; the standalone transaction above closes that distinction. The owner-approved over-cap test remains a CLI owner-signing proof, separate from browser wallet verification.

## Identities

| Component | Mainnet address |
| --- | --- |
| Interpreter | `CDIMIQDB6ZL6Q3TJM24HC3SU3YIKDNL2LB2GXHHVVCI4BRNHYDZGXEEW` |
| Dedicated Prime | `CBYG2TO43C7WIBD3KFCSJAAPODRJKAFFNNEU6YEYPF7G4YSUVG3EOC7G` |
| Stateless adapter | `CATAOK5AQMVF2UDBTEAMESTWUVSSA7NS23PG6CHOTCTKIRXVS7S5A5HX` |
| Owner / fee payer | `GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN` |
| Agent | `GCTI2WE25C3Z4CUQXKT6RSAC4NS7M7BBVLR5PM7VS6OKYQPOABLJSMXE` |
| Blend FixedV2 | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` |

Pinned interpreter WASM: `cc05ac55747d2472f6da1fc229a2f9f8083607ba8c08bf5eaeac7cd73ef6fb66`.

Pinned adapter WASM: `57bf132b9537f0d35b9de4327e047f920938eac655e7d140c108e84da3b03474`.

The adapter has no constructor arguments and no configuration storage. Its address is derived from the Prime as deployer and SHA-256 of `prime.execution.adapter.v1`. The proof checks the official Blend registry, factory membership, and pinned pool/factory code before using the pool.

## Authorization and custody

1. Install token child rule 1 and pool child rule 2, binding each to the adapter before making any agent root usable.
2. Install supply root rule 3 and withdrawal root rule 4, also binding both to the adapter.
3. Approve only the Prime to spend a small, expiring wallet allowance. The adapter never has a wallet allowance.
4. Agent supply uses rule IDs `[3, 1, 2]`, the agent's delegated authorization, and the adapter's contract authorization. The batch's complete canonical projection is constrained by rule 3.
5. The native-token transfer events must show wallet → adapter → Blend in one successful transaction; the position belongs to Prime.
6. Withdrawal sends the position proceeds directly from Blend to the wallet.
7. At the exact excluded cap, the agent is denied. The owner can sign the exact complete batch using owner rule 0 for all contexts. This does not widen or replace the agent policies.

The agent can supply a positive amount strictly below 100,000 stroops (0.01 XLM). The successful agent supply is 50,000 stroops (0.005 XLM); the owner-approved supply is 100,000 stroops (0.01 XLM). Each deposit is withdrawn before the next; at most 0.01 XLM principal is exposed at once. The harness enforces a 10 XLM total fee/principal budget and preserves a cleanup reserve.

## Reproduction

From this repository, with the existing proof signing identities configured:

```sh
# Read-only preflight; after completion, independently rechecks final state and bindings.
bun scripts/verify-stateless-mainnet.ts

# Authorized bounded mainnet proof; completed receipts are resumed.
bun scripts/verify-stateless-mainnet.ts --execute --fee-cap-xlm 10
```

For setup, cleanup, and the owner-approval test, the owner transaction envelope is signed by Stellar CLI identity `mainnet_deployer`. The existing agent key is loaded privately in memory; no secrets are persisted in the public evidence. Network requests are paced and HTTP 429 responses are retried. Transport errors are never accepted as policy-denial evidence.

## Scope of evidence

The machine-readable evidence is [stateless-mainnet-verification.json](stateless-mainnet-verification.json). It records successful transaction receipts, charged fees, transfer events, policy denials, snapshots, and the independent final-state check.

The late-failure check uses mainnet RPC simulation and is explicitly not an included failed mainnet transaction. The previously recorded testnet proof separately includes an actual failed batch demonstrating rollback.

The owner-approval mainnet proof uses a CLI-signed Stellar owner key. It verifies Soroban authorization semantics, not Freighter or MetaMask browser signing. Browser wallet integration must be assessed separately.
