#!/bin/bash
cd /home/ubuntu/work/swig-spike
L=/home/ubuntu/work/prime-refine/logs/owners
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
for c in "1 1" "2 2" "3 5"; do set -- $c; T=$1; N=$2
  PRIME_OWNERS=$N PRIME_THRESHOLD=$T PSN_STATE=$L/state-psn-${T}of${N}.json flock /home/ubuntu/work/prime-refine/near.lock bun psn.ts > $L/psn.${T}of${N}.log 2>&1
done
