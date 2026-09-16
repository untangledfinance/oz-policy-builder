# Stateless execution deployment — mainnet

Deployed September 16, 2026 from `feat/policy-signer`, contract source commit `47df478`; testnet verification commit `a40ed75`.

- Interpreter: `CDIMIQDB6ZL6Q3TJM24HC3SU3YIKDNL2LB2GXHHVVCI4BRNHYDZGXEEW`
- Interpreter WASM SHA256: `cc05ac55747d2472f6da1fc229a2f9f8083607ba8c08bf5eaeac7cd73ef6fb66`
- Execution adapter WASM SHA256: `57bf132b9537f0d35b9de4327e047f920938eac655e7d140c108e84da3b03474`
- Deployer: `GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN`
- Verified interpreter grammar: **5**, ledger **64454688**.
- Actual charged fees across the two uploads and interpreter creation: **115.4773486 XLM**; declared cumulative fee cap **140 XLM**.

Transactions:
1. Interpreter upload: `a77ab4bf71eb9be9764c72bb0fc8371a2bdac5cf2b5745b3158fae49f12dd602`
2. Adapter upload: `0f8716e9810f049184cd96c30dfb1aebd12f81cc644f5096149bbcb6484fab1a`
3. Interpreter creation: `8c03489d4466676e03ac2a3913d9edd736347047281f833f00f640a353201a0a`

The deployment script verified local artifact hashes before signing, checked the RPC network passphrase and CLI identity, simulated each transaction, enforced reserve-adjusted funding and fee caps, persisted transaction hashes before broadcast, and verified on-chain code hashes and grammar afterward. Full public receipts are in [stateless-mainnet-deployment.json](stateless-mainnet-deployment.json).

The interpreter production diff remains **24 net lines** relative to `afa2f18`. This is a fresh interpreter, not an in-place update to old stored documents. Existing v4/v6 rules retain their original interpreter references.

## Activation and execution

Each Prime activates its own adapter by authorizing CreateContractV2 with Prime as deployer, salt `SHA256("prime.execution.adapter.v1")`, the pinned adapter WASM, and no constructor arguments. The address is deterministic for the network and Prime. The adapter has no instance storage.

Venue setup installs bounded v5 child predicates with the adapter as signer, binds them to the adapter, and only then enables the agent root predicate. The root commits to the complete projected execution request. Policy administration remains with the owner.

The wallet grants token allowance to **Prime**, never to the adapter. An authorized agent batch pulls wallet → adapter using Prime as spender, then supplies adapter → venue with the resulting position owned by Prime. All calls are one atomic Soroban transaction. No-funding actions omit the pull.

An owner may approve a single exact request under the account's existing owner rule. This does not raise the agent policy cap. Browser wallet signing and contract authorization are separate verification surfaces; see the mainnet verification report for precisely what was exercised.

## Reproduce or resume

From the repository root, with Stellar CLI on PATH:

```sh
bun scripts/deploy-stateless-mainnet.ts --fee-cap-xlm 140
bun scripts/deploy-stateless-mainnet.ts --execute --fee-cap-xlm 140
```

The default run is read-only. The script resumes its matching receipt and refuses unresolved prior broadcasts or mismatched artifacts.
