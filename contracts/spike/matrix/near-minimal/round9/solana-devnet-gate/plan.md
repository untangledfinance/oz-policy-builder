# Solana devnet gate run: plan and budget (2026-10-09, written after the reclaim and before the deploy)

Payer: `5bevLKtW8bA6LCXXMqQAjnWBRCWcSXwcvQHiCbT6JjuY`. Floor for the custody flow: the run stops when the payer would drop below 0.05 SOL.

## Reclaim result

The payer started at 0.276073 SOL and holds 0.484632 SOL after the reclaim (+0.208559 SOL, 0.208 SOL net of fees). The vaults held 0.12086 SOL (A) and 0.0279 SOL (B), less than the 0.25 and 0.03 SOL funded on 10-08, because the run spent the rest on moves. Those two balances alone lift the payer to 0.4248 SOL, 0.057 SOL short of the deploy peak. The shortfall closed with rent that the 10-08 accounts still held for the payer:

| Step | Gain (SOL) | Votes |
|---|---|---|
| Sweep vault A and vault B (system transfers by the 2-of-3) | 0.148760 | 2 (Phantom key plus one NEAR MPC signature each) |
| Close 6 executed and 5 rejected Squads transactions and proposals (rent collector is the payer) | 0.052619 | none for the executed ones, 2 NEAR MPC signatures to reject the five active proposals |
| Remove the two movers policies (rent returns to the payer) | 0.007310 | 1 NEAR MPC signature |

The 43 session keys of the 10-08 run hold 0.086 SOL. Each key came from `Keypair.generate()` and no file stores its secret, so nothing can sign for them. The two settings accounts (1,838,960 lamports each) stay open because the Squads program has no close instruction for a settings account.

## Deploy peak

Devnet charges 5,080 lamports per byte (`getMinimumBalanceForRentExemption`, read today). The gate `.so` is 47,160 bytes, built from the repo source at sha256 `6d196cab...4dfd7`.

| Account | Bytes | Lamports |
|---|---|---|
| Buffer (37 header + 47,160) | 47,197 | 240,411,000 |
| Program data (45 header + 47,160, `--max-len 47160`) | 47,205 | 240,451,640 |
| Program account | 36 | 833,120 |
| Peak (all three open at once) | | 481,695,760 |

About 49 transactions (buffer create, 47 writes, deploy) cost 5,000 to 10,000 lamports each, 0.26 million lamports in total. The payer holds 484,631,760 lamports, so the peak plus fees leaves a margin of about 2.7 million lamports. After the loader returns the buffer, the program costs 0.2413 SOL and the payer holds about 0.2431 SOL.

Deploy steps, in order: write the buffer with an explicit buffer keypair (stored under `secrets/`, never printed), deploy it upgradeable with the program keypair the build created, run `pdhash` (on-chain code equals the `.so`), then `solana program set-upgrade-authority --final`, then `solana program show --buffers` and close any leftover buffer.

## Custody flow cost

Everything runs on plain local keys, so no NEAR signature is needed. The relayer (payer) pays fees and rent. Custody pays the gate account's rent, so it gets 0.004 SOL. A refused attempt fails in simulation, never reaches the chain and costs nothing.

| Item | Lamports |
|---|---|
| Prime Account (Squads settings, 234 B; creation fee is 0 on devnet) | 1,838,960 |
| Mint, 6 decimals, classic Token, no freeze authority (82 B) | 1,066,800 |
| Custody multisig [custody, backup, trustee, trustee], m = 3 (355 B) | 2,453,640 |
| Gate account (213 B, one listed destination) | 1,732,280 |
| Four token accounts: gate-owned source, Prime vault 1 account, trustee wallet account, stranger account (165 B each) | 5,953,760 |
| Agent rule (Squads policy, about 600 B) | about 3,700,000 |
| Forged-multisig probe (mint at an address starting with a zero byte, plus one token account) | 2,555,240 |
| Custody rent float for the gate account | 4,000,000 |
| About 45 confirmed transactions at 10,000 to 15,000 lamports | about 600,000 |
| Total | about 23,900,000 (0.024 SOL) |

That leaves about 0.219 SOL above the 0.05 floor, so the full list in the task fits with room. At the end the run closes the empty token accounts it owns and sweeps custody's float back to the payer, so the spend ends lower than this table.

## Run order

1. Reclaim (done): `reclaim-close.log`, `reclaim-sweep.log`, `reclaim-reject.log`, `reclaim-policies.log`, links in `tx-signatures.md`.
2. Build, deploy, `pdhash`, `--final`.
3. Custody flow on devnet (`gate-devnet.ts`, a copy of the a4 harness logic pointed at devnet):
   - Prime Account (Squads) with three plain owners, threshold 2;
   - mint, custody multisig [custody, backup, trustee, trustee] m = 3, the app's `checkMultisig`;
   - create the gate, then the app's `checkGate` read-back;
   - hand over the close authority first, then the owner, then `checkHandedOver`;
   - the multisig threshold sets the cap (allow);
   - an agent move to the listed destination through a Squads rule;
   - refusals: unlisted destination, over the cap, custody alone moving funds, the trustee alone moving funds;
   - one custody signer lowers the cap, then an agent move is refused;
   - the owners at their threshold recover above the cap to the trustee's wallet;
   - release back by the multisig, then the new owner moves the funds;
   - the forged multisig (a token account posing as the multisig) is refused.
4. Clean-up: close empty token accounts back to the payer, sweep custody's float.
5. Report, bundle copy, secret scan, commit, `pull --rebase`, push to `feat/solana`.

## Guards

- The harness reads the payer balance every eight confirmed transactions and exits below 0.05 SOL.
- RPC calls run 200 ms apart with a back-off on 429.
- Mainnet is never touched: the harness holds one RPC URL, `https://api.devnet.solana.com`, and checks the genesis hash at start.
