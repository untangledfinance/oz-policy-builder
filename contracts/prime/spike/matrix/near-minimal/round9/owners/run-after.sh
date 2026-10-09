#!/bin/bash
L=/home/ubuntu/work/prime-refine/logs/owners
until grep -q ALLDONE $L/resume.progress; do sleep 10; done
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
cd /home/ubuntu/work/swig-spike
rm -f $L/state-psn-7of12.json
PRIME_OWNERS=12 PRIME_THRESHOLD=7 PSN_STATE=$L/state-psn-7of12.json flock /home/ubuntu/work/prime-refine/near.lock bun psn.ts > $L/psn.7of12.log 2>&1
echo "psn 7of12 rerun done $(date -u +%T)" >> $L/after.progress
