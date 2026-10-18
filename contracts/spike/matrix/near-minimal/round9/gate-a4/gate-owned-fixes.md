# Gate-owned custody gate: fixes from the independent review

Date: 8 October 2026. The independent review (`reports/gate-owned-review.md`) gave the verdict adopt with fixes. This report covers the fixes to the app checks (`setup-checks.ts`) and to the three documents. The gate program is unchanged, and nothing under `/home/ubuntu/work/opt/` was touched. Nothing is committed.

## What changed

**`/home/ubuntu/work/gate-spike/a4-min/setup-checks.ts`** (148 to 265 lines, `tsc --strict` clean):

- **`checkMint({ owner, data })` (F1, F2):** reads the mint and the program that owns it. It returns `program`, `refuse` and `warn`.
  - Refuses a Token-2022 mint with a permanent delegate, a transfer hook, a transfer fee, confidential transfer (and its fee and confidential mint and burn variants), non-transferable tokens or frozen-by-default accounts.
  - Fails closed on any extension it cannot parse or does not know, on a malformed or cut-off extension, a bad mint marker, non-zero padding, a bad flag byte, an uninitialised mint and a mint owned by another program. A benign extension with the wrong length is refused as malformed.
  - Warns, for the app to show before funds move, for a freeze authority: "the issuer can freeze this account; while frozen, recovery and release are refused" (with the authority's address). It also warns for a pause authority and for Token-2022 itself, with the advice to prefer the classic Token program (immutable, where Token-2022 is upgradeable).
  - Allows metadata and group pointers, a close authority, interest-bearing and scaled-amount display, which leave the raw amount and the account authorities alone.
- **`parseGate`, `gateAddress`, `checkGate(account, expected)` (F3):** decodes the gate account (181 bytes plus 32 per destination) and compares the owner program, the derived address, the stored bump and every fixed field with the plan: multisig, Prime settings, both lane vaults, recovery address, end time, window, seed and destination list (entry for entry). It also refuses a recovery address that is empty, custody's own, the multisig or a destination. `checkGate` takes `{ address, owner, data }` because the owner program and the address are part of what it must check.
- **Harness:** `gate-a4.ts` gains section SX (32 live checks). `lib.ts` allows port 9111 next to 9081 (one regex). `run-validator-9111.sh` starts the own validator (port 9111, ledger `ledger-9111`, PID file `validator-9111.pid`).

**Documents** (zero lint hits on each; Mermaid blocks render: 2, 11 and 9 of them):

- `docs/prime-solana-setup-and-recovery.md`: a "Read first" block (F1, F4); nine setup steps with the gate read-back at step 3, before the hand-over, and the owners' second read at step 9; the mint check and the table of refused mints (F2) in section 5; the gate read-back table and seed squatting and locked rent (F3, F6, F7) in section 4; the full reach of an owner majority (F4) in section 11; new rows in the mistakes table; the function table of section 13; section 14 (the review and its fixes); section 15 (who you trust, F5).
- `docs/prime-solana.md`: the two limits in section 1; a "Which mints the gate holds" table in section 4; nine setup steps and the mermaid sequence in section 6; the full reach in section 9; new attack rows, the Token-2022 trust line and the `--final` consequence in section 15; the review marked done with the fix table in section 17.
- `ARCHITECTURE.md` section 7.4 (the two limits above "Design", the Token-2022 and upgrade rows, the gate read-back row, nine setup steps, the full reach in "Recovery", new findings, "Independent review: adopt with fixes", "Who you trust", the counts) and section 13 (the review marked done, the freezable-mint item, the recovery item).

I confirmed the upgrade facts on chain (read-only RPC, 8 October 2026): Token-2022 `TokenzQd...` upgradeable with authority `AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz`, classic Token `Tokenkeg...` with no upgrade authority, Squads `SMRTzfY6...` with authority `HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2`.

## Verification

| Check | Result |
|---|---|
| `tsc --strict` on `setup-checks.ts` | clean |
| Unit tests (`bun test setup-checks.test.ts`) | 43 of 43: the 19 earlier ones unchanged, 24 new (mint: classic clean, freeze warning, Token-2022 warning, permanent delegate, hook, fee, confidential, non-transferable, default state frozen and open, unknown and account-only extensions, benign and pausable, malformed cases, other owner program; gate: parse, derivation, match, mismatched recovery, each field, seed, bump, destination list, owner and address, recovery sanity) |
| Live checks, local validator at 9111, own ledger, mainnet feature set | 54 of 54 (`logs/gate/a4-fix/gate-a4.sc-sx.log`): the 22 earlier checks (SC1 to SC8e) and 32 new (SX1 to SX16b) |
| Mutation pass (`ts-mutants.py`) | 88 of 88 killed: the 28 earlier mutants and 60 new ones on `checkMint`, `parseGate`, `gateAddress` and `checkGate` (`logs/gate/a4-fix/ts-mutants.fix.log`) |
| lint.py on the three documents and this report | 0 hits each |
| measure.py on the three documents | 0 flags each |
| Mermaid check on the three documents | all blocks render |

The live SX checks cover the review's cases on a real validator: a permanent-delegate mint refused (SX4), a classic mint with a freeze authority allowed with the warning (SX2), hook, fee, non-transferable and frozen-by-default mints refused (SX5 to SX6), an unknown extension refused (SX7), a correct gate read back as passing (SX8b), a gate whose recovery address belongs to a rogue signer refused (SX9b), and gates with an extra destination, another end time or window, swapped lanes, custody's own recovery address, another multisig and another Prime Account refused (SX10 to SX16b).

## Status of each finding

| # | Finding | Fix | Status |
|---|---|---|---|
| F1 | A freeze authority stops recovery and release | `checkMint` warning, the caveat in all three documents | Done in code, tests and docs. The app screen is design only |
| F2 | A permanent-delegate mint bypasses the gate | `checkMint` refuses it and the other unsafe mints | Done in code and tests |
| F3 | No gate read-back | `checkGate`, run before the hand-over and again by the owners | Done in code and tests |
| F4 | The owner majority's full reach | Stated in section 11, section 9 and section 7.4 | Done in docs |
| F5 | Upgradeable Squads and Token-2022, final gate | Stated in section 15 of the guide, section 15 of `prime-solana.md` and "Who you trust" | Done in docs. The app's refusal of a gate with an upgrade authority is design only |
| F6 | Rent locked in gate-owned accounts | Stated in all three documents | Done in docs |
| F7 | Seed squatting | Stated in all three documents, with the app's retry | Done in docs |

## Cleanup and one slip

My validator (PID from `validator-9111.pid`) was stopped by its PID and its ledger deleted. The other validators on the host (ports 9101 and 9103) belong to other agents and were left alone. While checking a diff I ran `git stash` in the oz-policy-builder repo by mistake and restored it at once with `git stash pop`: the diff of `ARCHITECTURE.md` is identical before and after (57 insertions, 22 deletions), and the stash list is empty.

## Open items

- The app screens that show the mint warnings and the gate read-back do not exist yet (design only).
- The app's refusal of a gate program that still has an upgrade authority has no code (design only).
- `setup-checks.ts` does not yet check that the multisig and the token account belong to the same token program, nor that the recovery address has a token account for each token.
- `checkMint` takes the mint account as given. The app has to fetch the mint that `parseTokenAccount(...).mint` names (SX1b shows the path) and has to pass the observed account owner into `checkGate`.
- The mint extension table follows the Token-2022 type ids as of `@solana/spl-token` 0.4.15. A newer extension is refused as unknown until someone classifies it.

Status: DONE
Summary: `checkMint` and `checkGate` are added to `setup-checks.ts` with 43 unit tests, 54 live checks on an own validator and 88 of 88 mutants killed, and the three documents carry the F1 to F7 fixes and the review marked done (adopt with fixes), with zero lint hits and rendering Mermaid blocks.
Concerns/Blockers: none blocking. The app screens for the mint warning and the gate read-back, and the app's refusal of an upgradeable gate program, remain design only.
