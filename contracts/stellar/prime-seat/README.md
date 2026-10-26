# Prime seat

The Prime seat (crate `prime-seat`) is an owner's seat on one Prime Account on Stellar, and that owner's session keys. The seat owner is an ed25519 key. Its holder must produce a raw ed25519 signature over the 32-byte grant hash. In the reference integration a NEAR-routed MPC holds the key; any signer that can raw-sign that hash, such as a server-held keypair or a custody service configured for raw ed25519 signing, can serve. Interactive wallets that sign only transactions or prefixed messages produce signatures the seat refuses. The seat verifies only ed25519 signatures. The owner key signs only grants and ends, and the seat votes and acts through a session key that the owner granted, for at most 7 days.

One seat serves one account. The constructor takes `(account, owner)` and stores the account's 32-byte contract id and the owner key. The app deploys every seat first, reads back the stored account and owner against the key it derived offline, and only then creates the account.

## Interface

| Function | Use |
|---|---|
| `grant(key, start, end, by, sig)` | Starts, extends or ends a session. `by` is the owner, or the session key itself when `end` is 0. `sig` is `by`'s ed25519 signature over the grant hash. Anyone may submit it; the signature carries the authority. |
| `verify(hash, key_data, proof)` | The `External` signer interface, for rule 0 only. `key_data` must be the account's 32-byte contract id. `proof` is a live session key (32 bytes), its signature (64 bytes) over `sha256(seat ‖ hash)`, then the preimage of `hash`. |
| `__check_auth(payload, (key, sig, preimage), contexts)` | The `Delegated` signer interface, for rules other than rule 0. A live key signs `sha256(seat ‖ payload)`. The first context must be a call on the pinned account whose first argument is the account's digest. |
| `batch_canonicalize_key(keys)` | One constant per seat, so the account refuses a second `External` entry for the same seat. |

Grant hash: `sha256("prime-seat-grant" ‖ network id ‖ account ‖ seat ‖ key ‖ be64 start ‖ be64 end)`, with the account, seat and key as raw 32 bytes and times in unix seconds. An end is the same hash with start and end at 0. A unit test checks the hash, and a grant signed over it, against four fixed testnet vectors kept in `src/test.rs`.

Rules the contract enforces on a grant: `start <= now <= end`, `end - start <= 604,800`, a new end must be later than the stored one, and an ended key gets no new grant while its end entry lives. Every grant entry lives for the maximum TTL (about 180 days), and an end stores 0. Once an end entry expires, a grant the owner signed for that key can be valid again; only the owner signs grants. Every use compares the stored end with `ledger().timestamp()`, because TTL counts ledgers and the window counts seconds. The seat does not extend its own instance or code; the relayer extends them with an `ExtendFootprintTTL` operation.

## Which rule a seat may serve

The deployed account's digest is `sha256(payload ‖ XDR(rule ids))`. The seat cannot see the rule ids, so each proof carries that preimage and the seat checks that it hashes to the digest it was given. Then it reads the ids:

- `External(seat, account id)` serves rule 0 only. `verify` returns false when any id is not 0.
- `Delegated(seat)` serves rules other than rule 0 only. `__check_auth` refuses when any id is 0.
- `__check_auth` also needs the first context to be a call on the stored account, and its first argument to be the digest the preimage hashes to. The seat checks the contract address and that argument; it reads no function name. A seat bound to one account refuses the frames of every other account.

This ties the seat to the digest form of the pinned account wasm (`91a2cd56…`). A newer OZ account that adds the account address to the preimage makes the seat's signatures fail until new seats are deployed. OpenZeppelin's `v0.8.0` account (`8286422f…`, which the testnet reference account runs) is such an account: its signers commit to `AuthDigestPreimage { account, context_rule_ids, signature_payload }`, so a Prime with seats stays on `91a2cd56…`. It fails closed.

## Rule 0 layout

Rule 0 holds each native G account as `Delegated(G)` and each seat as `External(seat, account id)`. Two policies go into the account constructor together (assumption A10, settled on testnet):

| Policy | Install parameter |
|---|---|
| `simple_threshold` | `threshold` = M, the approvals the app shows |
| `weighted_threshold` | native weight K, seat weight 1, `threshold` K, where K is the number of seats plus one |

Invariants the app checks on read-back:

- Every `Delegated` entry in rule 0 is a G account address. Rule 0 holds no `Delegated` contract address. OpenZeppelin checks duplicates for `Delegated` and `External` apart, so `Delegated(seat)` can sit beside `External(seat)`. The seat refuses the `Delegated` copy in rule 0, and the read-back refuses the layout too.
- Every seat appears once, as `External(seat, account id)`.
- Each native weight equals K, and the weights of every entry that names a seat contract, in either form, sum below K.
- The weighted threshold equals K, and the simple threshold equals M.
- Every seat reads back with the stored account and owner equal to the offline values, and runs the pinned wasm.

Seats alone sum to less than K, so every M-of-N decision carries a signature from a native Stellar wallet. A seat added after creation sits at weight 0, because the account cannot change its rule-0 weights or thresholds (contract re-entry). Changing M or K, or adding a native owner, needs a new account.

## Rules that list a seat

Allowed shapes:

- `External(seat, account id)` in rule 0.
- `Delegated(seat)` in a `CallContract(X)` rule that carries the pinned policy-interpreter predicate, where X is a contract other than the account, the account's policy contracts and the seats.

Refuse and flag everything else on install and on read-back. In particular:

- Bounded rules are `CallContract`-scoped only. The interpreter refuses `Default` scope at install.
- A rule scoped to `CallContract(SIMPLE)` or `CallContract(WEIGHTED)` that lists a seat is dangerous. The threshold policies need only the account's authorization to change a threshold or a weight, so a session could lower rule 0's threshold and then hold rule 0.
- The chain still allows `Delegated(seat)` in a rule with no policy. The seat sees only the account's own `__check_auth` frame, never the call being authorized, so it cannot limit what such a rule reaches (residual R7). Installing the rule takes a decision that carries a native signature, and the app must refuse to build it.

A rule with the interpreter predicate bounds the session on chain. A `CallContract(XLM)` rule with a transfer-only predicate refused an account admin call in the testnet runs.

## Notes for the relayer

- A grant needs no authorization entry, and when an identical copy is submitted twice, the first to be applied sets the state. The second submitter gets contract error #1. Read the stored end before reporting a failure.
- Extend the seat's instance and code TTL with `ExtendFootprintTTL`. A grant does not.

## Build and checks

```
./build-wasm.sh                          # reproducible wasm, prints its sha256
cargo test                               # unit tests
cargo mutants -j1 --timeout 180          # every viable mutant caught
```

The size, the build hash and the test count are in [contracts/README.md](../../README.md).
