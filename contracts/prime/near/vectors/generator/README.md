# Vector generator

Writes `../requests.json`, the shared vectors for prime-near-signer v2. Expected texts, key paths and hashes come from viem, `@stellar/stellar-sdk`, `@solana/web3.js` and `@noble`, so the Rust code is checked against code it does not share.

```
bun install
bun gen.ts ../requests.json     # or: bun run generate
```

The test wallets are throwaway keys derived from fixed labels (`prime-vector-freighter`, `prime-vector-phantom`, `prime-vector-metamask`). They are never funded and never used outside these vectors. `NOW` in `lib.ts` is the block time the vectors assume for the time rules.
