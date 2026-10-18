# Real Phantom controls a NEAR wallet-contract account (readable text) — NEAR testnet

`defuse-wallet-text-ed25519` (in ../near-wallet-sep53/near-intents-sep53.patch): owner signs the readable
request text with plain ed25519, which Phantom's `signMessage` does for UTF-8 text. Global contract
`CBSiykn7pJdPm1DpqQmALPdftzZbfH1VZq2C4WfhyU5z`. Phantom 26.32.0 (Chrome Web Store), driven by `bridge.mjs`;
the request is shown in Phantom as readable JSON (`phantom-prompts.txt`, `prompt-readable-request.png`).

run1: account created; MPC secp256k1 (EVM key 0xf550eedf…616a, equals derived_public_key); MPC ed25519
(Solana key 65uz3uLX…y2o). run2: another key's signature refused, genuine accepted, replay refused.
