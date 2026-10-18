#!/bin/bash
# Historical (round 7, before the rename): contracts/session-signer is now contracts/prime/stellar/prime-session.
# Round 7 (sLOC trim): rebuild, then Stellar testnet, EVM live Base Sepolia, Solana local validator - in sequence
# (they share the NEAR relayer key). Output: one log per chain + round7.log summary.
set -u
W=/home/ubuntu/work
SS=/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/session-signer
log() { echo "$(date -u +%T) $*" | tee -a $W/round7.log; }
: > $W/round7.log

log "build session-signer"; (cd $SS && stellar contract build >/dev/null 2>&1; sha256sum target/wasm32v1-none/release/session_signer.wasm) | tee -a $W/round7.log
log "build prime-session"; (cd $W/prime-session && PATH=$W/swig-spike/solana-release/bin:$PATH PRIME_CLUSTER=localnet cargo-build-sbf >/dev/null 2>&1; sha256sum target/deploy/prime_session.so) | tee -a $W/round7.log
log "build PrimeKey"; (cd $W/prime-evm && PATH=$HOME/.foundry/bin:$PATH forge build >/dev/null 2>&1; echo ok) | tee -a $W/round7.log

log "STELLAR"
cd $W/near-session-spike
[ -f state-stn.json ] && mv state-stn.json state-stn.round6.json
[ -f stn.log ] && mv stn.log stn.round6.log
for part in setup seats rules separation sessions cross summary; do echo "== $part" >> stn.log; bun stn.ts $part >> stn.log 2>&1; done
log "stellar: $(grep -E '[0-9]+/[0-9]+ passed' stn.log | tail -1)"

log "EVM live"
cd $W/swig-spike
[ -f pkn-live.log ] && mv pkn-live.log pkn-live.round6.log
[ -f state-pkn-live.json ] && mv state-pkn-live.json state-pkn-live.round6.json
PKN_LIVE=1 PKN_KEY=$(python3 -c "import json;print(json.load(open('/home/ubuntu/work/primex-recordings/keys.json'))['custody']['privateKey'])") bun pkn.ts > pkn-live.log 2>&1
log "evm: $(grep -E '^[0-9]+/[0-9]+ passed' pkn-live.log | tail -1)"

log "SOLANA"
rm -rf ledger-r7
PATH=$W/swig-spike/solana-release/bin:$PATH solana-test-validator --ledger ledger-r7 --rpc-port 8899 --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G $W/prime-session/target/deploy/prime_session.so --quiet > validator-r7.log 2>&1 &
VPID=$!
sleep 30
[ -f psn.log ] && mv psn.log psn.round6.log
[ -f state-psn.json ] && mv state-psn.json state-psn.round6.json
bun psn.ts > psn.log 2>&1
log "solana: $(grep -E '^[0-9]+/[0-9]+ passed' psn.log | tail -1)"
kill $VPID; sleep 2
log "DONE"
