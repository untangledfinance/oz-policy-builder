#!/bin/bash
L=/home/ubuntu/work/prime-refine/logs/owners
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
cd /home/ubuntu/work/swig-spike
PRIME_OWNERS=12 PRIME_THRESHOLD=7 PKN_STATE=$L/state-pkn-7of12.json flock /home/ubuntu/work/prime-refine/near.lock bun pkn.ts > $L/pkn.7of12.log 2>&1
PRIME_OWNERS=12 PRIME_THRESHOLD=7 PSN_STATE=$L/state-psn-7of12.json flock /home/ubuntu/work/prime-refine/near.lock bun psn.ts > $L/psn.7of12.log 2>&1
