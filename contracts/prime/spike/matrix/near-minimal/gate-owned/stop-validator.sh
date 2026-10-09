#!/usr/bin/env bash
# Stops the validator this directory started (by PID file only).
D=$(cd "$(dirname "$0")" && pwd)
[ -f "$D/validator.pid" ] && { P=$(cat "$D/validator.pid"); kill "$P" 2>/dev/null; for i in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 1; done; rm -f "$D/validator.pid"; }
exit 0
