| mutant | weakened check | result | first failing check | harness | time |
|---|---|---|---|---|---|
| l01 | create: both lanes may be the same vault | killed | G13c. | stopped at the first failure | 18s |
| l02 | create: agent lane 0 (where session rules sign) is accepted | killed | G13. | stopped at the first failure | 16s |
| l03 | create: owners lane 0 is accepted | killed | G13b. | stopped at the first failure | 17s |
| l04 | create: the destination list need not be whole 32-byte entries | killed | G16b. | stopped at the first failure | 14s |
| l05 | create: the signer need not be a signer of the multisig | killed | G4. | stopped at the first failure | 9s |
| l06 | create: a multisig with m greater than n is accepted | killed | G9. | stopped at the first failure | 14s |
| l07 | create: the settings account need not be owned by Squads | killed | G12. | stopped at the first failure | 14s |
| l08 | create: a Prime Account with a settings authority is accepted | killed | G11. | stopped at the first failure | 17s |
| l09 | votes: the identity need not belong to a token program | killed | G6. | stopped at the first failure | 12s |
| l10 | votes: a key counts although it did not sign | killed | G14. | stopped at the first failure | 22s |
| l11 | create: the seed is not part of the gate address | killed | G1. | stopped at the first failure | 12s |
| l12 | create: the two lane vaults are stored swapped | killed | G2. | stopped at the first failure | 13s |
| l13 | transfer: the lane need not sign | killed | T6c. | stopped at the first failure | 55s |
| l14 | transfer: any signer counts as a lane | killed | G20d. | stopped at the first failure | 23s |
| l15 | transfer: the not-after may have passed | killed | T5. | stopped at the first failure | 52s |
| l16 | transfer: the not-after has no upper bound (custody's window) | killed | T5b. | stopped at the first failure | 47s |
| l17 | transfer: the gate end time is ignored | killed | E2. | stopped at the first failure | 68s |
| l18 | transfer: the agent lane may pay any destination | killed | T2. | stopped at the first failure | 41s |
| l19 | transfer: the owners lane may pay any destination | killed | T13. | stopped at the first failure | 47s |
| l20 | transfer: the agent lane may pay the recovery address | killed | T3. | stopped at the first failure | 44s |
| l21 | transfer: the agent path accepts a source the cap PDA owns (no limit) | killed | T8b. | stopped at the first failure | 42s |
| l22 | call: any program may be named as the token program | killed | A13. | stopped at the first failure | 36s |
| l23 | load: a gate account of another program is accepted | killed | A14. | stopped at the first failure | 38s |
| l24 | allow: one signer may raise the cap | killed | A2. | stopped at the first failure | 34s |
| l25 | allow: the same cap counts as a raise | killed | A5c. | stopped at the first failure | 36s |
| l26 | allow: the multisig need not be the gate's | killed | A10. | stopped at the first failure | 38s |
| l27 | allow: the cap PDA account is not checked | killed | A9. | stopped at the first failure | 37s |
| l28 | allow: a foreign close authority is accepted | killed | X2. | stopped at the first failure | 53s |
| l29 | allow: an unset close authority is refused | killed | H4e. | stopped at the first failure | 28s |
| l30 | release: one signer may release | killed | R1. | stopped at the first failure | 87s |
| l31 | release: the multisig need not be the gate's | killed | R5. | stopped at the first failure | 88s |
| l32 | release: the owner changes before the close authority | killed | H4f. | stopped at the first failure | 34s |
| l33 | release: only the owner is handed back | killed | H4g. | stopped at the first failure | 28s |
| l34 | release: only the close authority is handed back | killed | H4g. | stopped at the first failure | 29s |
| l35 | transfer: the destination owner is read from the mint field | killed | G20c. | stopped at the first failure | 19s |
| l36 | transfer: the cap PDA signs with another seed (agent path) | killed | G20c. | stopped at the first failure | 18s |
| l37 | create: the Allocate step is dropped | killed | G1. | stopped at the first failure | 12s |
| l38 | allow: the gate approves its own address as the delegate (the cap PDA is not used) | killed | G20c. | stopped at the first failure | 18s |
| l39 | transfer: the owners lane signs as the cap PDA (bounded by the cap) | killed | A7d. | stopped at the first failure | 37s |
| l40 | transfer: the owners lane is stopped by the end time | killed | E3. | stopped at the first failure | 77s |
| l41 | process: a create shorter than its fixed fields reaches create | killed | G16c. | stopped at the first failure | 17s |
| l42 | process: a transfer of the wrong length reaches transfer | killed | G16d. | stopped at the first failure | 15s |
| l43 | process: an allow of the wrong length reaches allow | killed | G16e. | stopped at the first failure | 19s |
| l44 | process: a release of the wrong length reaches release | killed | G16f. | stopped at the first failure | 23s |
| l45 | allow: the current cap is read from the balance field | killed | A2. | stopped at the first failure | 43s |
| l46 | release: the close authority is cleared instead of handed back | killed | H4f. | stopped at the first failure | 35s |
| l47 | votes: only the first two signer slots count | killed | R12c. | stopped at the first failure | 107s |
| l48 | votes: m and n are read swapped | killed | G9. | stopped at the first failure | 23s |
| l49 | create: the rent top-up transfers nothing | killed | G1a. | stopped at the first failure | 15s |
| l50 | create: the Assign step is dropped | killed | G1. | stopped at the first failure | 16s |
| l51 | create: the agent lane index is fixed at 1 | killed | G20b. | stopped at the first failure | 19s |
| l52 | create: the owners lane index is fixed at 3 | killed | G20b. | stopped at the first failure | 18s |
| l53 | transfer: the end time is exclusive (boundary second) | killed | B1. | stopped at the first failure | 300s |
| l54 | transfer: a not-after equal to now is refused (boundary second) | killed | B2. | stopped at the first failure | 311s |
| l55 | le: little-endian numbers are read big-endian | killed | G20c. | stopped at the first failure | 23s |
| l56 | cpi: one account too many is writable | CRASHED |  | stopped at the first failure | 21s |
| l57 | cpi: no account signs | killed | G1. | stopped at the first failure | 12s |
| l58 | gate_seeds: the bump is read from the seed's last byte | CRASHED |  | stopped at the first failure | 21s |
| l59 | gate_seeds: the seed is read one byte late | CRASHED |  | stopped at the first failure | 21s |
| l60 | load: the last byte of the gate account is dropped | killed | T1c. | stopped at the first failure | 45s |
| l61 | need: a failed condition passes | killed | G1. | stopped at the first failure | 9s |
| l62 | create: the system calls sign for nothing (system call signer count 0) | killed | G1. | stopped at the first failure | 9s |
