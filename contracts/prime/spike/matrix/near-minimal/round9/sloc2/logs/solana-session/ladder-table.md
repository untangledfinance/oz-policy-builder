| rung | cut | formatted sLOC | formatted delta | as-written delta | tokens delta | kind |
|---|---|---|---|---|---|---|
| r00 | original after rustfmt | 102 | | | 906 tokens | |
| r01 | `pubkey` imported and `ProgramError as E` | 102 | +0 | +1 | +0 | neutral |
| r02 | one flat import list, `entrypoint!` by its path | 96 | -6 | -6 | +0 | shape only |
| r03 | short parameter names | 95 | -1 | +0 | +0 | shape only |
| r04 | account list taken apart with split_first_chunk | 94 | -1 | -1 | +1 | shape only |
| r05 | `need` and `le` helpers: refusals as one-line checks, numbers by one fold | 96 | +2 | +2 | +57 | neutral |
| r06 | ed25519 header read as eight words in one slice pattern | 91 | -5 | -5 | -61 | logic removed |
| r07 | session key not copied into a tuple | 86 | -5 | -5 | -1 | shape only |
| r08 | PDA check as two named conditions with the seeds bound once | 84 | -2 | -2 | +17 | shape only |
| r09 | revoke: one system-call closure taking the instruction tag | 71 | -13 | -13 | -14 | logic removed |
| r10 | Smart Account call through new_with_bytes | 64 | -7 | -7 | -17 | logic removed |
