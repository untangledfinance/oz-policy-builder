#!/bin/bash
# Resumable: each step is skipped when its marker is already in owners2.progress.
L=/home/ubuntu/work/prime-refine/logs/owners
LK=/home/ubuntu/work/prime-refine/near.lock
P=$L/owners2.progress
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
bal() { curl -s -X POST https://rpc.testnet.near.org -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"prime-spike-muwguc60.testnet"}}' | python3 -c "import sys,json;print(int(json.load(sys.stdin)['result']['amount'])/1e24)"; }
step() { grep -q "^$1 " $P 2>/dev/null; }
mark() { echo "$1 $(date -u +%T) relayer_near=$(bal)" >> $P; }
echo "start $(date -u +%T) relayer_near=$(bal)" >> $P
cd /home/ubuntu/work/swig-spike
if ! step psn-7of12; then
  rm -f $L/state-psn-7of12.json; cp $L/psn.7of12.log $L/psn.7of12.attempt1.log
  PRIME_OWNERS=12 PRIME_THRESHOLD=7 PSN_STATE=$L/state-psn-7of12.json flock $LK bun psn.ts > $L/psn.7of12.log 2>&1; mark psn-7of12; fi
if ! step pkn-default; then
  PKN_STATE=$L/state-pkn-default.json flock $LK bun pkn.ts > $L/pkn.default.log 2>&1; mark pkn-default; fi
if ! step psn-default; then
  PSN_STATE=$L/state-psn-default.json flock $LK bun psn.ts > $L/psn.default.log 2>&1; mark psn-default; fi
cd /home/ubuntu/work/near-session-spike
if ! step stn-8of15; then
  [ -f $L/stn.8of15.log ] && mv $L/stn.8of15.log $L/stn.8of15.funding-bug.log; rm -f $L/state-stn-8of15.json
  PRIME_OWNERS=15 PRIME_THRESHOLD=8 STN_STATE=$L/state-stn-8of15.json flock $LK bun stn.ts owners > $L/stn.8of15.log 2>&1
  STN_STATE=$L/state-stn-8of15.json flock $LK bun stn.ts summary > $L/stn.8of15.summary.log 2>&1; mark stn-8of15; fi
if ! step stn-default; then
  rm -f $L/state-stn-default.json; : > $L/stn.default.log
  for part in setup seats rules separation sessions cross summary; do echo "== $part" >> $L/stn.default.log; STN_STATE=$L/state-stn-default.json flock $LK bun stn.ts $part >> $L/stn.default.log 2>&1; done; mark stn-default; fi
echo ALLDONE >> $P
