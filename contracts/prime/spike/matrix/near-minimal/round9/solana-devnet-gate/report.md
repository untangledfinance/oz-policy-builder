# Custody gate on Solana devnet (2026-10-09)

The final custody gate is deployed on devnet and final, the on-chain code equals the `.so`, and the gate-owned custody flow passes 84 of 84 checks against it. The reclaim of the 10-08 test accounts lifted the payer from 0.276073 to 0.484632 SOL, enough to cover the 0.4817 SOL deploy peak with 2.9 million lamports to spare.

| Item | Value |
|---|---|
| Program id | `58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx` ([explorer](https://explorer.solana.com/address/58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx?cluster=devnet)) |
| Build | `cargo-build-sbf` from `contracts/prime/solana/custody-gate` on branch `feat/solana`, sha256 `6d196cab5b6c6d29bc6cf650a1526b4be56c0550bed479b55090364d7a04dfd7`, 47,160 B |
| Program data | `12zjuTsmzpN75z1QWoUR7eb2ZJuq2mbrcCfSTDDdn1TS`, 47,160 B of code space (`--max-len 47160`) |
| Deploy tx | [`2YPjUoKg...3TNGoU`](https://explorer.solana.com/tx/2YPjUoKgoegqd6UH5pevRUBR9w6QnCdjYg1MzFey3P9Mqq5LTBHVmg3dvQY217tKBRc2ENr98m8BoTRcHMTNKGoU?cluster=devnet) (slot 509,094,290), after a separate `write-buffer` of 47 write transactions into a buffer I created |
| Hash equality | `pdhash-gate.ts` on devnet: the on-chain code starts with the local `.so`, the code space has the same length, and sha256 of the on-chain code is `6d196cab...4dfd7` (`pdhash-before-final.log`) |
| Final tx | [`3tvBoRtA...3caLzAP`](https://explorer.solana.com/tx/3tvBoRtAtxgda4MqFeDyv2AaxjzCrrPBnPBzPWkx811x1678AMHcTG54SFQMUttWuJEZDEtT1ZmGhRuJJ3caLzAP?cluster=devnet) (`set-upgrade-authority --final`, slot 509,094,346) |
| After final | `solana program show`: Authority none; `pdhash-gate.ts`: upgrade authority none (final), same hash (`pdhash-after-final.log`) |
| Leftover buffer | `solana program show --buffers` lists nothing; the loader returned the buffer rent at the deploy |
| N/N | 84/84 checks in `gate-devnet.log` (state in `state-gate-devnet.json`) |
| SOL | the deploy and the flow cost 0.268098 SOL, the reclaim returned 0.208559 SOL and the clean-up 0.013092 SOL; the payer ends at 0.229626 SOL, 0.046447 SOL below the 0.276073 it started with |

## 1. Reclaim

The vaults held 0.12086 SOL (A, `Ge5g2ZRr...`) and 0.0279 SOL (B, `GfpFgQHX...`). The 10-08 run funded them with 0.25 and 0.03 SOL and spent the rest on moves, so sweeping them alone gave 0.424833 SOL, 0.057 SOL short of the deploy peak. The shortfall closed with rent the two accounts still held for the payer. Every step used a 2-of-3 owner vote (Phantom's local test key plus one NEAR MPC signature for MetaMask under `prime:solana`, under `near.lock`, five MPC signatures in total) or needed no vote.

| Step | Payer before | Payer after | Gain (SOL) |
|---|---|---|---|
| Close the 6 executed Squads transactions and proposals (the rent collector is the payer, no vote) | 0.276073 | 0.305802 | 0.029729 |
| Sweep vault A and vault B to the payer (one synchronous Squads transaction each, 2 NEAR MPC signatures) | 0.305802 | 0.454532 | 0.148730 |
| Reject the 5 active proposals of account A (2 NEAR MPC signatures), then close them | 0.454532 | 0.477337 | 0.022805 |
| Remove the movers policy of A and of B (one transaction, 1 NEAR MPC signature) | 0.477337 | 0.484632 | 0.007295 |

The sweeps took the whole vault balance, since a system account can drop to zero. The two settings accounts (1,838,960 lamports each) stay open: Squads has no close instruction for a settings account. The 43 session keys of the 10-08 run hold 0.086 SOL. Each came from `Keypair.generate()` in memory and no file stores its secret, so nothing can sign for them and I left that SOL where it is. The scripts are `close-executed.ts` and `close-done.ts`, `sweep-vaults.ts`, `reject-active.ts` and `remove-policies.ts` in the bundle. Logs: `reclaim-close.log`, `reclaim-sweep.log`, `reclaim-reject.log`, `reclaim-policies.log`.

## 2. Budget

`plan.md` holds the numbers computed before the deploy. Devnet charges 5,080 lamports per byte, so the deploy peak is the buffer (240,411,000) plus the program data (240,451,640) plus the program account (833,120): 481,695,760 lamports. The payer held 484,631,760 lamports, and the deploy plus its 49 transactions used 241,544,760 of them. The custody flow was planned at about 0.024 SOL and cost 0.026553 SOL, with the Squads rent of the settings account and the three gate accounts as the largest items. After the run the clean-up closed every token account the flow's keys own, removed the agent rule and swept the float of custody and the trustee, which returned 0.013092 SOL. The harness checked the payer balance every eight confirmed transactions against the 0.05 SOL floor and stayed far above it during the flow (lowest balance 0.2165 SOL).

## 3. What ran

All keys are plain local keys saved under `secrets/` and kept out of git, so the Prime Account setup is autonomous. Refused attempts fail in the preflight simulation, so they carry no signature and cost nothing; each refusal is matched to the program and error that refused it.

| Check | Result |
|---|---|
| Prime Account (Squads Smart Account) with three owners, threshold 2, no settings authority | S1, S1b: reads back as planned |
| Mint (classic Token, 6 decimals, no freeze authority) and the app's `checkMint` | S2: nothing to refuse or warn about |
| Custody multisig [custody, backup, trustee, trustee], m = 3 and the app's `checkMultisig` | S3, S3b: clean, the trustee holds weight 2, custody and its backup together hold weight 2 |
| Create the gate, then the app's `checkGate` read-back | G1, G1b, G1c: no difference from the plan; recovery is the trustee's wallet |
| A rogue member creates a gate with its own recovery address | G2, G2b: `checkGate` reports `gate-recovery` |
| A stranger, a System account as multisig, a taken address and agent lane 0 | G3 to G6: refused by the gate |
| Hand over the close authority first, then the owner, then the read-back | H1, H1b, H2, H2b: the transaction orders the two SetAuthority calls close authority, then owner; `checkHandedOver` and `checkSourceAccount` read clean |
| Custody alone, the trustee alone and a stranger try to transfer, move the owner or the close authority; the multisig set as owner | H3 to H7: refused by the token program, nothing moved |
| Install the agent rule (Squads policy) | R1 |
| Set the cap (allow): custody alone, custody plus backup, the trustee alone and a stranger are refused, custody plus trustee (weight 3) sets 100 | R3 to R4b |
| Agent move of 10 to the listed destination through the rule | M1, M1b: the destination gained 10, the cap fell to 90 |
| Agent refusals: unlisted destination, recovery address as destination, over the cap, above the rule's band, an expired deadline, raise or release through the rule, a stranger as lane, a foreign cap address | M2 to M10 |
| One custody signer lowers the cap, then an agent move above it is refused | L1 to L3b; control L4 moves exactly 5, L5 is refused once the cap is used up, L6 sets the cap again |
| Recovery to the trustee's wallet by the owners (2 of 3) above the cap | C1, C1b: 300 moved with a cap of 100, the cap untouched; C2 to C6 refuse one owner, a listed destination, a stranger, an expired deadline and a foreign lane |
| Release back by the multisig | T1 to T2b refuse custody alone, custody plus backup, the trustee alone and the owners; custody plus trustee releases X to a new key; T3 to T6: the new key moves funds and the gate refuses the agent and the recovery afterwards |
| Custody's key lost: the trustee and the backup release a second account | T7 to T7e |
| Forged multisig (a token account whose bytes read as a multisig with a signer in slot 4) | F1 to F4: the gate refuses it with error 5 (length check), `parseMultisig` refuses it, a gate on the real multisig still creates |

The agent rule pins the gate program, the gate account and the source account and bounds the amount to 1 to 100 tokens. It leaves the destination open, so the unlisted-destination refusal (M2) comes from the gate's own list and not from the rule. The over-the-rule-band refusal (M5) comes from the rule.

## 4. Numbers measured on devnet

| Operation | Compute units | Transaction size | Fee (lamports) |
|---|---|---|---|
| Create the gate (2 signatures) | 21,106 | 485 B | 10,000 |
| Hand over a token account (2 SetAuthority) | 251 | 374 B | 10,000 |
| Install the agent rule (Squads policy, 450 B) | 32,975 | 776 B | 15,000 |
| Set the cap by the multisig (custody plus trustee) | 5,741 | 537 B | 15,000 |
| Agent move through the rule | 40,336 | 583 B | 10,000 |
| One signer lowers the cap | 5,411 | 440 B | 10,000 |
| Recovery by the owners (2 of 3) | 23,077 | 671 B | 15,000 |
| Release by the multisig (custody plus trustee) | 5,439 | 528 B | 15,000 |
| Release by the trustee and the backup | 5,431 | 528 B | 15,000 |

## 5. Left out

- **Real Orca and Kamino venues and the venue mock:** these are cloned from mainnet or deployed as fixtures on the local validator. The local matrix covers them (345/345 mock venue, 53/53 real Orca and Kamino, 9/9 trustee, 4/4 forged multisig refused).
- **Token-2022, wrapped SOL, stored batches with a time lock, mutants and the boundary-second checks:** these stay in the local run. This run covers the list in the task on the final deployed program.
- **Session keys of the 10-08 run:** 0.086 SOL, see section 1.
- **Accounts that stay open:** the gate accounts (three), the two mints, the multisig, the lookalike token account (its close authority is a made-up key) and the Prime Account's settings account, about 0.0131 SOL of rent in total.

## 6. Files

- Logs and plan: `/home/ubuntu/work/prime-refine/logs/solana-devnet-gate/` (`plan.md`, `tx-signatures.md`, `build.log`, `write-buffer.log`, `deploy.log`, `pdhash-before-final.log`, `final.log`, `pdhash-after-final.log`, `buffers-after.log`, `gate-devnet.log`, `cleanup.log`, the four `reclaim-*.log` files and `state-gate-devnet.json`). The bundle copy is `contracts/prime/spike/matrix/near-minimal/round9/solana-devnet-gate/` in the repo.
- Harness: `/home/ubuntu/work/prime-refine/devnet-gate/` (`dev.ts`, `lib-devnet.ts`, `gate-devnet.ts`, `cleanup-devnet.ts`, `pdhash-gate.ts`, the reclaim scripts and a copy of `setup-checks.ts`). `lib-devnet.ts` is `a4-min/lib.ts` with one RPC URL (devnet, genesis hash checked), the funded payer in place of airdrops, saved test keys and a transaction log.
- Keys: the flow keys, the buffer keypair and the program keypair sit under `devnet-gate/secrets/` with mode 600 and stay out of git.

## Transactions

Every confirmed transaction with its explorer link (cluster devnet). Refused attempts carry no signature.

### Reclaim

- close executed vault transaction A#4: [22e8uHK6...VvAPZ](https://explorer.solana.com/tx/22e8uHK6bL2JsrsmAjgBbuEde5KJ1MN2nBgxP2Pvibnx6ZFvAZPxRHooDb59KKCbhpW3nwcDKdhHume5kTJVvAPZ?cluster=devnet)
- close executed vault transaction A#5: [4X7b5Hzs...cwAj8](https://explorer.solana.com/tx/4X7b5Hzsee6Eu3phqTibWfbm1hUzC1jkYnJbDNcWCV9EvxgRiBrNoxmhq7zw5Z8ChQi3d8YVQeEPwNRTCTScwAj8?cluster=devnet)
- close executed vault transaction A#6: [4LnNwRFW...17uwq](https://explorer.solana.com/tx/4LnNwRFW7t2jPVB6urjg7DEN8gqkQ34ug8PAPmaUDT3xwBcxo3HUXGRMi76RT35qHrHjKBsyLuQRgsuMss417uwq?cluster=devnet)
- close executed settings transaction A#8: [2sZdkZoX...2qMsv](https://explorer.solana.com/tx/2sZdkZoXFCEstHwKs9uj9Sig8vWF5deuLDo9HHXBAUfwpzpTifkSS9LVfby8Cxs6UszaZgzHnn1ep5JVL5i2qMsv?cluster=devnet)
- close executed settings transaction A#10: [5AEvBFCQ...sfW25](https://explorer.solana.com/tx/5AEvBFCQYDsQhV8yx2sdXRyavYwTZ4uhDvEpSWE4Y6gnPq5i4GHBEANLTQ8MsHAXv9yv1hiVJhDJTSHN64GsfW25?cluster=devnet)
- close executed settings transaction B#1: [3vnQw791...udrEC](https://explorer.solana.com/tx/3vnQw791KsVqtNoGDHq7keU8fUCY1MpJwfR98W1FLoWU6DVNe1kRAfS1ZTPj9VRUjFwZh1h9MEN9tjMzXihudrEC?cluster=devnet)
- sweep vault of Prime Account A (settings Ge5g2ZRr...) to the payer, 0.12086 SOL: Phantom + MetaMask (NEAR MPC): [4TZci16Y...S97w9](https://explorer.solana.com/tx/4TZci16YHTjDP4rV9a89uSY92AwhrKPX5Aciwo3ZgcfPYwaj3NDxCJ2oLBcJGttkk8HseMusvyQNoHAzh1WS97w9?cluster=devnet)
- sweep vault of Prime Account B (settings GfpFgQHX...) to the payer, 0.0279 SOL: Phantom + MetaMask (NEAR MPC): [3pKTc2W2...esu1J](https://explorer.solana.com/tx/3pKTc2W2yX6SyBKc9Am2th4fnCgLvFtxS7dQb4BscfqrEVv3kzTt35g6J553fgGpJJ2mWQzjsr9UZUWP7sHesu1J?cluster=devnet)
- reject active proposals 1,2,3 of Prime Account A: Phantom + MetaMask (NEAR MPC): [3nozVGr4...M85YL](https://explorer.solana.com/tx/3nozVGr4TcLnUaKgDMnMJS3tmRdJmeYjrDCrh4usbwiSURwQp1ECbBdtPgSuiwFf6Jk45gk8xiygjFhMpGoM85YL?cluster=devnet)
- reject active proposals 7,9 of Prime Account A: Phantom + MetaMask (NEAR MPC): [2VVfGQLb...1Cnf2](https://explorer.solana.com/tx/2VVfGQLb31EbJ5mDnL6TXoHsXN8Z1dUVGA42uFuoW4BrhRBwotWZBT9dPivggEayQt9MTZJS7SqqB5RNGP81Cnf2?cluster=devnet)
- close rejected vault transaction A#1: [5K4tMetr...X6WRV](https://explorer.solana.com/tx/5K4tMetr2p4oibzrMxxwHFQtXpP7mVdVptrePH5vbMzq29fFSW4PB8CheKicdnQu5HQMomNadBNy3QHrfJMX6WRV?cluster=devnet)
- close rejected vault transaction A#2: [3fwym3XP...2jgPw](https://explorer.solana.com/tx/3fwym3XPwKjVfPJZP5SLuoaFQa6pufjS51TQoUng735XoDF1jpu4XyiwqJEYEC3ajmNFnssi4RFnQJhuWhK2jgPw?cluster=devnet)
- close rejected vault transaction A#3: [2oiqnv7f...MQSrP](https://explorer.solana.com/tx/2oiqnv7fVHGqoe8a11vRhQGvcz42mapP3NNcM5fzBC2Hu2r1c2XnYA732TDjmkHeLmt9kkZ9edvJ8jPZeZqMQSrP?cluster=devnet)
- close rejected vault transaction A#7: [5Qoau8YC...eAq6h](https://explorer.solana.com/tx/5Qoau8YCDVyJC6HJkfEi2EMDosLxB7WzrgPH4k1o4AnDf6hyhePmLA9timYCru6pLrvxHSGbLxoFhrJ6bcDeAq6h?cluster=devnet)
- close rejected vault transaction A#9: [5f9AUsBv...7vBFe](https://explorer.solana.com/tx/5f9AUsBvob9vcFXWp5VqPRLyqRMs937ggzsD32wWc7j2HknC432h9MZq1uTFWvzQALyhMMzZxPGHY69JWi47vBFe?cluster=devnet)
- remove the movers policies of Prime Accounts A and B (rent back to the payer): Phantom + MetaMask (NEAR MPC): [87NHedsU...82AoT](https://explorer.solana.com/tx/87NHedsULcGYuKrKjNTMwYoFqToSDHCv37XrbVM7awurtr98mptE88VwHDLRLnu6wimPBWmCaY4PYkeRbW82AoT?cluster=devnet)

### Deploy
- deploy (program data created from the buffer, buffer rent returned, slot 509,094,290): [2YPjUoKg...3TNGoU](https://explorer.solana.com/tx/2YPjUoKgoegqd6UH5pevRUBR9w6QnCdjYg1MzFey3P9Mqq5LTBHVmg3dvQY217tKBRc2ENr98m8BoTRcHMTNKGoU?cluster=devnet)
- `set-upgrade-authority --final` (slot 509,094,346): [3tvBoRtA...3caLzAP](https://explorer.solana.com/tx/3tvBoRtAtxgda4MqFeDyv2AaxjzCrrPBnPBzPWkx811x1678AMHcTG54SFQMUttWuJEZDEtT1ZmGhRuJJ3caLzAP?cluster=devnet)
- program: [58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx](https://explorer.solana.com/address/58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx?cluster=devnet), program data [12zjuTsm...dn1TS](https://explorer.solana.com/address/12zjuTsmzpN75z1QWoUR7eb2ZJuq2mbrcCfSTDDdn1TS?cluster=devnet)
- buffer [7xkCP6ve...MDoDkF](https://explorer.solana.com/address/7xkCP6vekgDG57AaHNTnQGWdMmom9YDQfCQXJHGMoDkF?cluster=devnet) (47 write transactions by `write-buffer`, balance returned at the deploy; `solana program show --buffers` is empty)

### Custody flow
- fund custody with the gate account rent: [5wjokvMD...F651L](https://explorer.solana.com/tx/5wjokvMDqiUquxdUbsntDJn34rcjsFfVQ23TL5HF7MQAGryuKzv8hgbFzCpcZcd8oTcDHubmrskssjzeLjXF651L?cluster=devnet)
- fund the trustee with the rent of a rogue gate: [CZ5tDAqe...bsFTT](https://explorer.solana.com/tx/CZ5tDAqeTjieBXqs7m9HSeTQEuK4VBjtjd9YcVTnt4q7VAQkMc45NrfNTZgpLQdP6uU47q1LHQm9L2XWFNbsFTT?cluster=devnet)
- S1. the Prime Account (Squads Smart Account) is set up with three plain owner keys, threshold 2, no settings authority: [Rge3iZXC...MvwTC](https://explorer.solana.com/tx/Rge3iZXCpLtfgqX1gGSQjEpjyQpYT9XygcsEoDqqDttxF2YjWZ9JnEvEcjJoJQacoug7QGS3sUB2B7EojdMvwTC?cluster=devnet)
- create the mint (classic Token, 6 decimals, no freeze authority): [3MK9iLGS...n6QuC](https://explorer.solana.com/tx/3MK9iLGSigHyPpYLWtpV811YhGpaLAhhyGWkEcF73YZ2uCKhb2Df1qBRwRLLmEzeLZeUvtxKJ6jeBzJau3kn6QuC?cluster=devnet)
- create the token accounts of the Prime vault 1, the trustee wallet and a stranger: [65h9AZLC...ZonH9](https://explorer.solana.com/tx/65h9AZLCj9A2FNdpwtrJrY3kU5up98N28W7mDJfPZ5WWKd9TR6HdEPmTiDUXr85htoo6gm85He7dbwAKLJWZonH9?cluster=devnet)
- S3. custody's identity: the weighted multisig [custody, backup, trustee, trustee], m = 3: [2fcpqTkt...t7YRP](https://explorer.solana.com/tx/2fcpqTktKXxYy4uLErhA5YytcZjc386Y4T1LJXAiTTLpQCE3TCA462xKHwem7tyTXwvUBa9TKviZ9zUppRVt7YRP?cluster=devnet)
- G1. custody (a signer of the multisig) creates the gate: Prime Account P, agent lane vault 1, owners lane vault 3, window 60 s, recovery = the trustee's wallet, one listed destination (vault 1): [2YS7ET9f...6yC8R](https://explorer.solana.com/tx/2YS7ET9fiG818m6Reo2uwhZR83GawF4VAcoAKGVZQhr9H97J6nUKfUR17dWuXaK83MLQJ7xkwTVNSwtiFob6yC8R?cluster=devnet)
- G2. a rogue member of the multisig (the trustee) creates a second gate whose recovery address is its own choice: [5nJUYyi2...M8bRz](https://explorer.solana.com/tx/5nJUYyi28LTuvpjaxcR3Bzuaoa8gRtWBJNpxtjYR6N3P1v1fkeC7yaKscDrYGBFfLJ5Z7P1Cwc7iDWDAGtZM8bRz?cluster=devnet)
- create custody's dedicated token account X and fund it with 1,000 tokens: [23PD5SW7...BAhC5](https://explorer.solana.com/tx/23PD5SW7jvayPj5BKG7XbWajhBk4HkrmYYkr44LAAy27DM5Fsw9rWqEmzZGqwwrQ3XWSxkFTko9PLGuykP4BAhC5?cluster=devnet)
- H1b. custody signs the two SetAuthority calls in one transaction: [4CUeQFun...Fhy9x](https://explorer.solana.com/tx/4CUeQFunZ9MDm1jFhfps3GWgUQgMPCVyHKnLmFAVVXbUikRShBCh9BLKukxABpgtn3a9htaVvfZVKL58TfdFhy9x?cluster=devnet)
- R1. the owners (2 of 3) install the agent rule at lane 1: the gate's transfer from X, amount 1 to 100, a deadline set: [39jzdTgD...wTFVb](https://explorer.solana.com/tx/39jzdTgDkMcKGBCferCKdzWWQL3jr3Ciqy81yQbzt4p2CU1MLDjuW5eKbAyKmoDb7XAK1Xv4BEPgmY86BBrwTFVb?cluster=devnet)
- R4. custody and the trustee (weight 3 of 3) set the cap to 100: [4ihAQ3co...jSfbF](https://explorer.solana.com/tx/4ihAQ3copg3ktN1r3GHtz4ffbVTqGrnKDNQERQK5f2kFFHY3ZJnBQoEM8dWPgjWQaUN76faFChvTftiQrYNjSfbF?cluster=devnet)
- M1. the agent moves 10 to the listed destination (the Prime vault 1 account) through the Squads rule: [2RYfjSY6...7JryD](https://explorer.solana.com/tx/2RYfjSY6C6LpHPxh9dPr9JVc4ouVWFdp7ZBUD82v4XbARDQPbw2JPJMwdxtEwoF2kkvaZ1biUCjrUoHaD427JryD?cluster=devnet)
- L1. custody alone lowers the cap from 90 to 5: [49aUCDav...5dcok](https://explorer.solana.com/tx/49aUCDavx1TmyVEQJk9JGfGG7hYDC3mjDVqS7TAFSXMeTfZuFfaEtXeVDPXgg1o7DHzaQfC9bGD2aPBYL8p5dcok?cluster=devnet)
- L4. control: the agent moves exactly 5, the lowered cap: [2KC1t58X...SrhHP](https://explorer.solana.com/tx/2KC1t58X2HDtajHLF6Dreyb31hj68RwP3rcxcivgFPF7WvnPKgwGRMQHqYJXqbY1Dn4SdD8cD5rWFC3VdQwSrhHP?cluster=devnet)
- L6. custody and the trustee set the cap to 100 again: [4k538ERC...DAyP7](https://explorer.solana.com/tx/4k538ERCZA2kwbxdRy312LYfAfEi6QHVCuKBpVtjRtPmuJRg1RqNSqhJBMBnzBzH81zAwuCgY54dj8pckEjDAyP7?cluster=devnet)
- C1. the owners (2 of 3) as the owners lane recover 300 to the trustee's wallet account: above the cap of 100: [3tVEKZdq...UWN21](https://explorer.solana.com/tx/3tVEKZdqEjFWqXPrkgdyPpNhZTVTJjPsLGjiQSMTP9FRGeo6iPHKfhBjtaW9umnVz5Z8YRxfbGvYaFJ1tJkUWN21?cluster=devnet)
- T2. custody and the trustee (weight 3 of 3) release X to newKey: [2fGx4F1g...pB8fj](https://explorer.solana.com/tx/2fGx4F1gLzxmC2KkncE8LXkkkSNMLyHAMWV4gEvUACofDY4srLbsX5WqmNQwJsd1sHXApJ9CD4odCRDpNRjpB8fj?cluster=devnet)
- T3. newKey alone moves 50 out: full control is back: [3VQguFAJ...NHpFp](https://explorer.solana.com/tx/3VQguFAJCTuMaevmQjMT1Gsc4uhDASndkn9HuoRyN5Q1NMb7rjwMriEWVVxV3oUG2QQ4nD2mMFLYfpQCDWHNHpFp?cluster=devnet)
- create a second dedicated account Y of custody with 10 tokens: [3r8EE1ZJ...XfJx3](https://explorer.solana.com/tx/3r8EE1ZJvPEJ6cWJz9L1LcpRMRyRzsrFn2eBWVC62MSYrL65VMudutAGBNr8Rd5dB4Hju8CN6zG96fh8YvXfJx3?cluster=devnet)
- T7. custody hands Y to the gate: close authority first, then owner: [4A92AxHy...efvJz](https://explorer.solana.com/tx/4A92AxHycUWD7bPcpRzTZEfbg4KRh3xBTrN2YTvgsvudZU6uUPimRbo2S8VKKG6v9KJMmm1cjXx5CXkV82MefvJz?cluster=devnet)
- T7d. the trustee and the backup (weight 3) release Y to newKey with no custody signature: [5LP217MJ...teJbL](https://explorer.solana.com/tx/5LP217MJTmLqZPF1qNJA4y7JJ3nxPtqAda5fNRJHenTR6T5osfjAuXFopqZ1Y21kB7LdAAqbtREYut78QFtteJbL?cluster=devnet)
- create the mint (classic Token, 6 decimals, no freeze authority): [3P4rPyyg...zsXoj](https://explorer.solana.com/tx/3P4rPyyg9dvoJJ2r6tg13RfgNAduZAEJusgRSxtT6uKFhUokchyYhzbbn45ghW1UPB3RTd21PKWQrPoApUizsXoj?cluster=devnet)
- create the lookalike: a token account whose mint address starts with a zero byte and whose close authority carries a key in a signer slot: [ESrkzpDc...CkWFS](https://explorer.solana.com/tx/ESrkzpDcF8oUJNZHk3Q72wMFR2MfzDVchDwydpzvyLQTPxgtFaLAqTirThwPZrJvsyFokANrvJHvF8aNLZCkWFS?cluster=devnet)
- F4. control: a gate on the real multisig is still created: [49pXHhPY...e6jhr](https://explorer.solana.com/tx/49pXHhPYgYPYuREw3742ZnMaocUiZXgfKcSZJwdDTsyg2AJZfAKBRFaqjGUyqCbNscbF4UiBkdohZLHcUT7e6jhr?cluster=devnet)

### Clean-up
- close X (owner newKey) and return its rent to the payer: [4ZEGs9mU...qMHF4](https://explorer.solana.com/tx/4ZEGs9mUebCUAZYgkcCigGJpmni1acjAnWpVLjLHj3bAGnYAyinMc3JUCZukswnFdvijXRvs8rd3aLZ6K9VqMHF4?cluster=devnet)
- close Y (owner newKey) and return its rent to the payer: [4qhsG4T7...kHTVP](https://explorer.solana.com/tx/4qhsG4T7gAWgg5QA26PzbFiKidGKxpCy2tTdxL42Tk3mf5BMzizKs34GoYTgKGvWiogm2zYbrc4nfCikci1kHTVP?cluster=devnet)
- close the trustee wallet's token account: [4FcXxi8v...xDnYc](https://explorer.solana.com/tx/4FcXxi8vxLFd1RZ4mpkcACU81CYji7s5fwXdKSNMXYieke8ePjX4aMJnYv3jWmzL9HoTfrRLKxfCKBrUVcDxDnYc?cluster=devnet)
- close the stranger's token account: [3CiYhru9...bakqr](https://explorer.solana.com/tx/3CiYhru9XDz2XDfDi731Z7JWf3VE4sXtXh9Znyzwc3WuXbnNfi7KKAE3pKnTFWBW5UMoXzRyzPaxGrbqYGQbakqr?cluster=devnet)
- the owners (2 of 3) burn the tokens of the Prime vault 1 account and close it, rent to the payer: [5gdXRL1g...zAFbW](https://explorer.solana.com/tx/5gdXRL1gr9VPgtCnCmPp6F3XLoXyQL8M1niRS2ueSSnsv9kyMfbz16Z2TvwdgmuE5JDCk9B87vbYerHk8VfzAFbW?cluster=devnet)
- the owners (2 of 3) remove the agent rule, rent to the payer: [2oYmBygq...gQWWY](https://explorer.solana.com/tx/2oYmBygqbNKHZxZYKVv78K44oZww6uRv4RkxcFdtMwyEv3zYj2dzUswK3v7P8M7ZPhw6y1t1ESkX4tzxrjbgQWWY?cluster=devnet)
- sweep 0.001535 SOL of custody to the payer: [5RsdeA8z...EcsKh](https://explorer.solana.com/tx/5RsdeA8zrMUKjSqgf4ThLmLQVX2SwX91EXsmsqqWJWTAXHd2Qo4sS8TDEXQ6TEqaSuvR9mRQezTdo6q2a9HEcsKh?cluster=devnet)
- sweep 0.001268 SOL of the trustee to the payer: [NNJuW3V2...cuxHW](https://explorer.solana.com/tx/NNJuW3V2tPZ7Nmr9gAGUaEng5wP37jqrfxiJ9zvj6kGrzgh74YLSJNWtG5jsJC49LQvEtV7zv8BBRU814dcuxHW?cluster=devnet)

## Follow-ups for the orchestrator

- `contracts/prime/solana/README-architecture.md` and `ARCHITECTURE.md` can cite the program id, the deploy and final transactions and the 84/84 result.
- A second devnet run needs about 0.03 SOL for the flow. The payer holds 0.229626 SOL.
- The reclaim recipe (close executed proposals, reject active ones, remove policies, sweep vaults) returned 0.209 SOL, so a future devnet run can fund itself the same way.

Status: DONE
Summary: The final custody gate is deployed on devnet at `58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx` and final, the on-chain code equals the `.so` (sha256 `6d196cab...4dfd7`), and the gate-owned custody flow passes 84/84 on devnet. The reclaim lifted the payer from 0.276073 to 0.484632 SOL before the deploy; the payer ends at 0.229626 SOL.
Concerns/Blockers: The 43 session keys of the 10-08 run (0.086 SOL) are unrecoverable because their secrets were never stored. The 10-08 vaults held 0.15 SOL against the 0.28 SOL funded, so the deploy fit only after closing and removing the old Squads proposals and policies.
