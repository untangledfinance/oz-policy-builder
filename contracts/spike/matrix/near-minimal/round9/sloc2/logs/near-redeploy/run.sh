#!/usr/bin/env bash
set -u
L=/home/ubuntu/work/prime-refine/logs/near-sloc2
export PATH=/home/ubuntu/.local/bin:/home/ubuntu/.cargo/bin:/home/ubuntu/.nvm/versions/node/v26.4.0/bin:/home/ubuntu/.bun/bin:$PATH
flock -x /home/ubuntu/work/prime-refine/near.lock bash -c '
set -u
L='$L'
echo "lock acquired $(date -u +%FT%TZ)"
cd /home/ubuntu/work/near-session-spike
bun $L/derive.ts > $L/derive-before.log 2>&1; echo "derive-before exit $?"
cd $L && bun deploy-signer-self.ts > deploy.log 2>&1; echo "deploy exit $?"
cd /home/ubuntu/work/near-session-spike
bun $L/derive.ts > $L/derive-after.log 2>&1; echo "derive-after exit $?"
bun signer-neg.ts > $L/signer-neg.log 2>&1; echo "signer-neg exit $?"
bun proof-near.ts > $L/proof-near.log 2>&1; echo "proof-near exit $?"
cd /home/ubuntu/work/sloc2/solana/session
export PSN_RPC=http://127.0.0.1:9181 PSN_STATE=$L/state-psn-9181.json
bun psn.ts > $L/psn-local.log 2>&1; echo "psn exit $?"
echo "lock released $(date -u +%FT%TZ)"
'
