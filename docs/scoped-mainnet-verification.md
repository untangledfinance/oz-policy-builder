# Scoped execution: bounded mainnet proof

Completed on 2026-09-16. Nine transactions succeeded on Stellar mainnet using a **new, dedicated OZ Prime**, the production deterministic adapter, and the grammar-6 PolicyInterpreter. This was a 0.01 XLM round trip through the official Blend FixedV2 native reserve. It did not use the custom Untangled USDC venue facade, swap assets, or touch customer positions.

The complete public envelopes, results, metadata, observations and fee accounting are in [scoped-mainnet-verification.json](audit/evidence/scoped-mainnet-verification.json). The runner is [scoped-mainnet-verify.ts](../scripts/scoped-mainnet-verify.ts).

## Identities and code

| Component | Address or SHA256 |
| --- | --- |
| Dedicated Prime | `CDZ7DPPF2H7ANQ7JRRUEGY7MKKUGNEDTND7IMEFNIMHZJVCGNPKRRMOU` |
| Prime-owned deterministic adapter | `CBCNMZ2T2L72WMO6MFMKNDLZAOG6DHB4SCIZEW33QKJU54UHDPXQN6ZL` |
| Verified v6 interpreter | `CCZDVEJOVQ2H5NDLDYLF6N47WDC2ZW7UTLY4Z5LCIL3ZMEHUMKNGW747` |
| Unchanged OZ account WASM | `91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9` |
| Adapter WASM | `719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c` |
| Interpreter WASM | `67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a` |
| Owner, custody and transaction fee payer | `GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN` |
| Distinct delegated agent | `GCTI2WE25C3Z4CUQXKT6RSAC4NS7M7BBVLR5PM7VS6OKYQPOABLJSMXE` |

The adapter address uses the Prime as deployer and salt `sha256("prime-execution:v2")`. Its deployed code and immutable Prime/interpreter bindings were read and verified.

The owner signed transaction envelopes through the existing `mainnet_deployer` CLI identity. The distinct agent signed Soroban authorization entries; the owner paid transaction fees. The agent's native balance was unchanged. No private keys were written to the evidence or logs.

## Venue verification

The pool was taken from the [official Blend deployment registry](https://github.com/blend-capital/blend-utils/blob/main/mainnet.contracts.json), with the v2 factory corroborated by [Blend's deployment documentation](https://docs.blend.capital/mainnet-deployments).

- FixedV2 pool: `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`.
- Native SAC: `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`, independently derived from Stellar's native asset and public-network passphrase.
- Official v2 factory: `CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU`.
- The factory's `is_pool` returned true. Its stored pool-code hash matched the live pool executable: `a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e`.
- Live `get_reserve_list` included the native SAC. The pool's observed native liquidity was `7645601842141922` stroops, and a read-only 0.01 XLM supply simulation succeeded before allocating the dedicated account.

The app-configured Untangled mainnet venue supports USDC and its wrapper, not native XLM. The deployer held no USDC, so that venue and other wallets' non-native assets were excluded.

## Authorization and results

The unmodified production `scopedBlendExecutionPlans` builder supplied both exact plans. The encoded document hash was `ccce15a005586e4ac54e6e6dddfd7cbf481026ebfbab98f1f79f4451ec8e5dd5`. It was installed on scoped rules 1/2/3 for adapter/native token/pool. Each new rule used nonce 1, owner policy administration and agent operation. Owner rule 0 remained unchanged.

Two enforcing simulations failed with scoped-policy errors before any corresponding transaction was broadcast:

- A standalone custody pull, bypassing the adapter.
- A batch whose pull and supply amounts differed.

The successful supply emitted exactly custody → adapter → Blend transfers of 100,000 stroops each. The withdrawal emitted Blend → custody of 99,999 stroops and removed all supply shares. The **one-stroop difference (0.0000001 XLM)** was protocol rounding; no balance or position remained in the Prime or adapter.

| Action | Ledger | Transaction |
| --- | ---: | --- |
| Create dedicated OZ Prime | 64452934 | `ff5803be279f88ccd3a5e55178be8a803c6cdb73ce77221e6a14f6b0582ce269` |
| Activate deterministic adapter | 64452935 | `34c3c5042be534001688b5942bc15ecceeb204a5043b42c9643226b6c026680c` |
| Install adapter scope | 64452976 | `a3717ff991a44ba3b3a0dd3d77175342251d8e13e78e2e3a68f9c20f509fd6fe` |
| Install native-token scope | 64452977 | `79ed771a1353c00992f2cba79c169b503ec699502816110747ce120ba2920946` |
| Install pool scope | 64452978 | `d3ea816921554b29d05d74c9e546c6244903054ab4a0bac34b1a5b6e104a236d` |
| Approve exactly 0.01 XLM | 64452979 | `51a3cb8c581bec4ac9c23af733831d933357d4bed3b7bd7da77f10a6d5ffc46a` |
| Agent-authorized supply | 64452981 | `f7dcaaa67823b36f95b936ea3d8eb94c84a2548981dc09b9a5c5791e491aadb5` |
| Agent-authorized full withdrawal | 64452982 | `5e9f83cf14b6cde3af95301de74e5f82258c32bdd4e6c531371b80a627bbc701` |
| Explicit allowance revocation | 64452984 | `8a1c2cb90f0d36cd74ad34194d0e87f8dba7d79a9b0f93f5b9a19ae6936570a8` |

Final reads: **Prime balance 0; adapter balance 0; allowance 0; supply, collateral and liability positions empty**. Deployer balance was **11.9442213 XLM**.

## Budget and reproduction

The initial 1.5 XLM guard stopped before the first scope install: its simulated fee alone was approximately 2.706 XLM. Only Prime creation and adapter activation had occurred; no allowance or supply existed then. The cap was explicitly adjusted to **10.5 XLM including the already spent fees and principal**, within the authorized 120 XLM overall deployment/verification budget.

Before resuming writes, the exact three-rule forecast plus 1.5 XLM completion reserve and prior fees/principal totaled **10.0277133 XLM**. Every transaction was simulated again and checked against the remaining cap. The runner retained a 0.4 XLM cleanup allocation before depositing. It used a 1,000-stroop inclusion bid and added the resource fee only once.

Actual proof fees were **7.2189548 XLM**. Reported core deployment fees plus this proof were **102.0557786 XLM**.

```sh
# Read-only network, venue, code and funding preflight:
bun scripts/scoped-mainnet-verify.ts

# Explicitly bounded execution/resumption for this dedicated fixture:
bun scripts/scoped-mainnet-verify.ts --execute --fee-cap-xlm 10.5
```

The completed checkpoint prevents another funded round trip. Any ambiguous broadcast must be reconciled before resumption. This proof verifies the deployed contract flow and actual authorization on mainnet; it is not a browser-wallet approval demonstration or a claim about the custom USDC facade.
