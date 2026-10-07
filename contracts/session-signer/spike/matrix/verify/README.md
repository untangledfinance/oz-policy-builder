# Prime across Stellar, Solana and EVM: final verified architecture

> **Superseded on contracts:** the EVM contracts (SessionMember, Ed25519Owner, SessionMemberEd) are now one contract, PrimeKey. The Stellar and Solana contracts are trimmed. See [`../minimal/README.md`](../minimal/README.md). The architecture below is otherwise unchanged.

This report follows two verification rounds. **Round 1** re-ran every spike from clean state, with the harness bugs from earlier runs fixed. **Round 2** tried to break the result:
- an independent security review of the four new contracts;
- fixes for the review findings, with tests;
- ed25519 test vectors and edge cases;
- the real Freighter 5.49 and Phantom extensions.

## What a Prime Account is, on every chain

| Part | What it does |
|---|---|
| 2-of-3 seats | Admin: rules, members, recovery. Any two of MetaMask (EVM wallet), Freighter (Stellar wallet) and Phantom (Solana wallet). |
| Rules | What a session may do: which contract, function, arguments, recipients and amounts, plus caps. |
| Sessions | One wallet signature grants a short-lived key (at most 7 days) that moves funds within the rules. The key can be revoked, and its rule can be removed by the 2-of-3. |

## Architecture per chain (verified)

| | Account + seats | Rules | Sessions | NEAR |
|---|---|---|---|---|
| **Stellar** | OZ smart account; rule 0 uses `weighted_threshold` 2 of {MetaMask, Freighter, Phantom}. Freighter is a native signer. MetaMask and Phantom sit through their session-signer. | OctoGate policy interpreter | `session-signer` v3, whose owner is `Evm` (EIP-712), `Stellar` (SEP-53) or `Solana` (`signMessage` text) | **not needed** |
| **Solana** | Squads Smart Account (settings 2-of-3) | Squads `ProgramInteraction` policies | Option A: `prime-session` v2, our program, for all three wallets. Option B: Swig for MetaMask and Phantom, plus option A or NEAR for Freighter. | **not needed** (option A) |
| **EVM** | PrimeX Safe 1.4.1, 2-of-3. MetaMask is a native owner. Freighter and Phantom are `Ed25519Owner` contracts (ERC-1271). | Zodiac Roles v2.1.1 (PrimeX's own `buildRuleInstall`) | `SessionMember` (EIP-712) for MetaMask; `SessionMemberEd` for Freighter and Phantom | **not needed**, at a gas cost |

### Where NEAR is an alternative
- **MetaMask via NEAR's eth-implicit account:** stock NEAR, needs no NEAR contract of ours. Gives one MetaMask-controlled MPC key on any chain.
- **Freighter or Phantom via NEAR:** this needs *our* wallet-contract variants: the SEP-53 and plain-text schemas we added to near/intents and deployed as global contracts on NEAR testnet. They are not upstream. So "use NEAR for Freighter/Phantom" means "change NEAR-side contracts".
- **What NEAR buys:** no on-chain ed25519 check on EVM, which saves about 0.9M gas per signature check.
- **What NEAR costs:**
  - 5–20 s per MPC signature;
  - a relayer;
  - a dependency on NEAR MPC;
  - those wallet contracts to maintain and audit.

### Why each piece is necessary
- **Phantom can't sign for Stellar or EVM directly.** The real extension refused raw non-text bytes ("You cannot sign solana transactions using sign message") but signed readable text. So the grant must be text, checked on chain.
- **Freighter only signs Stellar transactions or SEP-53 messages.** The real 5.49 extension showed "Stellar Signed Message: …" and produced a signature byte-identical to our copy of its code (`freighter-sign.ts`). So on Solana and EVM, Freighter needs an on-chain SEP-53 check (prime-session v2, `Ed25519Owner`) or NEAR.
- **PrimeX has no sessions,** and a Safe or Roles member can't be granted a key by one signature. Hence `SessionMember`.
- **A Squads policy change needs the 2-of-3,** so one-signature sessions need a session layer (prime-session or Swig).

## Results

### Round 1: clean reproduction (no harness errors left)

| Spike | Network | Checks |
|---|---|---|
| Stellar matrix: seats, sessions, revoke, expiry, cross-wallet refusals | **Stellar testnet** | 29/29 |
| Solana: Squads Smart Account policy + Swig, Freighter via NEAR (run 10) | local validator, programs cloned from devnet | 66/66 |
| Solana: seats MetaMask/Phantom/Freighter via NEAR (run 11) | local validator | 19/19 * |
| Solana: prime-session v1 + Swig seat for MetaMask (run 12) | local validator | 57/57 |
| EVM via NEAR MPC (run 11) | anvil fork of Base Sepolia | 42/42 |
| EVM via on-chain ed25519 (run 12) | anvil fork | 28/28 |

\* The first two attempts stopped receiving client confirmations after a few minutes. The transactions themselves landed (`state-seats.r1-attempt*.json`): the funds arrived and the proposals executed. The script now looks the signature up on chain when confirmation times out. The third attempt passed 19/19, with no lookup needed.

### Round 2: trying to break it

| Check | Result |
|---|---|
| Independent review of session-signer v3, prime-session, SessionMember, Ed25519Auth | No critical findings. Two medium findings for prime-session (no cluster binding, no revoke) and some low ones (below). |
| prime-session **v2** fixes: cluster + program in the grant, `revoke`, Smart-Account-only target | 65/65. Revocation works for each wallet, a revoke signed by someone else is refused, and a swapped marker is refused. Grants for mainnet, for the v1 program, or in v1 format are refused. System Assign/transfer is refused. An ed25519 instruction reading from another instruction is refused. |
| ed25519 in Solidity (chengwenxi/Ed25519, unaudited): RFC 8032 vectors, 40 random pairs, tampering, S + L malleability | 12/13. **It accepts a forgery for a small-order public key**: identity key, R = identity, S = 0. |
| Fix: `Ed25519Wallet` refuses small-order and non-canonical keys | 10/10. All 8 small-order encodings and y ≥ p are refused; a real key is accepted. |
| Real Freighter 5.49: signature equals our copy | byte-identical; verifies SEP-53, not raw text |
| Real Freighter on Stellar testnet: v3 grant → move, other recipient refused, revoke → #2 | 4/4 |
| Real Freighter on EVM: Safe approval text through `Ed25519Owner` | valid for its Safe and transaction only |
| Real Phantom: raw 32-byte hash | refused (control text signed) |
| Real Phantom (run 12): Stellar v3 grant, Solana prime-session grant, EVM approval and grant | 7/7 on chain |

### Open findings to fix before production

| Where | Finding | Status |
|---|---|---|
| prime-session | no cluster or program binding; no revoke; any target | **fixed in v2**, tested |
| Ed25519Auth | small-order public keys allow forgery | **fixed** (constructor check), tested |
| Ed25519Auth | ~0.9M gas per check; `SessionMemberEd` re-checks the grant every move | open: store the grant on first use |
| Ed25519Auth | the approval text says "safe tx" for Safe messages too | open, low |
| SessionMember(Ed) | a signed call has no deadline | open, low |
| session-signer v3 | the 7-day cap is counted in ledgers (5 s assumed) | open, low |
| everything new | spike code; the ed25519 library is unaudited | needs an audit |

Not covered: real MetaMask (viem signs the same `personal_sign` and EIP-712 bytes); DeFi calls beyond token and XLM transfers; mainnet.
