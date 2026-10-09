#!/usr/bin/env bash
# run-x.sh: the extended harness psn.x.ts (section F, forged signature offsets) on today's build, the Pinocchio build, and the three mutants of the index checks.
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
./run-psn.sh x-today so/today-localnet.so 9141 psn.x.ts > logs/run-psn.x-today.out 2>&1 &
./run-psn.sh x-pino so/pino-localnet.so 9143 psn.x.ts > logs/run-psn.x-pino.out 2>&1 &
wait
PSN_SCRIPT=psn.x.ts PSN_TAG=-x python3 mutants.py run -j 3 s01 s03 s04 s05 s15 > logs/mutants-x.run.log 2>&1
