#!/usr/bin/env bash
# Re-run of the real Freighter part and the summary. Call as: flock /home/ubuntu/work/prime-refine/near.lock bash run-realfr.sh
cd /home/ubuntu/work/near-session-spike
L=/home/ubuntu/work/prime-refine/logs/stellar/fix
F=/home/ubuntu/work/freighter-ext
cp $L/freighter-bridge.out $L/freighter-bridge.attempt1.out
rm -f $F/bridge/done-auth
(cd $F && xvfb-run -a node explore-auth.mjs > $L/freighter-bridge.out 2>&1) &
BR=$!
for i in $(seq 1 90); do grep -q "bridge ready" $L/freighter-bridge.out 2>/dev/null && break; sleep 1; done
echo "== realfr $(date -u +%T)"; bun stn.ts realfr > $L/stn-realfr.log 2>&1; echo "exit $?"
touch $F/bridge/done-auth; wait $BR
echo "== summary $(date -u +%T)"; bun stn.ts summary > $L/stn-summary.log 2>&1; echo "exit $?"
cp state-stn.json $L/state-stn.json
echo "== done $(date -u +%T)"
