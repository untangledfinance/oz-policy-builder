#!/bin/bash
L=/home/ubuntu/work/prime-refine/logs/owners
cd /home/ubuntu/work/near-session-spike
PRIME_OWNERS=15 PRIME_THRESHOLD=8 STN_STATE=$L/state-stn-8of15.json flock /home/ubuntu/work/prime-refine/near.lock bun stn.ts owners > $L/stn.8of15.log 2>&1
STN_STATE=$L/state-stn-8of15.json flock /home/ubuntu/work/prime-refine/near.lock bun stn.ts summary > $L/stn.8of15.summary.log 2>&1
