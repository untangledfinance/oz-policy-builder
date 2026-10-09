#!/usr/bin/env bash
# Stops the validator this directory started (by PID file) and starts a fresh one; waits until it is healthy.
D=$(cd "$(dirname "$0")" && pwd)
"$D/stop-validator.sh"
"$D/run-validator.sh"
for i in $(seq 1 120); do curl -s -m 2 localhost:9081 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && { echo healthy; exit 0; }; sleep 1; done
echo "validator not healthy"; exit 1
