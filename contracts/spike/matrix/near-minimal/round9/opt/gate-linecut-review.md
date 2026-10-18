# Independent review: the line-cut Solana custody gate

Date: 2026-10-09. This review covers the step from the reviewed gate-owned gate (`/home/ubuntu/work/gate-spike/a4-min/variants/gate-owned.rs`, 91 sLOC, verdict "adopt with fixes" in `reports/gate-owned-review.md`) to the line-cut gate that is now the production candidate (`/home/ubuntu/work/opt/gate/variants/gate-lc.rs`, 84 sLOC, standard `solana_program`). Tuan accepted Solana at 117 sLOC: this gate plus prime-session at 33.

I worked in copies under `/tmp/linecut-review/`, on my own `solana-test-validator` at port 9141 with its own ledger, the mainnet feature set (`--clone-feature-set` against read-only mainnet RPC), the mainnet Squads Smart Account build and the mainnet Token-2022 build. I stopped only my own validator, by its PID file. Nothing was signed on a public network and nothing was committed. Both source directories were read only.

## Verdict

**Adopt the line-cut gate.**

The line cut is a pure refactor. Every check of the a4 gate is still in the line-cut source, in the same order, with the same error codes. The only change in what the gate sends to other programs is one signer flag on a System `Transfer`, and the System program ignores it. Three independent kinds of evidence agree:

- a host differential test ran both sources on 3 million random inputs and found no difference in result, error code, the calls made or the account data written, apart from that flag and one error code on a create that both builds refuse;
- the 62-mutant pass kills every mutant on my validator, and five mutants of my own aimed at the refactored helpers behave as expected (three die, two equivalence probes survive the whole harness);
- the a4 harnesses pass unchanged on my validator: 345 of 345 mock checks, 53 of 53 real Orca and Kamino checks, 9 of 9 trustee checks, 54 of 54 setup-check live checks.

The binary rebuilds bit for bit, the count is 84 sLOC as written (241 after `rustfmt`), and F1 to F7 hold as before. The account layout is unchanged, so `checkGate` still matches it.

I found one issue that both builds share and the earlier review missed (L1 below): a classic Token account can pose as custody's multisig with a threshold of 0, after which anyone can raise the cap and release accounts on that gate. The setup checks refuse such a gate, so it only matters to a party that skips them. A length check inside an existing line closes it at no sLOC cost; I built and tested that variant (see L1). Because the gate deploys with `--final`, I recommend taking the fix before the audit and the final deploy. It does not block adopting the line cut itself.

## What I reproduced

| Claim | Result |
|---|---|
| Rebuild of `gate-lc.rs` from source, own crate copy and target | SHA-256 `00d6a5c4d7f04be1b23c635bc3cd8c952354404bb799875fcaf0c9346b7f7871`, 47,304 bytes, identical to `opt/gate/so/gate-lc.so` |
| Rebuild of the a4 `gate-owned.rs` (reference) | `f2157f8623e67ae8...601958`, 50,464 bytes, identical to the a4 binary |
| sLOC, as written / after `rustfmt --edition 2021` (`sloc.py`; a plain non-blank, non-comment count agrees) | gate 84 / 241 (a4: 91 / 253); prime-session 33 / 102; total 117 |
| Mainnet builds the validator loads, against a read-only dump of mainnet today | Squads `1c95bd7b...`, Token-2022 `0999dbf7...`, Token (p-token) `8190d3f7...`: all three identical to the harness copies |
| `gate-a4.ts`, mock venue | 345 of 345 |
| `venues-a4.ts`, real Orca Whirlpool and Kamino Lend (mainnet state cloned), whole-batch time lock, prime-session today (`be6ade02`) | 53 of 53 |
| `trustee-a4.ts`, a Prime vault as the trustee | 9 of 9 |
| `setup-checks.test.ts` (the fixed `setup-checks.ts` from a4-min) | 43 of 43 |
| SC and SX live sections of the fixed a4-min harness, run against the line-cut gate | 54 of 54 |
| The earlier review's freeze and permanent-delegate probe (`probe2.ts`), against the line-cut gate | 12 of 12 (the two limits behave exactly as on a4) |
| `mutants2.py lc`: 62 mutants, regenerated from source, each identical to the shipped `opt/gate/mut/l*.rs` | 62 of 62 killed |
| Five reviewer mutants on the refactored code (`mut/lr01` to `lr05`) | lr02 killed at T11, lr03 at G4, lr04 at G1; the equivalence probes lr01 and lr05 pass 345 of 345, as expected |
| Host differential test, a4 against line cut, 3 seeds of 1,000,000 random inputs | 0 mismatches |

Code size went down for real: the non-comment text shrinks from 6,185 to 5,534 characters (11 percent). The as-written count leans on long lines in both sources (longest line 183 characters in a4, 199 in the line cut), so an auditor who counts formatted lines will see 241.

## Line-by-line diff

Every changed line keeps its check inside the gate. The table names the check, how the line cut writes it, and the mutant that dies when the check is weakened. Test ids are the a4 harness checks (G create, T transfer, A allow, R release, X close authority, H hand-over, E end time, B boundary second).

| a4 line(s) | Line cut | Who enforces it now | Evidence |
|---|---|---|---|
| 15 to 25: imports, `SQUADS`, `TOKEN` written with `solana_program::pubkey!` over five lines | 16, 21, 22: `pubkey` imported, `TOKEN` on one line | The constants, same 32-byte values | l07 (G12), l22 (A13); the differential runs both programs against the same account owners |
| 41 to 42: `autonomous` from `get(24..56)`, then one `if` returning `Custom(5)` | 38: one `need(...)`, settings read with `read`, which returns `Custom(5)` on short data | The gate, same four conditions | l05 (G4), l06 (G9), l07 (G12), l08 (G11) |
| 45: `bump` as a `u8` | 41: `bump` as a one-byte array | The gate | l11 (G1) |
| 47: rent read into `top` | 45: rent read inside the first system call | The gate | l49 (G1a) |
| 49 to 54: a loop over three hand-built System calls | 44 to 47: a `sys` closure over `cpi`, every account writable and signing | The gate for Allocate and Assign (unchanged metas). For the `Transfer`, the gate account is now also flagged as a signer. The runtime grants that flag because the seeds derive the gate, and the System program reads only the source's signature | lr01 restores the a4 metas and survives the whole mock harness (equivalent); l37 (G1), l50 (G1), l62 (G1), l57 (G1) |
| 64: `if !lane.is_signer \|\| !(agent \|\| owners)` | 57: `need(lane.is_signer && (agent \|\| owners), 1)` | The gate | l13 (T6c), l14 (G20d) |
| 65: destination owner via `get(32..64).ok_or(Custom(5))` | 58: `read(dst, 32..64)` | The gate, same error code | l35 (G20c), lr02 (T11 pins the code) |
| 66 to 67: `from_le_bytes`, then `now > by \|\| by > now + window` | 59 to 60: `le(...)`, then `need(now <= by && by <= now + window, 4)` | The gate | l15 (T5), l16 (T5b), l54 (B2), l55 (G20c) |
| 68: end time and destination list, or the recovery address | 61: the same condition inside `need(..., 2)` | The gate | l17 (E2), l18 (T2), l19 (T13), l20 (T3), l40 (E3), l53 (B1) |
| 69 to 71: metas closure; the owners path signs as the gate with spelled-out seeds | 62 to 63: `call(..., &[src, dst, gate], 2, &gate_seeds(&g))` | The gate builds identical metas; the runtime checks the seeds and the writable flags | l39 (A7d); l58 and l59 (wrong seed offsets) and l56 (one extra writable account) are refused by the runtime's signer, seed and privilege checks at the first `allow` |
| 74: source must be owned by the gate on the agent path | 66: `need(read(src, 32..64)? == gate.key, 5)` | The gate | l21 (T8b) |
| 75: the cap PDA signs | 67: `call(..., &[src, dst, cap], 2, cap seeds)` | The gate | l36 (G20c) |
| 84 to 86: source read, `raise`, then one `if` returning `Custom(1)` | 76 to 77: `read(src, 0..165)`, one `need(...)` with the raise test inline | The gate | l24 (A2), l25 (A5c), l26 (A10), l45 (A2) |
| 87 to 88: `key != cap \|\| tag != 0 && close != gate` | 78: `need(key == cap && (tag == 0 \|\| close == gate), 5)` (the same condition after De Morgan) | The gate | l27 (A9), l28 (X2), l29 (H4e) |
| 89 to 90: `Approve` metas using the derived cap address | 79: `call(..., &[src, cap, gate], 1, ...)` using the passed cap account, which line 78 has just proved equal to the derived address | The gate | l38 (G20c) |
| 99: release threshold `if` | 88: `need(..., 1)` | The gate | l30 (R1), l31 (R5) |
| 100 to 104: `for kind in [3, 2]` with `?` | 89: `[3, 2].iter().try_for_each(...)` | The gate keeps the order; the runtime ends the program at the first failed call | l32 (H4f), l33 and l34 (H4g), l46 (H4f); lr05 runs both calls and returns only the last result, and survives the whole harness: a failed inner call stops the program on chain |
| 107 to 110: `load` | 98 to 101: `need` plus `read` of the whole account | The gate | l23 (A14), l60 (T1c) |
| 115: `votes` owner `if` | 108: `need(TOKEN.contains(ms.owner), 5)` | The gate | l09 (G6), l10 (G14), l47 (R12c), l48 (G9) |
| 121 to 124: `call` | 114 to 117: `call` (allow-list) plus a new `cpi` helper (metas from a writable count and a signer count) | The gate for the allow-list; the runtime for the flags | l22 (A13), l56, l57, lr04 (G1) |
| new: `need`, `le`, `read`, `gate_seeds` | 92 to 103 | The gate | l61 (G1), l55 (G20c), lr02 (T11), lr03 (G4), l58 and l59 |

Nothing moved to another party. The two places where a party outside the gate now carries the weight are both the runtime: it refuses a signer the seeds do not derive and a writable flag the caller lacks (l56, l58, l59 all die there), and it stops the program at the first failed inner call (lr05).

**Error codes:** all a4 codes stay. The one difference in my runs is a create aimed at an address that is not the gate PDA whose System `Transfer` also fails on its own (for example a member short of lamports). There a4 returns the System program's error from the `Transfer`, and the line cut returns the runtime's signer error before the `Transfer` runs. Both refuse and the transaction reverts. With a working `Transfer`, both builds stop at the same signer error (G15).

## Host differential test

`/tmp/linecut-review/diff/` builds both sources as host modules and runs them through `solana_program`'s syscall stubs. The stub records each inner call (program, accounts with their signer and writable flags, data, the addresses the seeds derive), applies the runtime's signer and writable privilege checks, emulates System Allocate, serves Clock and Rent, and can fail the first, second or third inner call. A generator builds create, transfer, allow and release inputs around valid gates, with wrong owners, short account data, wrong lanes, destinations, cap and multisig accounts, boundary times, extreme clocks, duplicate accounts and malformed instruction data.

- **Result:** 3 seeds of 1,000,000 inputs, 0 mismatches. Per seed about 7,200 successful transfers, 13,700 creates, 64,500 `allow` and 55,300 `release` calls. Every successful create differs from a4 only by the `Transfer` signer flag, and no other successful call differs at all.
- **Sensitivity:** the same test, with each mutant of `mutants2.py` swapped in for the line-cut source, flags 61 of the 62 (l41 needs a create shorter than 54 bytes with a length of 22 modulo 32, which my generator does not build; the harness kills it at G16c). Of my own mutants it flags lr02 and lr04, lists lr03 under changed error codes, and passes lr01. It also flags lr05, because the host stub returns a failed inner call to the program; on chain the runtime ends the program there, so lr05 survives the validator run.
- **Known differences it reports:** apart from the signer flag, only the create case under "Error codes" above, 230 to 267 times per seed, all with an injected failure of the `Transfer`.

## Findings

### L1 (Low, present in a4 and the line cut): a classic Token account can pose as custody's multisig

`votes` reads m from byte 0, n from byte 1 and signer slots every 32 bytes from byte 3 of any account a token program owns. A classic Token account fits: byte 0 is the first byte of its mint, and slot 4 (bytes 131 to 163) holds two zero bytes of the close-authority tag followed by the first 30 bytes of the close authority, which the account's owner sets freely. I built one (`probe-fakems.ts`, logs `logs/probe-fakems.gate-lc.log` and `.gate-owned.log`, 8 of 8 on each build):

- FM0: a mint whose address starts with a zero byte (about 256 tries) gives m = 0; a key with two leading zero bytes (about 65,000 tries, seconds in `bun`) fills slot 4 through the close authority.
- FM1: `create` accepts the token account as the multisig and the ground key as its member. Any party can do this, with no custody key involved.
- FM2 and FM3: on that gate, `allow` raises the cap and `release` hands an account to a stranger with no signer at all, because w >= m holds with m = 0.
- FM4 and FM5: `checkGate` refuses the gate against custody's real multisig (`gate-multisig`, `gate-address`), and `parseMultisig` refuses the 165-byte account.

So the setup flow in the guide stops this, and funds reach such a gate only if custody hands an account over without running the checks. The earlier review states "a Token-owned account cannot carry forged slot bytes because only `InitializeMultisig` writes them"; that line needs this correction. The gate's own rule "any one signer of custody's multisig creates the gate" holds only for genuine multisigs.

**Fix at no sLOC cost:** require the multisig's exact length in the existing line of `votes`:

```rust
need(TOKEN.contains(ms.owner) && d.len() == 355, 5)?;
```

Classic Token writes 355-byte accounts only through `InitializeMultisig`, and Token-2022 refuses to treat any 355-byte account as a mint or token account (`check_min_len_and_not_multisig`, and it pads extension layouts away from 355). An uninitialised 355-byte account holds m = 0 and empty slots, and `create`'s `w >= 1` already refuses it. The variant is `/tmp/linecut-review/gate/variants/gate-lc-msfix.rs`: 84 / 241 sLOC, 47,160 bytes, SHA-256 `6d196cab...`. On my validator it refuses the forged multisig with `Custom(5)` and still creates and releases a gate on a real multisig (`probe-fakems.ts` with `EXPECT_REFUSE=1`, 4 of 4), and it passes the whole mock harness (345 of 345). The line-cut gate itself is the mutant that removes the check, and FM1 kills it.

### Earlier findings F1 to F7

| # | Finding | On the line cut |
|---|---|---|
| F1 | A freeze authority stops recovery and release | Holds as before: `probe2` FZ3 and FZ5 refused with token error 0x11 on the line-cut gate; `checkMint` warns |
| F2 | A permanent-delegate mint bypasses the gate | Holds as before: `probe2` PD2 drains the gate-owned account; `checkMint` refuses the mint (SX4) |
| F3 | No gate read-back; any one member sets the fixed fields | Fixed in the app by `checkGate`; SX8 to SX16 pass against line-cut gates (54 of 54). L1 widens "any one member" to "anyone with a forged multisig", and `checkGate` refuses that case too (FM4) |
| F4 | The owner majority's reach; custody cannot stop a recovery | Unchanged: RR7, T1, A7d and RR3b pass in the mock run (345 of 345), and the venue run includes recovery of venue funds |
| F5 | Upgradeable Squads and Token-2022; final gate | Unchanged. The mainnet builds today match the harness copies (hashes above) |
| F6 | Rent locked in gate-owned accounts | Unchanged: the line cut has no close instruction and never calls `CloseAccount` |
| F7 | Seed squatting | Unchanged: G10 passes. With L1, a squatter needs no custody key, and the squat still binds only a gate address that the forged multisig's key derives, so custody's real seed space is untouched |

### `checkGate` and the account layout

The line cut writes the gate account from the same parts in the same order (`create`, line 42): multisig 0, settings 32, agent lane vault 64, owners lane vault 96, recovery 128, until 160, window 168, seed 172, bump 180, destinations from 181. The seeds (`["gate", multisig, settings, seed]` and `["cap", gate]`), the instruction tags, the data layouts and the account orders of all four instructions are unchanged. `parseGate` and `checkGate` use exactly these offsets, and the 32 SX checks pass against gates the line-cut program wrote.

## Cautions for the record

- **Shared disk:** the host disk is at 97 to 98 percent. My first mutant validator stopped when the disk filled (RocksDB "No space left on device"). I reran the two runs it cut short on a fresh ledger. A harness that fails with "Unable to connect" on this host should be read as an infrastructure stop.
- **The line cut's crate directory:** `opt/gate/gate/src/lib.rs` holds the threshold-only option from the last ladder build, so `variants/gate-lc.rs` is the source of the candidate. Whoever deploys should build from `variants/gate-lc.rs` and compare the hash above.

## Recommended actions

1. Adopt the line-cut gate as the production candidate.
2. Before the audit and the `--final` deploy, take the zero-line length check of L1 and rerun the mutation pass (add a mutant that removes it and a probe like FM1 to kill it).
3. Correct the multisig sentence in `reports/gate-owned-review.md` and in section 14 of the setup guide, and keep "run `checkGate` and `checkMultisig` before any hand-over" as a hard step.
4. Update the counts in `ARCHITECTURE.md` 7.4 and `prime-solana.md` (91 lines, 50,464 bytes) to 84 lines, 47,304 bytes, or to 47,160 bytes with the L1 fix.

## Files

- Work copy: `/tmp/linecut-review/gate/` (harness copy, `variants/gate-lc-msfix.rs`, `mut/lr0*.rs`, `probe-fakems.ts`, `probe2.ts`, `gate-a4-fix.ts`, `run-lr.sh`, `bld-r.sh`).
- Differential test: `/tmp/linecut-review/diff/` (`src/main.rs`, `mutdiff.sh`).
- Logs: `/tmp/linecut-review/logs/` (`hashes.txt`, `mock.gate-lc.log`, `venues.gate-lc.log`, `trustee.gate-lc.log`, `sc-sx.gate-lc.log`, `probe2.gate-lc.log`, `probe-fakems.*.log`, `mutants-lc.md`, `mutants-lc.run.log`, `run-lr.log`, `mutdiff.log`, `diff.seed*.log`), per-mutant logs in `gate/logs/mutants-lc/`.
- Mainnet dumps: `/tmp/linecut-review/dump/`.

Status: DONE_WITH_CONCERNS
Summary: The line-cut gate is a pure refactor of the reviewed a4 gate: it rebuilds bit for bit, counts 84 sLOC, passes 345 mock, 53 venue, 9 trustee and 54 setup-check checks and kills 62 of 62 mutants on an own validator, and a 3-million-input differential test finds no behaviour difference; adopt.
Concerns/Blockers: a pre-existing issue in both builds (L1): a classic Token account can pose as custody's multisig with threshold 0, so anyone can raise the cap and release on that gate; the setup checks refuse it, and a zero-line length check in `votes` (tested, 345 of 345) closes it on chain before the `--final` deploy.
