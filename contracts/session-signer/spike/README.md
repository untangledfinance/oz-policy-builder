# Testnet spike: MetaMask via NEAR once, then session keys

Run on 6 Oct 2026 on Stellar testnet and NEAR testnet. Results are in
`testnet-run.json` (addresses and transaction hashes only).

| Script | What it does |
|---|---|
| `mkacct.ts` | Creates a NEAR testnet account that plays our relayer (submits `rlp_execute`, pays gas). |
| `mm.ts` | A testnet key stands in for MetaMask. It signs a chain-398 transaction calling `v1.signer-prod.testnet.sign`, which the relayer submits through the account's NEP-518 wallet contract, as `apps/prime-relayer` does on mainnet. Returns the MPC ed25519 signature. |
| `near.ts` | Derives the MPC-controlled Stellar key (`prime:<id>/stellar-1`), the same math as `octopos/packages/prime-core/src/derive.ts`, checked against `derived_public_key`. |
| `setup1.ts` | Creates a Prime Account whose rule 0 is A (the NEAR key), B and C with `simple_threshold` 2, deploys `session-signer` bound to the MetaMask address and the account, and funds the account. No NEAR signature. |
| `setup2.ts` | The one NEAR-signed step: `add_context_rule` for a rule scoped to the XLM contract, signer `session-signer`, policy the pinned testnet interpreter (`transfer`, to the venue only). A signs through NEAR, B co-signs. |
| `moves.ts` | Sessions with no NEAR signature: a fresh ed25519 key plus one EIP-712 signature from the MetaMask key per session, then the allowed and refused cases. |
| `vector.ts`, `t-mmlib.ts` | The EIP-712 vector the Rust tests pin, and a check that MetaMask's own `@metamask/eth-sig-util` produces the same signature as viem. |

Secrets (`secrets/`) are generated on first run and are not committed.
