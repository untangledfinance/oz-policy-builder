#!/usr/bin/env bash
# run-venues.sh <gate-id> <port> [prime-session .so]: fresh validator with the real Orca and Kamino state (VENUES=1), then venues-a4.ts against <gate-id>; log in logs/venues.<gate-id>.log; stops the validator.
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
ID=$1; PORT=$2; [ -n "${3:-}" ] && export PS_SO=$3
VENUES=1 VPORT=$PORT ./restart-validator.sh | tail -1
GATE_RPC=http://127.0.0.1:$PORT GATE_ID=$ID GATE_MODE=venues GATE_STATE=$D/state-$ID-venues.json bun venues-a4.ts > "logs/venues.$ID.log" 2>&1
echo "exit $?"; tail -3 "logs/venues.$ID.log" | cut -c1-200
VPORT=$PORT ./stop-validator.sh
