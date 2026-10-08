#!/bin/bash
L=/home/ubuntu/work/prime-refine/logs/owners
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
cd /home/ubuntu/work/swig-spike
PRIME_OWNERS=1 PRIME_THRESHOLD=1 PKN_STATE=$L/state-pkn-1of1.json flock /home/ubuntu/work/prime-refine/near.lock bun pkn.ts > $L/pkn.1of1.log 2>&1
for c in "1 1" "2 2" "3 5"; do set -- $c; T=$1; N=$2
  PRIME_OWNERS=$N PRIME_THRESHOLD=$T PSN_STATE=$L/state-psn-${T}of${N}.json flock /home/ubuntu/work/prime-refine/near.lock bun psn.ts > $L/psn.${T}of${N}.log 2>&1
done
