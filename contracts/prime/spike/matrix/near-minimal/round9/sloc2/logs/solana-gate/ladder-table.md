| rung | cut | formatted sLOC | formatted delta | as-written delta | tokens delta | kind |
|---|---|---|---|---|---|---|
| r00 | original after rustfmt | 241 | | | 2157 tokens | |
| r01 | read: one `?` chain | 238 | -3 | -3 | -3 | logic removed |
| r02 | token programs as two constants | 236 | -2 | -2 | +6 | shape only |
| r03 | create guard: one minimum test for both lanes | 232 | -4 | -4 | +1 | shape only |
| r04 | long conditions bound to a name before need() | 226 | -6 | -6 | +11 | shape only |
| r05 | transfer: one lane test, one destination list | 219 | -7 | -7 | +5 | shape only |
| r06 | cap seeds and token data bound once | 207 | -12 | -12 | -4 | logic removed |
| r07 | create: lane vaults from one map over their indexes, the shared seed word as a constant | 198 | -9 | -8 | +10 | shape only |
| r08 | create: multisig and settings keys named once | 185 | -13 | -5 | -7 | logic removed |
| r09 | create: signer seeds read back from the body, the seeds array goes | 184 | -1 | -1 | -28 | logic removed |
| r10 | create: system calls build their instruction directly, no helper call | 179 | -5 | -5 | +45 | shape only |
| r11 | create: rent bound before the call, the copy as the tail expression | 175 | -4 | -4 | +1 | shape only |
| r12 | account lists taken apart in one expression (try_from, split_first_chunk) | 168 | -7 | -7 | +29 | shape only |
| r13 | call: token program as the first key, the cpi helper folds into call | 142 | -26 | -26 | -65 | logic removed |
| r14 | release: two calls of one data builder | 136 | -6 | -6 | +26 | shape only |
| r15 | votes: the signer test named once | 134 | -2 | -2 | +15 | shape only |
| r16 | imports as one flat list | 126 | -8 | -8 | +0 | shape only |
