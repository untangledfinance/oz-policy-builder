# One minimal contract per chain

> **Superseded by [`../near-minimal/README.md`](../near-minimal/README.md):** wallets now reach other chains through NEAR. That leaves smaller session-only contracts and no ed25519 library on EVM, and seats are kept apart from sessions.

Each chain gets one new contract that does two jobs for each wallet (MetaMask, Freighter, Phantom):

- **seat**: it is the wallet's seat in the account's 2-of-3;
- **session**: the wallet signs one readable grant, and then a short-lived session key makes moves within the account's rules.

Everything else is existing, audited code: the OZ smart account and OctoGate on Stellar, the Squads Smart Account on Solana, and Safe 1.4.1 with Zodiac Roles v2.1.1 on EVM. NEAR is not used anywhere.

Each wallet signs plain text with its own message signing:

- MetaMask uses `personal_sign`;
- Freighter uses `signMessage` (SEP-53);
- Phantom uses `signMessage`.

The grant has the same shape on every chain:

```
Prime session
contract: <the contract / signer>      (Solana: "signer: <PDA>")
session key: <key>
valid until …: <ledger | unix time>
network: <id>                          (Stellar: none, the contract ID is network-bound; Solana: "cluster: <c>\nprogram: <id>")
```

Revoking a session is the same text with "valid until" set to 0. A grant ending at 0 can never authorise a move.

## Size

sLOC counts non-blank lines that are not comments.

| Chain | Contract | sLOC | Before | Replaces |
|---|---|---|---|---|
| EVM | `evm/src/PrimeKey.sol` | **59** (+ vendored ed25519 library; hex/decimal text, EIP-191 and ECDSA from OpenZeppelin 5.4) | 175 + separate verifier | SessionMember, Ed25519Owner, SessionMemberEd, Ed25519Wallet, and the separately deployed Ed25519Verifier |
| Stellar | `session-signer/src/lib.rs` | **89** | 102 | the EIP-712 path, now one text grant for all three wallets; no network line (a Stellar contract ID already hashes the network ID) |
| Solana | `solana/prime-session/src/lib.rs` | **71** | 94 (v2) | separate grant/revoke texts and duplicated parsing |

The EVM count leaves out `lib/Ed25519.sol` (869 lines) and `lib/Sha512.sol` (235 lines). These are chengwenxi/Ed25519 (Apache-2.0, **unaudited**). The only change is wrapping each body in `unchecked {}` for 0.8. EVM has no ed25519 precompile, so Freighter and Phantom need this library on EVM unless NEAR does the signing. An audit must cover it.

## What each contract does

**PrimeKey (EVM).** There is one instance per wallet, created with `kind` (0 MetaMask, 1 Freighter, 2 Phantom), `owner` and the Roles modifier.

- **Seat:** `isValidSignature(bytes,bytes)`, the legacy ERC-1271 form that Safe 1.4.1 calls. The wallet signs `Prime approval\nsafe: <safe>\nsafe tx: <safeTxHash>`. MetaMask's seat stays its own EOA.
- **Grant:** `grant(key, end, sig)` checks the wallet's signature once per session and stores `until[key]`. Sessions last at most 7 days. A grant can only extend a session, so an older grant cannot be replayed to shorten it. The zero key is refused.
- **Moves:** `exec(…, key, sig)` takes the session key's ECDSA signature over (contract, chain, per-key nonce, call). It then calls `roles.execTransactionWithRole`, and the Roles rule decides what is allowed.
- **Revoke:** `revoke(key, sig)` is permanent for that key.
- **Constructor:**
  - refuses a zero or over-wide MetaMask owner (with a zero owner, any malformed signature would recover to it);
  - refuses ed25519 keys of small order or with a non-canonical encoding (the library accepts a forgery with the identity key);
  - refuses unknown kinds.

**session-signer (Stellar).** It is a `Delegated` signer of the OZ account, with `Owner::Evm | Stellar | Solana`.

- MetaMask now grants with `personal_sign` over the same text that Freighter and Phantom sign. The EIP-712 types are gone.
- Refusals: #1 expired or more than 7 days ahead, #2 revoked, #3 not the owner.

**prime-session (Solana).** It is stateless. Each move carries the wallet's grant, which Solana's ed25519 or secp256k1 program checks in the same transaction. Every field must come from that signature instruction itself.

- **Signer:** the PDA `["prime", kind, owner]` is the wallet's seat and its policy member.
- **Target:** a session may only call the Squads Smart Account program.
- **Revocation fix:** a revocation is now an account at `["revoked", PDA, key]` that the program **owns**. v2 treated any lamports at that address as "revoked". Anyone could send lamports to that address and stop a live session (V16 to V22 now check this can't happen). Revoking now tops the marker up to rent exemption and assigns it to the program, whatever balance the marker already has.

## Results

**EVM.** 104/104 pass (`evm/pk.log`). The run used an anvil fork of Base Sepolia and the PrimeX onboarding/policy code from octopos.

- **A1–A10 (ported library):**
  - RFC 8032 tests 1–3 pass;
  - 40 random keys with messages of 0–1024 bytes are accepted;
  - flipped message/R/S bits, another key, S+L and an all-zero signature are refused.
- **B1–B22 (constructor):**
  - zero and over-wide MetaMask owners are refused;
  - kind 3 is refused;
  - all 9 small-order/non-canonical encodings are refused for both Freighter and Phantom;
  - real owners deploy.
- **C1–C4 (account setup):** the Safe is created with seats MetaMask EOA + PrimeKey(Freighter) + PrimeKey(Phantom) and threshold 2. The movers rule is installed for the three PrimeKeys.
- **S1–S11 (seats):**
  - a single wallet is refused;
  - every pair of wallets moves funds;
  - these are all refused: Freighter without the SEP-53 prefix, a Phantom seat signed by Freighter, an approval of another transaction, an approval naming another Safe, and MetaMask's signature on an ed25519 seat.
- **G (sessions, ×3 wallets):**
  - one signature opens a session, then two moves succeed;
  - these are all refused: a replayed move, another recipient (the Roles rule), another signer, a session longer than 7 days, a stretched end, a shortening replay, and the zero key;
  - revoke works; a revoked key is refused, and so is re-granting it;
  - other sessions are unaffected.
- **X1–X9 (cross-checks):** these are all refused:
  - a grant presented to the wrong wallet's PrimeKey;
  - a grant replayed to another PrimeKey;
  - a session key used through another PrimeKey;
  - a stranger calling Roles directly;
  - a move over the daily cap;
  - a move after the session ends.

The first run failed only B22. That was a harness bug: three deployments sent in parallel reused a nonce. The log is kept in `evm/pk.run1-harness-nonce-bug.log`.

EVM gas from this run:

| | MetaMask | Freighter | Phantom |
|---|---|---|---|
| grant (once per session) | 96k | 518k | 715k |
| first move | 161k | 144k | 144k |
| each later move | 126k | 126k | 126k |

- The Safe approval by Freighter + Phantom (two ed25519 seats) cost 1.22M gas.
- One ed25519 verification costs about 0.64M gas (it was about 0.9M with the 0.6 build).
- The earlier SessionMemberEd checked ed25519 on **every** move. PrimeKey checks it once per grant.

**Stellar.** 27/27 pass on testnet (`stellar/final-stellar.log`), with the new wasm `200c807c…`.

- Rule 0 is 2-of-3: S_mm, Freighter's G account, and S_ph.
  - Y1–Y8: a single wallet is refused, every pair succeeds, and wrong-wallet grants are refused.
- R: the session rules are installed.
- Q: MetaMask (now `personal_sign`), Freighter and Phantom sessions move XLM to VENUE.
  - Q-*2–Q6: other recipients, changes to rule 0, cross-rule use and wrong-format grants are refused.
  - Q8: a revoked session is refused with #2.
  - Q9: an expired session is refused with #1.
- Unit tests: 18/18 pass (`cargo test`). They include a fixed viem `signMessage` vector.

**Solana.** 75/75 pass (`solana/ps3.log`) on a local validator, with Squads Smart Account and Swig cloned from devnet and prime-session loaded at genesis.

- **P0 (setup):** the seats are the three PDAs, threshold 2.
- **K1–K5 (seats):**
  - a single wallet is refused;
  - every pair proposes, approves and executes.
- **Policy:** the movers policy is installed by a 2-of-3 decision.
- **M (sessions, ×3 wallets):**
  - a move to VENUE succeeds;
  - moves elsewhere are refused;
  - calls to any program other than the Smart Account are refused.
- **N:** wrong-format and wrong-wallet grants are refused.
- **V1–V15:**
  - revoke works for each wallet, and a revoke signed by another key is refused;
  - a swapped marker is refused;
  - grants for another cluster or another program are refused;
  - an ed25519 instruction that reads its key from another instruction is refused.
- **V16–V25:**
  - a stranger pre-funding the marker (at the rent minimum and at 0.01 SOL) neither revokes a live session nor blocks a real revoke;
  - revoking twice is a no-op;
  - a signed revoke text cannot be used as a grant.

The first run failed only V16, and the test caused it: the runtime refuses a 1000-lamport transfer that would leave a new account below rent exemption. The log is kept in `solana/ps3.run1-v16-below-rent.log`.

## Still open

- **Audit:** all three contracts, plus the vendored ed25519 library on EVM.
- **EVM moves have no deadline:** a signed move can wait for up to the session's end. Its nonce and the 7-day cap bound it.
- **Stellar's 7-day cap counts ledgers:** it is 120,960 ledgers, not seconds.
- **Phantom on Solana:** the real Phantom refuses to `signMessage` raw bytes. The grant is UTF-8 text, so this is fine, and it was checked with the real extension in round 2.

## Second trim

- **EVM, 75 → 59 sLOC:** OpenZeppelin `Strings`, `MessageHashUtils` and `ECDSA` replace the hand-written hex/decimal, EIP-191 and recovery code. Revocation is now `until = type(uint256).max` instead of a second mapping; `exec` refuses any `until` more than 7 days ahead, and `grant` refuses because `until[key] < end` fails. Result: 104/104 again. The MetaMask grant fell from 96k to 76k gas.
- **Stellar, 93 → 89 sLOC:** the `network:` line is dropped, and the two ed25519 owner branches share one verify call. Result: 27/27 on testnet and 17/17 unit tests. The `another network` unit test is gone because the contract ID already differs per network.
- Build note: `evm/lib/oz` is OpenZeppelin Contracts 5.4.0 unpacked from npm (not committed): `npm pack @openzeppelin/contracts@5.4.0` and copy `package/utils` there.
