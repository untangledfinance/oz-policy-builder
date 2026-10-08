#!/bin/bash
cd /home/ubuntu/work/swig-spike
L=/home/ubuntu/work/prime-refine/logs/owners
for c in "2 2" "3 5"; do set -- $c; T=$1; N=$2
  PRIME_OWNERS=$N PRIME_THRESHOLD=$T PKN_STATE=$L/state-pkn-${T}of${N}.json flock /home/ubuntu/work/prime-refine/near.lock bun pkn.ts > $L/pkn.${T}of${N}.log 2>&1
done
