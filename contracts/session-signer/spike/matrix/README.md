# Wallet matrix: Prime on Solana, Stellar and EVM × MetaMask, Freighter, Phantom

Every Prime Account here is a 2-of-3 whose seats are one EVM wallet (MetaMask), one Stellar wallet
(Freighter) and one Solana wallet (Phantom). Each network is checked for both jobs a wallet has:

- **seat**: approving admin actions as one of the 2-of-3;
- **session**: one wallet signature opens a short-lived session key that moves funds within the rules.

Wallets are stood in by local keys that sign exactly what the extension signs (Freighter through
`freighter-sign.ts`, Freighter's `signMessage` code path). Freighter and Phantom are the same keys
that control NEAR wallet-contract accounts `0s2ee0a8…` (SEP-53; key B acts on it as an extension since
run 5) and `0s0114c4…` (text-ed25519). MetaMask is a test key (two different ones were used: the
NEAR eth-implicit one for the Solana seat and the Stellar row, another for Solana's Swig wallets and EVM).

## Result

| Prime on | MetaMask seat | Freighter seat | Phantom seat | MetaMask session | Freighter session | Phantom session |
|---|---|---|---|---|---|---|
| **Solana** (Squads Smart Account + Swig) | NEAR eth-implicit MPC key | NEAR wallet contract (SEP-53) → MPC key | native ed25519 | Swig secp256k1 session (run 10) | NEAR wallet contract → MPC key owns a Swig session role (run 10) | Swig ed25519 session (run 10) |
| **Stellar** (OZ account + session-signer v3) | session-signer v3, owner `Evm` | native (Delegated G account) | session-signer v3, owner `Solana` | session-signer v3 `Evm` (EIP-712) | session-signer v3 `Stellar` (SEP-53) | session-signer v3 `Solana` (`signMessage` text) |
| **EVM** (PrimeX Safe 1.4.1 + Roles v2.1.1) | native | NEAR wallet contract (SEP-53) → MPC secp256k1 | NEAR wallet contract (text) → MPC secp256k1 | `SessionMember` (EIP-712) | `SessionMember`, grant via NEAR MPC | `SessionMember`, grant via NEAR MPC |

All cells pass. Run 11 said NEAR was *needed* for Freighter on Solana and Freighter / Phantom on EVM.
**Run 12 (`run12/`) shows that is wrong:** a small Solana program (prime-session) and an ed25519 verifier
in Solidity give every wallet a seat and sessions on every chain without NEAR, and a Swig wallet can hold
MetaMask's Solana seat. NEAR is an option, not a requirement.

## Runs

| Row | Where | Script | Checks |
|---|---|---|---|
| Solana seats | local validator, programs cloned from devnet | `solana/seats.ts` | 19/19 |
| Solana sessions | same | `../squads-smart-account/` (run 10) | 62/67 (5 harness errors redone, pass) |
| Stellar | **testnet** | `stellar/matrix.ts` (run from the near-session-spike folder) | 29/29 |
| EVM | anvil fork of Base Sepolia (real Safe/Roles contracts) | `evm/evm.ts`, `evm/SessionMember.sol` | 47/49 + 7 redone (2 harness errors) |

### Solana seats (`state-seats.json`)
Squads Smart Account, signers MetaMask (A), Phantom (P), Freighter (F), threshold 2; each wallet signs its own
transaction (proposal flow). One approval → `InvalidProposalStatus`; A+P, P+F, F+A execute (DEST gets exactly
0.01 SOL each time); a non-member → `NotASigner`; F + A replace the Phantom seat with D and the removed seat
is refused.

### Stellar (`state-matrix.json`, testnet hashes in the logs)
Rule 0 = {S_mm, Freighter G, S_ph}, weighted_threshold 1/1/1 ≥ 2.
- Seats: Freighter alone and Phantom alone refused (#3213); MetaMask+Freighter, Freighter+Phantom,
  MetaMask+Phantom pass; an outsider refused (#3016); a Phantom seat presented with a Freighter-signed
  grant refused.
- Sessions (one rule per wallet: XLM transfer from the account to VENUE only): each wallet's session moves
  1 XLM to VENUE; elsewhere refused by the interpreter (#100); rule 0 refused; a Phantom session on the
  MetaMask rule, a Phantom-style grant on the Freighter signer, and a Phantom grant on the MetaMask signer
  refused; Freighter revokes its session with one SEP-53 signature → `session-signer` #2; an expired Phantom
  session → #1.

### EVM (`state-evm.json`)
Created with PrimeX's own code (`onboarding.ts`, `buildRuleInstall` spending-limit rule: 100 tokens/day to
VENUE). Safe owners MetaMask + the NEAR MPC addresses of Phantom and Freighter, threshold 2. Roles members
are three `SessionMember` contracts, one per wallet.
- Seats: one signature `GS020`; MetaMask + outsider `GS026`; MetaMask+Phantom, Phantom+Freighter,
  Freighter+MetaMask transfer (exactly 3 tokens).
- Sessions: each wallet's one grant → 10 tokens to VENUE; another recipient refused by Roles; a replayed
  move and a move signed by another key refused (`bad session sig`); a grant used on another member or with
  a stretched `validUntil` → `not owner`; > 7 days → `expired`; the cap is shared (60 + 41 refused
  `AllowanceExceeded`, 60 + 40 passes, 1 more refused); a revoked session → `revoked`; an outsider cannot
  revoke; an expired session refused; Phantom + Freighter remove the MetaMask member and its live session
  gets `NoMembership` while Phantom's keeps working.
- Harness errors: X5 and X10 were refused for the wrong reason (an earlier partial run had spent part of the
  cap; the session expired before the revoke was checked). Redone as C1–C4 and R1–R3.

## New code

- `session-signer` v3 (`../../src/lib.rs`): owner is `Evm(address)`, `Stellar(ed25519)` (SEP-53) or
  `Solana(ed25519)` (`signMessage` text). Freighter and Phantom grants sign readable text:
  `Prime session / contract / session key / valid until ledger / network`. 18 unit tests.
- `evm/SessionMember.sol`: the EVM counterpart: a Roles member that accepts an owner's EIP-712 grant and
  the session key's per-call signature (nonce, chain, member bound).
- `near/matrix_sign.rs` + `near-sign.sh`: one NEAR MPC signature (ed25519 or secp256k1) requested by
  Freighter or Phantom through NEAR's wallet contract (run inside the near/intents checkout).

Not covered: real browser extensions in this run (earlier runs drove real Phantom and Freighter's code path),
DeFi calls beyond token/XLM transfers, mainnet.
