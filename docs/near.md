# Prime on NEAR: the signers

NEAR holds no Prime account and no funds. It gives an owner whose wallet lives on
another chain a key on each chain the wallet cannot sign for: the NEAR MPC
service holds that key, and a contract of ours asks the MPC to sign only after
it has checked the wallet's own signature. Two such contracts are deployed, both
on NEAR testnet. Both live in `contracts/near/`. Each signer account still holds
a full-access key that can call the MPC without the contract, so the checks
below bind every caller only once those keys are deleted ([Limits](#limits)).
[architecture.md](architecture.md) shows where they sit in the whole system.

| Contract | Account | Signs | Used by |
|---|---|---|---|
| `prime-near-signer-v2` | `seats.prime-spike-muwguc60.testnet` | the grant and the End of a seat session, nothing else | the seats on Stellar, EVM and Solana |
| `prime-near-signer` (v1) | `signer.prime-spike-muwguc60.testnet` | any payload the wallet approved | the spike harnesses of 7 to 9 October 2026; octopos main does not call it |

## Why a signer on NEAR

Each wallet refuses to sign some formats, so no wallet can act on all three
chains with its own key. The table comes from the round-9 design record
(section 5.1 of the
[old ARCHITECTURE.md](https://github.com/untangledfinance/oz-policy-builder/blob/archive/spike-final/contracts/prime/ARCHITECTURE.md),
read from the wallets' own code in October 2026).

| Wallet | Signs | Cannot sign |
|---|---|---|
| MetaMask | EVM transactions and messages (secp256k1) | a Solana or Stellar signature, which needs ed25519 |
| Freighter | Stellar transactions, Soroban authorization entries, and messages in SEP-53 form only: `sha256("Stellar Signed Message:\n" + text)` | an EVM message or a Solana transaction: the SEP-53 prefix goes on every message |
| Phantom (Solana account) | Solana transactions, and messages that are valid UTF-8 and do not parse as a Solana transaction | a Stellar transaction or authorization entry, which is 32 hash bytes |

Each chain could check every wallet's format itself. The spike measured that
version at 219 lines of contract code plus 1,104 lines of a vendored ed25519
library on EVM, which has no ed25519 built in. With NEAR, the contract on each
chain checks one signature format, and the only new cryptography code runs on
NEAR (section 5.2 of the old record). The cost is a NEAR round trip of about 8
seconds per signature, measured in the October harness runs.

NEAR's own wallet contract accepts ed25519 over a raw 32-byte hash, WebAuthn or
no signature, and Freighter and Phantom produce none of these. NEAR Intents
accepts SEP-53 but calls other contracts only through `on_auth`, and the MPC
contract has none (section 5.4 of the old record). So the route needs a contract
of ours.

## prime-near-signer v2

`contracts/near/prime-near-signer-v2/src/lib.rs`, 323 formatted sLOC across
`lib.rs`, `hash.rs` and `render.rs`.

```
sign(wallet, scheme, request, signature) -> Promise    (payable)
```

| Field | Values |
|---|---|
| `wallet` | a lowercase 64-hex ed25519 key (Freighter, Phantom) or a lowercase `0x` address (MetaMask) |
| `scheme` | `Sep53` (Freighter `signMessage`), `Raw` (Phantom `signMessage`), `Eip191` (MetaMask `personal_sign`) |
| `request` | `Grant { chain, account, seat, key, start, end }` or `End { chain, account, seat, key }`. `SafeVote`, `SolanaVote` and `StellarVote` exist only to fail with the reason `vote` |
| `signature` | hex of the wallet's signature over the rendered text |

The contract parses every field into fixed bytes and refuses any spelling that
differs from the canonical one (`hash.rs`), renders the text the wallet signed
(`render.rs`), checks the wallet's signature over that text, applies the time
rules, and only then calls the MPC's `sign` with:

- the key path `<scheme>:<wallet>/prime:<evm|solana|stellar>:<account>`, so a
  Freighter and a Phantom owner with the same ed25519 key derive different seat
  keys, and each account gets its own key;
- domain 0 (secp256k1) for Base Sepolia and domain 1 (ed25519) for Solana
  devnet and Stellar testnet;
- the 32-byte grant hash it computed itself as the payload. No request carries
  a free payload.

The wallet sees this text for a grant (`render.rs`):

```
Prime: start a session
Chain: <Base Sepolia (84532) | Solana devnet | Stellar testnet>
Prime Account: <account>
Your seat: <seat>
Session key: <key>
Starts: <date>
Ends: <date>
Until it ends, this key approves and votes for you on this Prime Account beside a signature from one of its own wallets, and acts alone in rules that list your seat.
Signature scheme: <scheme>
Signer: seats.prime-spike-muwguc60.testnet
```

An End says "Prime: end a session" and "After this, the key can never act
again."

**Time rules:** a grant starts at most 300 seconds after block time, ends after
it starts and lasts at most 604,800 seconds (7 days). So a grant signed through
v2 is usable for at most 7 days and 5 minutes after the signing, however long
the app holds it back. An End is the grant hash with start and end at 0.

**Hashes it signs:** the seat on each chain recomputes the same hash, so a
grant signed for one chain, account, seat or key fails everywhere else.

| Chain | Grant hash |
|---|---|
| EVM | `keccak256(abi.encode(keccak256("PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)"), 84532, account, seat, key, start, end))` |
| Solana | `sha256("prime-seat-grant" ‖ "devnet" ‖ account ‖ seat ‖ key ‖ be64 start ‖ be64 end)` |
| Stellar | `sha256("prime-seat-grant" ‖ network id ‖ account ‖ seat ‖ key ‖ be64 start ‖ be64 end)`, network id = `sha256("Test SDF Network ; September 2015")` |

`contracts/near/vectors/requests.json` holds the shared vectors: accepted
requests with their texts, paths and hashes, and refusals with their one-word
reason (`address`, `wallet`, `start`, `window`, `vote`, `signature`, and the
parse refusals `chain`, `field`, `variant`). The
generator in `contracts/near/vectors/generator` writes them with viem,
`@stellar/stellar-sdk`, `@solana/web3.js` and `@noble`, code the Rust contract
does not share. The EVM, Solana and Stellar seats test the same vectors.

**Fees:** the caller attaches the MPC fee (1 yoctoNEAR), and v2 forwards the
whole attached deposit to the MPC with all remaining gas.

## prime-near-signer v1

`contracts/near/prime-near-signer/src/lib.rs`, 42 sLOC after `rustfmt` (22 as
written). This build runs at `signer.prime-spike-muwguc60.testnet` since 9
October 2026; an earlier build ran there from 7 October.

```
sign(key, sep53, path, domain_id, payload, signature) -> Promise    (payable)
```

The wallet signs a short text with the contract, path, domain and payload:

```
Prime NEAR signer
contract: signer.prime-spike-muwguc60.testnet
path: <path>
domain: <id>
payload: <hex>
```

v1 checks the ed25519 signature (SEP-53 for Freighter when `sep53` is true, raw
text for Phantom) and asks the MPC to sign `payload` under the path
`<wallet key hex>/<path>`. It passes any payload through. The text shows the
payload as hex, so the wallet cannot show what it approves; v2 replaced this
with readable grant texts for the seats. v1 serves ed25519 wallets only: in the
spike, MetaMask reached the MPC through its stock NEAR account instead.

v1 is kept because it is deployed and pinned in CI. octopos main does not call
it; one offline test there uses its account name to show that v1 and v2 derive
different keys.

## How a key is derived

The MPC derives a key from the calling account and the path:
`sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + caller + "," + path)`
added to the MPC root key (section 12.5 of the old record, checked against live
MPC signatures for both key types). The caller is the signer account: its
contract, or anyone holding the account's full-access key (see
[Limits](#limits)). Through the contract the path starts with the wallet that
signed, so wallet A cannot obtain wallet B's key; the key holder can name any
path. v1 and v2 are separate accounts, so they derive different keys for the
same path.

## Build and test

From `contracts/near/prime-near-signer-v2`:

```sh
cargo test                                   # 4 tests over the vectors, the MPC call and the refusals
RUSTFLAGS="-C link-arg=-s --cfg near" cargo build --release --target wasm32-unknown-unknown
```

The wasm build needs `--cfg near`: without it `near-sdk` compiles software
hashing into the wasm and every refusal traps with no message. CI also remaps
the registry path to the deployed build's form, and the result is
`4b98d6d3c6a6ae15b11daa6e0a28b19f5764f028fd64440572e58904a17df7de` (157,934
bytes).

v1 builds with `cargo-near` 0.22.0 under Rust 1.98.1 with two path remaps
([contracts/README.md](../contracts/README.md#near) has the command). Its hash
is `c27904a329814b6ee92e8b37cc99490c8edbc9bbd3fd86a926b38e7d05b793c8` (110,145
bytes).

The vectors regenerate with Bun 1.4.2:

```sh
( cd contracts/near/vectors/generator && bun install --frozen-lockfile &&
  bun gen.ts /tmp/requests.json && cmp /tmp/requests.json ../requests.json )
```

## Deployed

| Contract | Network | Account | Code hash (base58) | Wasm sha256 |
|---|---|---|---|---|
| v2 | NEAR testnet | `seats.prime-spike-muwguc60.testnet` | `666kSs8zNUkMMfJ39hDne3UqV9AqE5Dw2deTTZPsnJjF` | `4b98d6d3…` |
| v1 | NEAR testnet | `signer.prime-spike-muwguc60.testnet` | `E6986kfXDAec5nZvuYiBiC3fmonHCrynwRCtd33s1U5u` | `c27904a3…` |

Both call the testnet MPC, `v1.signer-prod.testnet`, the default of the
compile-time setting `PRIME_MPC`. Nothing is deployed on NEAR mainnet. The code
hashes above were read from NEAR testnet on 18 October 2026, and each account
then held one full-access key.

## Limits

- **Testnet only:** v2's `Chain` type lists Base Sepolia, Solana devnet and
  Stellar testnet and no mainnet. A mainnet signer needs new chain entries,
  a build with `PRIME_MPC` set to the mainnet MPC, and a new account.
- **The deploy keys can sign anything until they are deleted:** each signer
  account holds one full-access key (read on 18 October 2026). Its holder can
  call the MPC as that account with any path and payload, so it can sign a grant
  for any NEAR-routed owner without the wallet, and it can replace the code. A
  session started from a forged grant still needs a native signature for every
  decision, and acts alone in every rule that lists the seat. v2's key
  (`ed25519:9hEsUKUV…`) is kept only in the agents' host's NEAR credentials;
  v1's key (`ed25519:K7JPXNYz…`) is also the key of the relayer account
  `prime-spike-muwguc60.testnet`, which the octopos relayer uses to pay NEAR
  calls. Locking an account means deleting its full-access key after the last
  code-hash check, which also ends upgrades; the deletion cannot be undone. This
  is a testnet limitation of today's deployment.
- **NEAR availability:** when NEAR or its MPC is down, a NEAR-routed owner
  cannot start or end a session. Live sessions keep working, because votes and
  moves never touch NEAR.
- **The relayer's NEAR balance:** each MPC `sign` call prepays 300 Tgas. In the
  spike runs one call burned about 0.0012 NEAR at the minimum gas price, and at
  ten times that price the prepay reached 0.3009 NEAR, so whoever pays for the
  calls needs a floor of about 0.31 NEAR (section 4.1 of the old record).
- **v1 signs blind:** the wallet sees a hex payload. Use v2 for anything new.
