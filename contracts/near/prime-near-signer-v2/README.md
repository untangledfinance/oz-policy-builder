# prime-near-signer v2

A contract on NEAR that gives a wallet on another chain NEAR MPC signatures under keys only that wallet controls. A Prime seat for a NEAR-routed owner uses those keys for one job: the owner signs one readable grant through NEAR, and the contract asks the MPC for the grant hash that text describes. Everything after the grant runs on the session key, so a NEAR-routed owner never serves as a wallet signature in a vote. v1 stays in `../prime-near-signer` on `signer.prime-spike-muwguc60.testnet`. v2 goes to its own account, `seats.prime-spike-muwguc60.testnet`, so the two derive different keys for the same path.

## Method

```
sign(wallet, scheme, request, signature) -> Promise     (payable, 1 yoctoNEAR for the MPC)
```

| Field | Values |
|---|---|
| `wallet` | lowercase 64-hex ed25519 key (Freighter, Phantom) or lowercase `0x` address (MetaMask) |
| `scheme` | `Sep53` (Freighter `signMessage`), `Raw` (Phantom `signMessage`), `Eip191` (MetaMask `personal_sign`) |
| `request` | `Grant` or `End` (revoke); field names and examples are in `../vectors/requests.json`. `SafeVote`, `SolanaVote` and `StellarVote` fail with the reason `vote` |
| `signature` | hex of the wallet's signature over the rendered text (64 bytes, or 65 bytes `r‖s‖v` with `v` 27 or 28 for `Eip191`) |

The contract parses every field into fixed bytes, refuses any spelling that differs from the canonical one, renders the text, verifies the wallet's signature over that text, applies the time rules and calls `v1.signer-prod.testnet` `sign` with the key path `<scheme>:<wallet>/prime:<evm|solana|stellar>:<account>` (`scheme` is `sep53`, `raw` or `eip191`, so a Freighter and a Phantom owner with one ed25519 key derive different seat keys), domain 0 (secp256k1) for Base Sepolia and domain 1 (ed25519) for Solana devnet and Stellar testnet, and the 32-byte hash as the payload. No request carries a free payload.

## Rules

- A `Grant` starts at most 300 s after block time, ends after it starts, and lasts at most 604,800 s.
- `End` is a grant hash with start and end at zero, so the owner (or the key itself) can revoke.
- Every text ends with `Signature scheme: <scheme>` and `Signer: <this account>`. There is one session type, so a `Grant` has no scope field.
- Callers attach exactly 1 yoctoNEAR. v2 forwards the whole attached deposit to the MPC. The MPC call comes from the v2 account, so a refund of any extra deposit returns to the v2 account.
- Every vote request is refused with the reason `vote`. Any other request shape, and any unknown field, fails to deserialize.

Hash formats are in `hash_notes` of `../vectors/requests.json`. Refusal reasons are one word each (`address`, `wallet`, `start`, `window`, `vote`, `signature`, and the parse refusals `chain`, `field`, `variant`), and the vectors name the reason each refusal case expects.

## Build and test

```
cargo test                                   # vectors, MPC call arguments, refusals
cargo mutants --in-place --timeout 60        # every mutant killed
RUSTFLAGS="-C link-arg=-s --cfg near" cargo build --release --target wasm32-unknown-unknown
```

The vectors come from independent code (viem, `@stellar/stellar-sdk`, `@solana/web3.js`, `@noble`). The generator is in `../vectors/generator` (`bun install` then `bun gen.ts ../requests.json`); send changes to the vectors to the `near-signer` agent. `near-sdk` needs its `unstable` feature for `env::ecrecover`, and the wasm build needs `--cfg near`. Without that flag `near-sdk` compiles software hashing into the wasm and every refusal traps with no message.
