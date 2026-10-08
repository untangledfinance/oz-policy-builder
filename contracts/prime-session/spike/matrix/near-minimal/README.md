# One small session contract per chain; NEAR only through stock code and one 21-line signer

The full design write-up, with diagrams and testnet proofs, is [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md).

This replaces `../minimal/`. The goals were the least new code, no lines added to NEAR's open-source wallet contract, and seats kept apart from sessions.

## Round 9 (current)

Round 9 changed all four contracts and re-ran every matrix. The tables further down describe round 8 and stay as the earlier record. Where they differ from this section, this section applies. The follow-up spikes of the same day (native second-chain accounts and Swig) follow the round 9 tables.

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
- Logs: `round9/{evm,solana,stellar,near}/` (the later runs of 8 October are in `round9/{owners,seat,calls,wallets}/`) (and `round9/{swig,native}/` for the follow-up spikes below), plus Freighter prompt screenshots in `round9/stellar/freighter-prompt/` (collapsed and expanded authorization row, the earlier SEP-53 prompt, three parameter shapes). Logs are ignored by `*.log`, so add them with `git add -f`.
- Stellar run record: `round9/stellar/run.out` and `run2.out` show two runs; the first stopped at the real Freighter step when the browser behind the bridge closed (`stn-realfr.attempt1.log`, `freighter-bridge.attempt1.out`), and the retry passed.

## Follow-up spikes (8 October 2026)

Two spikes ran after round 9, on the round 9 contracts, with no contract change. The document sections are 5.6 (native accounts), 7.3 (Swig) and 12.6 (runs and logs).

### Native accounts on a second chain (Phantom on EVM, MetaMask on Solana)

Phantom's own EVM account and MetaMask's own Solana account act as seat and session owner, so NEAR drops out of those two cells. NEAR stays as the fallback route, and both harnesses select the route with `PKN_NATIVE` and `PSN_NATIVE`.

| Chain | Route | Checks | Log (under `round9/native/`) |
|---|---|---|---|
| EVM, Base Sepolia fork | NEAR route, same harness | **134/134** | `pkn.near-baseline-fork.log` |
| EVM | Phantom native, the real extension signs all 25 Phantom signatures, real NEAR for Freighter | **137/137** | `pkn.native-fork.log` |
| Solana, local validator | NEAR route, same harness | **128/128** | `psn.near-baseline-local.log` |
| Solana | MetaMask native, the real extension signs 12 `signMessage` requests, a stand-in with the same key signs the Squads votes, real NEAR for Freighter | **145/145** | `psn.native-local.log` |

The dry runs with a local NEAR stand-in (`NEARSIG_STUB`) are `pkn.native-dry-stub-near.log` (137/137) and `psn.native-dry2-stub-near.log` (145/145). Runs taken before the independent review sit beside the final ones as `*.before-review.log` and `*.run1.log`.

- **Rules found:** MetaMask's `signTransaction` prepends a compute price and appends a limit unless the transaction already holds both, so the client builds every MetaMask-signed transaction with both, and the relayer validates the returned message before it co-signs (`withBudget` and `acceptReturned` in `solana/psn.ts`). Phantom on Base Sepolia refuses typed data, so its Safe vote is `personal_sign` over the 32 raw bytes.
- **Open:** the seat-vote prompt choice for Phantom's EVM account (the document, section 5.6), and the real-wallet vote run on a funded devnet Smart Account (it needs a real-wallet path in `sendBy`, about 12 lines).
- **Side finding:** MetaMask 13.50.0 preinstalls a Stellar snap whose bundle contains `signAuthEntry`. We still need to run it.
- **Files:** `native/phantom-evm/` (`bridge.mjs`, README) and `native/metamask-sol/` (`bridge.mjs`, `page.html`, `drive.mjs`, `onboard.mjs`, `d.sh`, `run-validator.sh`, README, `stub/` with the NEAR stand-in and the two real-wallet checks). The bridges drive the real extensions in Chrome under Xvfb and read the wallet password from a local `secrets/` file that is not copied. The extension builds, browser profiles and wallet seeds are not in the bundle; the MetaMask build is identified by `native/metamask-sol/SHA256SUMS`. `evm/pkn.ts` and `solana/psn.ts` are the final harnesses with the native switches; `round9/native/pkn.before-native.ts` and `psn.before-native.ts` are the copies from before.
- **Logs:** `round9/native/` (the run logs, the bridge prompt logs, `queue.log` and the state files).

### Swig as the Solana session layer (tested and left out)

Swig wallets as the Squads policy signers in place of `prime-session`, on a local validator with the Smart Account program cloned from devnet. Swig ran as the devnet build and as the mainnet bytes at the same program id.

| What | Result | Log (under `round9/swig/`) |
|---|---|---|
| Mainnet bytes | **256/256** (247 checks and 9 findings) | `psw-mainnet-build.log`, `state-psw-mainnet-build.json` |
| Devnet build | **256/256** | `psw-devnet-build.log`, `state-psw-devnet-build.json` |
| Freighter flows with the real NEAR MPC | **13/13**, 5 signatures, 8.2 s average | `psw-near.log`, `state-psw-near.json` |
| Swig wallet as one seat of a 2-of-3 | passes | `psw-w3.log` |
| Slot time, upgrade history, authority, build comparison (read only) | see the document, section 7.3 | `psw-slots.log`, `psw-slots-series.log`, `psw-upgrades.log`, `psw-trust.log`, `psw-build-swig.log` |

- **Verdict:** keep `prime-session`. Swig works for all four owner routes and moves cost about 27% fewer compute units and 42% fewer bytes, but its cap counts slots (1,400,000 slots last 4.3 to 6.9 days), it allows one live session per role, and it adds upgradeable third-party code (document section 7.3).
- **Files:** `swig/psw.ts` (the matrix), `psw-near.ts`, `psw-probe.ts`, `psw-w3.ts`, `psw-slots.ts`, `psw-slots-series.ts`, `psw-trust.ts`, `psw-upgrades.ts`, `psw-summary.py` (counts the checks from a state file), `psw-errors.json` (Swig error names from source). They import `./keys.ts` (local testnet keys, kept out of the bundle) and `nearsig.ts`, and `psw.ts` reads `psw-errors.json` from the work directory. Run `bun psw.ts` with `PSW_LABEL` naming the build.
- **Start commands:** from the work directory with the Solana CLI on `PATH`: `solana-test-validator --ledger psw-ledger --rpc-port 8919 --faucet-port 9919 --dynamic-port-range 18500-18560 --url https://api.devnet.solana.com --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus --clone-upgradeable-program swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB` for the devnet build. For the mainnet build, replace the last clone with `--upgradeable-program swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB <mainnet .so> 8o2ZThbZ5Bky4RcPVBYjyWuzVtqfwfqPMbsboTkFf3aQ`, where the `.so` comes from `solana program dump` on mainnet (read only).
- **Logs:** `round9/swig/`, with the earlier runs in `round9/swig/prev/`.

## Later runs on 8 October 2026 (owner counts, seat voting, contract calls, wallet matrix)

These four pieces ran on the round 9 contracts after the follow-up spikes. Only the three harnesses changed, and each default path is identical to the earlier copy.

### Any number of owners and any threshold

`evm/pkn.ts` and `solana/psn.ts` take `PRIME_OWNERS` and `PRIME_THRESHOLD`; `stellar/stn.ts` takes the same through `bun stn.ts owners` and `STN_STATE` for the state file. The default pair (3 and 2) runs the old matrix. Every configuration passed with real NEAR signatures for the three wallets where they sign on a foreign chain. Owners 4 and up are local keys that act as seat and session owner.

| Config | EVM (Safe + Roles) | Solana (Squads) | Stellar (OZ account) |
|---|---|---|---|
| 1 of 1 | 28/28 | 30/30 | 29/29 |
| 2 of 2 | 47/47 | 49/49 | 54/54 |
| 2 of 3 (default) | 134/134 | 128/128 | 132/132 |
| 3 of 5 | 87/87 | 94/94 | 104/104 |
| 7 of 12 | 178/178 | 210/210 | above the chain limit |
| 8 of 15 | not run | not run | 274/274 |

Chain limits on owner count:

- **Stellar:** the OZ smart account holds at most 15 signers per rule. A 16th signer is refused with contract error 3010 (`TooManySigners`).
- **Squads Smart Account:** one create transaction holds up to 25 signers (1,150 of 1,232 bytes); 28 fail with "Transaction too large: 1249 > 1232". Growth by `addSignerAsAuthority` reached **62 signers** (settings account 2,181 bytes) when each add ran in its own transaction. The add of the 63rd signer fails with `Access violation writing 2317 bytes at address 0x30000772e (in heap region)` after 68,046 compute units. The two earlier probe logs (`psn.limits.log`, `psn.limits2.log`) stopped at 58 on instruction index 4 of a transaction that held several instructions. The final run is `psn.limits3.log`, from `solana/psn-limits.ts` (local validator on port 8989 with the Smart Account cloned from devnet).
- **Safe 1.4.1 and Zodiac Roles:** the contracts set no owner cap. A 12-owner setup took 1,518,079 gas, about 87,000 per extra owner.

Solana moves cost about 900 compute units more per owner (50,648 with one owner, 60,267 to 61,860 with twelve). Stellar account creation costs about 0.026 XLM more per owner. The Stellar 8-of-15 run first failed 22 checks because the harness funded a flat 30 XLM; `stn.ts` now funds the larger of 30 and five times the owner count, and the first run is kept as `stn.8of15.funding-bug.log`. One 1-owner case differs by chain: a sole owner removing itself is refused on Safe and Squads and accepted on Stellar, which leaves the account unreachable.

Logs: `round9/owners/` (`pkn.*.log`, `psn.*.log`, `stn.*.log`, the `*.stub.log` cross-checks with local keys in place of NEAR, `psn.limits*.log`, `stn.limits.log`, state files, runner scripts). The `*.before-owners.ts` files are the harnesses from before the owner parameters.

### Seat voting: each seat is a session contract

Spike code under `seat/`: the seat becomes the wallet's session contract itself, so a session key whose grant carries a vote flag can cast the seat's vote. All runs used the round 9 harness moves plus the new seat checks.

| Chain | Build | Result | Logs (under `round9/seat/`) |
|---|---|---|---|
| EVM, Base Sepolia fork | `PrimeSession` as Safe owner through ERC-1271, 36 sLOC against 32, 4,810 bytes | **263/263**, forge tests 23 (13 vote, 10 no-governance) | `evm/pse.fork.log`, `evm/forge-test.log` |
| Solana, local validator | `prime-seat` as Squads settings signer, 40 sLOC against 33 | **292/292** with real NEAR for MetaMask and Freighter | `solana/pss-dev3.log`, `solana/pss-full.log` |
| Solana, no-governance build | `prime-seat-ng` | **291/291** with a local stand-in for NEAR | `solana/pss-ng.log` |
| Stellar testnet | `prime-seat` as the rule-0 seat, 51 sLOC against 37, wasm 2,363 bytes | **263/263**; unit tests 18/18 | `stellar/sst-*.log`, `stellar/verify-sst.log` |
| Stellar, split seat and owner keys | `prime-seat-split`, 52 sLOC | **22/22** on testnet; unit tests 20/20 | `stellar/split-sst.log`, `stellar/split-build.log` |

Costs against round 9: EVM grant +659 gas, session move +7 gas, one Safe vote 97,508 to 103,056 gas against 81,515 for two plain keys. Stellar votes cost 27.5k to 43.5k stroops against 42.0k for plain keys.

What the runs show:

- A seat contract works as a Safe owner, a Squads settings signer and a rule-0 `External` signer without changes to those three systems.
- A move-only session never votes, the vote flag is bound by the owner's signature, a revoke is final, and replays across wallets, accounts and chains fail.
- A live vote session plus one other owner's vote reaches 2-of-3 and can lower the threshold or add a seat. The no-governance builds close this for settings changes and cost 4 or 5 more lines. On EVM and Stellar two vote sessions can still empty the account with no wallet signature.
- Wallets that sign through NEAR approve a hex payload, so the vote flag looks the same as a move-only grant. The Stellar split build fixes this because the vote grant needs the seat key.
- The independent review reproduced 282/282 on EVM and 303/303 on Solana in its own runs and recommends keeping plain-key seats; the no-governance design is adoptable only under the review's conditions.

Layout: `seat/evm/` (`src/PrimeSession.sol`, `src/PrimeSessionNoGov.sol`, `test/`, `pse*.ts`, `nearsig-stub.ts`), `seat/solana/` (`prime-seat/`, `prime-seat-ng/`, `pss.ts`, `run-validator.sh`, `summary.py`, `reqtable.py`), `seat/stellar/` (`prime-seat/`, `prime-seat-u32/`, `prime-seat-split/`, `variants/`, `sst.ts`, `split-sst.ts`, `verify-sst.ts`, `stellar.ts`, `nearsig.ts`, run scripts, `tables.py`). Key files, build outputs, `target/`, `node_modules/`, `Cargo.lock`, test snapshots and run state files are left out. The harnesses import a local `keys.ts` and load testnet keys from a local `secrets/` directory, both kept out of the bundle.

### Contract calls beyond token transfers

Under `calls/`. A session key can make any call the account's rule allows: one contract, one function and conditions on each argument. The venue contract keeps a ledger and moves no token. Each refused call was checked by its error, by an unchanged venue ledger and, where a control exists, by the seats making the same call successfully.

| Chain | Harness | Result | Accepted | Refused | Log (under `round9/calls/`) |
|---|---|---|---|---|---|
| EVM, Base Sepolia fork | `calls/evm/calls-evm.ts`, `src/Venue.sol` | **84/84** | 7 | 20 | `calls-evm.log` |
| Solana, local validator | `calls/solana/calls-sol.ts`, `venue/` | **89/89** | 7 | 30 | `calls-sol.log` |
| Stellar testnet | `calls/stellar/calls-stellar.ts`, `venue/` | **66/66** | 9 | 22 | `calls-stellar.log`, first run in `calls-stellar.run1.log` |

All runs signed with local keys standing in for MetaMask (EVM), Phantom (Solana) and Freighter (Stellar), so they made no NEAR call. The Squads source checkout, the round 9 `.so` and `.wasm` builds and the run state files stay out of the bundle.

### Wallet matrix with the real extensions

Under `wallets/`: the bridge code that drives each real extension in Chromium, the local dapp pages, the payload builders, the offline verifiers, the per-wallet option files and the result files in `wallets/out/`. We ran 12 wallets on testnet with a locally generated test seed.

| Chain | Result |
|---|---|
| EVM | Coinbase Wallet, Rabby, Rainbow, Trust and OKX pass all three formats: grant text, signer text and the Safe vote (EIP-712). `PrimeSession.grant` and `Safe.checkNSignatures` accepted each signature on the fork. |
| Stellar | Freighter and Hana have all three calls (`signMessage`, `signAuthEntry`, `signTransaction`). xBull, Rabet, Albedo and LOBSTR lack `signAuthEntry`. SEP-53 `signMessage` passes in xBull and Albedo; Hana and Rabet sign the raw text, which the signer contract accepts with `sep53 = false`. The LOBSTR row comes from source reading. |
| Solana | Solflare and Backpack pass `signMessage` and `signTransaction`. Glow passes `signMessage`; its `signTransaction` prompt showed no Approve button for either transaction shape. |

Rabby, Trust and OKX need `wallet_addEthereumChain` for chain 84532 before the Safe vote. Backpack and Glow register aliases of other wallets (`window.solflare`, `window.solana` with `isPhantom`), so a dapp picks the wallet explicitly. Logs: `round9/wallets/<wallet>.log`. Results per wallet and format: `wallets/out/`.

The extension builds (`crx/`, `ext/`), browser profiles, screenshots, the source clone of Albedo, built dapp bundles, the lockfile and the local seed are left out. `wallets/lib/seed.mjs` creates the seed on first use in a local `secrets/` directory.

### Files that need `git add -f`

`*.log` is ignored by `.gitignore`. These log files need `git add -f`:

- `round9/owners/*.log`, `round9/calls/*.log`, `round9/wallets/*.log`
- `round9/seat/evm/*.log`, `round9/seat/solana/*.log`, `round9/seat/stellar/*.log`

One command from this directory adds them all: `git add -f round9/owners round9/seat round9/calls round9/wallets seat calls wallets`.

### Checks on `ARCHITECTURE.md`

- Mermaid: `node mermaid-check.mjs ../../../ARCHITECTURE.md` renders every diagram with the real Mermaid library (8 diagrams); the script holds the paths of its Mermaid copy and browser.
- Links: `bun links-check.ts <document>` (the copy in `evm/`) re-reads every explorer link against its chain (60 links).
- Prose: `python3 .claude/skills/human-voice/scripts/lint.py <file>` from the wiki repository must report zero hits.

## Routes

Each wallet uses its own key on its home chain. Elsewhere it signs through NEAR's MPC.

| Wallet | EVM (Safe + Roles) | Solana (Squads Smart Account) | Stellar (OZ account) |
|---|---|---|---|
| MetaMask | **own EOA** | NEAR **stock** eth-implicit account → MPC ed25519 | NEAR stock eth-implicit → MPC ed25519 |
| Freighter | `prime-near-signer` (SEP-53) → MPC secp256k1 | `prime-near-signer` (SEP-53) → MPC ed25519 | **own key** |
| Phantom | `prime-near-signer` → MPC secp256k1 (used in the matrices), or its **own EVM account** (real extension; follow-up spikes above) | **own key** | `prime-near-signer` (plain text) → MPC ed25519 |

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

**Not verified in round 8:** there was no MetaMask extension on the machine. The follow-up spike above ran the real MetaMask 13.50.0 on this route. It removes NEAR from MetaMask on Solana but **no lines** of ours either: that route already uses stock NEAR.

## Test-harness problems on the way, kept with their logs

- **EVM run 2** (`evm/pkn.run2-variants.log`) is the previous run on the wallet-contract variants.
- **EVM runs 3 and 4** (`pkn.run3-near-expired.log`, `pkn.run4-near-nonce.log`) stopped on NEAR RPC errors: "Transaction has expired" and a stale access-key nonce. FastNear's load-balanced testnet RPC sometimes serves a node that is behind. A rejected NEAR transaction does not land, so `nearsig.ts` retries those two errors after 3 s.
- **EVM run 5** (`pkn.run5-s7design.log`, 86/87). S7 "Freighter's seat signed by Phantom's MPC key" was accepted, and that is correct behaviour. A Safe recovers ECDSA owners from the signature itself, so that is simply Phantom voting. Its earlier "refused" results came from signature ordering (GS026), which checks nothing about the key. S7 is now "one wallet signs twice", which is refused (GS026). The Solana (K6d) and Stellar (Y7) counterparts are sound, because there the signature is bound to the signer's key.

## Trade-offs to know

- **Latency:** NEAR-routed signatures averaged 7.9 to 8.2 s on testnet.
- **Availability:** seats and grants through NEAR need NEAR to be up; moves don't.
- **Solana has no per-session revoke.**
- **Audit scope:** the 21-line signer contract and the three session contracts.
