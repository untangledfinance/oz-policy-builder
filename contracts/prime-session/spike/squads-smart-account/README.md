# Squads Smart Account policy + Swig sessions (Prime on Solana)

Local validator with the Squads Smart Account Program (`SMRTzfY6…`, code sha256 456e8dee…, identical to
devnet) and Swig (`swigypWH…`) cloned from devnet, plus the program config account. The SDK
(`@sqds/smart-account` 2.1.2) is not on npm; it was built from the program repo (commit 80bf1f7).

## Layout

| Piece | What it is |
|---|---|
| Smart Account settings (rule 0) | signers A, B, C, threshold 2, no settings authority. A = NEAR MPC ed25519 key requested by MetaMask's eth-implicit account (no NEAR contract) |
| Policy P1 (ProgramInteraction) | signers W_mm, W_ph, W_fr (Swig wallet PDAs), threshold 1, 7-day expiry. Allows: System transfer from the vault to VENUE or VENUE2, ≤ 0.05 SOL per transfer, ≤ 0.08 SOL per day (shared by all signers) |
| W_mm | Swig wallet, root = MetaMask (secp256k1). Session role (MetaMask `personal_sign`) may only call the Smart Account program |
| W_ph | Swig wallet, root = Phantom (ed25519). Session role (Phantom signs one Solana tx), same limit |
| W_fr | Swig wallet, root = K = NEAR MPC ed25519 key of Freighter's NEAR wallet account `0s2ee0a8…` (SEP-53 wallet contract). Session role opened by one Freighter signature |

A move is: session key → Swig `sign` → Smart Account `executeTransactionSyncV2` (policy payload, W as
signer via Swig's outbound CPI) → vault transfer. The Smart Account program accepts PDA signers
(it only checks `is_signer`) and has no inbound-CPI check, unlike Swig.

## Results (`state-sa.json`, logs `sa-*.log`)

62 of 67 recorded checks pass. The 5 failures are harness mistakes that were refused for the wrong
reason; each was redone and passes:

| Bad run | Why it was invalid | Redone as |
|---|---|---|
| M9, M10 | instruction named an unsigned rent payer | M9r, M10r (`InvalidSignerCount`) |
| X3 | 1000 lamports to a new account is below rent | X3 with 0.01 SOL (ok) |
| R0, R2 | the MetaMask session had expired (Swig 0xbc6) | V5 (`InsufficientLamportAllowance`), V8 (`NotASigner`) |

Highlights:

- Install P1: B alone `InvalidSignerCount`; attacker + B `NotASigner`; A (MetaMask via NEAR, ~20 s) + B ok.
- MetaMask session: VENUE/VENUE2 ok; other address `ProgramInteractionAccountConstraintViolated`;
  0.06 SOL `ProgramInteractionInvalidNumericValue`; over 0.08/day `ProgramInteractionInsufficientLamportAllowance`;
  plain transfer out of W refused by Swig program limit; settings change or self-made policy `InvalidSignerCount`;
  the session key signing directly `NotASigner`.
- Phantom session: allowed move ok, other address refused, cannot sign as W_mm.
- Freighter: one SEP-53 signature → NEAR wallet contract → MPC (7.4 s) opens the session; allowed move ok,
  other address refused; a session signed by another key refused.
- Daily cap is shared by all policy signers (V4–V6).
- Revoke: B + C drop W_mm from the policy → its still-valid session gets `NotASigner`; Phantom keeps working.
  B + C remove the policy → every session refused (`AccountNotInitialized`).
- Expiry: policy with a 20 s expiry works, then `PolicyExpirationViolationTimestampExpired` while the
  Swig session itself is still valid.
- B (a 2-of-3 signer that is not a policy signer) cannot use the policy; B + C can still move anything
  with the 2-of-3 directly (X3).

## Not covered

- Real browser extensions (MetaMask, Phantom, Freighter are stood in by local keys; Freighter's SEP-53
  signing is the same code path as run 5).
- DeFi instructions (only System transfers were constrained); token spending limits per mint.
- Devnet (local validator only; devnet airdrop is rate-limited).
