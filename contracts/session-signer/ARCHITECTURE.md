# Prime on Stellar, EVM and Solana: three wallets, seats and sessions

Status: spike, testnet only, branch `spike/session-signer`. Runs dated 7 October 2026. Every claim links to a log, a testnet transaction or a source file (section 12). Spike paths below are relative to `spike/matrix/near-minimal/`.

## 1. The goal

A **Prime Account** is a shared account with three owners. Each owner uses one of three wallets: **MetaMask**, **Freighter** or **Phantom**. The account can live on any of three chains: **Stellar**, **EVM** (Base) or **Solana**.

Every wallet must be able to do two jobs on every chain:

1. **Seat.** The wallet is one of three votes. Any two votes together can change anything (2-of-3). One vote alone can change nothing.
2. **Session.** The wallet signs **once** to start a session key that lasts at most 7 days. The session key then makes moves by itself, but only the moves the account's rules allow. A session key can never vote.

Our **relayer** pays the fees for moves. If the relayer is down, the **session key pays its own fee**.

That is 3 wallets × 3 chains × 2 jobs = 18 cases. All 18 are tested (section 10).

## 2. Words used here

| Word | Meaning |
|---|---|
| Prime Account | The shared account: a Safe on EVM, a Squads Smart Account on Solana, an OpenZeppelin smart account on Stellar. |
| Seat | One of the three 2-of-3 votes. Always a plain key: an EVM address, a Solana key, or a Stellar account. |
| Ledger | Stellar's word for a block. One ledger closes about every 5 seconds. |
| Rule | What a session may do: which contract, which function, which recipient, and on EVM and Solana how much per move or per day. |
| Session contract | Our small contract that the rules list as a member (on Solana, the member is an address that only our program can sign for). It checks the wallet's one-time grant and the session key's signature on each move. |
| Grant | Readable text the wallet signs once: "session key K may act until time T". |
| Move | One action by a session key, such as "send 10 tokens to the venue". |
| Relayer | Our server. It sends transactions and pays their fees. Freighter and Phantom hold no NEAR, so their NEAR requests go through it. MetaMask's NEAR account is funded once by the relayer and pays the MPC fee itself. Moves still work without the relayer. |
| NEAR MPC | NEAR's signing service (`v1.signer-prod.testnet`). A NEAR account asks it to sign bytes. The key it signs with is derived from the account's name and a "path" string, so every NEAR account gets its own keys for every chain. Each request carries a small fee (1 yoctoNEAR on testnet). |
| Domain | Which kind of key the MPC uses: 0 = secp256k1 (EVM), 1 = ed25519 (Solana, Stellar). |
| Home chain | The chain a wallet can sign for by itself: MetaMask on EVM, Freighter on Stellar, Phantom on Solana. |
| Stand-in | A test key that signs in exactly the same format as the real wallet. The large test runs use stand-ins; section 10.1 lists what ran with the real wallet apps. |

Chain-specific terms are explained where they first appear.

## 3. The big picture

```mermaid
flowchart TB
  subgraph W[Wallets]
    MM[MetaMask]
    FR[Freighter]
    PH[Phantom]
  end
  R[Relayer<br/>pays NEAR fees]
  subgraph N[NEAR]
    EI[MetaMask's NEAR account<br/>stock NEAR code]
    SG[prime-near-signer<br/>ours, 21 lines]
    MPC[NEAR MPC<br/>holds one key per wallet per chain]
  end
  subgraph C[Prime Accounts]
    EVM[EVM<br/>Safe + Roles + PrimeKey]
    SOL[Solana<br/>Squads + prime-session]
    XLM[Stellar<br/>OZ account + session-signer]
  end
  MM == own key ==> EVM
  FR == own key ==> XLM
  PH == own key ==> SOL
  MM -. signed request .-> R
  FR -. signed text .-> R
  PH -. signed text .-> R
  R -. MetaMask .-> EI -.-> MPC
  R -. Freighter, Phantom .-> SG -.-> MPC
  MPC -. "MetaMask's keys" .-> SOL
  MPC -. "MetaMask's keys" .-> XLM
  MPC -. "Freighter's keys" .-> EVM
  MPC -. "Freighter's keys" .-> SOL
  MPC -. "Phantom's keys" .-> EVM
  MPC -. "Phantom's keys" .-> XLM
```

In one sentence: **each wallet uses its own key on its home chain, and a key held for it by NEAR MPC on the other two.**

| Wallet | EVM | Solana | Stellar |
|---|---|---|---|
| MetaMask | **own key** | stock NEAR account → MPC ed25519 key | stock NEAR account → MPC ed25519 key |
| Freighter | prime-near-signer → MPC secp256k1 key | prime-near-signer → MPC ed25519 key | **own key** |
| Phantom | prime-near-signer → MPC secp256k1 key (or its own EVM account, section 6.2) | **own key** | prime-near-signer → MPC ed25519 key |

On each chain, the same key does both jobs: it is the wallet's seat, and it is the owner that signs session grants.

## 4. Seats and sessions are kept apart

Seats are plain keys. Our session contracts are only ever members of the rules, never seats.

```mermaid
flowchart TB
  subgraph A[Prime Account]
    V[2-of-3 vote<br/>can change anything]
    R[Rules<br/>allowed moves only]
  end
  K1[MetaMask key] --> V
  K2[Freighter key] --> V
  K3[Phantom key] --> V
  S1[MetaMask's session contract] --> R
  S2[Freighter's session contract] --> R
  S3[Phantom's session contract] --> R
  SK((session keys)) -. sign moves .-> S1 & S2 & S3
```

| Chain | Seat (2-of-3) | Session contract is | and is not |
|---|---|---|---|
| EVM | Safe owner | a Zodiac Roles member | a Safe owner |
| Solana | Squads settings signer | a signer of a Squads policy | a settings signer |
| Stellar | signer of rule 0 | the only signer of that wallet's session rule | a signer of rule 0 |

So a stolen session key can at worst make allowed moves until it expires. It cannot add owners, change rules or vote. Each chain's tests try to make a session vote; every attempt is refused (section 10).

**Where the grant lives** differs by chain, to keep each contract small:

| Chain | Grant handling | Why |
|---|---|---|
| EVM | sent once in its own transaction; PrimeKey stores "valid until" per session key | each move then carries only the session key's signature, which keeps moves cheap |
| Solana, Stellar | not stored; the grant signature travels with every move and is checked every time | no storage and no extra transaction, so less code |

## 5. NEAR: a key for chains the wallet cannot sign for

### 5.1 Why a wallet cannot use its own key everywhere

The problem is the wallets: each one refuses to sign some formats.

| Wallet | Signs | So it cannot |
|---|---|---|
| MetaMask | EVM transactions and messages (secp256k1 keys) | sign for Solana or Stellar, which use ed25519 keys |
| Freighter | Stellar transactions, and messages only in SEP-53 form: `sha256("Stellar Signed Message:\n" + text)` | sign an EVM message or a Solana transaction. Its key is ed25519 like Solana's, but it adds the SEP-53 prefix to every message, so a Solana transaction signature cannot be made. |
| Phantom (Solana account) | Solana transactions, and messages that are valid UTF-8 and do not look like a Solana transaction | sign a Stellar transaction or authorization: those are 32 hash bytes, which are almost never valid UTF-8 |
| Phantom (EVM account) | EVM, on its built-in chain list only | sign for NEAR's EVM chain ids (397/398), so it cannot use MetaMask's NEAR route |

### 5.2 Why NEAR, and not a signature checker on each chain

Each chain could check the other wallets' formats itself. An earlier version on this branch did exactly that, with no NEAR (`spike/matrix/minimal/`):

| | Each chain checks every wallet's format | NEAR route (this design) |
|---|---|---|
| EVM | PrimeKey 59 lines **+ 1,104 lines** of an unaudited ed25519 library, because EVM has no ed25519 built in | PrimeKey 41 lines, normal EVM signatures only |
| Stellar | session-signer 89 lines: secp256k1, SEP-53 and plain-text owners | 65 lines: SEP-53 owners only |
| Solana | prime-session 71 lines: ed25519 and secp256k1 owners | 37 lines: ed25519 owners only |
| NEAR | — | prime-near-signer 21 lines |
| **Total** | **219 lines + 1,104 vendored** | **164 lines** |

This is not an exact like-for-like comparison. In the earlier version, the same contracts were also the wallets' seats, and the Solana one had revoke. The point that matters: with NEAR, each chain's contract checks only one signature format, and no chain needs extra cryptography code. The cost is a NEAR round trip of about 7–9 s on average for NEAR-routed seat votes, grants and revokes (never for moves).

### 5.3 MetaMask: stock NEAR code only

Every EVM address has a NEAR account of the same name (an "eth-implicit" account, NEP-518). It comes into existence the first time someone sends it NEAR (our relayer sent 2 NEAR), and it runs NEAR's stock wallet contract. MetaMask signs one EVM-style transaction for NEAR's chain id (398 on testnet, 397 on mainnet). The relayer sends it to the account's `rlp_execute` method and pays the gas. The stock contract then calls MPC `sign`, paying the 1 yoctoNEAR fee from the account's balance. Nothing of ours runs on NEAR for MetaMask.

### 5.4 Freighter and Phantom: why stock NEAR code is not enough

NEAR's open-source wallet contract (`near/intents`, `contracts/wallet/signatures/`) supports three modes: ed25519 over a raw 32-byte hash, WebAuthn (passkeys), and no signature. The no-signature mode checks no owner at all, so it is not usable. Neither wallet can produce the other two (section 5.1).

NEAR Intents does accept SEP-53. But it can call other contracts only through `AuthCall` → `on_auth()`, and the MPC contract has no `on_auth`, so Intents cannot ask the MPC to sign.

We do not change NEAR's wallet contract, so it stays stock, already-reviewed code. Instead we wrote one small separate contract.

### 5.5 prime-near-signer (ours, 21 lines)

A NEAR contract at `signer.prime-spike-muwguc60.testnet` with one method and no storage.

```mermaid
sequenceDiagram
  participant W as Freighter / Phantom
  participant R as Relayer
  participant S as prime-near-signer
  participant M as NEAR MPC
  W->>W: sign the readable text<br/>(contract, path, domain, payload)
  W->>R: wallet key + signature
  R->>S: sign(key, sep53, path, domain, payload, signature)<br/>relayer pays gas and the MPC fee
  S->>S: rebuild the text, check the signature
  S->>M: sign(payload) under path "<wallet key>/<path>"
  M-->>S: signature
  S-->>R: signature by this wallet's own derived key
```

This is the exact text real Phantom showed and signed on testnet:

```
Prime NEAR signer
contract: signer.prime-spike-muwguc60.testnet
path: prime:stellar
domain: 1
payload: 77d2870cebe528bcd6a869ff33ab3e0dc72c7a4e687c5fe2386507504a66a4e9
```

| Part | Why it is there |
|---|---|
| Readable text | Freighter signs it as SEP-53 and Phantom as plain UTF-8, both without changes. The user sees what they sign. |
| The text names the contract, path, domain and payload | A signature for one request cannot be used for any other. Eight refusal tests check this. |
| The wallet's key starts the MPC path | The MPC derives the key from (caller, path), and the caller is always this contract. With the wallet's key in the path, wallet A can never get wallet B's key. |
| No storage, no nonce | Replaying a request only gets another signature over the same payload, which gives nothing new. |

**Before mainnet:** delete the deploy key from the signer account so its code can never change. Today the account still has one full-access key (checked on testnet).

## 6. EVM (Base): Safe + Zodiac Roles + PrimeKey

### 6.1 Components and why each is needed

| Component | Who wrote it | Why it is needed |
|---|---|---|
| Safe 1.4.1 (SafeL2, proxy factory, fallback handler, MultiSend) | Safe, open source | Holds the funds. Its owners and threshold are the 2-of-3 seats. |
| Zodiac Roles v2 | Gnosis Guild, open source | The rules. A Safe "module" (an add-on the Safe trusts to send transactions) that lets each member call only allowed contracts, functions and arguments, within daily allowances. |
| PrimeX onboarding and policy code | ours, already in PrimeX (`apps/evm-web/src/core/onboarding.ts`, `evm-policy.ts`) | Creates the Safe, deploys Roles, writes the rule. Not changed by this work. |
| **PrimeKey** | **ours, new, 41 lines** | One per wallet per account. It is that wallet's Roles member. It checks the wallet's grant and the session key's signature on each move, then calls Roles. |
| OpenZeppelin ECDSA, MessageHashUtils, Strings 5.4 | OpenZeppelin, open source | Signature recovery and text building inside PrimeKey. |

Why not make each session key a Roles member directly? Adding a member takes a 2-of-3 Safe transaction every time. With PrimeKey, the 2-of-3 adds PrimeKey once. After that, the wallet starts sessions alone with one signature.

### 6.2 A seat action (2-of-3)

```mermaid
sequenceDiagram
  participant A as Wallet A
  participant B as Wallet B
  participant R as Relayer
  participant S as Safe
  A->>A: sign the Safe transaction hash
  B->>B: sign the Safe transaction hash
  A->>R: signature
  B->>R: signature
  R->>S: execTransaction(tx, both signatures)
  S->>S: two different owners? threshold 2 met?
```

- MetaMask signs with its own key. PrimeX already uses typed data (EIP-712) for this.
- Freighter and Phantom sign the hash through NEAR MPC with their secp256k1 keys. On the live Base Sepolia Safe, Phantom's seat is its MPC key `0x5F17…F3b1`.
- Phantom can instead use its own EVM account. Base Sepolia (84532) is on Phantom's chain list, but in our test (Testnet mode on), Phantom reported the switch to Base Sepolia as done but stayed on Sepolia, so it refused to sign typed data (EIP-712) for Base Sepolia. It can still `personal_sign` the hash: Safe has a signature type for `personal_sign` signatures and accepts it. This was tested with the real Phantom on a Base Sepolia fork.

### 6.3 A session

```mermaid
sequenceDiagram
  participant W as Wallet
  participant K as Session key
  participant R as Relayer (or K itself)
  participant P as PrimeKey
  participant Ro as Zodiac Roles
  participant S as Safe
  W->>W: personal_sign the grant text (once)
  W->>R: grant signature
  R->>P: grant(key, end, grant signature)
  K->>K: sign the move (contract, chain, nonce, call, role)
  K->>R: move + signature
  R->>P: exec(call, key, session signature)
  P->>P: session live? signed by K? nonce + 1
  P->>Ro: execTransactionWithRole(call)
  Ro->>Ro: contract, function, recipient, daily cap OK?
  Ro->>S: execute the call
```

- `personal_sign` (EIP-191) is the standard "sign this text" in EVM wallets. All three wallets sign the same grant text: MetaMask directly, Freighter and Phantom through NEAR MPC, which signs the same EIP-191 digest.
- A grant must end in the future, at most 7 days ahead, and later than the key's current end. So a grant can extend a session but never shorten or replay it.
- **Revoke:** the wallet signs the grant text with end 0. PrimeKey then sets the key's end to the largest possible number. A move needs "end within 7 days from now", so the key stops working. A new grant needs "new end later than current end", which is impossible, so the key can never be granted again.

## 7. Solana: Squads Smart Account + prime-session

### 7.1 Components and why each is needed

| Component | Who wrote it | Why it is needed |
|---|---|---|
| Squads Smart Account program (`SMRTzfY6…`) | Squads, open source | Holds the funds. Its settings signers with threshold 2 are the seats. Its `ProgramInteraction` policies are the rules (allowed programs and accounts, per-move limit, daily allowance). |
| Solana ed25519 program | built into Solana | Checks the wallet's grant signature inside the same transaction. |
| **prime-session** | **ours, new, 37 lines** | Signs for one "PDA" per wallet per account. A PDA is an address with no private key that only its program can sign for. Each wallet's PDA (`["prime", wallet key, Smart Account settings address]`) is a policy signer only. On each move, prime-session checks that the ed25519 program verified this wallet's grant in this transaction, then signs the Smart Account call as the PDA. |

Why a program at all? The policy needs a signer that is not a seat and that a wallet can hand to a session key with one signature. A PDA can be that signer, and only a program can sign for a PDA. Squads accepts it because it only checks that a policy signer is a member and has signed (`is_signer`), and a PDA signed by its program counts as signed.

### 7.2 A session

```mermaid
sequenceDiagram
  participant W as Wallet
  participant K as Session key
  participant R as Relayer (or K itself)
  participant E as ed25519 program
  participant P as prime-session
  participant SA as Squads Smart Account
  W->>W: sign the grant text (once)
  W->>K: grant signature
  K->>K: build the transaction with the relayer as fee payer<br/>(or K itself when the relayer is down), then sign it
  K->>R: the signed transaction
  R->>R: co-sign as fee payer, send it
  Note over E,P: one transaction, two instructions
  R->>E: ed25519 instruction: check the wallet's signature on the grant text
  R->>P: execute(wallet key, Smart Account settings address,<br/>end, index of the ed25519 instruction, call)
  P->>P: K signed this transaction? the grant names K?<br/>the ed25519 instruction checked this wallet and this text? not expired?
  P->>SA: the call, signed by the PDA
  SA->>SA: PDA is a policy signer? call inside the policy?
```

For a NEAR-routed wallet (MetaMask or Freighter on Solana), the first step goes through the relayer, NEAR and the MPC, as in section 5.

- **The grant text** names the PDA, the session key, the end time, the cluster and the program id. The cluster is set when prime-session is built (`PRIME_CLUSTER`, default `localnet`), so a grant for another cluster or another program is refused (X6, X7).
- **The session key is bound to the grant:** the grant text names the session key, and prime-session rebuilds the text with the key that signed the transaction.
- **No nonce is needed:** the session key must sign every transaction, and Solana itself refuses a transaction it has already processed.
- **No per-session revoke.** It would cost 13 lines; we add revoke only where it costs at most 10 lines per contract. A session ends at its time, or earlier when the 2-of-3 removes the PDA from the policy (R0–R3: after removal Freighter's live session is refused with `NotASigner`, and MetaMask's still works).
- prime-session may call only the Smart Account program.
- **One account only:** the PDA depends on the wallet's key and on the Smart Account, and the grant text names the PDA. So a grant made for one Prime Account is refused in any other, even one with the same three seats (tests A0–A6).

## 8. Stellar: OpenZeppelin smart account + session-signer

### 8.1 Components and why each is needed

| Component | Who wrote it | Why it is needed |
|---|---|---|
| Smart account (OpenZeppelin `stellar-accounts`, "context rules") | OpenZeppelin, open source | Holds the funds. Each rule lists signers and policies for some calls. Rule 0 covers everything and holds the three seats. Each seat is a `Delegated` signer: a Stellar account (G…) that must authorize the call itself. |
| OZ weighted-threshold policy | OpenZeppelin, open source | Makes rule 0 a 2-of-3. |
| policy-interpreter | ours, already on testnet and mainnet | The session rules' policy. Checks each move against a predicate, such as "only `transfer`, only to the venue". Not changed by this work. |
| **session-signer** | **ours, new, 65 lines** | One per wallet per account. It is the only signer of that wallet's session rule. When the account asks it to approve a call (`__check_auth`), it checks the wallet's SEP-53 grant and the session key's signature. |

Why both session-signer and policy-interpreter? They answer different questions. session-signer answers "who is asking?" (a live session of this wallet). policy-interpreter answers "is this move allowed?".

### 8.2 A session

```mermaid
sequenceDiagram
  participant W as Wallet
  participant K as Session key
  participant R as Relayer (or K's own account)
  participant A as Smart account
  participant S as session-signer
  participant I as policy-interpreter
  W->>W: SEP-53 sign the grant text (once)
  W->>K: grant signature
  K->>K: sign the move's authorization
  K->>R: move + proof (key, until, grant signature, session signature)
  R->>A: send the move
  A->>S: __check_auth
  S->>S: not expired? at most 7 days? not revoked?<br/>wallet signed the grant? key signed the move?
  A->>I: does the move match the rule?
```

For a NEAR-routed wallet (MetaMask or Phantom on Stellar), the first step goes through the relayer, NEAR and the MPC, as in section 5.

- The grant has no network line, because the contract address already differs per network.
- Expiry is a ledger number, at most 120,960 ledgers (about 7 days) ahead.
- A revoke is saved in long-lived ("persistent") storage. If Stellar archives that entry, any move that reads it fails until someone restores it with its old value, so a revoke can never quietly vanish. A new entry also lives at least 120,960 ledgers on testnet and 2,073,600 (about 120 days) on mainnet, both at least as long as the longest session.
- The tested session rules allow XLM transfers to one venue only. They have no amount limit; policy-interpreter can express one, but it was not part of these tests.

## 9. Fees: relayer first, session key as fallback

| Chain | Relayer up | Relayer down |
|---|---|---|
| EVM | relayer sends `grant` and `exec` | the session key sends them from its own address and pays the gas |
| Solana | the session key builds the transaction with the relayer as fee payer and signs it; the relayer co-signs and sends it | the session key is the fee payer and sends it |
| Stellar | relayer's account is the transaction source and pays | the session key's own Stellar account (same key) is the source and pays |
| NEAR | relayer pays gas, and the MPC fee for Freighter and Phantom | NEAR-routed seat votes, grants and revokes wait; moves are unaffected |

Each chain tests both paths, plus a session key with no money, which is refused.

## 10. What was tested

| Chain | Where | Result | Log |
|---|---|---|---|
| EVM | **real Base Sepolia** + NEAR testnet | **88/88**: 30 transactions (all succeeded on chain), 53 refusals, 5 balance and owner checks | `evm/pkn-live.log`, `evm/verify-evm.log` |
| Stellar | **Stellar testnet** + NEAR testnet | **55/55** | `stellar/stn.log`, `stellar/verify-stellar.log` |
| Solana | local validator running the devnet Squads program unchanged + NEAR testnet | **78/78** | `solana/psn.log` |
| prime-near-signer | NEAR testnet | **11/11**: 8 refusals, 3 accepted controls | `near-signer/signer-neg.log` |
| session-signer unit tests | local | **13/13** | `cargo test` in `contracts/session-signer` |

Each chain's matrix runs these groups. The table notes where a group covers only some wallets or chains.

| Group | What is checked |
|---|---|
| Seats | every pair of wallets can act; each wallet alone is refused; an outsider is refused; a wallet's key under another NEAR path is refused; one wallet cannot vote twice (EVM; Stellar and Solana check that a seat is signed by its own key) |
| Sessions cannot vote | a session key, or a session contract, is refused as a vote; a session cannot add owners, change rules or delegatecall (run code inside the account) |
| Sessions | one-signature grant; move paid by the relayer; move paid by the session key; no money means refused; replay, wrong signer, wrong recipient, too long, expired: all refused; over the cap refused (EVM, Solana) |
| Revoke (EVM: all three wallets; Stellar: MetaMask and Freighter) | one signature revokes; the revoked key is refused and cannot be granted again; the wallet's other sessions keep working |
| One account only (Solana, A0–A6, Phantom's grants) | a second Smart Account with the same seats: a grant for account A is refused in account B and the other way round; a grant for B works in B |
| Removal from the policy (Solana, R0–R3) | after the 2-of-3 removes Freighter's PDA, its live session is refused (`NotASigner`); MetaMask's still works |
| Cross-wallet | wallet A's grant on wallet B's session contract; a grant text made for another contract; the wrong format (raw hash instead of `personal_sign`, plain text instead of SEP-53): all refused |

### 10.1 Real wallet apps versus stand-ins

| Wallet | Run with the real browser extension | Stand-in in the matrices |
|---|---|---|
| Phantom 26.32.0 | Signed the prime-near-signer text above; NEAR MPC then signed with Phantom's derived key ([NEAR tx](https://testnet.nearblocks.io/txns/2xhZduPcJKwfXJfqG2WrSaZuoMeWn34XBDWhUtuAptcb)). Its own EVM account signed a PrimeKey grant and acted as a Safe seat on a Base Sepolia fork (`phantom-evm/`). | a test ed25519 key signing the same UTF-8 text |
| Freighter 5.49.0 | Signed the prime-near-signer text as SEP-53; NEAR MPC then signed with Freighter's derived EVM key `0xD114…a952`, the same address we derive offline ([NEAR tx](https://testnet.nearblocks.io/txns/GZxKyDGL9LZtM3uaMpA2jBskZWNXik6PjbHPK8HmhpC3)). | Freighter's own `signMessage` code with a test key |
| MetaMask | **not run** (no MetaMask extension on the test machine) | a test key signing the same chain-398 transaction and `personal_sign` text |

- The real extensions used their own keys, not the matrices' test keys. So they prove that each route works with the real app; they are not the seats of the test accounts (for example, the test Safe's Freighter seat is `0x29A9…13fF`, the stand-in's key).
- The Freighter test profile was first set to Main Net, which its prompt showed. `signMessage` signs only the text, so the network plays no part, and no mainnet transaction was made. The profile is now on Test Net, and a second real Freighter request showed "Network: Test Net" ([NEAR tx](https://testnet.nearblocks.io/txns/8npfk7AKj5qCLUruqvKTNmCm3pQi5mr7oVnQB8F6N57u), ed25519 key for Solana).

## 11. New code on top of open source

### 11.1 On-chain code

| Chain | Open source used as is | Our existing code, unchanged | **New for this design** | sLOC | Includes revoke? |
|---|---|---|---|---|---|
| NEAR | NEAR MPC; NEP-518 eth-implicit wallet (MetaMask) | — | **prime-near-signer** | **21** | not needed (no state) |
| EVM | Safe 1.4.1, Zodiac Roles v2, OpenZeppelin 5.4 libraries | PrimeX onboarding (308) and policy builder (555), TypeScript | **PrimeKey** | **41** | yes (5 of the 41) |
| Solana | Squads Smart Account, ed25519 program | — (no Prime app on Solana yet) | **prime-session** | **37** | no (would add 13) |
| Stellar | OZ smart account, OZ weighted-threshold policy | policy-interpreter (1,082, Rust); policy-synth rule builder | **session-signer** | **65** | yes (7 of the 65) |
| | | | **Total** | **164** | |

sLOC means non-blank, non-comment lines. Nothing was added to NEAR's wallet contract.

### 11.2 Off-chain code (app and relayer)

| Piece | What it does | Spike reference (sLOC, including test code) |
|---|---|---|
| NEAR routing client | MetaMask: build the chain-398 transaction for `rlp_execute`. Freighter / Phantom: build the request text and call the signer. Derive and check each MPC key. | `nearsig.ts` (81), `mm.ts` (55), `near.ts` (23) |
| EVM grant and move builders | grant text, move hash, relayer or self-paid submit | `evm/pkn.ts` (198, mostly tests) |
| Solana grant and move builders | ed25519 instruction, policy move, fee payer choice; also sets up the Squads account and policy | `solana/psn.ts` (216, mostly tests) |
| Stellar grant and move builders | grant text, auth proof, fee source choice | `stellar/stn.ts` (190, mostly tests), `stellar.ts` (121) |
| Relayer endpoints | send NEAR, grant and move transactions; pay their fees | the spike uses a local key; the Prime relayer needs new endpoints |

None of this is in the Prime apps yet. Solana has no Prime app; the spike creates its Squads account and policy directly.

## 12. Proofs

### 12.1 The deployed code is the reviewed code (`build-proofs.log`, `evm/bytecode-eq.log`)

| Contract | Network | Check | Result |
|---|---|---|---|
| prime-near-signer | NEAR testnet | base58(sha256) of our wasm equals the account's `code_hash` | `D2xgePUEzgfRysCScYruUGUFg2g8Twueuh1ipCpz3Hob`, equal |
| PrimeKey ×3 | Base Sepolia | deployed bytecode equals our solc 0.8.28 build, ignoring the owner and Roles addresses each PrimeKey is deployed with (4 places in the code) | equal, all three |
| session-signer ×3 | Stellar testnet | `stellar contract build` from this branch gives the deployed wasm hash | `a60de71f45b2bac63b874a481e96d7fc91af31b50808b9f8c3f3d70eed782d05`, equal |
| prime-session | local validator | the program code read back from the validator is our build plus zero padding (`solana/build-check.log`) | sha256 of our build `20a1bb171ca04848c3ad9ad58f5896adbb0a2c06b1f2fd3338285f18f6adcb0b`, equal |
| Squads Smart Account | Solana devnet | the validator cloned the devnet program, last deployed at slot 425,429,201 (2 December 2025), before our 7 October 2026 runs | unchanged |

### 12.2 EVM, real Base Sepolia

| What | Link |
|---|---|
| Safe 1.4.1; owners = the 3 seat keys, threshold 2 | [0xE440…D632](https://sepolia.basescan.org/address/0xE4408495D9ff5B37ADB67d5eC8e5b20d303fD632) |
| Roles (proxy of the Roles mastercopy `0xf296…83d5`); the three PrimeKeys are members and not Safe owners | [0xD6C8…750E](https://sepolia.basescan.org/address/0xD6C80C5FC2e7477e79F46C1787E0C5b95B43750E) |
| PrimeKey for MetaMask / Freighter / Phantom | [0x962d…adB4](https://sepolia.basescan.org/address/0x962d7E2DFB63d1F939510C2Cc2104439194eadB4), [0x064c…D6Aa](https://sepolia.basescan.org/address/0x064ceb320EC92aeD5Caf59c1737dee8eBC23D6Aa), [0x4cE0…f752](https://sepolia.basescan.org/address/0x4cE0138E8849A307cB4c5A147c821CA983DAf752) |
| C1 creates the Safe with MetaMask as its only owner (the PrimeX flow). C2, a Safe transaction signed by MetaMask, adds Freighter and Phantom as owners, sets the threshold to 2, and installs Roles with the three PrimeKeys and the rule. | [C1](https://sepolia.basescan.org/tx/0x5a867f76822e886c591c8f8047ab1d6f7dd54b92de664be1e634e784f48972b4), [C2](https://sepolia.basescan.org/tx/0x63212de8f140c6bb78c40b3ccfbb46b17b93c8a68fbccdb2467a5619433e74b8) |
| 2-of-3: MetaMask + Freighter, Freighter + Phantom, Phantom + MetaMask (S1, each wallet alone, was refused) | [S2](https://sepolia.basescan.org/tx/0x9c0feb7d25912c797333a0ea34af513c3838b639f0ccde9b8256676f81f6a0b2), [S3](https://sepolia.basescan.org/tx/0xed980a8b1ba16c5a21facde4ff25285ad7ab7110d993623970ee5064fdf90b9e), [S4](https://sepolia.basescan.org/tx/0x9993bbc4f2d7f9cd54cc664bb2e3457b55fafe7ff671c0bb5350ee2ce2e9a38e) |
| MetaMask session: grant, relayer move, self-paid move, revoke | [grant](https://sepolia.basescan.org/tx/0x95da55b2cf276ac7d76ea9c134ff7c8688a9f358d1697b20b4adbf6efab54147), [relayer](https://sepolia.basescan.org/tx/0x2c187faea618632ddbd923307a4e56fec426513418d44069c0e6966276bfa30e), [self-paid](https://sepolia.basescan.org/tx/0x9673b14958c19a719f471948adfe1c1143f080aeaf4183c6165f71daf2dc95b3), [revoke](https://sepolia.basescan.org/tx/0x37aebca160fadcb884b39c93e02bd8d5700c15c976e5b7c2156e4cc5de9c672d) |
| Freighter session (through NEAR): grant, relayer, self-paid, revoke | [grant](https://sepolia.basescan.org/tx/0x9331710d12e99e4c359530c16732eb0ef6065dd0e828aad0b1fa955f20fe7eb7), [relayer](https://sepolia.basescan.org/tx/0xc4234b3464e6e6e9e1788c480f97fdd4983f9899e8503d6cdd216d3aba0c17b7), [self-paid](https://sepolia.basescan.org/tx/0xe4c46a55379aea2fb5398001616de570be89f525b8bfe32ca0ffdf277968c835), [revoke](https://sepolia.basescan.org/tx/0x8a819a2c2a6e001aa638f4fd0d473b357813276be16b87efd39f4d01cb53324b) |
| Phantom session (through NEAR): grant, relayer, self-paid, revoke | [grant](https://sepolia.basescan.org/tx/0x8880a1a185ddb348b6e50a09d0b76365bfb7d55c6c8171e82a7df5ff9db94bc2), [relayer](https://sepolia.basescan.org/tx/0xaf0ed9870f33a49a38588f5cd231c474bc6a89d408e198eaf95c0300c12d12ce), [self-paid](https://sepolia.basescan.org/tx/0xae26b5212ffcabde8978017a8cf14a6e3a842808719d67b74674b60aa0b0f0b1), [revoke](https://sepolia.basescan.org/tx/0x0029ba2cfeaf66112035852be2e2ee494e1012878c738aa5ed115a20d7125391) |

- These are 17 of the 30 transactions. All 30 are listed with their test names in `evm/state-pkn-live.json`, and `evm/verify-evm.log` re-reads every receipt from the chain (30 succeeded, 0 failed).
- The self-paid transactions are sent from the session keys themselves (for example `0x7cb5…0173` for Freighter), not from the relayer.
- A refused move fails in simulation and is never sent, so refusals have no transaction. Their reasons are in `evm/pkn-live.log`. The public RPC dropped Roles' error data, so we replayed those calls to read it (`evm/roles-why.log`):

| Call from | Call | Roles error |
|---|---|---|
| a stranger | any `execTransactionWithRole` | `NotAuthorized(address)`: not a member |
| a PrimeKey | token transfer to another address | `ConditionViolation(ParameterNotAllowed)` |
| a PrimeKey | delegatecall | `ConditionViolation(DelegateCallNotAllowed)` |
| a PrimeKey | `addOwnerWithThreshold` on the Safe | `ConditionViolation(TargetAddressNotAllowed)` |

### 12.3 Stellar testnet

| What | Link |
|---|---|
| Prime Account. Rule 0 = the three seats + weighted-threshold policy. Rules 3–5 = one session-signer each + policy-interpreter. Rules 1–2 were test rules, added and removed by 2-of-3 votes (Y2–Y5). | [CDXR…DAPDF](https://stellar.expert/explorer/testnet/contract/CDXRG5FSQFXFSCIL75DDAE6PY5CZHM2L7CFINQH7L7AW5LVRDQ4DAPDF) |
| session-signer for MetaMask / Freighter / Phantom | [CBD2…AKB3](https://stellar.expert/explorer/testnet/contract/CBD2ZFLRBJ5IXOG7A64IU3Z23GZETTSARWCZTCKGV7XOZNJPHMGZAKB3), [CCMW…PZKS](https://stellar.expert/explorer/testnet/contract/CCMWQ3JQMU5JPHO6CYYMQGODR72F5DT66K4XQDHVBDPTTN3YAK5RPZKS), [CBYU…V4U2](https://stellar.expert/explorer/testnet/contract/CBYUQIBWAT2BZ4674KLAGPG7E3ATK42V5CRW7KBIHYMRIYL2XER2V4U2) |
| policy-interpreter (testnet; mainnet instance `CDN7…BN52`) | [CCBH…ANU5](https://stellar.expert/explorer/testnet/contract/CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5) |
| 2-of-3: MetaMask + Freighter add a rule, Freighter + Phantom remove it, Phantom + MetaMask add one, MetaMask + Phantom remove it (Y1, each wallet alone, was refused) | [Y2](https://stellar.expert/explorer/testnet/tx/df023f128b014c12035a458d2d6a3f4f10a8dd688212865627dbb5e3e4861848), [Y3](https://stellar.expert/explorer/testnet/tx/d2456207a2ca5ca969ad175f0e1817183554a33a84cde58a9aa46fe07570fa1d), [Y4](https://stellar.expert/explorer/testnet/tx/5629ef2403fab91393b4dc746d403b03fa062444896db5e51916ca3b63cd3988), [Y5](https://stellar.expert/explorer/testnet/tx/503d81ac8342edc1ccf9065ee49fd80dfed7708e6f2a4591cb7e0c9e89020a00) |
| MetaMask + Freighter install the three session rules (3, 4, 5) | [MetaMask's](https://stellar.expert/explorer/testnet/tx/cacb5381a173dd554fc235d9dc8bf6b9433f6185fc00a359c0017630bae2cf91), [Freighter's](https://stellar.expert/explorer/testnet/tx/518f11c9db7bfebb2939b6f03e51d1458a9642780e22e04cfa71f38dd52dd8f3), [Phantom's](https://stellar.expert/explorer/testnet/tx/457d46cc7a978f7f0f0069bbd338ccdf4042e3226e66633b728b497ed0b8d2a9) |
| MetaMask session: relayer move, self-paid move, revoke | [relayer](https://stellar.expert/explorer/testnet/tx/44312b2efceb3abf3c23de18351bbdb943e93c61c31602a381959c7c82e966ad), [self-paid](https://stellar.expert/explorer/testnet/tx/4f0c449b529c6a9f48f8c064bf20491c583a10b9f0f6a7fce8ce258ddb088bc6), [revoke](https://stellar.expert/explorer/testnet/tx/69ba10ffde0a981a6283e33a0461ef6568188cd924df2b21e4214d34e7f9529b) |
| Freighter session: relayer, self-paid, revoke | [relayer](https://stellar.expert/explorer/testnet/tx/132483e0b20726ea413546374cb38a3e5836e4cb4620a02c44f4606f72bf915a), [self-paid](https://stellar.expert/explorer/testnet/tx/ae4dd6b5c142c56f21c4b7dbf86cec40e652b0b16755dae2fe8b467df067e493), [revoke](https://stellar.expert/explorer/testnet/tx/829e76c545ba043b3abdc9811d54c87d3cd39c2f3f4c80a383b82efadb18e9e7) |
| Phantom session: relayer, self-paid (the Stellar revoke test ran for MetaMask and Freighter) | [relayer](https://stellar.expert/explorer/testnet/tx/d5d5f5ff9d6b6510dcc055dbbf1d9f05b46caacf65cdf0d10b1c131eb247067b), [self-paid](https://stellar.expert/explorer/testnet/tx/9fb8204361b95c2d57a077e645247d9ca0426cf823518e9c2fea7c2f7eef67e1) |

On Stellar, grants are not transactions: the grant signature travels inside each move. The self-paid moves have the session key as their source account (checked on Horizon, Stellar's public API).

### 12.4 NEAR testnet (`proof-near.log`)

| What | Link |
|---|---|
| prime-near-signer account (code hash `D2xg…3Hob`) | [signer.prime-spike-muwguc60.testnet](https://testnet.nearblocks.io/address/signer.prime-spike-muwguc60.testnet) |
| MetaMask's eth-implicit account runs NEAR's stock wallet (a "global contract": one shared copy of the code that all eth-implicit accounts run, hash `3PpYvRxBfC5BkZxTw8ZFG3D52w1ZRhvDDWirKoxphMDn`): `rlp_execute` → MPC `sign` | [tx](https://testnet.nearblocks.io/txns/FbhtJr2BGLgaBayWEiLBigr8KrpemwmLhZuCtwZXfmNd) |
| Phantom (stand-in) → signer → MPC ed25519; key = Phantom's Stellar seat `GB2U…KJQJ` | [tx](https://testnet.nearblocks.io/txns/BFsYLin2MzP13LMqz6nTrD2cdVePd2CnqyTBBucczGHB) |
| Freighter (stand-in) → signer → MPC secp256k1; address = Freighter's Safe seat `0x29A9…13fF` | [tx](https://testnet.nearblocks.io/txns/79S64xykAnBB1KRQ79McTGisU7DykbkCUGU7TJqzYHK1) |
| Real Phantom → signer → MPC ed25519 | [tx](https://testnet.nearblocks.io/txns/2xhZduPcJKwfXJfqG2WrSaZuoMeWn34XBDWhUtuAptcb) |
| Real Freighter → signer → MPC secp256k1 | [tx](https://testnet.nearblocks.io/txns/GZxKyDGL9LZtM3uaMpA2jBskZWNXik6PjbHPK8HmhpC3) |
| Real Freighter (Test Net) → signer → MPC ed25519 | [tx](https://testnet.nearblocks.io/txns/8npfk7AKj5qCLUruqvKTNmCm3pQi5mr7oVnQB8F6N57u) |

Each NEAR-derived key was checked three ways:
- the MPC signature verifies against the key we derive offline;
- the derived key equals the seat on the target chain (Stellar rule 0, Safe owners, Solana settings signers);
- the transaction's receipts show the call path signer → `v1.signer-prod.testnet` → `sign`.

The EVM run made 36 NEAR MPC signatures, averaging 7.4 s each (`evm/pkn-live.log`, last lines).

### 12.5 Source references

| Claim | Source |
|---|---|
| Phantom signs only valid UTF-8 that is not a Solana transaction | Phantom 26.32.0 extension, `chunk-GN2XWC4M.js`: `isSafeMessage` (`a5e`) and the UTF-8 check `o_t` |
| Phantom's EVM chain list has no 397/398 | same extension, `btc.js`: `eip155` chains 1, 137, 143, 998, 999, 8453, 10143, 42161, 80002, 84532, 421614, 11155111 |
| Freighter signs messages only as SEP-53 | Freighter `extension/src/helpers/stellar.ts` (`encodeSep53Message`) and `handlers/signBlob.ts`; copied in `freighter-sign.ts` |
| NEAR wallet contract schemes: ed25519, webauthn, no-sign | `near/intents` at `4127e8e`, `contracts/wallet/signatures/` |
| NEAR Intents reaches other contracts only through `on_auth` | `near/intents`, `contracts/defuse/core/src/intents/auth.rs` (`AuthCall`) |
| eth-implicit accounts, chain ids 397/398, `rlp_execute` | NEP-518 |
| A Squads policy signer only needs to be a member and `is_signer` | `Squads-Protocol/smart-account-program` at `80bf1f7`: `transaction_execute_sync.rs` calls `validate_synchronous_consensus` in `utils/context_validation.rs` |
| Roles errors and status codes | `gnosisguild/zodiac-modifier-roles`, `PermissionChecker.sol` (`Status`, `ConditionViolation`, `moduleOnly`) |
| PrimeX signs Safe transactions with EIP-712 | `octopos/apps/evm-web/src/app/safe-actions.ts`, `components/queue-list.tsx` (`signTypedData`) |
| Archived persistent entries fail until restored, and are never re-created | Stellar docs, "State archival" |
| Persistent lifetime 120,960 (testnet), 2,073,600 (mainnet) ledgers | network config `stateArchivalSettings.minPersistentTtl`, read from both networks |
| The earlier on-chain format checks cost 219 lines + 1,104 vendored | `spike/matrix/minimal/README.md` ("Size", "What each contract does") |
| MPC key derivation | `sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + caller + "," + path)` added to the MPC root key; checked against live MPC signatures for both key types (`near.ts`, `secpderive.ts`) |

## 13. Limits and open items

- **Solana ran on a local validator**, not devnet: deploying prime-session needs about 0.25 SOL, devnet airdrops were refused (daily rate limit, re-tried on 7 October), other public devnet endpoints require a paid key, and we do not use the web faucet. Sending about 1 SOL to `5bevLKtW8bA6LCXXMqQAjnWBRCWcSXwcvQHiCbT6JjuY` on devnet would let the same matrix run there. The Squads program in it was cloned unchanged from devnet.
- **MetaMask extension not run.** Its route uses only stock NEAR code and standard MetaMask methods.
- **Latency.** NEAR-routed signatures averaged 7.4 s (36 signatures, EVM run) to 8.5 s (27 signatures, Solana run) on testnet. Moves never use NEAR; only NEAR-routed seat votes, grants and revokes do.
- **NEAR availability.** If NEAR or its MPC is down, NEAR-routed wallets cannot vote, start sessions or revoke them. Existing sessions keep working. Each chain has only one wallet that signs natively (two on EVM if Phantom uses its own EVM account), so stopping a session early may have to wait for NEAR to return, or for the session to end (at most 7 days).
- **Solana has no per-session revoke** (section 7.2).
- **Stellar amount limits** were not part of these tests (section 8.2).
- **Before mainnet:** remove the full-access key from the signer account; point the signer at the mainnet MPC and MetaMask's route at chain 397; build prime-session for mainnet (`PRIME_CLUSTER`).
- **Audit scope:** the four new contracts, 164 lines in total.
