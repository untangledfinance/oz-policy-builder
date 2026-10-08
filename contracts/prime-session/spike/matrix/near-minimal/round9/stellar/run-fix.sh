#!/usr/bin/env bash
# Full Stellar matrix after the two security fixes. Call as: flock /home/ubuntu/work/prime-refine/near.lock bash run-fix.sh
cd /home/ubuntu/work/near-session-spike
L=/home/ubuntu/work/prime-refine/logs/stellar/fix
F=/home/ubuntu/work/freighter-ext
for p in setup seats rules separation sessions cross; do echo "== $p $(date -u +%T)"; bun stn.ts $p > $L/stn-$p.log 2>&1; echo "exit $?"; done
rm -f $F/bridge/done-auth
(cd $F && xvfb-run -a node explore-auth.mjs > $L/freighter-bridge.out 2>&1) &
BR=$!
for i in $(seq 1 90); do grep -q "bridge ready" $L/freighter-bridge.out 2>/dev/null && break; sleep 1; done
echo "== realfr $(date -u +%T)"; bun stn.ts realfr > $L/stn-realfr.log 2>&1; echo "exit $?"
touch $F/bridge/done-auth; wait $BR
echo "== summary $(date -u +%T)"; bun stn.ts summary > $L/stn-summary.log 2>&1; echo "exit $?"
echo "== verify $(date -u +%T)"; bun verify-stellar.ts > $L/verify-stellar.log 2>&1; echo "exit $?"
cp state-stn.json $L/state-stn.json
echo "== done $(date -u +%T)"
