# Independent security review: the gate-owned Solana custody gate

Date: 2026-10-08. An adversarial review of the gate-owned custody gate for Prime on Solana, before Prime adopts it. The build under review is `variants/gate-owned.rs` (and its threshold-only sibling `variants/gate-owned-thr.rs`) in `/home/ubuntu/work/gate-spike/a4-min/`, the shape Tuan chose in the "Gate-owned custody on Solana" decision. The source of truth for the design is `DECISIONS.md` and `CONTEXT.md`; the build and its own tests are in `reports/gate-a4-min.md`; the setup and recovery guide is `docs/prime-solana-setup-and-recovery.md`.

I worked from a copy under `/tmp/gate-owned-review/`, on my own `solana-test-validator` at port 9091 with its own ledger, the mainnet feature set (`--clone-feature-set`, read-only mainnet RPC), the mainnet Squads Smart Account and Token-2022 builds. I killed only my own validator by its PID, and deleted only artifacts I can rebuild. Nothing was signed on a public network, no NEAR key was used, nothing was committed. I did not re-run the real Orca and Kamino venue suite; for the two Token-2022 questions that suite does not cover (a freeze authority and a permanent delegate) I wrote my own probes and ran them against the gate.

## Verdict

**Adopt with fixes.**

The gate is small, the enforcement rests correctly on the token program for the cap and on Squads for the agent rules, and every property the brief asks about holds on chain. I reproduced the build, the sizes, the mock harness and a mutation pass from scratch, and I found no way for custody alone, the trustee alone, the owners alone, the agent, the relayer or a stranger to move funds off the fixed paths. The fixes before adoption are about the assets the gate is allowed to hold and the checks the app runs; the gate's own logic holds:

1. Read the mint at setup and refuse or warn on a freeze authority, a permanent delegate, a transfer fee and a transfer hook. Today the app reads the token account alone, so a permanent-delegate mint passes and a freezable mint passes (F1, F2).
2. State plainly, in the report and the guide, that recovery is reliable only for a mint whose issuer cannot freeze the account, and name the assets this rules in and out. USDC and USDT can both be frozen by their issuers, which stops recovery and release alike (F1).
3. Add a gate read-back to `setup-checks.ts` so the hand-over and the owners' confirmation compare the gate's stored recovery address, destinations, lanes, multisig and settings against what each party intends (F3).

## What I reproduced

| Claim | Result |
|---|---|
| Rebuild of `gate-owned.rs` from source, own target directory | byte-identical to the shipped binary: sha256 `f2157f8623e67ae8...601958`, 50,464 bytes |
| Rebuild of `gate-owned-thr.rs` | byte-identical: sha256 `f2f5bd3985ac8fa0...1727c9`, 50,408 bytes |
| sLOC, as written / after `rustfmt --edition 2021` | 91 / 253 (primary), 90 / 251 (threshold-only), matching `gate-a4-min.md` |
| Mock harness, primary build, my validator at 9091 | 345 of 345 |
| Mock harness, threshold-only build | 348 of 348 |
| `setup-checks.ts` unit tests (`bun test`) | 19 of 19 |
| Mutation pass: 14 of the author's security-critical mutants, regenerated from source | each identical to the shipped mutant source, all 14 killed |
| Mutation pass: 7 of my own mutants | all 7 killed, no survivors |
| Validator feature set | solana-cli 4.3.0, SIMD-0268 inactive (CPI nesting 4), as in the a4 run |

The 14 author mutants I re-derived and killed: `o05 o10 o13 o14 o18 o19 o21 o22 o23 o24 o26 o28 o30 o31` (signer and slot checks in create, the lane signature and lane match, the destination and recovery checks, the source-owner check, the token-program allow-list, the gate-account owner check, the cap raise rule, the multisig binding, and the release threshold). My own 7: `r01` (the agent lane signs as the owner so the cap never binds, killed by A1), `r02` (the raise test inverted, A2), `r03` (one signer fewer than m releases, R1), `r04` (one signer fewer than needed on allow, A2), `r05` (the autonomy test reads the wrong field, G1), `r06` (the two lanes read swapped, G20c), `r08` (votes counts signer accounts instead of multisig slots, so a key passed twice counts twice, killed by A2e). Logs and the table are in `/tmp/gate-owned-review/logs/` (`gate-a4.gate-owned.log`, `gate-a4.thr.log`, `review-mutants.md`, `probe2.log`).

## Single-party reach (brief item 1)

I confirmed, by reading the source and by the harness run, that no single party moves funds off the fixed paths:

- **Custody alone, the trustee alone, a stranger:** refused for transfer, close, set-authority, approve and revoke on a gate-owned account (H5 to H10). A single signer of the multisig can only lower or suspend the cap, which reduces the agent's reach and nothing else.
- **The owners at their count:** bounded to the cap, to the listed destinations, through the agent lane; and uncapped, to the fixed recovery address, through the owners lane. They cannot release, cannot set a close authority, and cannot approve an arbitrary delegate. See F4 for the shape of this reach.
- **The agent:** only through an owner-installed Squads rule, within the cap, to a listed destination, before the end time, with a mandatory not-after inside custody's window.
- **The relayer:** a fee payer and a rent payer for stored batches, with no authority the gate reads. Squads forwards outer signers into inner calls, so the relayer's signature is visible to the gate's CPIs, and the gate accepts only the lane vault as a lane, so the relayer gains nothing.

Taking ownership back, closing the account, changing the close authority and re-delegating are all refused to every party except through `release` (custody and the trustee at the threshold). The gate has no close instruction, so a gate-owned account can never be closed while the gate owns it (F6).

## Findings

### F1 (High for freezable assets): a mint's freeze authority stops recovery and release

A token account can be frozen by whoever holds the mint's freeze authority, a third party that is neither custody nor the gate. Once the account is frozen, the token program refuses every transfer and every ownership change on it. I proved this against the gate:

- `probe2` FZ2: a third-party freeze authority froze the gate-owned account.
- FZ3: the owners' recovery of the frozen account was refused by the token program with `AccountFrozen` (0x11).
- FZ5: a release by custody and the trustee was refused the same way (0x11). Set-authority on a frozen account is refused, so a release cannot move the account out either.
- FZ5b: the balance stays in the account, owned by the gate, until the third party unfreezes it.

USDC and USDT, the assets Prime is most likely to hold, both carry a live freeze authority, so their issuers can stop recovery and release at will. This is how SPL works for any custody design on these assets, so it is not specific to this gate. For adoption it matters because the build report and the recovery guide promise reliable recovery with no such caveat, and the goal Tuan set is reliability.

**Minimal fix:** read the mint at setup and warn when it holds a freeze authority. In the report and the guide, state that recovery is reliable only for a mint whose issuer cannot freeze the account, and name the assets this rules in and out.

### F2 (Medium): a permanent-delegate mint bypasses the gate, and `setup-checks` passes it

A Token-2022 mint can carry a permanent delegate, a fixed address that can move any account of that mint. The extension sits on the mint, so the token account stays exactly 165 bytes and `checkSourceAccount` returns clean. I proved the bypass:

- `probe2` PD1: the dedicated account is 165 bytes and `checkSourceAccount` passes it.
- PD2: after the hand-over, the permanent delegate (a third party) moved the whole balance out with a plain `TransferChecked`, with no gate call and no cap. PD2b: the gate-owned account was left empty.

The mint checks the guide lists (permanent delegate, transfer fee, transfer hook, freeze authority) live only in the guide's design-only list. `setup-checks.ts` reads the token account alone and never reads the mint. The build report's finding 7 names the permanent delegate as a reason to keep such mints out, and the guard that would keep them out is absent.

**Minimal fix:** add a `checkMint` to `setup-checks.ts` that reads the mint's extensions and refuses a permanent delegate, a transfer fee, a transfer hook and (see F1) a freeze authority, and make the hand-over depend on it.

### F3 (Medium): no gate read-back, and any one multisig member sets the gate's fixed fields

`create` (`gate-owned.rs:38`) accepts any single signer of the multisig (`w >= 1`) and stores the recovery address, the destination list, the lanes, the end time and the window from that one member's data. `setup-checks.ts` has `parseTokenAccount`, `checkHandedOver` and `checkMultisig`, and no function that reads the gate PDA and compares its stored recovery, destinations, lanes, multisig and settings against what custody and the owners intend. The guide's step "the owners confirm the gate" and the check "the recovery address is set and differs from custody's own" are in the design-only list. The gate can never be edited and the hand-over is one way, so a hand-over to a gate whose recovery is an attacker's address is caught only by a person reading an explorer.

A single rogue member cannot take funds alone: the threshold still has to hand the account over, and the owners at their count still have to run the recovery or install the agent rule. The gap is that the documented automatic guard against a wrong or hostile gate address is absent, on an action that cannot be undone.

**Minimal fix:** add `checkGate(data, expected)` to `setup-checks.ts` that parses the gate layout (multisig 0, settings 32, agent lane 64, owners lane 96, recovery 128, until 160, window 168, seed 172, destinations from 181) and compares every fixed field, and make the hand-over step and the owners' confirm step depend on it.

### F4 (Medium, by design): the owner majority's reach, and custody cannot stop a recovery

With the Prime Account's own time lock at 0, which is the autonomous baseline, the owners at their count sign as the owners-lane vault through the synchronous settings path and pay the fixed recovery address at once, uncapped, before or after the end time (RR7, T12, E3b). They can also sign as the agent-lane vault through the same path and draw up to the cap to any listed destination, with no agent key and no installed rule (T1). If a listed destination is a Prime vault the owners control, the owner majority can draw the cap to themselves. Custody's one-signature cap lowering stops the agent lane and has no effect on recovery (A7d, RR3b). So custody's only defence against an owner majority that recovers in bad faith is a release back to itself, which races the recovery and needs custody, the trustee and an unfrozen account.

The recovery wait and the owners' own cancel window exist only when the Prime Account's own time lock is above 0: I confirmed that at time lock 0 the owners recover at once (RR7), and after the account's time lock is set to 5 seconds the synchronous path is refused with `TimeLockNotZero` and only the stored recovery under the rule's wait runs (RR8d, RR8e). The report's finding 2 frames this around recovery; the agent-lane-via-owners reach and the "custody cannot stop a recovery" point belong alongside it.

**Minimal fix (documentation):** state the owner-majority reach in full (the cap to listed destinations, and uncapped to the fixed recovery address), that custody cannot stop a recovery once it is signed, and that the wait and the cancel window depend on the Prime Account's own time lock being above 0.

### F5 (Informational, trust): the upgradeable dependencies and the final gate

- **Squads Smart Account** (`SMRTzfY6...`) is upgradeable on mainnet, with upgrade authority `HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2`. The gate's two lanes are Squads vaults, so whoever holds that authority can change how the vaults sign. The reach stays inside the gate's fixed recovery address, cap and destination list, so this party is bounded the same way an owner majority is (F4). Re-check the gate after each Squads upgrade; the upgrade carries no time lock.
- **Token-2022** (`TokenzQd...`) is upgradeable on mainnet, with upgrade authority `AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz`. Holding assets there adds its upgrade authority as a trusted party. Classic Token (`Tokenkeg...`) is immutable, so prefer it where the asset allows.
- **The gate deploys with `--final`:** a latent gate bug then cannot be patched, and the way out is a release to a fresh gate, which itself needs custody, the trustee and an unfrozen account. The small surface (253 formatted lines) and the external audit are what make this acceptable. The app refuses a gate program that still has an upgrade authority, which the harness honours by loading the gate as non-upgradeable.

### F6 (Low): gate-owned accounts hold their rent until a release

There is no close instruction and the gate never calls `CloseAccount`, so each gate-owned account keeps its rent (about 0.002 SOL) while the gate owns it. A recovery empties the balance and leaves the account open. The rent returns only after a release hands the account back and the new owner closes it.

### F7 (Low): seed squatting

Any multisig member can create a gate at a chosen 8-byte seed, and `create` refuses an address already taken (G10). A member can pre-take the seed the app plans to use and force a retry. The random 8-byte seed makes an accidental collision negligible, so this is a griefing note only.

## What holds (confirmed)

- **Multisig verification (brief item 2):** duplicate slots weight correctly, a key passed twice counts once per slot, non-signers do not count, a fake multisig owned by another program is refused, m greater than n is refused at `create`, an uninitialised multisig is refused, and a Token-owned account cannot carry forged slot bytes because only `InitializeMultisig` writes them. Mutants `o05 o10 o24 o26 o30 o31` and my `r08` (counting signer accounts instead of slots) all die. A Token-2022 multisig can serve as custody's identity against a classic Token account, because the gate PDA authorises the token calls; the multisig is the gate's own governance reference.
- **The cap and the delegate (brief item 6):** the cap is the token program's delegated amount, so the agent cannot exceed it across several instructions in one transaction (the token program decrements the allowance on each transfer). The gate reads the delegated amount only to decide one signer versus the threshold on `allow`, and a single-signer change never raises the agent's reach, because a change counts as a raise whenever the new cap exceeds the remaining allowance.
- **The PDA and the binding (brief item 3):** the gate binds the multisig and the Prime settings into its address, and the cap PDA into a child address, so seeds do not collide across custody and Prime pairs (G19); a wrong-mint account becomes its own gate-owned account with its own cap and leaks nothing; lane 0 and a non-autonomous Prime Account are refused (G11, G13). A pre-funded gate address does not block `create`, and a PDA address can be funded with lamports but cannot be pre-allocated or pre-assigned by anyone other than the gate program, so lamport funding is the only pre-funding and the build handles it (G17, G18).
- **The close-and-reopen bypass:** refused at `allow` when a source's close authority is a third party (X2), and recovery still empties such an account (X6, X8e).
- **Stored batches (brief item 7):** a stored batch lapses by its not-after and by the gate's end time, and a cap lowered between storing and running stops the run (TL7b, TL8c, TL9). The owners cancel a stored batch through their vote seat; the agent and custody cannot (TL6 to TL6d).

## Two cautions for the trustee choice

- If the trustee is the Prime Account's own vault (the `trustee-a4.ts` case, 9 of 9), then custody plus the owners at their count can release, so the independent second party is gone. This is a trade of fewer parties to manage for the loss of an outside check, and it should be a deliberate choice.
- The recovery address is the whole bound on an owner majority. If it is the trustee's wallet, as the guide recommends, the owner majority can force every gate-owned balance to the trustee at any time (F4). Custody, the owners and the investors must all trust the trustee, and custody's defence is a release to itself before the recovery runs.

## Files

- Work copy, logs and probes: `/tmp/gate-owned-review/` (`a4/` the copy on port 9091, `logs/` the run logs, `a4/probe2.ts` the freeze and permanent-delegate probe, `a4/review-mutants.py` the mutation pass).
- Build under review (unchanged): `/home/ubuntu/work/gate-spike/a4-min/`.
- My validator is stopped by its PID and its ledger deleted. The one remaining `bun gate-a4.ts` process on the host belongs to another agent (cwd `/home/ubuntu/work/opt/gate`, `GATE_ID=gate-lc`) and I left it alone.

Status: DONE_WITH_CONCERNS
Summary: The gate-owned gate reproduces byte-for-byte, passes 345 and 348 mock-venue checks on an independent validator, 19 unit tests and a 21-mutant pass with no survivors, and no single party can move funds off the fixed paths; adopt with fixes.
Concerns/Blockers: a mint's freeze authority stops both recovery and release, so recovery is reliable only for assets whose issuer cannot freeze them (F1); a permanent-delegate mint bypasses the gate and `setup-checks` passes it (F2); the mint checks and the gate read-back the guide describes are design-only and absent from `setup-checks.ts` (F2, F3); an owner majority reaches the cap and the fixed recovery address and custody cannot stop a recovery (F4).
