# Size pass of 9 October 2026

This folder holds the scripts and logs behind the reduced session contracts: the mutation scripts, the differential harnesses and the run logs. The contracts keep their behaviour, and formatted sLOC (after `rustfmt` or `forge fmt`) is the count from this pass on.

| Contract | Formatted before | Formatted after | Build identity |
|---|---|---|---|
| `evm/prime-session` | 65 | 53 | runtime bytecode 82 bytes smaller |
| `stellar/prime-session` | 50 | 41 | `stellar contract build` wasm byte-identical to `e36d155f…`; `build-wasm.sh` hash `547f67f3…` |
| `near/prime-near-signer` | 50 | 42 | wasm `c27904a3…`, code hash `E6986kfXDAec5nZvuYiBiC3fmonHCrynwRCtd33s1U5u` |
| `solana/custody-gate` | 241 | 126 | `.so` `a5d19edb…` |
| `solana/prime-session` | 102 | 64 | `.so` `181013d2…` |

## Contents

| Path | What it holds |
|---|---|
| `evm/mutate-evm.py`, `logs/evm/` | 57 mutants of `PrimeSession.sol` (57 killed by the 16 forge tests), the fork matrix (134/134), the bytecode comparison and the Roles refusals |
| `stellar/mutate-stellar.py`, `logs/stellar/` | 28 mutants (28 killed), `cargo test` 12/12 |
| `near/mutate-near.py`, `near-diff/`, `logs/near/` | 29 mutants (29 killed), a differential harness that runs the previous and the new source under the NEAR mocked blockchain (500,000 random cases, 0 differences) |
| `logs/near-redeploy/` | the signer redeploy at `signer.prime-spike-muwguc60.testnet` (deploy transaction `82Cj53AxZjzodX4DKba2eyhgcDVBHb6USAKcHtytLdwf`), the 12 refusal checks, the routing proof and the Solana session run on real NEAR (133/133) |
| `solana/gate/mutants3.py`, `solana/gate-mutants.md` | 78 gate mutants (78 killed) |
| `solana/session/mutants-new.py`, `solana/session-mutants.md` | 34 session mutants (32 killed; the two survivors are checks the ed25519 program already repeats) |
| `solana/diff/` | the differential harness: both builds run on the host with stubbed syscalls, and each scenario compares the result, the error, every CPI and the final account data (18 million scenarios, 0 mismatches) |
| `solana/gate/ladder/`, `solana/session/ladder/`, `solana/ladder-*` | the cut-by-cut ladders and their metrics |
| `logs/solana-gate/`, `logs/solana-session/` | the harness runs on the new builds (gate 345/345 mock, 53/53 real venues, 9/9 trustee, 4/4 forged multisig; session 133/133 with stub and with real NEAR) |
| `solana/SHA256SUMS` | hashes of the old and new `.so` files and of the two sources |

The mutation scripts and `run-diff.sh` use the scratch layout of the pass (`/home/ubuntu/work/sloc2/`), so adjust the paths before running them elsewhere. The state files, ledgers, mutant binaries and keypairs of the runs stay out of the bundle.
