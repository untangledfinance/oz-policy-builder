# Freighter (SEP-53) controls a NEAR account that calls NEAR MPC — testnet spike

Patch on near/intents @ 4127e8e (`git apply near-intents-sep53.patch`) adds `defuse-wallet-sep53`:
a signature schema for NEAR's wallet contract (`contracts/wallet`) where the owner is a Stellar key
signing a readable text with SEP-53 `signMessage` (what Freighter's signMessage produces).

- Global contract (by hash) on NEAR testnet: `5LVYEYWkNFZ9FM86Ge7RAVDjL3zzoYMfNnbRGdU2HgKQ`
  (sha256 406d0d3a…, 358 KB; deploy burned ~35.8 testnet NEAR = 10x storage)
- Run: `cargo build -p defuse-wallet-sep53 --example spike --features signer`, then the example with
  NEAR_NETWORK=testnet, NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY (relayer), SEP53_CODE_HASH.
- `freighter-sign.ts` is Freighter's `encodeSep53Message` + `Keypair.sign` verbatim; the example
  checks Rust gives byte-identical signatures. `stellar-mpc.ts` closes the loop on Stellar.
- Results: `run1.log` (19/19), `run2-stellar.log` (MPC-signed Stellar payment accepted).
