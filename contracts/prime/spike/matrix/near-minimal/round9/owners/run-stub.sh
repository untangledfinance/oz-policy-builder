#!/bin/bash
# Stubbed MPC (local keys instead of NEAR): owner-count logic without the NEAR relayer. No NEAR lock needed.
L=/home/ubuntu/work/prime-refine/logs/owners
P=$L/stub.progress
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
export NEARSIG_STUB=/home/ubuntu/work/metamask-sol/stub/nearsig-stub.ts
step() { grep -q "^$1 " $P 2>/dev/null; }
mark() { echo "$1 $(date -u +%T)" >> $P; }
cd /home/ubuntu/work/swig-spike
step psn-7of12-stub || { PRIME_OWNERS=12 PRIME_THRESHOLD=7 PSN_STATE=$L/state-psn-7of12-stub.json bun psn.ts > $L/psn.7of12.stub.log 2>&1; mark psn-7of12-stub; }
step psn-default-stub || { PSN_STATE=$L/state-psn-default-stub.json bun psn.ts > $L/psn.default.stub.log 2>&1; mark psn-default-stub; }
step pkn-default-stub || { PKN_STATE=$L/state-pkn-default-stub.json bun pkn.ts > $L/pkn.default.stub.log 2>&1; mark pkn-default-stub; }
step pkn-7of12-stub || { PRIME_OWNERS=12 PRIME_THRESHOLD=7 PKN_STATE=$L/state-pkn-7of12-stub.json bun pkn.ts > $L/pkn.7of12.stub.log 2>&1; mark pkn-7of12-stub; }
echo ALLDONE >> $P
