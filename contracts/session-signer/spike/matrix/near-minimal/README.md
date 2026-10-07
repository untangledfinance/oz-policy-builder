# One small session contract per chain; NEAR only through stock code and one 21-line signer

This replaces `../minimal/`. The goals were the least new code, no lines added to NEAR's open-source wallet contract, and seats kept apart from sessions.

## Routes

Each wallet uses its own key on its home chain. Elsewhere it signs through NEAR's MPC.

| Wallet | EVM (Safe + Roles) | Solana (Squads Smart Account) | Stellar (OZ account) |
|---|---|---|---|
| MetaMask | **own EOA** | NEAR **stock** eth-implicit account → MPC ed25519 | NEAR stock eth-implicit → MPC ed25519 |
| Freighter | `prime-near-signer` (SEP-53) → MPC secp256k1 | `prime-near-signer` (SEP-53) → MPC ed25519 | **own key** |
| Phantom | **own EVM account** (verified with the real extension, below), or `prime-near-signer` → MPC secp256k1 | **own key** | `prime-near-signer` (plain text) → MPC ed25519 |

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
- **Stateless:** replaying a request only reproduces the same MPC signature, so there is no nonce or storage.
- **For mainnet:** remove the testnet deploy key from the account, so the contract cannot be changed.

### Session contracts (unchanged from the previous run)

| Chain | Contract | Owner signs | sLOC | Revoke |
|---|---|---|---|---|
| EVM | `evm/src/PrimeKey.sol`: Roles member only | `personal_sign` text | 41 | yes (5 lines) |
| Solana | `solana/prime-session/src/lib.rs`: policy-member PDA only | plain text | 37 | no (13 lines); expiry, or a 2-of-3 policy update |
| Stellar | `contracts/session-signer/src/lib.rs`: signer of the wallet's session rule only | SEP-53 | 65 | yes (7 lines) |

**Our new code in total:**
- 21 sLOC on NEAR, replacing our two NEAR wallet-contract variants (58 + 53 sLOC, now retired);
- 41 on EVM, 37 on Solana, 65 on Stellar.

## Results (signer contract and stock NEAR only; no NEAR wallet-contract variants)

| What | Where | Result | Log |
|---|---|---|---|
| Signer contract refusals | NEAR testnet | **11/11** | `near-signer/signer-neg.log` |
| EVM matrix | Base Sepolia fork + NEAR testnet | **87/87** | `evm/pkn.log` |
| Solana matrix | local validator (Smart Account from devnet) + NEAR testnet | **70/70** | `solana/psn.log` |
| Stellar matrix | Stellar testnet + NEAR testnet | **55/55** | `stellar/stn.log` |
| Phantom's own EVM account as a Safe seat | real Phantom extension + Base Sepolia fork | **P1, P2 pass** | `phantom-evm/phx.log`, `phantom-evm/pevm.log` |

**Signer contract refusals.** Each of these is refused inside our contract, before any MPC call:
- another wallet's signature for a key;
- SEP-53 sent as plain text, and plain text sent as SEP-53;
- a request signed for another payload, path, domain or signer contract;
- a malformed key.

There are two accepted controls (Freighter on ed25519, Phantom on secp256k1). Upper-case payload hex is also accepted, because it decodes to the same bytes the wallet signed.

**The three matrices** cover what the previous run did, now on the new MPC keys. For every wallet on every chain:
- seats: 2-of-3, single-wallet refusals, wrong-key refusals;
- sessions cannot vote as seats;
- grant, then moves paid by the relayer and by the session key itself;
- every refusal, revoke, and the cross-wallet cases.

### Real Phantom's own EVM account, no NEAR (the "smaller things")

- **Grant:** Phantom `personal_sign` of a PrimeKey grant text recovers to its EVM address `0x06e7…267c`.
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

- **Latency:** each NEAR-routed signature took 7–9 s on testnet.
- **Availability:** seats and grants through NEAR need NEAR to be up; moves don't.
- **Solana has no per-session revoke.**
- **Audit scope:** the 21-line signer contract and the three session contracts.
