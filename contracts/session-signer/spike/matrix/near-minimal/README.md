# One small session contract per chain, wallets reached through NEAR

This replaces `../minimal/`. The goal is less of our own code on every chain, with each wallet's seat kept apart from its sessions.

## The design

Each wallet uses its own key on its home chain. On every other chain it signs through its NEAR account: NEAR's MPC signs with a key derived for that wallet's NEAR account and path.

| Wallet | EVM (Safe + Roles) | Solana (Squads Smart Account) | Stellar (OZ account) |
|---|---|---|---|
| MetaMask | **its own EOA** | NEAR eth-implicit account → MPC ed25519 | NEAR eth-implicit account → MPC ed25519 |
| Freighter | our SEP-53 NEAR wallet contract → MPC secp256k1 | SEP-53 NEAR wallet → MPC ed25519 | **its own key** |
| Phantom | our text NEAR wallet contract → MPC secp256k1 | **its own key** | text NEAR wallet → MPC ed25519 |

**Seats.** These keys are ordinary signers of the 2-of-3:

- EVM: Safe owners;
- Solana: Squads settings signers;
- Stellar: `Delegated` G accounts in rule 0.

None of our contracts is a seat.

**Sessions.** There is one small contract per wallet, and its owner is the same key. The owner signs one grant, and from then on the session key alone signs each move. Each contract checks only that chain's own message format:

| Chain | Contract | Owner signs | sLOC |
|---|---|---|---|
| EVM | `evm/src/PrimeKey.sol`: the wallet's Roles member, never a Safe owner | `personal_sign` text (MetaMask; for Freighter and Phantom, MPC signs the EIP-191 digest) | **41** (OpenZeppelin ECDSA / MessageHashUtils / Strings; **no ed25519 library**) |
| Solana | `solana/prime-session/src/lib.rs`: PDA `["prime", owner]`, a policy member only, never a settings signer | plain text (Phantom `signMessage`; MPC signs the text for MetaMask and Freighter) | **37** |
| Stellar | `contracts/session-signer/src/lib.rs`: a `Delegated` signer of that wallet's session rule only, never of rule 0 | SEP-53 (Freighter `signMessage`; MPC signs the SEP-53 digest for MetaMask and Phantom) | **65** |

The previous version (`../minimal/`) had 59 sLOC plus a 1,104-line ed25519 library on EVM, 71 on Solana and 89 on Stellar.

**What NEAR adds.** NEAR brings our two NEAR wallet-contract variants: SEP-53, about 58 sLOC, and text-ed25519, about 53 sLOC. MetaMask uses NEAR's stock eth-implicit wallet. Each NEAR signature took 7–15 s on testnet.

**Revoke.**

- EVM and Stellar keep a per-session revoke: the owner signs the grant text with valid-until 0. It costs 5 and 7 lines.
- Solana dropped it, because it cost 13 lines (over the 10-line limit). There, a session ends at its expiry (at most 7 days). It can be ended sooner by a 2-of-3 policy update that removes that wallet's PDA; that is tested as R1–R3.

**Gas and fees.** A relayer pays, and when it is down the session key pays from its own balance. Both paths are tested on every chain.

## Results

| Chain | Where | Result | Log |
|---|---|---|---|
| EVM | anvil fork of Base Sepolia, PrimeX onboarding/policy code from octopos, NEAR testnet MPC | **87/87** | `evm/pkn.log` |
| Solana | local validator, Squads Smart Account cloned from devnet, NEAR testnet MPC | **70/70** | `solana/psn.log` |
| Stellar | Stellar testnet and NEAR testnet | **55/55**, plus 13/13 unit tests | `stellar/stn.log` |

### What is covered, wallet by wallet, on every chain

**Seats.**

- Each wallet alone is refused.
- Every pair moves funds or changes rules: MetaMask+Freighter, Freighter+Phantom, Phantom+MetaMask.
- The amounts that arrive are checked exactly.
- These are all refused:
  - an outsider plus one seat;
  - one wallet's seat signed by another wallet's MPC key;
  - a seat signed by the right NEAR account under another derivation path;
  - an approval of a different transaction.

**A session can never vote as a seat.** This is the point of separating seats from sessions.

- **EVM:**
  - the session key's signature as a Safe owner is refused (GS026);
  - PrimeKey as a contract signature is refused, because it has no seat function;
  - a session that asks Roles to add an owner, to delegatecall, or to re-assign roles is refused.
- **Solana:**
  - a session PDA or session key approving or proposing is refused (NotASigner);
  - adding itself as a signer is refused;
  - calling any program other than the Smart Account is refused.
- **Stellar:**
  - session-signers on rule 0 are refused (#3016), whether one or two of them;
  - the session key's own G account on rule 0 is refused;
  - a session rule used for admin calls such as removing rule 0 is refused (#3002).

**Sessions, for each wallet.**

- One grant signature, then:
  - a move via the relayer succeeds;
  - a move with the session key paying its own fee succeeds;
  - with no relayer and no funds the move is refused, and the logged reason is the missing balance or account.
- Refused:
  - another recipient;
  - an amount over the rule's limit;
  - a move signed by another key;
  - a replayed move on EVM;
  - a stretched valid-until;
  - a grant longer than 7 days;
  - an expired grant;
  - someone else's key used with the grant;
  - the zero key on EVM.
- Revoke (EVM, Stellar):
  - a revoked session is refused;
  - a revoked key cannot be granted again;
  - another live session of the same wallet still works;
  - another wallet cannot revoke.
- Daily caps are shared by all members.

**Cross-wallet.** Every combination is refused:

- a grant signed by another wallet (MetaMask, Freighter or Phantom, through NEAR or natively);
- a grant signed with the right NEAR account under another path;
- the wrong message format: a raw hash instead of `personal_sign`, or a missing SEP-53 prefix;
- a grant made for one wallet's contract presented to another's;
- a grant signed for another cluster or program (Solana).

### Problems in the test harness, kept with their logs

- **EVM run 1, 80/87** (`evm/pkn.run1.log`). Two viem copies disagreed on address checksum casing, so the owner check failed on exact string compare. Also, the "session key has no ETH" case reused a key that still held ETH, so that move succeeded and the balance checks after it were off by one. Both fixed: compare lower-cased, set the balance to 0.
- **Solana run 1** (`solana/psn.run1-confirm-stall.log`). `confirmTransaction` stalled on a transaction that had landed, so the harness now polls the signature status.
- **Solana run 2** (`solana/psn.run2.log`). Stopping the earlier job left its process running. Its writes interleaved with the new run's, and it used the same NEAR relayer key at the same time (a NEAR nonce collision). The surviving run reported 70/70. The "no SOL" refusals had logged an empty reason, so the harness now keeps the error message. The clean run is `solana/psn.log`.
- **Solana run 3** (`solana/psn.run3-near-429.log`). NEAR's deprecated public testnet RPC `rpc.testnet.near.org` returned 429. The MetaMask path now uses `test.rpc.fastnear.com` (`near.ts`). Run 4 is the clean 70/70.
- **Solana, four unreadable reasons.** In the clean run, four refusals logged `[object Object]`: the three "no SOL" cases (G-*4) and G12. An empty `getLogs()` result had overwritten the message. `solana/psn-probe.ts` reproduces both cases and prints the full errors:
  - **G-*4:** "Attempt to debit an account but found no record of a prior credit", so the unfunded session key cannot pay.
  - **G12:** Solana's ed25519 program itself rejects the tampered instruction (error 0x3, invalid data offsets) before prime-session runs. prime-session's own index check is a second line of defence that this case does not reach.
  - **Control:** an untampered grant passes every prime-session check and fails only later, at the Smart Account call.
  The harness now keeps the message.
- **Stellar run 1** (`stellar/stn.run1-rulebuilder.log`). The rule-builder call was copied wrongly, which crashed the rules step. The rule builder is now copied verbatim from the earlier harness and the run resumed. The `separation` lines in the first part of the log come from the stopped process.

## Trade-offs to know

- **Blind signing.** Through NEAR, the wallet signs a NEAR request that carries the payload as hex: a Safe transaction hash, a Solana transaction or a grant digest. It does not see the grant's readable text. Only the native path (MetaMask on EVM, Phantom on Solana, Freighter on Stellar) shows the text itself.
- **Latency and availability.** Every NEAR-routed signature waits on NEAR's signing network, 7–15 s each on testnet. Seats and grants through NEAR depend on NEAR being up. Moves don't, because the session key signs them.
- **NEAR-side code.** Our SEP-53 and text wallet-contract variants are our code on NEAR and need an audit along with the three contracts here. MetaMask's eth-implicit wallet is stock NEAR.
- **Solana has no per-session revoke.** See above.
