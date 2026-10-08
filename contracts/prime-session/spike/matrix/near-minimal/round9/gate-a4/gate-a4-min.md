# Solana custody gate, gate-owned build (a4-min)

Date: 2026-10-08. Scope: the minimal custody gate for Prime on Solana, in the shape Tuan chose at about 16:25 UTC ("Gate-owned custody on Solana" in `DECISIONS.md`), built and verified in `/home/ubuntu/work/gate-spike/a4-min/` from copies of the a2 and a3 code (those two directories are unchanged). Everything ran on my own `solana-test-validator` at port 9081 with its own ledger, the mainnet feature set (`--clone-feature-set`, read-only mainnet RPC), the mainnet Squads Smart Account build and the mainnet Token-2022 build. Orca Whirlpool and Kamino Lend are the mainnet programs with mainnet pool and reserve state cloned read-only. Nothing was signed on a public network, no NEAR key was used, nothing was committed.

The first half of the task used the delegate design (custody's SPL Token multisig owns the account and approves the gate as delegate). When the direction changed I stopped that line after building its sources, so `variants/delegate-ms.rs` and `variants/delegate-ms-end.rs` are comparison builds only. They compile and are sized below. No harness check ran against them.

## Answer

The gate-owned gate is 91 lines as written and 253 after `rustfmt`, a 50,464-byte binary. The a2 gate was 119 and 276 lines and 87,160 bytes. Custody hands the owner and the close authority of a dedicated token account to the gate PDA. The agent lane draws within a cap that the token program enforces. The owners lane recovers without any cap. The custody multisig releases the account back. Every property the brief lists passed on the mock venue (345 checks), on real Orca and Kamino (53 checks), and under a mutation pass that killed 56 of 56 gate mutants and 28 of 28 setup-check mutants.

| Item | Result |
|---|---|
| Gate, one-signature lowering of the cap (primary) | 91 sLOC, 253 formatted, 50,464 B, `variants/gate-owned.rs` |
| Gate, threshold-only cap | 90 sLOC, 251 formatted, 50,408 B, `variants/gate-owned-thr.rs` |
| Mock-venue harness, primary / threshold-only | 345 of 345 / 348 of 348 |
| Real venues (Kamino deposit and redeem, Orca swap, whole-batch time lock on Orca, recovery, release, prime-session), each build | 53 of 53 |
| Custody multisig whose trustee is a Prime vault | 9 of 9 |
| Gate mutants (`mutants.py`) | 56 of 56 killed |
| `setup-checks.ts` | 19 unit tests, 22 live checks, 28 of 28 mutants killed, `tsc --strict` clean |
| Deploy rent, gate alone / with prime-session | 0.354 SOL / 0.732 SOL |

**Cost of the cap split:** one line (two formatted, 56 bytes). Section "Cap rule" has the table. I recommend keeping the split, since it gives custody a one-signature stop for 56 bytes.

## Design

Custody's token account `X` is a dedicated 165-byte account at an address of its own. Custody signs two `SetAuthority` calls on it, close authority first, owner second, both to the gate PDA. From then on only the gate signs for `X`:

- **Agent lane:** the Prime Account's agent vault pays token accounts whose owner is on the destination list fixed at creation, before the end time, with a not-after inside custody's run window. The gate signs as the cap PDA, the delegate of `X`, so the token program stops the draw at the cap.
- **Owners lane:** the Prime Account's owners at their approval count (a second vault) pay the recovery address and nothing else, at any time, before or after the end time. The gate signs as the owner. A cap on the delegate has no effect on an owner-signed transfer, so recovery has no cap.
- **Cap:** the gate approves the cap PDA as delegate with the cap amount. One signer of custody's multisig can lower or suspend it. Raising it takes the multisig's threshold.
- **Release:** the multisig's threshold hands the owner and the close authority back to the key it names.

### Instructions

Tags are the first data byte. Account lists are in order. "(s)" marks a signer.

| Tag | Name | Data after the tag | Accounts |
|---|---|---|---|
| 0 | `create` | recovery (32) \| until i64 \| window u32 \| seed (8) \| agent lane u8 \| owners lane u8 \| destinations (32 each, owner addresses) | member (s, writable, pays rent), gate PDA (writable), Prime settings, system program, custody multisig |
| 1 | `transfer` | amount u64 \| not_after i64 | gate, lane vault (s), source, destination, token program, cap PDA |
| 2 | `allow` | cap u64 | gate, source, token program, custody multisig, cap PDA, then the signers (s) |
| 3 | `release` | new owner (32) | gate, source, token program, custody multisig, then the signers (s) |

PDAs: gate = `["gate", multisig, settings, seed]`, cap = `["cap", gate]`. The lane vaults are Squads vaults of `settings` at the two lane indexes.

Gate account (181 bytes plus 32 per destination, 245 bytes and 2,596,080 lamports of rent with two destinations): multisig 0..32, settings 32..64, agent lane vault 64..96, owners lane vault 96..128, recovery 128..160, until i64 160..168, window u32 168..172, seed 172..180, bump 180, destinations from 181. Nothing writes the account after `create` (check Y1).

Errors: `Custom(1)` caller is not a lane, or too few signers of the multisig; `2` destination not allowed or the gate has ended; `4` outside the batch's run window; `5` wrong account.

### Rules the gate enforces

| Rule | Where |
|---|---|
| `settings` is owned by Squads and has no settings authority (an autonomous Prime Account) | `create` |
| Both lane indexes are 1 or above (vault 0 belongs to session rules) and differ | `create`, dispatch |
| The seed is 8 bytes | `create` |
| The creator signs and holds a slot of the custody multisig, a Token or Token-2022 multisig with m <= n | `create` |
| The destination list is whole 32-byte entries | dispatch |
| The not-after is mandatory on both lanes: now <= not_after <= now + window | `transfer` |
| The agent lane pays listed owners only, until the end time, and the source is owned by the gate | `transfer` |
| The owners lane pays the recovery address only | `transfer` |
| Only Token and Token-2022 are called | every token call |
| A raise of the cap needs m signers, a lowering needs one | `allow` |
| The delegate is the cap PDA of this gate, and the source's close authority is the gate or unset | `allow` |
| Release needs m signers of this gate's multisig | `release` |

### Setup order for the guide

1. Custody and the trustee create the multisig (2-of-2, or `[custody, backup, trustee, trustee]` with m = 3). The app runs `checkMultisig` and the test signature.
2. A multisig signer creates the gate (`create`).
3. Custody opens an empty dedicated account `X` (165 bytes, owner custody).
4. Custody signs `SetAuthority(CloseAccount)` and `SetAuthority(AccountOwner)` to the gate PDA in one transaction, in that order.
5. The app reads `X` back (`checkHandedOver`): owner is the gate, close authority is the gate (none for wrapped SOL), no delegate, 165 bytes.
6. Custody funds `X`.
7. The multisig threshold calls `allow` to set the cap.
8. The owners install the agent rule and the recovery rule.

## Hand-over order

I ran both orders on a Token account, a Token-2022 account and a wrapped-SOL account (checks H1 to H4g, Z1c to Z1e, N1 to N2).

| Account | Close authority first, then owner | Owner first |
|---|---|---|
| Token, dedicated | Both authorities end at the gate. | The second call is refused (Token error 0x4: the signer must now be the gate). The close authority stays unset and falls back to the owner, the gate. |
| Token-2022, dedicated | Same as Token. | Same as Token (Token-2022 error 0x4 on the second call). |
| Wrapped SOL | The owner change clears the close authority (none after the hand-over), as gate-a3 N2 found. | The same end state: owner is the gate, close authority unset. |

An account with an unset close authority and the gate as owner is safe: the gate's `allow` accepts it and `release` hands it back (H4e, H4f). The app still reports it, so the guide has one canonical end state. `checkHandedOver` accepts an unset close authority for wrapped SOL only.

Two more results from the hand-over:

- **A delegate set before the hand-over is cleared** by the owner change (H11 to H11d), so a backdoor delegate does not survive.
- **The Token-2022 CPI guard blocks the owner change** with error 0x2f while it is switched on (Z9b). An account with the guard never reaches the gate, and `checkSourceAccount` flags the extension before custody tries.

## Cap rule

Variant A (primary) lets any one signer lower or suspend the cap and asks m signers to raise it. Variant B asks m signers for every change.

| | A: one signer lowers, threshold raises | B: threshold only |
|---|---|---|
| sLOC as written / formatted | 91 / 253 | 90 / 251 |
| Binary | 50,464 B | 50,408 B |
| `allow` gate compute units (range over runs) | 5,204 to 9,909 | 5,726 to 8,726 |
| One-signature stop | yes (A4, A7, TL7, V22, V30) | no |
| Harness | 345 of 345 | 348 of 348 |

The compute-unit ranges overlap because the cap PDA search takes a variable number of failed bump steps of about 1,500 units each; the split itself adds a few hundred units. Variant B is one line smaller and offers custody no single-signature stop, so a bad batch waits for m signers. A stolen single key under variant A can lower the cap to 0 and stop the agent lane, and nothing else: it cannot raise the cap, release, or touch recovery.

## Close-and-reopen bypass

**The attack:** a non-native token account keeps its close authority through an owner change. If custody keeps the close authority, an agent that draws the account empty lets custody close it, open the same address as its own account, and receive the venue's proceeds there, where custody alone can move them.

**Choice:** the gate refuses it. Setup hands over the close authority too (Tuan's design), and `allow` refuses to set a cap on a source whose close authority is neither the gate nor unset (one line). A cap is the only way an agent draw becomes possible, because the cap PDA is the sole delegate and no other path lets the agent lane sign. A wrong setup therefore stops at `allow` and never reaches a draw. I picked the on-chain refusal over a setup-only rule because it holds even when the app is bypassed or wrong, and it costs one line. The app check (`checkHandedOver`) reports the same condition before funds arrive.

**Test X1 to X8e:**

1. Custody hands over the owner only and keeps its close authority (X1). The read-back flags it (X1b).
2. The threshold's `allow` is refused with error 5 (X2). With no cap the agent lane is refused by the token program (X3).
3. A scripted run of the full bypass on a fresh account (cap, draw the account empty, close, reopen, venue pays proceeds, custody moves them) stops at the cap and captures 0 (X5). On mutant o28, which lacks the check, the same script completes all five later steps and custody moves the 50 tokens alone.
4. Recovery still moves the 50 tokens out of the wrongly set up account (X6).
5. Custody fixes the setup by signing `SetAuthority(CloseAccount)` as the close authority (X7); the read-back is clean and the cap works (X7b, X7c).
6. A stranger as close authority blocks the cap and blocks `release` (the token program refuses the gate's `SetAuthority`), and recovery still empties the account (X8 to X8e). The app prevents this by reading the account back before it is funded.

## Recovery

- **Any time, no cap:** the owners lane pays the recovery address before the end time, after it, with the cap at 0, and above any cap that was ever set (T12, E1b, E3, E3b, A7d, RR4, V30c). The end time stops the agent lane only.
- **The agent lane cannot reach recovery** unless custody lists the recovery address as a destination; the two lanes are different vaults, and the app warns about that listing (T3, T13, T13b).
- **The wait is real only when the Prime Account's own Squads time lock is above 0:** the owners at their approval count pay through the settings path at once (RR7). After the Prime Account's time lock is set to 5 s, the synchronous path is refused with `TimeLockNotZero` and only the stored recovery under the owners' rule runs, after the rule's wait (RR8 to RR8g). A rule time lock binds those who use the rule. A Prime Account time lock also delays every settings change.
- **Stored recovery lapses:** the owners lane carries a not-after as well, so an approved stored recovery that waits past its window is refused (T15).
- **Custody's key lost:** no recovery transaction holds a custody signature. With the weighted multisig `[custody, backup, trustee, trustee]`, the trustee and the backup raise the cap, release and keep the agent lane working (R12c, R12e to R12g).
- **Squads upgrade exposure (a reading of the code):** an upgrade that signs as the owners-lane vault can move custody's gate-owned funds, with no cap, to the recovery address custody fixed at creation, and nowhere else. An upgrade that signs as the agent lane reaches the listed destinations within the cap. The recovery address is a fixed custody-side value, so both reaches stop at addresses custody chose. A recovery address that no key controls loses funds, so the app warns when it equals a destination or has no known holder.

## Setup checks (`setup-checks.ts`)

148 lines, `tsc --strict` clean, 19 unit tests in `setup-checks.test.ts` on synthetic bytes plus 22 live checks (section SC of the harness) that run the token program, a simulation and a version 0 transaction.

| Function | Purpose | Evidence |
|---|---|---|
| `parseMultisig`, `weight` | Read m, n, the initialised flag and the first n slots; count a key once per slot, as the token program does | unit tests, SC1 |
| `checkMultisig` | m <= n (the token program accepts m > n), m >= 2, every slot known, custody's keys cannot reach m, the trustee alone cannot reach m | unit tests, SC3 to SC5 |
| `weightedSlots` | Slot list that keeps the trustee mandatory: custody once each, trustee m - 1 times; refuses a layout where custody alone reaches m or a list above 11 slots | unit tests, SC5, R12 |
| `testSignatureIx`, `simulateTestSignature` | Zero-amount transfer on a multisig-owned account, simulated with signature verification: the round-trip signature that proves the intended signers reach m | SC2 to SC5 |
| `checkSourceAccount` | Dedicated account only: refuses associated accounts of both programs, accounts above 165 bytes (any extension), frozen accounts | Z7 to Z9 |
| `handOverIxs` | The two `SetAuthority` calls, close authority first | H1, Z1, N1 |
| `checkHandedOver` | Read-back after the hand-over: owner is the gate, close authority is the gate (none for wrapped SOL), no delegate, 165 bytes | H2b, X1b, N2 |
| `txShape`, `legacySize`, `v0BestSize`, `lookupTableIxs`, `compileV0` | Pick legacy, version 0 with a lookup table, or too large | SC8 to SC8e |

**Findings from the live checks:**

- **The multisig test signature works with no funds:** a zero-amount transfer passes `validate_owner` on an empty account. The 3-of-2 multisig fails it even with both signers, and a 2-of-3 whose custody keys reach 2 passes it with custody's keys alone (SC3b, SC4b), and `checkMultisig` flags both cases.
- **Eleven signers fit only when one of them pays the fee:** an 11-signer `allow` is 1,314 bytes as a legacy transaction and 1,195 bytes as a version 0 transaction with a lookup table when a signer pays. With the relayer as fee payer it needs a 12th signature and reaches 1,291 bytes even with the table (SC8). The app lets a multisig signer pay the fee, or keeps n at 10 or below.
- **Associated accounts:** a Token-2022 associated account has an immutable owner, so `SetAuthority(AccountOwner)` fails with Token-2022 error 0x22 (Z7b). A classic associated account hands over (Z7d), and its address then still names custody, so the associated token program refuses to create custody's own account for that mint (Z7e). Both go in by transfer into a dedicated account, and the app flags them.
- **Vault as trustee:** a Prime vault (Squads signs vault PDAs on inner calls) fills a multisig slot. With custody plus Prime vault 5 as a 2-of-2, the owners at their count sign as vault 5 with custody's signature and raise the cap (30,299 CU, 761 B) and release (29,494 CU, 751 B). Either side alone is refused (`trustee-a4.ts`, 9 of 9). Custody plus the owners at M can then release without any external trustee, so this choice trades the independent second party for fewer parties to manage.

## Verification

Final logs are in `/home/ubuntu/work/prime-refine/logs/gate/a4/` (`gate-a4.gate-owned.final.log`, `gate-a4.gate-owned-thr.final.log`, `venues-a4.gate-owned.final.log`, `venues-a4.gate-owned-thr.final.log`, `trustee-a4.gate-owned.final.log`). Each refusal names the program and error that refused it, and a control shows the move works for the party that may make it.

| Requirement | Checks | Result |
|---|---|---|
| Custody alone is refused for transfer, close, SetAuthority, approve and revoke on a gate-owned account; so are the trustee alone, the threshold acting as owner, and a stranger | H5 to H10 | refused, nothing moved |
| Gate creation: member of the multisig, autonomous Prime Account, Squads-owned settings, m <= n, lanes at 1 or above and different, 8-byte seed, stored lane indexes, lengths, signature | G1 to G20f | 41 of 41 |
| A pre-funded gate address does not block `create` (1,000,000 lamports and 5 SOL) | G17 to G18c | works, rent paid in full |
| The cap: threshold sets, one signer lowers or suspends, raise needs m, wrong cap PDA, wrong multisig, hostile program, foreign close authority refused; a used-up cap gives no uncapped fallback | A1 to A16e | 36 of 36 |
| Agent lane: listed destinations, cap, not-after window, end time, lane checks, forged gate account, source owned by the cap PDA, hostile token program | T1 to T11, E1 to E5, B1, B2 | refused or allowed as specified |
| Boundary second: a draw in the end time's own second and a call in its not-after's own second are allowed, the next second is refused | B1, B2 | pass (probes every 300 ms across the boundary) |
| Recovery above the cap, with the cap at 0, after the end time; the agent cannot reach it | T12 to T16, E1b to E3b, A7d | works |
| Release by the threshold returns full control; custody alone, the trustee alone, a stranger, wrong multisig refused; re-hand-over; weighted multisig with custody's key lost | R1 to R14, R12 to R12g | 33 of 33 |
| Close-and-reopen bypass refused | X0 to X8e | 16 of 16 |
| Agent rule: band, pinned accounts, atomic draw and payback, rollback on a failed leg, vault 0 session rule reaches nothing | P1 to P10b | 14 of 14 |
| Whole-batch time lock: store, early run refused, atomic run, second run refused, owners cancel, custody lowers the cap and the run fails, the not-after lapses, a not-after beyond the window, gate end time, rule expiry | TL1 to TL11b | 24 of 24 |
| Recovery rule with a time lock, cancel by the owners, cap does not bind it, Prime Account time lock | RR1 to RR8g | 21 of 21 |
| Token-2022 (agent, cap, recovery, release), fee and hook mints fail closed (error 0x1f), associated accounts, CPI guard | Z1 to Z9b | 28 of 28 |
| Wrapped SOL (hand-over, agent draw, cap, recovery, release, close) | N1 to N7c | 16 of 16 |
| Setup checks live | SC1 to SC8e | 22 of 22 |

### Real venues

Setup: the validator clones the Whirlpool and Kamino programs, the USDC/USDT whirlpool `4fuUiYxT…` with its vaults, ticks and oracle, and the Kamino USDC reserve with its market, supply vault, collateral mint and Scope feed. The USDC mint authority is patched to a local key so the harness can fund custody. Custody's USDC, USDT and collateral accounts are gate-owned dedicated accounts. The Prime vault of the agent lane is the one listed destination. The agent key signs, Squads checks the rule, the gate draws into the vault's account, the venue call runs signed by the vault, and proceeds land in a gate-owned account of custody.

| Run | Compute units | Bytes | Depth | Result |
|---|---|---|---|---|
| Kamino deposit, agent through the rule (refresh at the top level) | 119,676 | 1,002 | 3 | custody lost 100 USDC and holds 83.03 collateral tokens in a gate-owned account; the vault holds 0 |
| Kamino redeem, agent through the rule | 111,049 | 1,052 | 3 | 48 USDC back to custody; the vault keeps 0.176564 USDC of rounding dust |
| Orca swap, agent through the rule | 83,328 | 978 | 3 | 100 USDC became 100.05 USDT in custody's gate-owned USDT account |
| Orca swap, owners as the lane, no rule | 68,117 | 1,065 | 3 | works |
| Orca swap, whole batch stored under a 6 s time lock | 43,464 + 56,022 to store, 119,159 to run | 1,035 + 401, 942 | 3 | 50 USDC became about 50 USDT in one run |
| Owners cancel a stored batch (sync) | 48,709 | 564 | | cancelled batch refused |
| Recovery of venue funds, cap at 0 | 29,240 | 711 | | 500 USDC to R |
| Orca swap through prime-session, session key, version 0 with a lookup table | 107,462 | 897 | 4 | 20 USDC became about 20 USDT |
| The same through prime-session as a legacy transaction | | 1,512 | | refused, too large |

The whole-batch run, the cancel, the lapse (V28c) and the one-signature stop (V22, V23) all ran on real Orca state. Depth is the highest stack height in the logs: the gate and the venue at 2 (Squads at 1, and at 2 again inside its own call), the token program at 3, and one level more through prime-session. The venue run passes on both builds (53 of 53 each).

## Mutation pass

`mutants.py` weakens one check of the final gate source per mutant, loads each at its own program id, and runs the whole harness against it with the run stopped at the first failing check. Final pass: 56 mutants, 56 killed, no survivors (`logs/gate/a4/mutants.final.md` and `mutants.final.log`). Mutants o01 to o54 mutate the primary gate. Mutants t01 and t02 mutate the allow line of the threshold-only build.

| Group | Mutants | Killed by |
|---|---|---|
| Dispatch guards (lane indexes at 1 or above and different, whole destination entries, data lengths of the four instructions) | o01 to o04, o41 to o44 | G13, G13b, G13c, G16b to G16f |
| `create` (signer and slot, m > n, Squads owner, autonomy, seed in the address, stored lane vaults, Allocate, Assign, rent top-up, fixed lane indexes) | o05 to o08, o11, o12, o37, o49 to o52 | G1, G1a, G2, G4, G9, G11, G12, G14, G20b |
| `transfer` (lane signature, lane match, not-after window, end time, listed destinations, recovery, source owner, cap seed, owners path signer, end time on the owners path, destination field offset, boundary seconds) | o13 to o21, o35, o36, o39, o40, o53, o54 | T2, T3, T5, T5b, T6c, T8b, T13, E2, E3, A7d, G20c, G20d, B1, B2 |
| `call` and `load` (token-program allow-list, gate account owner) | o22, o23 | A13, A14 |
| `allow` (raise rule, equal cap, current-cap offset, multisig binding, cap PDA, foreign and unset close authority, delegate account) | o24 to o29, o38, o45 | A2, A5c, A9, A10, X2, H4e, G20c |
| `release` (threshold, multisig binding, order, owner only, close authority only, close authority cleared) | o30 to o34, o46 | R1, R5, H4f, H4g |
| `votes` (token-program owner of the identity, signer flag, slot range, m and n) | o09, o10, o47, o48 | G6, G14, R12c, G9 |
| Threshold-only build | t01, t02 | A2, A10 |

**Survivors found on the way, each closed with a test:**

- **o04** (destination list need not be whole entries) survived the first pass at 329 of 329 checks. G16b refused its malformed create for a different reason (lane 0). G16b now sends a valid create with 5 stray bytes. G16c to G16f cover the length guards o41 to o44.
- **o49** (rent top-up transfers nothing) crashed the harness instead of failing a check, because the unfunded gate account vanished. G1a now checks that the account exists and holds the rent-exempt minimum.
- **o51, o52** (lane indexes fixed at 1 and 3) cannot be seen with the default lanes. G20 creates a gate with lanes 2 and 4 and uses them.
- **o53, o54** (boundary second of the end time and of the not-after) cannot be seen by sleeping between calls. Section B sends a call every 300 ms across the boundary, reads the block time of each, and requires an allowed call in the boundary second itself.
- **Parallel-run interference:** the first kills of o53 and o54 came from a wrapped-SOL venue account that every parallel run shared. N now uses an account of its own Prime vault, and the final pass ran with the corrected harness.

**Clauses removed because no mutant of them could survive a real attack** (each was in an earlier gate; keeping them adds lines and no property):

- The comparison of the cap PDA with the account passed in `transfer`: the runtime refuses a signer that is not derived from the seeds (T7, T7b show the runtime error).
- The length and initialised-flag clauses of the multisig identity check: a token-program account that fails them has no slot holding the signer (a3 survivors m05 to m07).
- The slot limit `take(n)`: unused slots hold the zero key, which cannot sign.
- The explicit check of the gate address in `create`: the runtime gives the signature to the derived address only (G15).
- A subtraction of the pre-funded lamports in the rent top-up: the creator pays the full rent and the donation stays in the account (G18c).

**Setup checks:** `ts-mutants.py` ran 28 mutants over `setup-checks.ts` against the unit tests: 28 killed (`ts-mutants.final.log`). A mutant that moved signer accounts into the lookup table survived because the compiler keeps signers static; the filter went away and the 28 cover the final code.

## Costs

Measured on the local validator without a compute-budget instruction. Compute units vary run to run because the PDA searches take a variable number of failed bump steps (about 1,500 units each), so each row shows the range over the runs in `logs/gate/a4/`.

| Move | Gate's own units | Total units | Bytes |
|---|---|---|---|
| `create`, 2 destinations (also on a pre-funded address) | 12,171 to 22,671 | same | 517 |
| Hand over an account (two `SetAuthority`) | 0 | 251 | 374 |
| `allow`, threshold sets the cap (2 signers) | 5,455 to 10,232 | same | 537 |
| `allow`, one signer lowers or suspends | 5,204 to 9,909 | same | 440 |
| `release`, 2 signers | 5,156 to 5,433 | same | 528 |
| Agent draw, owners as the lane (sync) | 5,307 to 6,807 | 27,752 to 33,735 | 671 |
| Agent draw through a rule | 5,307 | 43,226 | 583 |
| Agent batch, draw and venue payback | 5,307 | 51,630 | 666 |
| Recovery by the owners (sync) | 3,662 | 23,090 to 36,590 | 671 |
| Agent stores a batch under a time lock | | 81,848 | 845 |
| The stored batch runs | 9,807 | 81,974 | 711 |
| Owners cancel a stored batch | | 52,140 | 564 |
| A stored recovery runs | 3,662 | 65,464 | 645 |
| `allow` by 11 signers (version 0, lookup table, a signer pays) | | 8,281 | 1,195 |
| `release` by 11 signers (same) | | 7,985 | 1,217 |

Rent: gate account 2,596,080 lamports (245 bytes); SPL multisig 3,361,680 (355 bytes); a dedicated token account 2,039,280 (165 bytes); agent rule PS 733 bytes, 5,992,560; time-lock rule PW 766 bytes, 6,222,240; real-venue rules PKM 923 bytes, 7,314,960, PO 888 bytes, 7,071,360, PTO 921 bytes, 7,301,040; a stored mock batch 468 bytes, 4,148,160 plus a 294-byte proposal, 2,937,120; a stored Orca batch 733 bytes, 5,992,560 plus the proposal.

### Sizes and deploy rent

sLOC counts non-blank, non-comment lines with the counter of the earlier Solana reports (`sloc.py`), as written and after `rustfmt --edition 2021`. Deploy rent is the program-data account plus the program account, `(len + 173) * 6,960 + 1,141,440` lamports.

| Build | sLOC as written | After `rustfmt` | Binary | Deploy rent |
|---|---|---|---|---|
| a2 gate (earlier hardened build, for reference) | 119 | 276 | 87,160 B | 0.609 SOL |
| Delegate gate of the minimality review (for reference) | 46 | 124 | 38,904 B | 0.273 SOL |
| **gate-owned (primary)** | **91** | **253** | **50,464 B** | **0.354 SOL** |
| gate-owned, threshold-only cap | 90 | 251 | 50,408 B | 0.353 SOL |
| delegate-ms, multisig-owned delegate gate (built only) | 51 | 137 | 39,432 B | 0.277 SOL |
| delegate-ms-end, with a one-signature end instruction (built only) | 59 | 149 | 40,000 B | 0.281 SOL |
| prime-session | 33 | 102 | 54,024 B | 0.378 SOL |

Lines of the primary gate by function, as written / formatted: imports and constants 10 / 18, dispatch 9 / 17, `create` 19 / 67, `transfer` 16 / 61, `allow` 12 / 33, `release` 11 / 24, `load` 4 / 6, `votes` 6 / 11, `call` 4 / 16. The gate-owned build is larger than the delegate builds because it signs two ways (owner and delegate), carries `allow` and `release`, and builds its account with Transfer, Allocate and Assign.

## Findings and points for Tuan

1. **Keep the one-signature rule for lowering the cap:** it costs one line and 56 bytes and gives custody a stop that needs no second party. A threshold-only rule saves that line.
2. **Recovery has no cap by design:** the owners at M can move every gate-owned account to the recovery address at any time. Custody's protection against a majority acting in bad faith is the recovery address it fixed at creation. A custody that wants a bound there picks an address under its own control.
3. **Decision on the recovery wait:** whether the Prime Account sets its own time lock. Today the owners at M recover at once (RR7); a time lock adds the wait and delays every settings change (RR8).
4. **The trustee can be a Prime vault:** the trade-off is in the setup-checks section. Tuan decides who the trustee is: a person's key, a Fordefi vault, or the Prime Account's vault.
5. **Dedicated accounts only:** associated accounts of both programs are refused by the app, and Token-2022 associated accounts cannot be handed over anyway.
6. **A close authority held by a third party** blocks the cap and the release for that account, and recovery still empties it. The guide has custody hand over an empty account, read it back, and fund it afterwards.
7. **Token-2022 limits:** fee and hook mints fail closed (error 0x1f, Z8). A mint with a permanent delegate lets that delegate move custody's tokens with no gate involved (probed in the earlier gate review), so custody should not hold such mints behind the gate.
8. **Custody has no single-signature exit, by design:** custody leaves through `release` (custody and the trustee), through an agent move to a listed destination, or through the owners' recovery.
9. **Gate accounts cannot be closed:** the 2,596,080 lamports of a gate stay locked.
10. **Agent rules must pin the destination accounts:** the gate checks the owner of the destination, and anyone can open a token account owned by a listed address.
11. **Eleven signers:** a signer must pay the fee, or n stays at 10 or below (SC8).

## What is left

- **Fordefi:** the hand-over (`SetAuthority` of a dedicated account to a program PDA), `allow` and `release` through Fordefi's policy engine, with the multisig's partial signatures. The harness signs with raw keys.
- **External audit** of the final source (253 formatted lines), a verifiable build, and a `--final` deploy; the app refuses a gate program that still has an upgrade authority. The harness loads the gate as a non-upgradeable program.
- **Independent security review** of this build (queued in `DECISIONS.md`).
- **A devnet run** after the other agent's budget frees up; the local validator on the mainnet feature set stands in.
- **Re-run after each Squads upgrade:** the program upgrades on mainnet without a time lock.
- **Mutation coverage:** the 56 gate mutants and 28 setup-check mutants cover checks and conditions. Account-layout offsets inside Squads and Token-2022 extension handling rest on the live tests.

## Files

- Gate sources: `/home/ubuntu/work/gate-spike/a4-min/variants/` (`gate-owned.rs` primary, `gate-owned-thr.rs`, comparison builds `delegate-ms.rs` and `delegate-ms-end.rs`); binaries in `so/`; mutants in `mut/` (`mutants.py build` and `mutants.py run`).
- Harness: `lib.ts`, `gate-a4.ts` (mock venue, sections M G H A T X E R P TL RR Z N SC Y B), `venues-a4.ts` (real Orca and Kamino), `trustee-a4.ts`; `setup-checks.ts`, `setup-checks.test.ts`, `ts-mutants.py`.
- Scripts: `run-validator.sh` (port 9081, `MUTANTS=1` or `VENUES=1`), `restart-validator.sh`, `stop-validator.sh`, `bld.sh`, `metrics.py`, `report-data.py`.
- Logs and state: `/home/ubuntu/work/prime-refine/logs/gate/a4/` (`*.final.log`, `mutants.final.md`, `mutants.pass1.md`, `ts-mutants.final.log`, `state/`).
- My validator is stopped by PID and its ledger deleted. `a2/` and `a3-multisig/` are unchanged.

Status: DONE_WITH_CONCERNS
Summary: The gate-owned gate is 91 sLOC (253 formatted, 50,464 B) against 119 for the a2 gate; it passes 345 mock-venue checks, 53 real Orca and Kamino checks including the whole-batch time lock and prime-session, and a mutation pass that killed 56 of 56 gate mutants and 28 of 28 setup-check mutants.
Concerns/Blockers: a Fordefi policy-engine run, the external audit with a `--final` deploy and the independent review are still to do; recovery has no cap by design, so the recovery address custody fixes at creation is the bound on a majority of owners; the recovery wait exists only when the Prime Account's own time lock is above 0.
