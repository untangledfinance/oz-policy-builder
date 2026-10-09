| mutant | weakened check | result | first failing check | harness | time |
|---|---|---|---|---|---|
| p01 | create: both lanes may be the same vault | killed | G13c. | stopped at the first failure | 18s |
| p02 | create: agent lane 0 (where session rules sign) is accepted | killed | G13. | stopped at the first failure | 14s |
| p03 | create: owners lane 0 is accepted | killed | G13b. | stopped at the first failure | 17s |
| p04 | create: the destination list need not be whole 32-byte entries | killed | G16b. | stopped at the first failure | 15s |
| p05 | create: the signer need not be a signer of the multisig | killed | G4. | stopped at the first failure | 10s |
| p06 | create: a multisig with m greater than n is accepted | killed | G9. | stopped at the first failure | 14s |
| p07 | create: the settings account need not be owned by Squads | killed | G12. | stopped at the first failure | 15s |
| p08 | create: a Prime Account with a settings authority is accepted | killed | G11. | stopped at the first failure | 16s |
| p09 | votes: the identity need not belong to a token program | killed | G6. | stopped at the first failure | 12s |
| p10 | votes: a key counts although it did not sign | killed | G14. | stopped at the first failure | 27s |
| p11 | create: the seed is not part of the gate address | killed | G1. | stopped at the first failure | 13s |
| p12 | create: the two lane vaults are stored swapped | killed | G2. | stopped at the first failure | 15s |
| p13 | transfer: the lane need not sign | killed | T6c. | stopped at the first failure | 55s |
| p14 | transfer: any signer counts as a lane | killed | G20d. | stopped at the first failure | 23s |
| p15 | transfer: the not-after may have passed | killed | T5. | stopped at the first failure | 51s |
| p16 | transfer: the not-after has no upper bound (custody's window) | killed | T5b. | stopped at the first failure | 47s |
| p17 | transfer: the gate end time is ignored | killed | E2. | stopped at the first failure | 68s |
| p18 | transfer: the agent lane may pay any destination | killed | T2. | stopped at the first failure | 42s |
| p19 | transfer: the owners lane may pay any destination | killed | T13. | stopped at the first failure | 47s |
| p20 | transfer: the agent lane may pay the recovery address | killed | T3. | stopped at the first failure | 43s |
| p21 | transfer: the agent path accepts a source the cap PDA owns (no limit) | killed | T8b. | stopped at the first failure | 43s |
| p22 | call: any program may be named as the token program | killed | A13. | stopped at the first failure | 36s |
| p23 | load: a gate account of another program is accepted | killed | A14. | stopped at the first failure | 39s |
| p24 | allow: one signer may raise the cap | killed | A2. | stopped at the first failure | 36s |
| p25 | allow: the same cap counts as a raise | killed | A5c. | stopped at the first failure | 37s |
| p26 | allow: the multisig need not be the gate's | killed | A10. | stopped at the first failure | 39s |
| p27 | allow: the cap PDA account is not checked | killed | A9. | stopped at the first failure | 38s |
| p28 | allow: a foreign close authority is accepted | killed | X2. | stopped at the first failure | 53s |
| p29 | allow: an unset close authority is refused | killed | H4e. | stopped at the first failure | 31s |
| p30 | release: one signer may release | killed | R1. | stopped at the first failure | 88s |
| p31 | release: the multisig need not be the gate's | killed | R5. | stopped at the first failure | 86s |
| p32 | release: the owner changes before the close authority | killed | H4f. | stopped at the first failure | 33s |
| p33 | release: only the owner is handed back | killed | H4g. | stopped at the first failure | 26s |
| p34 | release: only the close authority is handed back | killed | H4g. | stopped at the first failure | 29s |
| p35 | transfer: the destination owner is read from the mint field | killed | G20c. | stopped at the first failure | 22s |
| p36 | transfer: the cap PDA signs with another seed (agent path) | killed | G20c. | stopped at the first failure | 19s |
| p37 | create: the Allocate step is dropped | killed | G1. | stopped at the first failure | 10s |
| p38 | allow: the gate approves its own address as the delegate (the cap PDA is not used) | killed | G20c. | stopped at the first failure | 19s |
| p39 | transfer: the owners lane signs as the cap PDA (bounded by the cap) | killed | A7d. | stopped at the first failure | 37s |
| p40 | transfer: the owners lane is stopped by the end time | killed | E3. | stopped at the first failure | 78s |
| p41 | process: a create shorter than its fixed fields reaches create | killed | G16c. | stopped at the first failure | 16s |
| p42 | process: a transfer of the wrong length reaches transfer | killed | G16d. | stopped at the first failure | 18s |
| p43 | process: an allow of the wrong length reaches allow | killed | G16e. | stopped at the first failure | 21s |
| p44 | process: a release of the wrong length reaches release | killed | G16f. | stopped at the first failure | 21s |
| p45 | allow: the current cap is read from the balance field | killed | A2. | stopped at the first failure | 43s |
| p46 | release: the close authority is cleared instead of handed back | killed | H4f. | stopped at the first failure | 34s |
| p47 | votes: only the first two signer slots count | killed | R12c. | stopped at the first failure | 106s |
| p48 | votes: m and n are read swapped | killed | G9. | stopped at the first failure | 26s |
| p49 | create: the rent top-up transfers nothing | killed | G1a. | stopped at the first failure | 18s |
| p50 | create: the Assign step is dropped | killed | G1. | stopped at the first failure | 11s |
| p51 | create: the agent lane index is fixed at 1 | killed | G20b. | stopped at the first failure | 17s |
| p52 | create: the owners lane index is fixed at 3 | killed | G20b. | stopped at the first failure | 18s |
| p53 | transfer: the end time is exclusive (boundary second) | killed | B1. | stopped at the first failure | 302s |
| p54 | transfer: a not-after equal to now is refused (boundary second) | killed | B2. | stopped at the first failure | 313s |
| p55 | le: little-endian numbers are read big-endian | killed | G20c. | stopped at the first failure | 25s |
| p56 | cpi: one account too many is writable | CRASHED |  | stopped at the first failure | 20s |
| p57 | cpi: no account signs | killed | G1. | stopped at the first failure | 11s |
| p58 | gate_seeds: the bump is read from the seed's last byte | CRASHED |  | stopped at the first failure | 21s |
| p59 | gate_seeds: the seed is read one byte late | CRASHED |  | stopped at the first failure | 22s |
| p60 | load: the last byte of the gate account is dropped | killed | T1c. | stopped at the first failure | 44s |
| p61 | need: a failed condition passes | killed | G1. | stopped at the first failure | 9s |
| p62 | create: the system calls sign for nothing (system call signer count 0) | killed | G1. | stopped at the first failure | 9s |
