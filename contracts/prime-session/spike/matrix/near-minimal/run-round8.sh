#!/bin/bash
# Round 8 (rename to prime-session + sLOC trim): rebuild, then Stellar testnet, EVM on an anvil fork of Base Sepolia
# (the live relayer is out of test ETH), Solana local validator (cloned from devnet) - in sequence (they share the NEAR
# relayer key). Output: one log per chain + round8.log summary.
set -u
W=/home/ubuntu/work
PS=/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime-session
log() { echo "$(date -u +%T) $*" | tee -a $W/round8.log; }
: > $W/round8.log

log "build prime-session (Stellar)"; (cd $PS && stellar contract build >/dev/null 2>&1; sha256sum target/wasm32v1-none/release/prime_session.wasm) | tee -a $W/round8.log
log "build prime-session (Solana)"; (cd $W/prime-session && PATH=$W/swig-spike/solana-release/bin:$PATH PRIME_CLUSTER=localnet cargo-build-sbf >/dev/null 2>&1; sha256sum target/deploy/prime_session.so) | tee -a $W/round8.log
log "build PrimeSession (EVM)"; (cd $W/prime-evm && PATH=$HOME/.foundry/bin:$PATH forge build >/dev/null 2>&1; echo ok) | tee -a $W/round8.log
log "unit tests (Stellar)"; (cd $PS && cargo test 2>&1 | grep "test result") | tee -a $W/round8.log

log "STELLAR"
cd $W/near-session-spike
[ -f state-stn.json ] && mv state-stn.json state-stn.round7.json
[ -f stn.log ] && mv stn.log stn.round7.log
for part in setup seats rules separation sessions cross summary; do echo "== $part" >> stn.log; bun stn.ts $part >> stn.log 2>&1; done
log "stellar: $(grep -E '[0-9]+/[0-9]+ passed' stn.log | tail -1)"

log "EVM fork"
cd $W/swig-spike
[ -f pkn.log ] && mv pkn.log pkn.round7.log
[ -f state-pkn.json ] && mv state-pkn.json state-pkn.round7.json
$HOME/.foundry/bin/anvil --fork-url https://sepolia.base.org --port 8547 --silent > anvil-8547.log 2>&1 &
A=$!
sleep 12
bun pkn.ts > pkn.log 2>&1
log "evm fork: $(grep -E '^[0-9]+/[0-9]+ passed' pkn.log | tail -1)"
BE_FORK=1 bun bytecode-eq.ts > bytecode-eq.log 2>&1; log "evm bytecode: $(grep -c "local build (immutables masked): true" bytecode-eq.log)/3 equal"
kill $A; sleep 2

log "SOLANA"
rm -rf ledger-r8
PATH=$W/swig-spike/solana-release/bin:$PATH solana-test-validator --ledger ledger-r8 --rpc-port 8899 --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G $W/prime-session/target/deploy/prime_session.so --quiet > validator-r8.log 2>&1 &
VPID=$!
sleep 30
[ -f psn.log ] && mv psn.log psn.round7.log
[ -f state-psn.json ] && mv state-psn.json state-psn.round7.json
bun psn.ts > psn.log 2>&1
log "solana: $(grep -E '^[0-9]+/[0-9]+ passed' psn.log | tail -1)"
bun pdhash.ts > pdhash.log 2>&1; log "solana program hash: $(tail -2 pdhash.log | tr '\n' ' ')"
kill $VPID; sleep 2
log "DONE"
