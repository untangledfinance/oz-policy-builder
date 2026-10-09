# Can real Phantom sign a NEAR transaction? — NEAR testnet, Phantom 26.32.0 (Chrome Web Store)

Phantom's key is ed25519, so its NEAR implicit account is `hex(pubkey)`. A NEAR tx signature is
`ed25519(sha256(borsh(tx)))`, so the dApp asks Phantom to `signMessage(sha256(borsh(tx)))`.

1. Plain attempt: **refused before any prompt** — "You cannot sign solana transactions using sign message".
   Phantom's background `isSafeMessage` only signs messages that are valid UTF-8 and do not parse as a
   Solana message with instructions; a 32-byte hash is almost never valid UTF-8 (p ≈ 1.0e-8).
2. Ground attempt: `grind/` varies the FunctionCall `gas` (free 8 bytes) until sha256(tx) is valid
   UTF-8 (52M tries, 3.7 s on 8 cores). Phantom then showed **"Sign Message … Network: Solana"** with the
   hash as garbled text (`prompt-1.png`); after Confirm, NEAR testnet accepted the tx:
   `32NJVvrjDKafT6JDKRCYym8ZkLWkGUGnhS4JyeGYvtvG` (signer `dff7d5e4…338b` = Phantom key
   `G5H71U2p…6LT4`, MPC `sign`, success). The MPC ed25519 signature verified and the derived key equals
   `v1.signer-prod.testnet` `derived_public_key`.

Conclusion: technically possible, practically unusable (blind gibberish labelled "Solana", depends on
grinding and on a Phantom heuristic). Phantom does sign readable UTF-8 text, so the readable-message
wallet-contract route works for Phantom too.
