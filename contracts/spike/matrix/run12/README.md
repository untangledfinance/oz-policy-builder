# Run 12: are the run 11 decisions necessary?

Run 11 claimed NEAR (and Swig) were *needed* in some cells. Each claim was tested by building the alternative.

| Claim from run 11 | Alternative tried here | Result |
|---|---|---|
| Freighter on Solana needs NEAR | `solana-program/`: prime-session, ~150 lines, checks the wallet's grant with Solana's own ed25519 / secp256k1 signature programs and signs as a PDA | **Wrong.** Freighter (SEP-53), Phantom and MetaMask each hold a seat and open sessions, no NEAR |
| Solana sessions need Swig | the same program | **Wrong.** Swig is optional |
| MetaMask's Solana seat needs NEAR (eth-implicit) | a MetaMask-owned Swig wallet as a Smart Account signer | **Wrong.** Works (W0–W5) |
| Freighter / Phantom on EVM need NEAR | `evm/Ed25519Auth.sol`: ed25519 checked in Solidity (chengwenxi/Ed25519, unaudited) for an ERC-1271 Safe owner and a session member | **Wrong**, at a gas cost: ~0.94M gas per check (≈ cents on Base) |
| Phantom signs the v3 / prime-session / EVM grant texts | the **real Phantom extension** through the Playwright bridge | **Right.** It shows the readable text and signs; the signatures worked on Stellar testnet, Solana and EVM |

So no wallet/chain pair *needs* NEAR. NEAR (or Swig) is a choice, traded against writing and auditing a
small verifier per chain.

## Results

| Run | Checks |
|---|---|
| Solana prime-session (`solana/state-ps.json`) | 59/63 recorded; the 4 failures are harness errors, each redone and passing (M-x3 → M-x3r, W3 → W3r) |
| EVM ed25519 (`evm/state-evm2.json`) | 31/31 |
| Stellar real Phantom (`../stellar/state-matrix.json`, RP1–RP4) | 4/4 on testnet (matrix total 33/33) |

### Solana: prime-session (local validator, Squads Smart Account + programs cloned from devnet)
- Seats are the PDAs `["prime", kind, owner]` of MetaMask, Freighter and Phantom; threshold 2. Every pair
  proposes, approves and executes through one-signature sessions (K2–K4, exactly 0.01 SOL each); one wallet
  alone → `InvalidProposalStatus` (K1); the movers policy is installed by MetaMask + Phantom (K5).
- Sessions through the policy: each wallet moves 0.01 SOL to VENUE; elsewhere
  `ProgramInteractionAccountConstraintViolated`; the shared daily cap holds (N9/N9b).
- The program refuses: a grant signed by another key, a Freighter grant without the SEP-53 prefix, a grant
  shown for another wallet's PDA, a stretched expiry, someone else's key replaying a grant, > 7 days,
  expired, and a missing signature-program instruction (N1–N8).
- **Finding:** prime-session does not restrict what the PDA signs, so a session is the wallet's full seat
  vote and can move the PDA's own SOL (M-x3r). Same power as Stellar's session-signer seat; a production
  version should allow only the Smart Account program (and maybe only some instructions).
- Harness errors: M-x3 sent 1000 lamports to an empty account (rent check); W3 had W pay rent, which a
  Smart-Account-only Swig role may not do (Swig 3006). Redone with 0.01 SOL and the session key paying rent.

### EVM (anvil fork of Base Sepolia, PrimeX Safe + Roles)
- Safe seats: MetaMask (EOA), `Ed25519Owner(Freighter)`, `Ed25519Owner(Phantom)`. Every pair executes
  (F3–F5, exactly 3 tokens); one wallet alone is refused (`GS021`: with one contract signature Safe reads the
  dynamic tail as the missing second entry, still a refusal); a Freighter signature without the SEP-53
  prefix, a Phantom seat signed by Freighter and an approval for another Safe tx → `GS024`.
- Sessions (`SessionMemberEd`): one-signature grants move 10 tokens to VENUE; elsewhere refused by Roles;
  stretched expiry, cross-wallet and wrong-format grants → `not owner`; revoke → `revoked`.
- Cost: every `exec` re-checks the grant (~0.93–1.18M gas per move). Caching a grant after its first use
  would make later moves cheap.

### Real Phantom (bridge-r12.log, bridge-r12-prompt-2.png)
Phantom 26.x showed each text in full (for example
`Prime session / signer: <PDA> / session key: <key> / valid until: <n>`) under "Sign Message" with no
warning, and labelled the network "Solana" for every request (it is its Solana account signing).

Not re-checked with real extensions: Freighter (its signMessage code path is copied in
`freighter-sign.ts`) and MetaMask (viem produces the same `personal_sign` / EIP-712 signatures).
