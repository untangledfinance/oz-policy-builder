# prime-near-signer v2

A contract on NEAR that gives a wallet on another chain NEAR MPC signatures under keys only that wallet controls. A Prime seat for a NEAR-routed owner uses those keys: the owner signs one readable text, and the contract asks the MPC for the chain hash that text describes. v1 stays in `../prime-near-signer` on `signer.prime-spike-muwguc60.testnet`. v2 goes to its own account, `seats.prime-spike-muwguc60.testnet`, so the two derive different keys for the same path.

## Method

```
sign(wallet, scheme, request, signature) -> Promise     (payable, 1 yoctoNEAR for the MPC)
```

| Field | Values |
|---|---|
| `wallet` | lowercase 64-hex ed25519 key (Freighter, Phantom) or lowercase `0x` address (MetaMask) |
| `scheme` | `Sep53` (Freighter `signMessage`), `Raw` (Phantom `signMessage`), `Eip191` (MetaMask `personal_sign`) |
| `request` | `Grant`, `End`, `SafeVote`, `SolanaVote`; field names and examples are in `../vectors/requests.json` |
| `signature` | hex of the wallet's signature over the rendered text (64 bytes, or 65 bytes `r‖s‖v` with `v` 27 or 28 for `Eip191`) |

The contract parses every field into fixed bytes, refuses any spelling that differs from the canonical one, renders the text, verifies the wallet's signature over that text, applies the time rules and calls `v1.signer-prod.testnet` `sign` with the key path `<wallet>/prime:<evm|solana|stellar>:<account>`, domain 0 (secp256k1) for Base Sepolia and domain 1 (ed25519) for Solana devnet and Stellar testnet, and the 32-byte hash as the payload. No request carries a free payload.

## Rules

- A `Grant` starts at most 300 s after block time, ends after it starts, and lasts at most 604,800 s.
- A `SolanaVote` has `valid_until` at most 900 s after block time.
- `End` is a grant hash with start and end at zero.
- `SafeVote` hashes `safeTxGas`, `baseGas`, `gasPrice`, `gasToken` and `refundReceiver` as zero and says so in the text.
- `SolanaVote` accepts only the Squads Smart Account program and these instructions: create proposal, activate proposal, approve proposal, reject proposal, execute transaction, execute settings transaction, create settings transaction (add signer, remove signer, change threshold, set time lock, remove policy) and create transaction (a vault transaction). The text lists every account of the instruction with its flags, and for vault transactions every account of the message, each inner instruction with its program and accounts, and its data in hex. The contract checks that the proposal and transaction accounts are the Squads addresses for the consensus account and index it prints.
- Everything else is refused: spending-limit use, synchronous execution, cancel, batches, policy create and update, spending-limit and archival settings, address lookup tables and memos.
- The Stellar vote (`StellarVote`) is not in this build.

Hash formats are in `hash_notes` of `../vectors/requests.json`. Refusal reasons are one word each (`address`, `wallet`, `data`, `value`, `start`, `window`, `valid_until`, `program`, `instruction`, `accounts`, `signature`), and the vectors name the reason each refusal case expects.

## Build and test

```
cargo test                                   # vectors, MPC call arguments, refusals
cargo mutants --in-place --timeout 60        # every mutant killed
RUSTFLAGS="-C link-arg=-s --cfg near" cargo build --release --target wasm32-unknown-unknown
```

The vectors come from independent code (viem, `@stellar/stellar-sdk`, `@solana/web3.js`, `@sqds/smart-account`, `@noble`). The generator lives outside the repo at `/home/ubuntu/work/near-int/near/gen.ts`; send changes to the vectors to the `near-signer` agent. `near-sdk` needs its `unstable` feature for `env::ecrecover`, and the wasm build needs `--cfg near`. Without that flag `near-sdk` compiles software hashing into the wasm and every refusal traps with no message.
