#!/usr/bin/env bash
# Stops the validator this directory started on VPORT (by PID file) and starts a fresh one; waits until it is healthy.
D=$(cd "$(dirname "$0")" && pwd)
VPORT=${VPORT:-9101}
"$D/stop-validator.sh"
"$D/run-validator.sh"
for i in $(seq 1 180); do curl -s -m 2 localhost:$VPORT -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && { echo healthy; exit 0; }; sleep 1; done
echo "validator not healthy"; exit 1
