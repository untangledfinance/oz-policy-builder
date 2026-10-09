#!/bin/bash
cd /home/ubuntu/work/sloc2-devnet/gate
L=../logs/reclaim
mkdir -p $L
bun close-executed.ts > $L/close.log 2>&1
flock /home/ubuntu/work/prime-refine/near.lock bun sweep-vaults.ts > $L/sweep.log 2>&1
flock /home/ubuntu/work/prime-refine/near.lock bun reject-active.ts > $L/reject.log 2>&1
bun close-done.ts > $L/close2.log 2>&1
flock /home/ubuntu/work/prime-refine/near.lock bun remove-policies.ts > $L/policies.log 2>&1
bun sweep-session-keys.ts > $L/session-keys.log 2>&1
echo ALLDONE > $L/done
