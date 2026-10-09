#!/bin/bash
L=/home/ubuntu/work/prime-refine/logs/owners
cd /home/ubuntu/work/near-session-spike
for c in "2 2" "3 5"; do set -- $c; T=$1; N=$2
  PRIME_OWNERS=$N PRIME_THRESHOLD=$T STN_STATE=$L/state-stn-${T}of${N}.json flock /home/ubuntu/work/prime-refine/near.lock bun stn.ts owners > $L/stn.${T}of${N}.log 2>&1
  STN_STATE=$L/state-stn-${T}of${N}.json flock /home/ubuntu/work/prime-refine/near.lock bun stn.ts summary > $L/stn.${T}of${N}.summary.log 2>&1
done
