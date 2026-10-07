# One small session contract per chain; NEAR only through stock code and one 21-line signer

The full design write-up, with diagrams and testnet proofs, is [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md).

This replaces `../minimal/`. The goals were the least new code, no lines added to NEAR's open-source wallet contract, and seats kept apart from sessions.

## Routes

Each wallet uses its own key on its home chain. Elsewhere it signs through NEAR's MPC.

| Wallet | EVM (Safe + Roles) | Solana (Squads Smart Account) | Stellar (OZ account) |
|---|---|---|---|
| MetaMask | **own EOA** | NEAR **stock** eth-implicit account → MPC ed25519 | NEAR stock eth-implicit → MPC ed25519 |
| Freighter | `prime-near-signer` (SEP-53) → MPC secp256k1 | `prime-near-signer` (SEP-53) → MPC ed25519 | **own key** |
| Phantom | `prime-near-signer` → MPC secp256k1 (used in the matrices), or its **own EVM account** (real extension, fork only; below) | **own key** | `prime-near-signer` (plain text) → MPC ed25519 |

**Seats.** These keys are ordinary 2-of-3 signers: Safe owners, Squads settings signers, Stellar `Delegated` G accounts. None of our contracts is a seat, so a session key can never vote.

### Why NEAR's stock wallet serves only MetaMask

This was checked in the real Phantom 26.x extension code and with Freighter's signing path.

| Upstream `near/intents` wallet scheme | Freighter | Phantom |
|---|---|---|
| `ed25519` (raw 32-byte hash) | only signs SEP-53 or Stellar transactions | `signMessage` signs only valid UTF-8 that is not a Solana transaction (`isSafeMessage`) |
| `webauthn`, `no-sign` | n/a | n/a |
| eth-implicit (stock) | no EVM account | its EVM account cannot sign for NEAR's EVM chain (397/398): Phantom refuses chains outside its built-in list |

### `near-signer/` (21 sLOC, ours, standalone, no fork of NEAR's wallet contract)

It is deployed at `signer.prime-spike-muwguc60.testnet`, code hash `D2xgePUEzgfRysCScYruUGUFg2g8Twueuh1ipCpz3Hob`.

- **One method,** `sign(key, sep53, path, domain_id, payload, signature)`.
- **The wallet signs** the readable text `Prime NEAR signer\ncontract: <this>\npath: <path>\ndomain: <id>\npayload: <hex>`. Freighter signs it as SEP-53; Phantom signs it as plain text.
- **The contract** checks that signature with NEAR's `ed25519_verify`, then asks the MPC to sign `payload` under the path `<wallet key hex>/<path>`.
- **Key binding:** the path includes the wallet's own key, so no wallet can obtain another wallet's derived key.
- **Stateless:** replaying a request only yields another MPC signature over the same payload, so there is no nonce or storage. (The source comment says "the same MPC signature"; it is left as deployed so the code-hash proof holds.)
- **For mainnet:** remove the testnet deploy key from the account, so the contract cannot be changed.

### Session contracts: one name, `prime-session`, on every chain

| Chain | Contract | Owner signs | sLOC | Revoke |
|---|---|---|---|---|
| EVM | `evm/src/PrimeSession.sol`: Roles member only | `personal_sign` text | 32 | yes (`grant` with end 0) |
| Solana | `solana/prime-session/src/lib.rs`: policy-member PDA only, one per wallet per Smart Account (`["prime", owner, settings]`) | plain text | 27 | no (about 13 lines); expiry, or a 2-of-3 policy update |
| Stellar | `../../../src/lib.rs` (crate `contracts/prime-session`): signer of the wallet's session rule only | SEP-53 | 54 | yes (7 lines) |

Round 8 renamed them (EVM `PrimeKey` → `PrimeSession`, Stellar `session-signer` → `prime-session`) and trimmed 7 more lines, with the same checks:
- EVM: `ECDSA.recover` in place of `tryRecover` plus an error check (`recover` reverts on a bad signature and never returns the zero address).
- Solana: no target check. The inner call goes to the Smart Account program id, a constant, so no other target is possible (X11: with another program in account 3, prime-session still calls only the Smart Account).
- Stellar: the SEP-53 prefix is part of the grant-message builder, and the hex helper writes into that message directly.

**Our new code in total:**
- 21 sLOC on NEAR, replacing our two NEAR wallet-contract variants (58 + 53 sLOC, now retired);
- 32 on EVM, 27 on Solana, 54 on Stellar (134 with the NEAR signer; 164 before round 7, 141 after it; see `round7.log`, `round8.log`).

## Results (signer contract and stock NEAR only; no NEAR wallet-contract variants)

| What | Where | Result | Log |
|---|---|---|---|
| Signer contract refusals | NEAR testnet | **11/11** | `near-signer/signer-neg.log` |
| EVM matrix, PrimeSession (round 8) | Base Sepolia fork + NEAR testnet | **92/92** (the live matrix without X11a, plus revoke edge cases X12–X16) | `evm/pkn.log`, `evm/bytecode-eq.fork.log` |
| EVM matrix, live, previous version (PrimeKey, round 7) | **real Base Sepolia** + NEAR testnet | **88/88** (the live relayer is now out of test ETH) | `evm/pkn-live.log`, `evm/verify-evm.log` |
| Real Phantom and real Freighter through the signer contract | NEAR testnet | both signed, MPC keys check out | `proof-near.log`, `real-wallets/` |
| Solana matrix | local validator (Smart Account from devnet) + NEAR testnet | **83/83** (A0–A6: a grant works in one Smart Account only; X8–X10: wrong PDA, wrong account, unsigned session key; X11: the System program in place of the Smart Account program) | `solana/psn.log` (`psn.round8-x11-expectation.log`: the first round-8 run, 81/82, where X11 wrongly expected a refusal); `solana/build-check.log`; the earlier per-wallet PDA run is `solana/psn.run5-pda-per-wallet.log` |
| Stellar matrix | Stellar testnet + NEAR testnet (fresh deployment, round 8) | **55/55** | `stellar/stn.log`, `stellar/verify-stellar.log` |
| Phantom's own EVM account as a Safe seat | real Phantom extension + Base Sepolia fork | **P1, P2 pass** | `phantom-evm/phx.log`, `phantom-evm/pevm.log` |

**Signer contract refusals.** Each of these is refused inside our contract, before any MPC call:
- another wallet's signature for a key;
- SEP-53 sent as plain text, and plain text sent as SEP-53;
- a request signed for another payload, path, domain or signer contract;
- a malformed key.

There are three accepted cases (11 = 8 refusals + 3): Freighter on ed25519, Phantom on secp256k1, and upper-case payload hex, which decodes to the same bytes the wallet signed.

**The three matrices** cover what the previous run did, now on the new MPC keys. For every wallet on every chain:
- seats: 2-of-3, single-wallet refusals, wrong-key refusals;
- sessions cannot vote as seats;
- grant, then moves paid by the relayer and by the session key itself;
- the refusals and the cross-wallet cases; revoke on EVM (all three wallets) and Stellar (MetaMask and Freighter). Solana has no per-session revoke.

### Real Phantom's own EVM account, no NEAR

- **Grant:** Phantom `personal_sign` of a sample grant text in the EVM format (placeholder addresses) recovers to its EVM address `0x06e7…267c`.
- **Seat:** a Safe on the Base Sepolia fork owned by MetaMask and Phantom's EVM address (threshold 2).
  - **P1:** Phantom `personal_sign`s the Safe transaction hash; it signs the raw 32 bytes. Submitted as Safe's eth_sign form (v + 4) with MetaMask's signature, the transfer executed.
  - **P2:** Phantom alone is refused (GS020).
- **Limitation:** with Testnet mode on, Phantom answers `wallet_switchEthereumChain` to Base Sepolia with "ok" but stays on Sepolia. So `eth_signTypedData_v4` for a chain-84532 Safe is refused ("not connected to the requested chain"). The `personal_sign` path above does not depend on the selected chain.
- **Code:** this route removes NEAR from Phantom on EVM, but **no lines**. The signer contract still needs secp256k1 for Freighter on EVM and plain text for Phantom on Stellar.

### MetaMask's own Solana account

**Not verified.** There is no MetaMask extension on this machine. It would remove NEAR from MetaMask on Solana but **no lines** of ours either: that route already uses stock NEAR.

## Test-harness problems on the way, kept with their logs

- **EVM run 2** (`evm/pkn.run2-variants.log`) is the previous run on the wallet-contract variants.
- **EVM runs 3 and 4** (`pkn.run3-near-expired.log`, `pkn.run4-near-nonce.log`) stopped on NEAR RPC errors: "Transaction has expired" and a stale access-key nonce. FastNear's load-balanced testnet RPC sometimes serves a node that is behind. A rejected NEAR transaction never lands, so `nearsig.ts` retries those two errors after 3 s.
- **EVM run 5** (`pkn.run5-s7design.log`, 86/87). S7 "Freighter's seat signed by Phantom's MPC key" was accepted, and that is correct behaviour. A Safe recovers ECDSA owners from the signature itself, so that is simply Phantom voting. Its earlier "refused" results came from signature ordering (GS026), not a real check. S7 is now "one wallet signs twice", which is refused (GS026). The Solana (K6d) and Stellar (Y7) counterparts are sound, because there the signature is bound to the signer's key.

## Trade-offs to know

- **Latency:** NEAR-routed signatures averaged 7.9–8.2 s on testnet.
- **Availability:** seats and grants through NEAR need NEAR to be up; moves don't.
- **Solana has no per-session revoke.**
- **Audit scope:** the 21-line signer contract and the three session contracts.
