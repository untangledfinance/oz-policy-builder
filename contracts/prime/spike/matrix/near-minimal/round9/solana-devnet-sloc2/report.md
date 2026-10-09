# Solana devnet: the 9 October 2026 builds (2026-10-09)

## Result

Both new Solana builds are deployed on devnet at new program ids and locked with `--final`, and everything passes there: prime-session 145 of 145 distinct checks (with program B and X7a to X7d included this time) and the custody gate 84 of 84. The on-chain code of each program equals its `.so`. The round cost 0.9724 SOL net; the payer holds 9.2572 SOL.

| Item | Value |
|---|---|
| prime-session A | `6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba` ([explorer](https://explorer.solana.com/address/6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba?cluster=devnet)), program data `2o1PtHRJguYDbihKyutSRTyGXkgMo8ZRPD7dGgKdhRaC` |
| prime-session B | `GLabPwsshHoaXMrHM6nHsHEkf51MFkKP86WCdRpXg3SD` ([explorer](https://explorer.solana.com/address/GLabPwsshHoaXMrHM6nHsHEkf51MFkKP86WCdRpXg3SD?cluster=devnet)), program data `6CEGGuVY6vEaoCGczVyDSYhqPjd9uQrrY3tAAzBXndHd` |
| Custody gate | `6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz` ([explorer](https://explorer.solana.com/address/6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz?cluster=devnet)), program data `BFMMi5dhPNXpF1PwBzGHCK4u46VUikmsxoEBqUdXsLbu` |
| Builds | session `PRIME_CLUSTER=devnet` sha256 `c883636111dfda411ef0dc80e7e73646cb6ee4d1fa9e924f645c0b6c33e68263` (53,720 B); gate `a5d19edb879e75d054f1025d710753ce5150726130c3dd74887236fbdbdc94e2` (47,472 B). Built from the repo source on `feat/solana` in a scratch copy; both equal the pins in `build-hashes.json` |
| Deploy | `write-buffer` into a buffer I created, then `deploy --buffer --max-len` equal to the size. Session A [`tMwr9cvd...fbw1a`](https://explorer.solana.com/tx/tMwr9cvddu6qLMyXDALLyEmGLHBmPMeEtHQLJw7sJFKCEEo1NM1HCgP9s5GKkrpBj2GW39am93XLQnSLUYfbw1a?cluster=devnet), B [`2LkKLseB...JU7nG`](https://explorer.solana.com/tx/2LkKLseBnQAVgifWXZVMiEYbAocrs56hqQoneokb4o3DRDz1NFvU7owdJqy3asa2aDQ1ta7E37MQYug1QHnJU7nG?cluster=devnet), gate [`4bVXEsmJ...bFvyG`](https://explorer.solana.com/tx/4bVXEsmJuWJDBWs3S35iy8LbVQddC6g3zth9dQPyPj2pw4H3AaCsSCDEQp5AJf7JBfz1q7if8ojAGkc2n4KbFvyG?cluster=devnet) |
| Hash equality | `pdhash-ids.ts` before `--final`: the on-chain code starts with the `.so`, the rest is zero, sha256 equals the build, for A, B and the gate. After `--final`: the same, upgrade authority none |
| Final | `set-upgrade-authority --final`: A [`4G22erQA...7VbJ1`](https://explorer.solana.com/tx/4G22erQAK37eMssFnPyXfgwXYNrEsJJ3PgWZyguvsCvafak4Bh2562t5CRNKHTQXFQP7X8UfPB5xAF7cnxG7VbJ1?cluster=devnet), B [`539WAf1c...cF4mY`](https://explorer.solana.com/tx/539WAf1c43uGLCfkPZLyK7VpCQBYTtptTq8Bszj6RBRmV7a8Jcyf4B1sjDV3WWZPFSRnzHb9aP9Dr6rviTEcF4mY?cluster=devnet), gate [`2GGEZ3LW...6aHDM`](https://explorer.solana.com/tx/2GGEZ3LW5JoeMUVBFdSWFAPSVrdPLKb1AQmrT9oAFPd2DxGhkANxyUwayKYFCA92n397hpChHHg6XuvNreF6aHDM?cluster=devnet) |
| Buffers | `solana program show --buffers` lists nothing after every deploy; the loader returned each buffer's rent |
| N/N | session 145/145, gate 84/84 |
| SOL | 10.229626 before, 9.257217 after: 0.972408 spent net |

The old ids (session `4tXCkZW255iZNT4gPHDuAbqR3eG8Zs3tRsgLRc1BoPRa`, gate `58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx`) are final and stay on devnet as previous builds.

## Order of work

I locked each program with `--final` right after the byte check and ran the matrix against the final programs, as the task asked. The flag `--skip-new-upgrade-authority-signer-check` of the 10-08 notes is not needed; `set-upgrade-authority <id> --final --keypair <payer>` is enough.

## 1. prime-session

`psn.ts` with `PSN_NET=devnet`, under `flock near.lock`, real NEAR MPC (41 signatures, 8.3 s average), logs `psn-devnet.log` and `psn-devnet-f4.log`. It covers the three routes (Phantom's own key; MetaMask and Freighter through NEAR), grants, relayed and self-paid moves, a session key without SOL refused, revoke then a refused move for all three wallets, the cross-account refusals (A3, A4, A6), the cross-cluster refusal (X6, error 7), the seat votes (K block, every pair reaches 2-of-3, a single seat and an outsider are refused), the policy removal (R block), the forged-offset block F, and now program B with X7a to X7d (error 2 for a grant that names the other program's PDA, error 7 for the text mismatch).

The main run ended 144 of 145. The one failure was F4, which needs a no-op program as "another program". The harness expects it at `AARnE8m37ewaTZq4ksPZhGJAsizXQD37JHiGf4mP3R6v` (a local-validator fixture), and devnet had no such account. I deployed the fixture (`noop.so`, 4,520 bytes, 0.0238 SOL) at the same id, locked it with `--final`, and re-ran F4 alone on the same accounts (`PSN_RERUN_F4`): refused with error 7, 1/1. That makes 145 of 145 distinct checks.

| Metric | Devnet |
|---|---|
| Move, ten Phantom samples, relayer pays | median 51,940 CU, max 54,940, 973 B, fee 15,000 lamports (local median 53,423) |
| Move per route | MetaMask 54,942, Freighter 53,473, Phantom 60,974 CU |
| Revoke | 22,261 CU, 724 B, fee 10,000 lamports; marker rent 650,240 lamports |

The Smart Accounts are A `BADcvrN6ym7xekL4LVoid4RXPqPpzgrj57zibU2DXYUb` and B `68xJKwva4kanNWAVsHMRGtk56iX7RJgaJgbJKJ1q2rh5`. The harness had no FAIL besides F4.

## 2. Custody gate

The gate-owned custody flow of `solana-devnet-gate.md` (harness copy `gate/gate-devnet.ts`, plain local keys, new flow keys) ran in 131 s against the new gate: 84 of 84, including S (Prime Account, mint, multisig), G (create, rogue member, stranger, taken address, lane 0), H (hand-over), R (agent rule, cap), M (agent moves and their refusals), L (one signer lowers the cap), C (recovery by the owners), T (release, lost key) and the forged multisig F1 to F4 (error 5 from the gate, `parseMultisig` refuses, the control gate on the real multisig is created). The flow does not call prime-session, so no session id is needed in it.

| Operation | Compute units | Size | Fee |
|---|---|---|---|
| Create the gate | 30,411 | 485 B | 10,000 |
| Hand over (2 SetAuthority) | 251 | 374 B | 10,000 |
| Install the agent rule | 33,006 | 776 B | 15,000 |
| Set the cap (custody plus trustee) | 5,836 | 537 B | 15,000 |
| Agent move through the rule | 40,424 | 583 B | 10,000 |
| One signer lowers the cap | 5,506 | 440 B | 10,000 |
| Recovery by the owners | 27,749 | 671 B | 15,000 |
| Release (custody plus trustee) | 5,595 | 528 B | 15,000 |

Create and recovery cost more than on 8 October (21,106 and 23,077). Both search for a PDA bump with random keys, and the search takes about 1,500 CU per failed step.

## 3. Cost and clean-up

| Step | SOL |
|---|---|
| Payer before | 10.229626 |
| After three deploys and finals | 9.436667 |
| After the no-op deploy and the session run | 8.960465 |
| After the gate flow | 8.933912 |
| After the gate clean-up (token accounts closed, agent rule removed, float swept) | 8.947004 |
| After the session reclaim and the session key sweep | 9.257217 |

The four programs hold 0.8168 SOL of rent for good (session A and B 0.2738 each, gate 0.2420, no-op 0.0238, and 0.0008 per program account). The session run kept about 0.141 SOL (fees, two settings accounts, six revoke markers) and the gate flow 0.0135 SOL. The reclaim ran the 10-08 recipe on the new accounts: close the executed Squads transactions, sweep both vaults to the payer (0.12186 and 0.0289 SOL; Phantom plus MetaMask through NEAR, 2 signatures), reject the five active proposals of account A (2 signatures), close the rejected ones, remove both movers policies (1 signature), then return the float of 50 session keys (0.09995 SOL in 9 transactions). The session keys of this run were saved to a mode 600 file outside git for that sweep, so nothing is lost this time.

Rent that stays locked: the two settings accounts, the revoke markers, the gate accounts (three), the multisig, two mints and the lookalike token account, about 0.025 SOL together.

## 4. Repo and docs

On `feat/solana`: `contracts/prime/README.md` (build table and devnet row), `ARCHITECTURE.md` section 7.5 (rewritten for the new ids, gate table, 145/145, cost) with the rows in 12.1, section 13, the deploy note and the funding sentences, `solana/README-architecture.md` (two devnet sections, cost row, open items) and `solana/SETUP-AND-RECOVERY.md` (where it ran, the deploy cost figures). The old ids appear as previous builds. Work mirrors `docs/prime-solana.md` and `docs/prime-solana-setup-and-recovery.md` are regenerated from the repo files. The SETUP guide carried a stale gate rent figure (0.258 SOL, 0.515 SOL peak); it now reads 0.2429 and 0.4849 from the deployed gate. Logs, state files, transaction lists and the harness copies are in `spike/matrix/near-minimal/round9/solana-devnet-sloc2/` (no keys; session keys, program keypairs and flow keys stay under `/home/ubuntu/work/sloc2-devnet/secrets/`).

Checks: `lint.py` 0 hits on all edited files and the bundle notes; the link check passes (95 links in the four docs, 119 explorer links in the two transaction lists, each transaction confirmed without error and each address present on devnet); the secret scan and the cross-check results are in section 5.

## 5. Harness changes

`psn.ts` (in the bundle `harness/`): `PSN_PROG_KEYPAIR` and `PSN_PROG_B_KEYPAIR` for the program ids, `PSN_DEVNET_B` (program B and X7a to X7d on devnet), `PSN_KEYS_OUT` (saves session keys), `PSN_RERUN_F4`. The local default is unchanged. New: `pdhash-ids.ts` (check any program id against a `.so`), `deploy.sh`, `reclaim.sh`, `gate/sweep-session-keys.ts`, `linkcheck.py`.

Status: DONE
Summary: session A, session B and the gate are deployed and final on devnet with on-chain code equal to the pinned builds; prime-session passes 145/145 and the gate 84/84, for 0.9724 SOL net, leaving the payer 9.2572 SOL.
Concerns/Blockers: F4 needed a no-op program on devnet (deployed and locked, 0.0238 SOL) and a one-check re-run on the same accounts.
