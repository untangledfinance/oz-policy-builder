# Testnet spike: MetaMask via NEAR once, then session keys

Run on 6 Oct 2026 on Stellar testnet and NEAR testnet. `testnet-run.json`
holds addresses and transaction hashes only (it also keeps the first run,
against the earlier contract, under `signer`, `installTx` and `movesA/B`).

| Script | What it does |
|---|---|
| `mkacct.ts` | Creates a NEAR testnet account that plays our relayer (submits `rlp_execute`, pays gas). |
| `mm.ts` | A testnet key stands in for MetaMask. It signs a chain-398 transaction calling `v1.signer-prod.testnet.sign`, which the relayer submits through the account's NEP-518 wallet contract, as `apps/prime-relayer` does on mainnet. Returns the MPC ed25519 signature. |
| `near.ts` | Derives the MPC-controlled Stellar key (`prime:<id>/stellar-1`), the same math as `octopos/packages/prime-core/src/derive.ts`, checked against `derived_public_key`. |
| `setup1.ts` | Creates a Prime Account whose rule 0 is A (the NEAR key), B and C with `simple_threshold` 2, and funds it. No NEAR signature. |
| `setup2.ts` | Deploys `session-signer` bound to the MetaMask address, then installs two session rules, each approved by rule 0: A through NEAR (one MPC signature) plus B. `session_blend`: Blend TestnetV2 `submit` for this account only, one request, kinds 0-3 (no borrow). `session_xlm`: XLM `transfer` to the pool only. |
| `moves.ts` | Sessions with no NEAR signature (parts a-e): supply/withdraw on Blend, refusals, instance binding, the 7-day cap, revocation, latency. |
| `vector.ts`, `t-mmlib.ts` | The EIP-712 vector the Rust tests pin, and the check that `@metamask/eth-sig-util` signs the same bytes as viem. |

| `mgmt.ts` | Owner policy management through a session with no new contract. Rule 0 stays A, B, C (2 of 3). Rule M (`owner_management`, scoped to the account itself) has signers A, S, B, C, OZ `weighted_threshold` {A:1, S:1, B:2, C:2} >= 3, and the grammar-6 interpreter (`policy_admins` = [A]) allowing only `add_context_rule` (scope `CallContract`, allowlisted targets, one signer: the session-signer) and `remove_context_rule` / `update_context_rule_*` / `add_policy` / `remove_policy` on rules above M. Parts `setup`, `a`, `a6`, `b`, `b2`, `c`, `d`, `e`, `f`, `tighten`, `g`. |

Secrets (`secrets/`) are generated on first run and are not committed.
