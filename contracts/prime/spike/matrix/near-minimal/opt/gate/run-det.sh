#!/usr/bin/env bash
# run-det.sh <label> <so file> <port>: fresh validator that loads <so file> at gate-owned's program id, then the mock harness with deterministic keys and seeds (GATE_DET=cu1), so builds compare on identical addresses.
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
L=$1; SO=$2; PORT=$3
mkdir -p /tmp/sodet-$L && cp "$SO" /tmp/sodet-$L/gate-owned.so
SO_DIR=/tmp/sodet-$L VPORT=$PORT ./restart-validator.sh | tail -1
GATE_DET=cu1 GATE_RPC=http://127.0.0.1:$PORT GATE_ID=gate-owned GATE_STATE=$D/state-det-$L.json bun gate-a4.ts > logs/det.$L.log 2>&1
echo "$L exit $? $(grep -E 'checks passed' logs/det.$L.log)"
VPORT=$PORT ./stop-validator.sh
