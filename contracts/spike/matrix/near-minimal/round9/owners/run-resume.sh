#!/bin/bash
L=/home/ubuntu/work/prime-refine/logs/owners
LK=/home/ubuntu/work/prime-refine/near.lock
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
echo "start $(date -u +%T)" > $L/resume.progress
cd /home/ubuntu/work/swig-spike
rm -f $L/state-psn-7of12.json
PRIME_OWNERS=12 PRIME_THRESHOLD=7 PSN_STATE=$L/state-psn-7of12.json flock $LK bun psn.ts > $L/psn.7of12.log 2>&1
echo "psn 7of12 done $(date -u +%T)" >> $L/resume.progress
cd /home/ubuntu/work/near-session-spike
for c in "3 5" "8 15"; do set -- $c; T=$1; N=$2
  rm -f $L/state-stn-${T}of${N}.json
  PRIME_OWNERS=$N PRIME_THRESHOLD=$T STN_STATE=$L/state-stn-${T}of${N}.json flock $LK bun stn.ts owners > $L/stn.${T}of${N}.log 2>&1
  echo "stn ${T}of${N} done $(date -u +%T)" >> $L/resume.progress
done
# default 2-of-3 regression
cd /home/ubuntu/work/swig-spike
PKN_STATE=$L/state-pkn-default.json flock $LK bun pkn.ts > $L/pkn.default.log 2>&1
echo "pkn default done $(date -u +%T)" >> $L/resume.progress
PSN_STATE=$L/state-psn-default.json flock $LK bun psn.ts > $L/psn.default.log 2>&1
echo "psn default done $(date -u +%T)" >> $L/resume.progress
cd /home/ubuntu/work/near-session-spike
rm -f $L/state-stn-default.json
for part in setup seats rules separation sessions cross summary; do echo "== $part" >> $L/stn.default.log; STN_STATE=$L/state-stn-default.json flock $LK bun stn.ts $part >> $L/stn.default.log 2>&1; done
echo "stn default done $(date -u +%T)" >> $L/resume.progress
echo ALLDONE >> $L/resume.progress
