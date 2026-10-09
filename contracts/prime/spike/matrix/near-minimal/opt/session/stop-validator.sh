#!/usr/bin/env bash
# Stops the validator started on VPORT (default 9103; rpc+1 is the websocket port), by PID file only, and deletes its ledger.
D=$(cd "$(dirname "$0")" && pwd)
VPORT=${VPORT:-9103}
F=$D/validator.$VPORT.pid
[ -f "$F" ] && { P=$(cat "$F"); kill "$P" 2>/dev/null; for i in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 1; done; rm -f "$F"; }
rm -rf "$D/ledger-$VPORT"
exit 0
