#!/bin/bash
# Round 8, Solana re-run after correcting X11's expectation (local validator cloned from devnet + NEAR testnet).
W=/home/ubuntu/work
log() { echo "$(date -u +%T) $*" | tee -a $W/round8.log; }
cd $W/swig-spike
log "SOLANA re-run (X11 corrected)"
rm -rf ledger-r8
PATH=$W/swig-spike/solana-release/bin:$PATH solana-test-validator --ledger ledger-r8 --rpc-port 8899 --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G $W/prime-session/target/deploy/prime_session.so --quiet > validator-r8.log 2>&1 &
VPID=$!
sleep 30
mv psn.log psn.round8-x11-expectation.log
mv state-psn.json state-psn.round8-x11-expectation.json
bun psn.ts > psn.log 2>&1
log "solana: $(grep -E '^[0-9]+/[0-9]+ passed' psn.log | tail -1)"
bun pdhash.ts > pdhash.log 2>&1; log "solana program hash: $(tail -1 pdhash.log)"
kill $VPID; sleep 2
log "DONE2"
