# One small session contract per chain; NEAR only through stock code and one 21-line signer

The full design write-up, with diagrams and testnet proofs, is [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md).

This replaces `../minimal/`. The goals were the least new code, no lines added to NEAR's open-source wallet contract, and seats kept apart from sessions.

## Round 9 (current)

Round 9 changed all four contracts and re-ran every matrix. The tables further down describe round 8 and stay as the earlier record. Where they differ from this section, this section applies.

### What changed

| Part | Change | Size |
|---|---|---|
| EVM `PrimeSession` | `until` and `nonce` share one storage slot; Freighter and Phantom own their session under the path `prime:evm-session`; the grant and the first move can go in one Multicall3 transaction (the grant call may fail, the move may not) | 32 sLOC, first move 18.7k gas cheaper |
| Solana `prime-session` | per-session revoke through an empty marker account; the bump travels in the data; no `program:` line in the grant text; the build needs `PRIME_CLUSTER`; session owners use `prime:solana-session` | 33 sLOC, 54,024 B |
| Stellar `prime-session` | the grant is stored on chain and checked by the owner's authorization; a revoke is final for that key; the four MPC-derived G accounts are locked (thresholds 1/1/2) | 37 sLOC, wasm 1,542 B |
| NEAR `prime-near-signer` | the payload string is signed and forwarded as received; redeployed to the same account | 20 sLOC |

Our new code in total is 122 sLOC: 32 + 33 + 37 + 20.

### Results

| What | Where | Result | Logs (under `round9/`) |
|---|---|---|---|
| Stellar matrix, including the real Freighter extension (grant, move, revoke through `signAuthEntry`) | Stellar testnet, fresh deployment, NEAR testnet | **139/139** (138 checks plus the earlier Horizon summary that stays in the state file; unit tests 11/11) | `stellar/stn-*.log`, `stellar/verify-stellar.log`, `stellar/cargo-test.log` |
| EVM matrix | anvil fork of Base Sepolia, NEAR testnet | **134/134**; bytecode of all three `PrimeSession` instances equals the build (3,996 bytes, 4 immutable slots); 50 receipts verified; forge tests 6/6 | `evm/pkn.fork-r9b.log`, `evm/bytecode-eq.fork-r9b.log`, `evm/verify-evm.fork-r9b.log`, `evm/roles-why.fork.log` |
| Solana matrix | local validator (Smart Account cloned from devnet), NEAR testnet | **138/138** (the 128 matrix checks plus ten paired compute-unit samples against the round 8 program) | `solana/psn-local.log`, `solana/pdhash-local.log`, `solana/so-hashes.txt`, `solana/build-*.log` |
| Signer contract | NEAR testnet | **12/12** (S11 now refuses upper-case payload hex; S12 passes a non-hex payload through to the MPC, which rejects it) | `near/signer-neg.log`, `near/signer-neg.old-contract.log`, `near/proof-near.log` |

### Hashes

| Artifact | Value |
|---|---|
| Stellar wasm (`stellar contract build`) | `e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3`; every deployed instance and the uploaded blob match it (`verify-stellar.log`) |
| Solana `.so`, localnet build | `be6ade02a14b495d528d69d4f4632a0ffb9c9c83a9165ac8d2e0b1dbac102e13`; on-chain code equals it for programs A and B (`pdhash-local.log`) |
| Solana `.so`, devnet build | `8db245ab5ba25a6b8585bfd193be5d9241e5df0f331792437c34f1ac888b7b76` (differs from the localnet build only in the cluster string) |
| NEAR signer code hash | `AfRTxyBpBmUDYi88xxytL5z4yfPn3tBa1SYawt4Jzh3b`, equal to the build; the derived MPC keys are unchanged from before the redeploy |
| EVM runtime bytecode | three instances compared by `evm/bytecode-eq.ts` with immutables masked (`bytecode-eq.fork-r9b.log`) |

### Pending live runs

- **Base Sepolia:** the relayer holds 0.0000017 ETH. The matrix needs about 0.00007 ETH; 0.0005 ETH leaves margin. Run `PKN_LIVE=1 bun pkn.ts` after funding.
- **Solana devnet:** the payer holds 0 SOL. Two program deploys and the matrix need about 1.43 SOL; fund 1.6 SOL. The commands are in `run-round9.sh`; the harness takes `PSN_NET=devnet`.

### Files

- Sources: `evm/src/PrimeSession.sol`, `evm/test/PrimeSession.t.sol`, `solana/prime-session/src/lib.rs`, `near-signer/src/lib.rs`. The Stellar contract and its tests are `../../../src/` in this repository.
- Harnesses: `evm/pkn.ts`, `evm/bytecode-eq.ts`, `evm/verify-evm.ts`, `evm/roles-why.ts`, `solana/psn.ts`, `solana/pdhash.ts`, `stellar/stn.ts`, `stellar/verify-stellar.ts`, `signer-neg.ts`, `proof-near.ts`. They import `stellar.ts`, `nearsig.ts` and `near.ts` (unchanged) and a local `keys.ts` that holds testnet key loading and is not copied.
- Runner: `run-round9.sh` (all parts in sequence under one lock, because they share the NEAR relayer key).
- Logs: `round9/{evm,solana,stellar,near}/`, plus Freighter prompt screenshots in `round9/stellar/freighter-prompt/` (collapsed and expanded authorization row, the earlier SEP-53 prompt, three parameter shapes). Logs are ignored by `*.log`, so add them with `git add -f`.
- Stellar run record: `round9/stellar/run.out` and `run2.out` show two runs; the first stopped at the real Freighter step when the browser behind the bridge closed (`stn-realfr.attempt1.log`, `freighter-bridge.attempt1.out`), and the retry passed.

## Routes

Each wallet uses its own key on its home chain. Elsewhere it signs through NEAR's MPC.

| Wallet | EVM (Safe + Roles) | Solana (Squads Smart Account) | Stellar (OZ account) |
|---|---|---|---|
| MetaMask | **own EOA** | NEAR **stock** eth-implicit account → MPC ed25519 | NEAR stock eth-implicit → MPC ed25519 |
| Freighter | `prime-near-signer` (SEP-53) → MPC secp256k1 | `prime-near-signer` (SEP-53) → MPC ed25519 | **own key** |
| Phantom | `prime-near-signer` → MPC secp256k1 (used in the matrices), or its **own EVM account** (real extension, fork only; below) | **own key** | `prime-near-signer` (plain text) → MPC ed25519 |

**Seats:** these keys are ordinary 2-of-3 signers: Safe owners, Squads settings signers, Stellar `Delegated` G accounts. None of our contracts is a seat, so a session key can never vote.

### Why NEAR's stock wallet serves only MetaMask

This was checked in the real Phantom 26.x extension code and with Freighter's signing path.

| Upstream `near/intents` wallet scheme | Freighter | Phantom |
|---|---|---|
| `ed25519` (raw 32-byte hash) | only signs SEP-53 or Stellar transactions | `signMessage` signs only valid UTF-8 that is not a Solana transaction (`isSafeMessage`) |
| `webauthn`, `no-sign` | n/a | n/a |
| eth-implicit (stock) | no EVM account | its EVM account cannot sign for NEAR's EVM chain (397/398): Phantom refuses chains outside its built-in list |

### `near-signer/` (21 sLOC, ours, standalone, no fork of NEAR's wallet contract)

It is deployed at `signer.prime-spike-muwguc60.testnet`, code hash `D2xgePUEzgfRysCScYruUGUFg2g8Twueuh1ipCpz3Hob`.

- **One method,** `sign(key, sep53, path, domain_id, payload, signature)`.
- **The wallet signs** the readable text `Prime NEAR signer\ncontract: <this>\npath: <path>\ndomain: <id>\npayload: <hex>`. Freighter signs it as SEP-53; Phantom signs it as plain text.
- **The contract** checks that signature with NEAR's `ed25519_verify`, then asks the MPC to sign `payload` under the path `<wallet key hex>/<path>`.
- **Key binding:** the path includes the wallet's own key, so no wallet can obtain another wallet's derived key.
- **Stateless:** replaying a request only yields another MPC signature over the same payload, so there is no nonce or storage. (The source comment says "the same MPC signature"; it is left as deployed so the code-hash proof holds.)
- **For mainnet:** remove the testnet deploy key from the account, so the contract cannot be changed.

### Session contracts: one name, `prime-session`, on every chain

| Chain | Contract | Owner signs | sLOC | Revoke |
|---|---|---|---|---|
| EVM | `evm/src/PrimeSession.sol`: Roles member only | `personal_sign` text | 32 | yes (`grant` with end 0) |
| Solana | `solana/prime-session/src/lib.rs`: policy-member PDA only, one per wallet per Smart Account (`["prime", owner, settings]`) | plain text | 27 | no (about 13 lines); expiry, or a 2-of-3 policy update |
| Stellar | `../../../src/lib.rs` (crate `contracts/prime-session`): signer of the wallet's session rule only | SEP-53 | 54 | yes (7 lines) |

Round 8 renamed them (EVM `PrimeKey` → `PrimeSession`, Stellar `session-signer` → `prime-session`) and trimmed 7 more lines, with the same checks:
- EVM: `ECDSA.recover` in place of `tryRecover` plus an error check (`recover` reverts on a bad signature and never returns the zero address).
- Solana: no target check. The inner call goes to the Smart Account program id, a constant, so no other target is possible (X11: with another program in account 3, prime-session still calls only the Smart Account).
- Stellar: the SEP-53 prefix is part of the grant-message builder, and the hex helper writes into that message directly.

**Our new code in total:**
- 21 sLOC on NEAR, replacing our two NEAR wallet-contract variants (58 + 53 sLOC, now retired);
- 32 on EVM, 27 on Solana, 54 on Stellar (134 with the NEAR signer; 164 before round 7, 141 after it; see `round7.log`, `round8.log`).

## Round 8 results (signer contract and stock NEAR only; no NEAR wallet-contract variants)

| What | Where | Result | Log |
|---|---|---|---|
| Signer contract refusals | NEAR testnet | **11/11** | `near-signer/signer-neg.log` |
| EVM matrix, PrimeSession (round 8) | Base Sepolia fork + NEAR testnet | **92/92** (the live matrix without X11a, plus revoke edge cases X12 to X16) | `evm/pkn.log`, `evm/bytecode-eq.fork.log` |
| EVM matrix, live, previous version (PrimeKey, round 7) | **real Base Sepolia** + NEAR testnet | **88/88** (the live relayer is now out of test ETH) | `evm/pkn-live.log`, `evm/verify-evm.log` |
| Real Phantom and real Freighter through the signer contract | NEAR testnet | both signed, MPC keys check out | `proof-near.log`, `real-wallets/` |
| Solana matrix | local validator (Smart Account from devnet) + NEAR testnet | **83/83** (A0 to A6: a grant works in one Smart Account only; X8 to X10: wrong PDA, wrong account, unsigned session key; X11: the System program in place of the Smart Account program) | `solana/psn.log` (`psn.round8-x11-expectation.log`: the first round-8 run, 81/82, where X11 wrongly expected a refusal); `solana/build-check.log`; the earlier per-wallet PDA run is `solana/psn.run5-pda-per-wallet.log` |
| Stellar matrix | Stellar testnet + NEAR testnet (fresh deployment, round 8) | **55/55** | `stellar/stn.log`, `stellar/verify-stellar.log` |
| Phantom's own EVM account as a Safe seat | real Phantom extension + Base Sepolia fork | **P1, P2 pass** | `phantom-evm/phx.log`, `phantom-evm/pevm.log` |

**Signer contract refusals:** each of these is refused inside our contract, before any MPC call:
- another wallet's signature for a key;
- SEP-53 sent as plain text, and plain text sent as SEP-53;
- a request signed for another payload, path, domain or signer contract;
- a malformed key.

There are three accepted cases (11 = 8 refusals + 3): Freighter on ed25519, Phantom on secp256k1, and upper-case payload hex, which decodes to the same bytes the wallet signed.

**The three matrices** cover what the previous run did, now on the new MPC keys. For every wallet on every chain:
- seats: 2-of-3, single-wallet refusals, wrong-key refusals;
- sessions cannot vote as seats;
- grant, then moves paid by the relayer and by the session key itself;
- the refusals and the cross-wallet cases; revoke on EVM (all three wallets) and Stellar (MetaMask and Freighter). Solana has no per-session revoke.

### Real Phantom's own EVM account, no NEAR

- **Grant:** Phantom `personal_sign` of a sample grant text in the EVM format (placeholder addresses) recovers to its EVM address `0x06e7…267c`.
- **Seat:** a Safe on the Base Sepolia fork owned by MetaMask and Phantom's EVM address (threshold 2).
  - **P1:** Phantom `personal_sign`s the Safe transaction hash; it signs the raw 32 bytes. Submitted as Safe's eth_sign form (v + 4) with MetaMask's signature, the transfer executed.
  - **P2:** Phantom alone is refused (GS020).
- **Limitation:** with Testnet mode on, Phantom answers `wallet_switchEthereumChain` to Base Sepolia with "ok" but stays on Sepolia. So `eth_signTypedData_v4` for a chain-84532 Safe is refused ("not connected to the requested chain"). The `personal_sign` path above does not depend on the selected chain.
- **Code:** this route removes NEAR from Phantom on EVM, but **no lines**. The signer contract still needs secp256k1 for Freighter on EVM and plain text for Phantom on Stellar.

### MetaMask's own Solana account

**Not verified:** there is no MetaMask extension on this machine. It would remove NEAR from MetaMask on Solana but **no lines** of ours either: that route already uses stock NEAR.

## Test-harness problems on the way, kept with their logs

- **EVM run 2** (`evm/pkn.run2-variants.log`) is the previous run on the wallet-contract variants.
- **EVM runs 3 and 4** (`pkn.run3-near-expired.log`, `pkn.run4-near-nonce.log`) stopped on NEAR RPC errors: "Transaction has expired" and a stale access-key nonce. FastNear's load-balanced testnet RPC sometimes serves a node that is behind. A rejected NEAR transaction does not land, so `nearsig.ts` retries those two errors after 3 s.
- **EVM run 5** (`pkn.run5-s7design.log`, 86/87). S7 "Freighter's seat signed by Phantom's MPC key" was accepted, and that is correct behaviour. A Safe recovers ECDSA owners from the signature itself, so that is simply Phantom voting. Its earlier "refused" results came from signature ordering (GS026), which checks nothing about the key. S7 is now "one wallet signs twice", which is refused (GS026). The Solana (K6d) and Stellar (Y7) counterparts are sound, because there the signature is bound to the signer's key.

## Trade-offs to know

- **Latency:** NEAR-routed signatures averaged 7.9 to 8.2 s on testnet.
- **Availability:** seats and grants through NEAR need NEAR to be up; moves don't.
- **Solana has no per-session revoke.**
- **Audit scope:** the 21-line signer contract and the three session contracts.
