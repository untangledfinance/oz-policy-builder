#!/usr/bin/env bash
# Real run on Stellar testnet, NEAR-routed owners. Run detached (setsid nohup) so a harness restart does not kill it.
# Each part holds the shared NEAR lock only while it runs. A part with a .pass marker is skipped on the next start.
cd /home/ubuntu/work/seat-spike/stellar
L=/home/ubuntu/work/prime-refine/logs/seat/stellar
LOCK=/home/ubuntu/work/prime-refine/near.lock
PARTS="${@:-setup rules votes separation danger sessions cross baseline nogov-setup nogov feebench summary}"
for p in $PARTS; do
  if [ -f $L/part-$p.pass ]; then echo "== $p skipped (passed)" >> $L/run.out; continue; fi
  echo "== $p queued $(date -u +%T)" >> $L/run.out
  flock $LOCK bun sst.ts $p > $L/sst-$p.log 2>&1
  rc=$?
  if [ $rc -eq 0 ] && ! grep -q ' FAIL ' $L/sst-$p.log; then touch $L/part-$p.pass; echo "== $p exit 0 pass $(date -u +%T)" >> $L/run.out
  else echo "== $p exit $rc (marker not set) $(date -u +%T)" >> $L/run.out; fi
done
bun verify-sst.ts > $L/verify-sst.log 2>&1; echo "== verify exit $? $(date -u +%T)" >> $L/run.out
cp state-sst.json $L/state-sst.json
echo "== done $(date -u +%T)" >> $L/run.out
