# Solana devnet run: plan and budget (2026-10-08, before any spend)

Payer: `5bevLKtW8bA6LCXXMqQAjnWBRCWcSXwcvQHiCbT6JjuY`, balance 1.000000000 SOL at the start. Floor: the run stops if the balance would drop below 0.05 SOL.

## Rent on devnet (read from the devnet RPC with `getMinimumBalanceForRentExemption`)

Devnet charges 5,080 lamports per byte (rent of an empty account: 650,240 lamports). The local validator charges 6,960, so the earlier plan overstates every rent figure by about 37%.

| Account | Bytes | Lamports | SOL |
|---|---|---|---|
| Program data (45 header + 54,024 `.so`, `--max-len` 54,024) | 54,069 | 275,320,760 | 0.27532 |
| Deploy buffer (37 header + 54,024) | 54,061 | 275,280,120 | 0.27528 |
| Program account | 36 | 833,120 | 0.00083 |
| Revoke marker (empty account) | 0 | 650,240 | 0.00065 |

Deploy peak: buffer + program data + program account = 0.55143 SOL, then the loader returns the buffer to the payer. Net deploy cost: 0.27615 SOL plus about 60 write transactions at 5,000 lamports (0.0003 SOL). After the deploy the payer holds about 0.7236 SOL.

## Matrix cost

Local run `psn-local.log` spent 92,919,040 lamports on rent and fees beyond vault funding (two accounts, proposals, policies, transactions, markers, fees). Devnet rent is lower, so this figure is an upper bound: 0.0929 SOL.

| Item | SOL |
|---|---|
| Rent and fees (local figure, upper bound) | 0.0929 |
| 41 session keys at 0.002 SOL | 0.0820 |
| Revoke checks for MetaMask and Freighter (two extra keys, two markers, fees) | 0.0100 |
| Vault of account A (moves total about 0.17 SOL: seat votes 0.03, policy moves under the 0.1 daily cap, small test moves) | 0.2500 |
| Vault of account B (only 0.001 and ten 0.00001 SOL moves) | 0.0300 |
| Matrix total | 0.4649 |

Run total: 0.2762 + 0.4649 = 0.7411 SOL, leaving about 0.259 SOL above zero and 0.209 above the floor.

## The full matrix does not fit

The original plan needs both programs and two 0.25 SOL vaults: 2 x 0.2762 + 0.5 + 0.0929 + 0.082 = 1.227 SOL. Program B alone (0.2762 net, 0.5514 peak while it deploys) leaves no room for the matrix after A is in place. The reduced run below drops program B and shrinks the two vaults.

## Reduced run

Everything in the matrix runs except the four two-program-id checks (X7a to X7d). The run adds a revoke block for the two wallets that reach Solana through NEAR (the default matrix revokes only Phantom's sessions).

1. Deploy `target/deploy-devnet/prime_session.so` (sha256 `8db245ab...888b7b76`, built with `PRIME_CLUSTER=devnet`) to program id `4tXCkZW255iZNT4gPHDuAbqR3eG8Zs3tRsgLRc1BoPRa` with `--max-len 54024`. Upgradeable at first.
2. `pdhash.ts` with `PSN_NET=devnet`: the on-chain code equals the `.so`.
3. `psn.ts` with `PSN_NET=devnet` under `flock near.lock`:
   - a 2-of-3 Squads account whose settings signers are MetaMask (NEAR `prime:solana`), Freighter (NEAR `prime:solana`) and Phantom (own key); the movers policy has the three session PDAs as its signers (K7);
   - per wallet: one grant signature, a relayed move, a self-paid move (the session key pays its own fee), and for the NEAR routes a revoke followed by a refused move (new block W);
   - cross-account refusals (A3, A4, A6, V6a) and the cross-cluster refusal (X6);
   - seat votes: 2-of-3 approvals from every pair, a single seat refused, an outsider refused, session keys refused as seats (K and N sections).
4. After the checks pass: `solana program set-upgrade-authority 4tXC... --final`, then `pdhash.ts` again (it prints the upgrade authority) and one more `psn.ts`-free confirmation that the program account is still executable.
5. Close any leftover buffer (`solana program show --buffers`, `solana program close`).

## Changes to the harness (devnet only, local default unchanged)

- Vault funding per account: 0.25 SOL for A and 0.03 SOL for B on devnet (2 SOL each locally).
- The startup check no longer needs program B on devnet and requires 0.55 SOL instead of 0.8.
- X7a to X7d run only locally (program B exists only there).
- Block W (devnet only): MetaMask and Freighter each grant, move, revoke, and the revoked session is refused.
- Balance guard: on devnet the harness reads the payer balance during the run and exits with a message when it falls below 0.05 SOL.
- `createAccount` retries when another user of the public Squads program takes the same account index first (the index was 592,625 and rising when checked).
- `pdhash.ts` prints the program's upgrade authority.

## Not run

- Program B (second program id) and checks X7a to X7d: 0.55 SOL peak does not fit next to the matrix. The local run covers them (138/138).
- Round 8 comparison moves (`PSN_R8`): local only.
- Leftover vault balance (about 0.1 SOL per account) stays in the two Smart Accounts. Returning it needs a 2-of-3 transfer that costs NEAR signatures for no verification value.
