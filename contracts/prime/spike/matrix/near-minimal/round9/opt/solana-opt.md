# Solana programs: line cuts and a Pinocchio port

Date: 2026-10-08. Scope: the two Solana programs of Prime, the custody gate (the a4-min build, `variants/gate-owned.rs`) and prime-session, each in up to three forms: today's source, a line-cut source and a Pinocchio port. I built and ran everything in copies under `/home/ubuntu/work/opt/` (`gate/`, `gate-pino/`, `session/`); `a4-min/`, `prime-session/` and `psn.ts` were read only. Validators ran on ports 9101 and above with one ledger each, the mainnet feature set (`--clone-feature-set` against read-only mainnet RPC), the mainnet Squads Smart Account build and program config, and the mainnet Token-2022 build. The Token program on those validators is the one mainnet runs today (see "Token program" below). Nothing was signed on a public network and nothing was committed.

## Answer

The Pinocchio ports are the large saving: binaries shrink by 27 to 29 percent, which takes 0.20 SOL off the two deploys at the local rate (0.15 SOL at devnet's), the gate's own compute units fall by 14 to 43 percent and prime-session's by 19 percent per move, and 96 linked crates become 5 or 6. The sources are not shorter, because the call and sysvar code is spelled out. The line cuts are small: the gate drops from 91 to 84 lines as written, with no change in behaviour. The target of about 70 lines is out of reach without removing a behaviour from `gate-a4-min.md`, because each remaining check has a mutant that dies.

Every build passes the a4 harness checks and every mutant of the gate dies on both new sources (62 of 62 each). A mutation pass over the Pinocchio session found a test gap that `psn.ts` has for today's program too: six of 22 mutants of the ed25519 instruction checks survive, three of them as attacks that would forge a grant. Section F, added in a copy of the harness, kills four of the six; the other two checks are redundant (see "A gap in `psn.ts`").

| | Gate today | Gate line cut | Gate Pinocchio | Session today | Session Pinocchio |
|---|---|---|---|---|---|
| sLOC as written | 91 | 84 | 86 | 33 | 41 |
| After `rustfmt` | 253 | 241 | 230 | 102 | 143 |
| Binary (bytes) | 50,464 | 47,304 | 36,000 | 54,024 | 39,592 |
| Deploy rent, local validator (SOL) | 0.3536 | 0.3316 | 0.2529 | 0.3784 | 0.2779 |
| Deploy rent, devnet at 5,080 lamports per byte (SOL) | 0.2581 | 0.2420 | 0.1846 | 0.2762 | 0.2028 |
| Crates linked into the program | 96 | 96 | 5 | 96 | 6 |
| Gate units: agent draw / recovery / `allow` / `release` | 5,307 / 3,662 / 8,732 / 5,433 | 5,368 / 3,649 / 8,739 / 5,437 | 3,730 / 2,092 / 6,980 / 3,842 | | |
| Session units: move / revoke (whole transaction) | | | | 53,334 / 22,229 | 49,250 / 18,585 |
| Harnesses | 345 + 53 + 9 | 345 + 53 + 9 | 345 + 53 + 9 | 128 (stub and real NEAR) | 128 (stub and real NEAR), 4 host checks |
| Mutants | 56 of 56 (a4) | 62 of 62 | 62 of 62 | not run | 22: 16 killed by `psn.ts`, 4 more by section F, 2 redundant |

**Recommendation:** ship the Pinocchio gate and the Pinocchio prime-session at the pins in this report if the external auditor takes `pinocchio` 0.9.3 as a reviewed dependency. They save about 0.10 SOL of deploy rent per program, most of the dependency source and a share of the compute units. The library is the one mainnet's Token program runs, with two audits and four program-level reviews behind it. If the auditor declines the library, ship the line-cut gate (84 lines, 3.2 KB smaller, same behaviour as a4) with today's session. Before either, merge section F into `psn.ts`: it guards four checks that the current harness lets someone remove unnoticed. Skip the alloc-free variants and the build-profile changes: each saves 3 to 4 KB at best and adds lines.


## Method

- **Harnesses:** the a4-min harnesses run against every build of the gate with their checks unchanged: `gate-a4.ts` (345 checks, mock venue), `venues-a4.ts` (53 checks, real Orca Whirlpool and Kamino Lend with mainnet state cloned read-only, whole-batch time lock, prime-session in the path) and `trustee-a4.ts` (9 checks). `lib.ts` gained three things: the validator port, an optional deterministic mode (`GATE_DET`, keys and seeds from a counter) and a recorded failure when a setup step fails. The session runs the unchanged `psn.ts` (SHA-256 `b1c4148c`, same as the original) and a copy `psn.det.ts` with session keys from a counter and a per-move "own compute units" figure.
- **Paired compute units:** a bump search costs about 1,500 units per extra step and the bumps depend on the addresses, so two random runs differ by more than the builds do. The deterministic runs give every build the same keys, seeds, program id and settings account, so identical transactions run at identical addresses and the difference is the program.
- **Token program:** the validator with the cloned feature set installs the same Token program mainnet runs. `solana program dump` of `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` from a local validator and from mainnet-beta both give 108,600 bytes with SHA-256 `8190d3f7ceb6cb7a7a8d8924...`, and the file holds the source path `pinocchio/program/src/processor/mod.rs`. Mainnet replaced SPL Token with p-token (SIMD-0266) at epoch 971 on 2026-05-13, so every earlier a4 figure was already a p-token figure.
- **Line counts:** sLOC counts non-blank, non-comment lines with the counter of the earlier Solana reports (`sloc.py`), as written and after `rustfmt --edition 2021`. Deploy rent is the program-data account plus the program account.
- **Builds:** `cargo-build-sbf` 4.3.0 (platform-tools 1.57, rustc 1.95), `overflow-checks = true` kept in every profile, `Cargo.lock` kept next to each crate. Rebuilding the a4 gate reproduces its `so/gate-owned.so` bit for bit (SHA-256 `f2157f86...`), and rebuilding today's prime-session gives the published `be6ade02...`.

## Gate line cuts

**Result:** 84 lines as written and 241 after `rustfmt`, from 91 and 253, and 47,304 bytes from 50,464, which is 14 lines above the target of about 70. Every behaviour in `gate-a4-min.md` stays, and each remaining check has a mutant that dies (see Verification), so going lower means giving up a behaviour. Lines by function, as written / formatted:

| Part | Today | Line cut |
|---|---|---|
| Imports and constants | 10 / 18 | 7 / 19 |
| Dispatch (`process`) | 9 / 17 | 9 / 17 |
| `create` | 19 / 67 | 15 / 59 |
| `transfer` | 16 / 61 | 15 / 36 |
| `allow` | 12 / 33 | 9 / 25 |
| `release` | 11 / 24 | 7 / 18 |
| Helpers (`need`, `le`, `read`, `load`, `gate_seeds`, `votes`, `call`, `cpi`) | 14 / 33 | 22 / 67 |
| Total | 91 / 253 | 84 / 241 |

The helpers grow because each one costs its own lines; the handlers shrink by more. Every step below is a refactor. Each rung compiles, the harness ran on the first and the last source, and the mutation pass exercises every changed line of the last.

### The cuts, in the order I made them

| Step | Change | sLOC | Formatted | Bytes | Why it stays safe |
|---|---|---|---|---|---|
| 0 | a4 gate-owned | 91 | 253 | 50,464 | |
| 1 | One `cpi` helper builds the account metas from a writable count and a signer count; the three system calls of `create` and every token call use it | 86 (-5) | 259 (+6) | 48,168 (-2,296) | The metas match the old ones. One difference: the gate account is also flagged as a signer on the System `Transfer`. The PDA signs through the seeds and the System program ignores the flag on the destination |
| 2 | `need(cond, code)` replaces eleven `if ... { return Err(..) }` | 87 (+1) | 257 (-2) | 48,552 (+384) | Each condition is negated once and each one has a mutant that dies (table in Verification) |
| 3 | `le`, `read` and `gate_seeds` replace repeated byte-slice code | 89 (+2) | 242 (-15) | 48,416 (-136) | Same ranges. Short account data still returns `Custom(5)` (T11 pins the destination case) |
| 4 | The autonomy test joins the create condition; `pubkey!` imports; `try_for_each`; the signer seeds as one array; instruction data passed by value | 84 (-5) | 241 (-1) | 47,304 (-1,112) | No logic change. Building the seeds with `concat()` cost 520 bytes and a second copy of the data cost 1,344 |

Totals: -7 lines as written, -12 formatted, -3,160 bytes.

### Checks I looked at for removal

A check can go only where another party enforces it and a test shows that. For every check below I built a mutant that removes it and ran the whole harness: each mutant dies, so each check holds a property of its own.

| Check | Could anything else stop it? | Evidence the check is needed |
|---|---|---|
| Lane account signed (`transfer`) | The token program checks the authority, but the authority is the gate PDA, which the gate signs for itself | Mutant 13 dies at T6c |
| Source owned by the gate on the agent path | A source owned by the cap PDA is an owner-path draw with no limit for the token program | Mutant 21 dies at T8b |
| Settings owned by Squads | A zero-filled account of another program passes the autonomy test and names lanes no vault can sign | Mutant 07 dies at G12 |
| Settings without an authority | None | Mutant 08 dies at G11 |
| Multisig owned by a token program | None at creation; `allow` and `release` rely on the stored address | Mutant 09 dies at G6 |
| `m <= n` | The token program accepts m above n (M5) | Mutant 06 dies at G9 |
| Whole 32-byte destination entries | `chunks_exact` skips a stray tail, so a bad tail is harmless; the guard gives a clean error | Mutant 04 dies at G16b |
| Instruction length guards | A short slice panics with another error | Mutants 41 to 44 die at G16c to G16f |
| Close authority is the gate or unset (`allow`) | None | Mutant 28 dies at X2 |
| Cap PDA address (`allow`) | The runtime checks signers only | Mutant 27 dies at A9 |

Two checks that a4 already removed hold up on all three builds: the cap PDA comparison in `transfer` (the runtime refuses a signer the seeds do not derive, T7 and T7b) and the gate address check in `create` (G15).

### Options I measured and did not adopt

Each one changes behaviour or adds bespoke code, so each needs a decision. The builds are sized only; the harness runs on one after the decision.

| Option | Change | sLOC | Formatted | Bytes |
|---|---|---|---|---|
| Threshold-only cap | `allow` asks m signers for a lowering too (the a4 "thr" rule) | 84 | 238 | 47,296 |
| Client-funded rent | `create` drops the System `Transfer` and the rent read; the transaction adds a transfer, and the runtime's rent check stops an unfunded account | 83 | 235 | 42,904 |
| Alloc-free Pinocchio gate | no `Vec`: fixed arrays, `no_std`, `no_allocator!` | 96 | 262 | 32,032 |
| Alloc-free Pinocchio session | the same for prime-session | 54 | 166 | 36,704 |
| Build profile | `lto = "fat"`: 49,128 on the first line cut (-40); `opt-level = "s"`: +5,424; `"z"`: +2,240 | | | |

Client-funded rent saves 4.4 KB, about 0.03 SOL once, and moves the funding out of the program into the app's transaction. The alloc-free forms save 3 to 4 KB and add lines and hand-written helpers.


## Pinocchio ports

**What changed:** both programs use `pinocchio` 0.9.3 in place of `solana-program`. Instruction data, account lists, PDAs and error codes match the solana-program builds, and the harness checks are unchanged. The gate port starts from the line-cut source, so its differences from that source are the library calls. The gate depends on `pinocchio =0.9.3` and `pinocchio-pubkey =0.3.0` (the `pubkey!` macro); the session adds `five8 =0.2.1` for base58, the same crate version today's build already pulls in through `solana-pubkey`. I did not use `pinocchio-system` or `pinocchio-token`: the token helpers address only the original Token program, and the System calls fit the shared `cpi` helper with the bytes the solana-program builds send.

| Area | solana-program | Pinocchio 0.9.3 | What I did |
|---|---|---|---|
| Account parsing | copies each account into a reference-counted struct | zero-copy views over the input buffer, up to 254 accounts | nothing: a transaction names far fewer accounts |
| Cross-program calls | `invoke_signed` with any number of accounts | `slice_invoke_signed`: at most 64 accounts, borrow state checked per account | the gate calls with 2 or 3 accounts; the session passes the Squads call's accounts through, so an inner call that names more than 64 accounts is refused with `InvalidArgument`. A legacy transaction holds about 35 accounts, so only a version 0 transaction with lookup tables reaches 64 |
| Instructions sysvar | `load_instruction_at_checked` copies the whole instruction | `Instructions` reads fields in place | checked against the reference crate (below); an index past the last instruction maps to `InvalidArgument`, as before |
| PDA creation error | `PubkeyError::InvalidSeeds` becomes `ProgramError::InvalidSeeds` | the syscall result converts to `Custom(1)` | explicit `map_err` to `InvalidSeeds` |
| Short session data | slicing panics | slicing panics | an explicit `InvalidInstructionData` before any slicing; V9 and V9b still refuse, now with a clean code |
| Rent | `Rent::minimum_balance` | same formula, integer arms for the 2.0 threshold and for SIMD-0194 | nothing |
| Overflow checks | on | on | `overflow-checks = true` kept in both profiles |

### The instructions sysvar parser

prime-session reads the ed25519 instruction from the Instructions sysvar. Three checks cover the parser:

1. **Docs:** Solana documents the sysvar as a `u16` instruction count, a `u16` offset table, then per instruction a `u16` account count, 33-byte account entries (a flag byte, then the key), a 32-byte program id, a `u16` data length and the data, with the current index in the last two bytes ([instruction introspection](https://solana.com/docs/core/instructions/instruction-introspection)); the flag byte holds the signer bit at 0 and the writable bit at 1 ([solana-instructions-sysvar source](https://docs.rs/solana-instructions-sysvar/latest/solana_instructions_sysvar/)). The ed25519 precompile instruction starts with a signature count and a padding byte, followed by seven `u16` fields (signature offset and instruction index, key offset and index, message offset, size and index), and an index of `u16::MAX` means the current instruction ([precompiled programs](https://solana.com/docs/core/programs/precompiles)). Pinocchio's reader and prime-session's field reads (count at 0, indexes at 4, 8 and 14, key offset at 6, message offset and size at 10 and 12) follow that layout.
2. **Reference crate:** `session/sysvar-check` (4 tests, all pass) serialises 300 generated instruction sets with `solana-instructions-sysvar` 2.2.2, the crate behind `solana_program::sysvar::instructions`, and compares every instruction's program id, data and account metas with Pinocchio's `Instructions`. It also checks the sysvar id (`Sysvar1nstructions1111111111111111111111111`), the ed25519 field offsets on a precompile instruction built in the documented layout, and `five8::encode_32` against `Pubkey`'s `Display` for 20,005 keys (including all-zero, all-255 and leading-zero keys).
3. **On chain:** `psn.ts` passes 128 of 128 on the Pinocchio build against the real ed25519 precompile, covering wrong-owner, wrong-text, wrong-key and revoke cases. The default run never places the signature instruction second, which a wallet that prepends a compute-budget instruction does; section F below covers that.

### A gap in `psn.ts`

I ran 22 single-check mutants of the Pinocchio session against the unchanged `psn.ts` (table in Verification). Six live. The checks they weaken are the same in today's program, so the gap belongs to the harness, and a deployed program is exposed to none of it. Three mutants stand for attacks that succeed once the check is gone, and a fourth for a case the default run never sends:

- **Mutant 01, program id of the signature instruction:** a transaction carries an instruction from some other program, laid out like an ed25519 instruction, with the owner's key, any signature bytes and the exact grant text. No precompile verifies it, so a program that skipped the id check would accept a grant the owner never signed.
- **Mutant 04, key index:** the attacker signs the owner's grant text with its own key, puts the owner's key in the instruction's data and points the key index at a second ed25519 instruction that holds the attacker's key. The precompile verifies the attacker's key; the program reads the owner's.
- **Mutant 05, message index:** the owner's real signature over one grant text is replayed with the message index pointing at the genuine instruction, while the instruction's own data holds a different text of the same length. The precompile verifies the old text; the program reads the new one. Anyone who has seen a grant on chain could stretch its time or name another session key.
- **Mutant 15, signature instruction fixed at index 0:** the default run never places the signature instruction second, which a wallet that prepends a compute-budget instruction does. Only `PSN_NATIVE` runs one (revoke NS5).

Two are redundant. Mutant 02 (any signature count): the precompile verifies every entry, and with a count of 0 it accepts only a two-byte instruction, which the program then cannot read (`agave-precompiles` 4.2.2, `ed25519.rs`, lines 19 to 30). Mutant 03 (signature index): the signature must verify against the key and message the program itself reads, wherever its bytes live.

Section F in `session/psn.x.ts` (a copy; `psn.ts` is unchanged) adds five checks: F0 is a control that sends the genuine instruction in second place with `sig_ix` 1, F1 (key index), F2 (message index) and F4 (another program) send the attacks above, and F3 sends the signature-index case, which the precompile stops anyway. Today's build and the Pinocchio build both pass `psn.x.ts` with 133 of 133. Mutants 01, 04, 05 and 15 die at F4, F1, F2 and F0: in 01, 04 and 05 the attack transaction succeeds, and in 15 the control is refused. Mutants 02 and 03 survive, as expected. Fixing `psn.ts` itself is its owner's call; the section can move across as it stands.



## Verification

All runs used the mainnet feature set, the mainnet Squads and Token-2022 builds and the Token program mainnet runs. Logs are under `gate/logs/` and `session/logs/` (paths in Files).

### Gate

| Check | Today | Line cut | Pinocchio |
|---|---|---|---|
| `gate-a4.ts`, mock venue, deterministic run | 345 of 345 | 345 of 345 | 345 of 345 |
| `venues-a4.ts`, real Orca and Kamino, with prime-session today | 53 of 53 | 53 of 53 | 53 of 53 |
| `venues-a4.ts`, with the Pinocchio prime-session | not run | 53 of 53 | 53 of 53 |
| `trustee-a4.ts`, a Prime vault as the trustee | 9 of 9 | 9 of 9 | 9 of 9 |
| Gate mutants killed (`mutants2.py`) | 56 of 56 (a4 report, `mutants.py`) | 62 of 62 | 62 of 62 |

The venue runs cover the real Orca swap, Kamino deposit and redeem, the whole-batch time lock on Orca, recovery of venue funds and the swap through prime-session with a lookup table, in every gate and session pairing I built.

**Mutation pass:** `mutants2.py` holds one table of 62 single-check weakenings. 54 are the a4 mutants translated to the new source and 8 are new, aimed at the code the line cuts added (`le`, `cpi`, `gate_seeds`, `load`, `need`). The same table builds against the line-cut source and, through an accessor translation (`.key` becomes `.key()`), against the Pinocchio source, and each source is run against the whole mock harness with the run stopped at the first failing check. Every mutant dies on both sources, and on the same check:

| Group | Mutants | Killed by |
|---|---|---|
| Dispatch guards: lane indexes, whole entries, the four length guards | 01 to 04, 41 to 44 | G13, G13b, G13c, G16b to G16f |
| `create`: signer slot, m above n, Squads owner, autonomy, seed in the address, stored lanes, Allocate, Assign, rent top-up, fixed lane indexes | 05 to 08, 11, 12, 37, 49 to 52 | G4, G9, G12, G11, G1, G2, G1a, G20b |
| `transfer`: lane signature and match, not-after window, end time, listed destinations, recovery, source owner, owners path, boundary seconds | 13 to 21, 35, 36, 39, 40, 53, 54 | T6c, G20d, T5, T5b, E2, T2, T13, T3, T8b, G20c, A7d, E3, B1, B2 |
| `call` and `load`: token-program allow-list, gate account owner | 22, 23 | A13, A14 |
| `allow`: raise rule, equal cap, current-cap offset, multisig binding, cap PDA, close authority, delegate account | 24 to 29, 38, 45 | A2, A5c, A10, A9, X2, H4e, G20c |
| `release`: threshold, multisig binding, order, owner only, close authority only, close authority cleared | 30 to 34, 46 | R1, R5, H4f, H4g |
| `votes`: token-program owner, signer flag, slot range, m and n | 09, 10, 47, 48 | G6, G14, R12c, G9 |
| New code: `le` endianness, `cpi` writable and signer flags, `gate_seeds` offsets, `load` length, `need`, system-call signers | 55 to 62 | G20c, G1, T1c and the first setup step |

**A harness change the pass needed:** three mutants (56, 58, 59) broke `allow`, which made the first setup step of section G20 throw, and the run ended without a recorded failure. `must()` in `lib.ts` now records the failing step before it throws, and the three mutants are killed by that setup step on both sources. The same check count (345) and results hold on every build.

### prime-session

| Check | Today | Pinocchio |
|---|---|---|
| `psn.ts`, stub NEAR, mainnet features | 128 of 128 | 128 of 128 |
| `psn.ts`, real NEAR under `near.lock` | 128 of 128 | 128 of 128 (final build; an earlier build of it also 128 of 128) |
| `sysvar-check`: Pinocchio parser against `solana-instructions-sysvar`, ed25519 layout, base58 against `Pubkey` | not applicable | 4 of 4 |
| `psn.x.ts`: `psn.ts` plus section F (5 checks on the signature instruction) | 133 of 133 | 133 of 133 |
| Session mutants killed by `psn.ts` | not run | 16 of 22 |
| Session mutants killed by `psn.x.ts` | not run | 20 of 22; the other two (02 and 03) are redundant checks |

**Session mutation pass:** `session/mutants.py` holds 22 single-check weakenings of the Pinocchio source, one validator per mutant (the harness fixes the program id), the unchanged `psn.ts` as the first column and `psn.x.ts` as the second for the survivors that stand for attacks.

| Mutant | Weakened check | `psn.ts` (128 checks) | `psn.x.ts` |
|---|---|---|---|
| 01 | the ed25519 instruction need not be the ed25519 program | survives | dies at F4 |
| 02 | the ed25519 instruction may carry any signature count | survives | survives: redundant check |
| 03 | the signature may live in another instruction (index not 0xffff) | survives | survives: redundant check |
| 04 | the public key may live in another instruction | survives | dies at F1 |
| 05 | the message may live in another instruction | survives | dies at F2 |
| 06 | the signing key need not be the owner | dies at X1, X2, X3 |  |
| 07 | the signed message need not be the grant text | dies at G-MetaMask7, G-MetaMask8, G-Freighter7 |  |
| 08 | the session PDA need not derive from the owner and settings | dies at X8, X9a, V4b |  |
| 09 | a revoked session still works (marker owner not checked) | dies at V2, V3b, V5b |  |
| 10 | the marker may be any address | dies at V8a |  |
| 11 | an expired grant works | dies at G10 |  |
| 12 | a grant may last longer than 7 days | dies at G9 |  |
| 13 | the session key need not sign a move | dies at X10 |  |
| 14 | the PDA does not sign the inner call | dies at G-MetaMask1 |  |
| 15 | the signature instruction is always instruction 0 | survives | dies at F0 |
| 16 | a revoke does not assign the marker to the program | dies at V1b, V2, V3b |  |
| 17 | a revoke funds the marker below the rent minimum | dies at V1 |  |
| 18 | the inner call goes to the System program | dies at G-MetaMask1 |  |
| 19 | the inner call signs with another seed | dies at G-MetaMask1 |  |
| 20 | every inner account is writable | dies at G-MetaMask1 |  |
| 21 | a revoke is taken for a move (revoke branch skipped) | dies at V1 |  |
| 22 | the grant text omits the session key | dies at G-MetaMask1 |  |

Mutants 01 and 02 first showed as killed at G10 (expired grant) in a run under a load average above 90: the validator clock lagged and the expiry check failed by itself. A rerun on a quiet machine shows both survive, and the table lists the rerun. Every other kill names a check that tests the weakened condition.



## Costs

### Compute units, paired

Deterministic runs on identical addresses (see Method), mainnet feature set, Token program as on mainnet. Each cell is the transaction total / the gate's own invocation (it includes the token calls the gate makes) / transaction bytes. A cell is the median of the samples the harness took (one or two per row), so differences under about 100 units are noise.

| Gate move | Today | Line cut | Pinocchio | Gate units, Pinocchio against today |
|---|---|---|---|---|
| `create`, 2 destinations | 12,171 / 12,171 / 517 | 12,111 / 12,111 / 517 | 10,500 / 10,500 / 517 | -14% |
| `allow`, threshold sets the cap (2 signers) | 8,732 / 8,732 / 537 | 8,739 / 8,739 / 537 | 6,980 / 6,980 / 537 | -20% |
| `allow`, one signer lowers the cap | 8,409 / 8,409 / 440 | 8,416 / 8,416 / 440 | 6,876 / 6,876 / 440 | -18% |
| `release`, 2 signers | 5,433 / 5,433 / 528 | 5,437 / 5,437 / 528 | 3,842 / 3,842 / 528 | -29% |
| `release`, 11 signers (version 0, lookup table) | 7,985 / 0 / 1,217 | 7,989 / 0 / 1,217 | 4,395 / 0 / 1,217 | -45% (whole transaction) |
| Transfer, agent draw through a rule | 38,726 / 5,307 / 583 | 38,787 / 5,368 / 583 | 37,149 / 3,730 / 583 | -30% |
| Transfer, agent batch (draw and venue payback) | 47,130 / 5,307 / 666 | 47,191 / 5,368 / 666 | 45,553 / 3,730 / 666 | -30% |
| Transfer, recovery by the owners | 29,121 / 3,662 / 671 | 29,108 / 3,649 / 671 | 27,551 / 2,092 / 671 | -43% |
| Transfer, stored batch runs | 83,536 / 5,307 / 711 | 83,597 / 5,368 / 711 | 81,959 / 3,730 / 711 | -30% |
| Transfer, Token-2022 agent draw | 35,319 / 9,860 / 671 | 35,380 / 9,921 / 671 | 33,744 / 8,285 / 671 | -16% |

The line cut keeps the units where they were (within 70). The Pinocchio port removes 1,500 to 1,750 units from each gate call and none from the Squads calls around it, so a transaction total falls by the same amount. The agent draw includes a PDA search for the cap PDA (about 1,500 units per step), which no library choice changes.

Real venues (unpaired, the bump search moves each run by up to 3,000 units): Orca swap through the rule 83,310 today and 83,219 on the Pinocchio gate; Kamino deposit 119,611 and 119,536; recovery of venue funds 29,240 and 27,701; the swap through prime-session and the gate (version 0 with a lookup table) 107,457 and 100,722.

| prime-session | Today | Pinocchio | Change |
|---|---|---|---|
| Move: whole transaction, median of ten sessions | 53,334 | 49,250 | -4,084 (-7.7%) |
| Move: prime-session's own units (total minus the Squads call and its children) | 21,663 | 17,579 | -4,084 (-18.9%) |
| Revoke: whole transaction (the program runs alone with two System calls) | 22,229 | 18,585 | -3,644 (-16.4%) |
| Transaction bytes (move / revoke) | 975 / 726 | 975 / 726 | 0 |

A grant has no transaction of its own: the owner signs the text off chain and every move re-checks it, so the grant check sits inside the move figure. The ten move samples use the same session keys in both builds; the three higher samples in each build are keys whose marker address needed extra bump steps (1,500 units each).

### Deploy rent

Measured by deploying each file with `solana program deploy` on a validator with the mainnet feature set and default rent (6,960 lamports per byte), and computed at devnet's 5,080 lamports per byte, the rate the devnet run of this round measured (`reports/solana-devnet.md`): rent is `(bytes + 337) x rate` for the program-data and program accounts together. The payer's cost on the local validator adds 270,000 lamports of fees.

| Build | Bytes | Local rent (SOL) | Devnet rent (SOL) |
|---|---|---|---|
| Gate today | 50,464 | 0.3536 | 0.2581 |
| Gate line cut | 47,304 | 0.3316 | 0.2420 |
| Gate Pinocchio | 36,000 | 0.2529 | 0.1846 |
| prime-session today | 54,024 | 0.3784 | 0.2762 |
| prime-session Pinocchio | 39,592 | 0.2779 | 0.2028 |
| Both programs today | 104,488 | 0.7319 | 0.5342 |
| Both programs Pinocchio | 75,592 | 0.5308 | 0.3874 |


## Audit scope: what adding Pinocchio changes

**Summary:** the programs link five or six small crates in place of 96, and those crates carry two library audits and the production exposure of the mainnet Token program. The cost is a library with heavy use of `unsafe`, which Zellic flagged, so the pin stays exact and the external audit names the library in scope.

| Item | Today (solana-program 2.3) | Pinocchio ports |
|---|---|---|
| Crates compiled into the program | 96 (gate) and 96 (session) | 5 (gate: `pinocchio`, `pinocchio-pubkey`, `five8_const`, `five8_core`, `sha2-const-stable`), 6 (session adds `five8`) |
| Source lines the build compiles (non-comment lines of the files in the dependency-info of a clean build) | about 130,000 in 472 files | about 4,000 in 25 files (gate), about 5,300 in 29 files (session); `pinocchio` itself is 3,786 lines |
| Our own source an auditor reads | 91 and 33 lines | 86 and 41 lines |
| `unsafe` in the dependency | across the tree | concentrated in `pinocchio`: entrypoint deserialisation, `AccountInfo` borrow tracking, CPI marshalling, sysvar reads |
| Pin | `solana-program = "2.2"` (locks 2.3.0) | `pinocchio =0.9.3`, `pinocchio-pubkey =0.3.0`, `five8 =0.2.1`, `Cargo.lock` kept |

**Facts about the library, each with its source:**

| Fact | Source |
|---|---|
| Pinocchio is Anza's library for programs with no external dependencies. Releases: 0.9.3 on 2026-03-13, 0.10.0 on 2026-01-05, 0.11.0 on 2026-04-08 and 0.11.2 on 2026-06-09 (0.10 and 0.11 renamed the account and address types) | [anza-xyz/pinocchio](https://github.com/anza-xyz/pinocchio), release tags and `git log` |
| Neodyme audited Pinocchio and p-token between 2025-04-23 and 2025-06-12: no findings at any severity, Pinocchio at revision `837535f` | [Neodyme report](https://github.com/anza-xyz/security-audits/blob/master/spl/NeodymePTokenPinocchioAudit-2025-06-12.pdf) |
| Zellic audited Pinocchio and p-token (report 2025-06-30, Pinocchio revision `887a115`): one critical, three high, one medium, three low and one informational item, mostly undefined behaviour and unsound `unsafe` helpers. Zellic wrote that the project was not yet ready for production at that revision and that a commit judged safe is a weak assurance for a library of this kind. Each item was acknowledged with a fix | [Zellic report](https://github.com/anza-xyz/security-audits/blob/master/spl/ZellicPTokenPinocchioAudit-2025-06-30.pdf) |
| Both audited revisions are ancestors of 0.9.3, and fix commits whose titles match the findings were merged between 2025-06-12 and 2025-07-10 (for example pull requests 179, 180, 182 and 186), before 0.9.0 (2025-07-24). Two later changes touch code the gate and session use: the entrypoint rewrite (#176) and the duplicated-account parsing fix (#209) | `git log` and `git merge-base --is-ancestor` on the Pinocchio repository |
| Anza lists both reports under "Pinocchio" and four more under "P-Token": Zellic patch reviews on 2025-10-13 (no issues) and 2026-03-26 (an out-of-bounds fix with no security impact), Runtime Verification equivalence proofs on 2026-01-26 and Certora formal verification on 2026-05-11 (no finding from critical to low; the informational items include a delegate that can revoke itself, which SPL Token refuses) | [anza-xyz/security-audits](https://github.com/anza-xyz/security-audits) |
| p-token v1.0.0 (2026-03-13) pins `pinocchio = "0.9.3"` and `pinocchio-pubkey = "0.3"`, the pins in these ports | [solana-program/token, tag p-token@v1.0.0](https://github.com/solana-program/token/tree/p-token@v1.0.0) |
| SIMD-0266 replaced the SPL Token program with p-token on mainnet at epoch 971 (2026-05-13). The mainnet program at `Tokenkeg...` is an upgradeable program whose ELF holds Pinocchio source paths, and the gate calls it on every move | [Anza announcement](https://x.com/anza_xyz/status/2054549276546470100), [Anza blog](https://www.anza.xyz/blog/febo-on-pinocchio-p-token-and-pushing-solanas-limits), and the dump in `gate/token-mainnet/token.so` |

**What this means for the external audit:**

- **Scope:** ask the auditor to treat the three crates as a reviewed dependency at the exact pin and to cover the surface our code calls: the entrypoint deserialiser, `AccountInfo` borrow tracking, `slice_invoke_signed`, `find_program_address` and `create_program_address`, `Clock`, `Rent` and `Instructions`. The Pinocchio surface adds about 4,000 to 5,300 lines of library code to read; the solana-program build links about 130,000 lines.
- **Evidence we hold:** a mutation pass that kills every mutant of the gate port (62 of 62), a session mutation pass, paired compute-unit runs, and the cross-check of the sysvar parser against the reference crate.
- **Risks that stay:** the audited revisions are from May and June 2025 and the 0.9.3 code contains later commits that only the p-token reviews exercise; the pin sits two minor versions behind 0.11.2, so a later upgrade is a mechanical port (account and address type names) that needs its own review; the 64-account call limit changes one behaviour of prime-session (table above).


## Open items

- **Devnet:** deploy both Pinocchio builds (about 0.39 SOL at devnet's rate) and run `psn.ts` with `PSN_NET=devnet`; every run in this report is local.
- **Inner calls above 64 accounts:** the session refuses them with `InvalidArgument`. We still need to run one on a validator to confirm the code; the venue runs use far fewer accounts.
- **Section F in `psn.ts`:** its owner decides; the section is in `session/psn.x.ts`.
- **External audit:** scope the three crates at the pins above and the two final sources, with the mutation tables as evidence.
- **Fordefi policy-engine run** of the hand-over, `allow` and `release` is still open from the a4 report.
- **Docs:** `ARCHITECTURE.md` 7.4 and `prime-solana.md` quote 91 and 33 lines and 50,464 and 54,024 bytes; they change only if the Pinocchio builds are adopted.


## Files

- **Sources:** `/home/ubuntu/work/opt/gate/variants/` (`gate-owned.rs` today, `gate-lc.rs` line cut, `gate-pino.rs` Pinocchio, `gate-pino-lean.rs` alloc-free experiment), `gate/ladder/` (the rungs and the options), `session/today/src/lib.rs`, `session/pino/src/lib.rs`, `session/pino-lean/src/lib.rs`. Crates: `gate/gate/` (solana-program), `gate-pino/`, `session/today/`, `session/pino/`, each with its `Cargo.lock`.
- **Binaries:** `gate/so/` (`gate-lc.so`, `gate-pino.so`), `gate/old/gate-owned.a4.so`, `session/so/` (`today-localnet.so`, `pino-localnet.so`, built with `PRIME_CLUSTER=localnet`). SHA-256 prefixes: gate today `f2157f86`, line cut `00d6a5c4`, Pinocchio `feaa1127`; session today `be6ade02`, Pinocchio `bcb53c15`.
- **Harness:** `gate/lib.ts`, `gate-a4.ts`, `venues-a4.ts`, `trustee-a4.ts` (ports 9101 and above, `GATE_DET`), `gate/run-validator.sh`, `run-det.sh`, `run-venues.sh`, `run-final.sh`, `compare.py`; `session/psn.ts` (unchanged copy), `psn.det.ts` (counter keys, own units), `psn.x.ts` (section F), `run-psn.sh`, `run-x.sh`.
- **Mutation:** `gate/mutants2.py` (62 mutants, flavours `lc` and `pino`), `session/mutants.py` (22 mutants); tables and logs in `gate/logs/mutants-*.md`, `gate/logs/mutants-*.run.log`, `session/logs/mutants*.md`.
- **Host check, no-op program and rent:** `session/sysvar-check/` (`cargo test --offline`), `session/noop/` (the "other program" of F4), `session/make-table.py`, `deploy-rent.sh` and `deploy-rent.out`.
- **Logs:** `gate/logs/` (`det.*.log`, `final/`), `session/logs/` (`psn.*.log`, state files).
- **Token program dump:** `gate/token-mainnet/token.so`.
- My validators are stopped by PID and their ledgers deleted. `a4-min/`, `prime-session/` and the original `psn.ts` are unchanged.

Status: DONE_WITH_CONCERNS
Summary: The Pinocchio ports cut binaries by 29 percent (gate, 36,000 bytes) and 27 percent (session, 39,592 bytes) and the gate's own units by 14 to 43 percent, with every harness check and all 62 gate mutants passing on both new gate sources; the line cut ends at 84 lines (91 before) and 3.2 KB less, 14 lines above the 70-line target.
Concerns/Blockers: the Pinocchio session is 8 lines longer than today's; Pinocchio 0.9.3 needs the auditor's acceptance at an exact pin; a mutation pass found a test gap in `psn.ts` (section F fixes it in a copy); the new builds still need a devnet deploy.

