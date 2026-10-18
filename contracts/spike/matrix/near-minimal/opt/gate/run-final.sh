#!/usr/bin/env bash
# run-final.sh: the final checks on the final binaries: venues (real Orca and Kamino) for each gate build with each prime-session build, then the trustee run for each gate build.
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
PS_T=$D/../session/so/today-localnet.so; PS_P=$D/../session/so/pino-localnet.so
for combo in "gate-lc $PS_T lc-today" "gate-pino $PS_P pino-pino" "gate-lc $PS_P lc-pino" "gate-pino $PS_T pino-today"; do
  set -- $combo; ID=$1; PS=$2; TAG=$3
  PS_SO=$PS VENUES=1 VPORT=9105 ./restart-validator.sh | tail -1
  GATE_RPC=http://127.0.0.1:9105 GATE_ID=$ID GATE_MODE=venues GATE_STATE=$D/state-final-venues-$TAG.json bun venues-a4.ts > logs/final/venues.$TAG.log 2>&1
  echo "venues $TAG exit $? $(grep -E 'checks passed' logs/final/venues.$TAG.log)"
  VPORT=9105 ./stop-validator.sh
done
VPORT=9105 ./restart-validator.sh | tail -1
for ID in gate-owned gate-lc gate-pino; do
  GATE_RPC=http://127.0.0.1:9105 GATE_ID=$ID GATE_MODE=trustee GATE_STATE=$D/state-final-trustee-$ID.json timeout 200 bun trustee-a4.ts > logs/final/trustee.$ID.log 2>&1
  echo "trustee $ID exit $? $(grep -E 'checks passed' logs/final/trustee.$ID.log)"
done
VPORT=9105 ./stop-validator.sh
