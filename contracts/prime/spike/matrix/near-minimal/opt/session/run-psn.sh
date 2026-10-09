#!/usr/bin/env bash
# run-psn.sh <label> <so file> <port> <script: psn.ts|psn.det.ts> [real]: fresh validator (mainnet feature set, mainnet Squads) with the build at program A and B, then the harness copy; stub NEAR unless "real" (then under flock near.lock).
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
L=$1; SO=$2; PORT=$3; SCRIPT=$4; MODE=${5:-stub}
VPORT=$PORT SO=$SO ./run-validator.sh | tail -1
export PSN_RPC=http://127.0.0.1:$PORT PSN_STATE=$D/logs/state-$L.json
if [ "$MODE" = real ]; then flock -x /home/ubuntu/work/prime-refine/near.lock bun $SCRIPT > logs/psn.$L.log 2>&1
else NEARSIG_STUB=/home/ubuntu/work/metamask-sol/stub/nearsig-stub.ts bun $SCRIPT > logs/psn.$L.log 2>&1; fi
echo "$L exit $? $(grep -E '^[0-9]+/[0-9]+ passed' logs/psn.$L.log)"
VPORT=$PORT ./stop-validator.sh
