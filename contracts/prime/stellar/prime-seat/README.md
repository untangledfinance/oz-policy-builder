# prime-seat

The seat of a NEAR-routed owner on one Prime Account on Stellar, and that owner's session keys. A wallet on another chain (MetaMask, Phantom) has no Stellar account. Its owner key is an ed25519 key that the NEAR MPC signs with, and the owner signs only grants and ends. Each seat votes and acts through a session key that the owner granted, for at most 7 days.

One seat serves one account. The constructor takes `(account, owner)` and stores both. The app deploys every seat first, reads back the stored account and owner against the key it derived offline, and only then creates the account.

## Interface

| Function | Use |
|---|---|
| `grant(key, start, end, by, sig)` | Starts, extends or ends a session. `by` is the owner, or the session key itself when `end` is 0. `sig` is `by`'s ed25519 signature over the grant hash. Anyone may submit it; the signature carries the authority. |
| `verify(hash, key_data, proof)` | The `External` signer interface for rule 0. `key_data` must be the account's 32-byte contract id. `proof` is a live session key (32 bytes) then its signature (64 bytes) over `sha256(seat ‖ hash)`. |
| `__check_auth(payload, (key, sig), contexts)` | The `Delegated` signer interface for rules bounded by the policy-interpreter. A live key signs `sha256(seat ‖ payload)`. |
| `batch_canonicalize_key(keys)` | One constant per seat, so the account refuses a second entry for the same seat. |

Grant hash: `sha256("prime-seat-grant" ‖ network id ‖ account ‖ seat ‖ key ‖ be64 start ‖ be64 end)`, with the account, seat and key as raw 32 bytes and times in unix seconds. An end is the same hash with start and end at 0. The hashes equal the shared vectors in `contracts/prime/near/vectors/requests.json`, and a unit test checks the four Stellar vectors.

Rules the contract enforces on a grant: `start <= now <= end`, `end - start <= 604,800`, a revoked key is never granted again, and a new end must be later than the stored one. An end stores 0 for the maximum TTL. Every use compares the stored end with `ledger().timestamp()`, because TTL counts ledgers and the window counts seconds. A grant sets the key's entry TTL to `(end - now) / 4 + 1` ledgers and extends the seat's instance and code to the same length.

## Rule 0 layout

Rule 0 holds each native G account as `Delegated(G)` and each seat as `External(seat, account id)`. Two policies go into the account constructor together (assumption A10, settled on testnet):

| Policy | Install parameter |
|---|---|
| `simple_threshold` | `threshold` = M, the approvals the app shows |
| `weighted_threshold` | native weight K, seat weight 1, `threshold` K, where K is the number of seats plus one |

Seats alone sum to less than K, so every M-of-N decision carries a signature from a native Stellar wallet. Invariants the app checks on read-back: each native weight equals K, the seat weights sum below K, the weighted threshold equals K, the simple threshold equals M.

## Rules that list a seat

A session acts alone only in rules that list `Delegated(seat)`. The seat cannot limit what such a rule reaches. The OZ account calls `seat.require_auth_for_args`, so the only context `__check_auth` sees is the account's own `__check_auth` frame, never the call being authorized. A check that refuses contexts on the account would refuse every use, and a test pins the real behaviour.

- A rule with the policy-interpreter predicate bounds the session on chain, whatever its scope. Testnet runs show a `Default` rule with a transfer-only predicate refusing an account admin call.
- A rule that lists the seat with no policy lets the session do anything the rule's scope matches, including account admin calls when the scope is `Default`. Installing it takes a decision that carries a native signature, and the app must refuse to build it and flag it on read-back (residual R7).

## Build and checks

```
./build-wasm.sh                          # reproducible wasm, prints its sha256
cargo test                               # unit tests
cargo mutants -j1 --timeout 180          # every viable mutant caught
```

Sizes and the testnet record are in the phase 04 report.
