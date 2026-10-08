#!/bin/bash
# Round 9 (stored Stellar grant, packed EVM session slot, Solana revoke marker, pass-through NEAR signer):
# rebuild, then NEAR signer checks, Stellar testnet, EVM on an anvil fork of Base Sepolia, Solana local validator
# (cloned from devnet) - in sequence, all under one lock because they share the NEAR relayer key.
# Output: one log per part under $L plus round9.log.
set -u
W=/home/ubuntu/work
L=$W/prime-refine/logs
LOCK=$W/prime-refine/near.lock
PS=/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime-session
SOL=$W/swig-spike/solana-release/bin
log() { echo "$(date -u +%T) $*" | tee -a $W/round9.log; }
: > $W/round9.log
exec 9>"$LOCK"; flock 9

log "build prime-session (Stellar)"; (cd $PS && stellar contract build >/dev/null 2>&1; sha256sum target/wasm32v1-none/release/prime_session.wasm) | tee -a $W/round9.log
log "unit tests (Stellar)"; (cd $PS && cargo test 2>&1 | grep "test result") | tee -a $W/round9.log
log "build prime-session (Solana, localnet and devnet)"
(cd $W/prime-session && PATH=$SOL:$PATH PRIME_CLUSTER=localnet cargo-build-sbf >/dev/null 2>&1
 PATH=$SOL:$PATH PRIME_CLUSTER=devnet cargo-build-sbf --sbf-out-dir target/deploy-devnet >/dev/null 2>&1
 sha256sum target/deploy/prime_session.so target/deploy-devnet/prime_session.so) | tee -a $W/round9.log
log "build PrimeSession (EVM) and forge tests"; (cd $W/prime-evm && PATH=$HOME/.foundry/bin:$PATH forge build >/dev/null 2>&1; PATH=$HOME/.foundry/bin:$PATH forge test 2>&1 | grep -E "Suite result|passed") | tee -a $W/round9.log

log "NEAR signer"
cd $W/near-session-spike
bun signer-neg.ts > $L/near/signer-neg.log 2>&1; log "signer: $(grep -E '^[0-9]+/[0-9]+ passed' $L/near/signer-neg.log | tail -1)"
bun proof-near.ts > $L/near/proof-near.log 2>&1; log "proof-near: exit $?"

log "STELLAR"
[ -f state-stn.json ] && mv state-stn.json state-stn.round8.json
for part in setup seats rules separation sessions cross; do bun stn.ts $part > $L/stellar/fix/stn-$part.log 2>&1; done
# real Freighter extension (needs xvfb and the extension bridge in /home/ubuntu/work/freighter-ext)
F=$W/freighter-ext
rm -f $F/bridge/done-auth
(cd $F && xvfb-run -a node explore-auth.mjs > $L/stellar/fix/freighter-bridge.out 2>&1) &
BR=$!
for i in $(seq 1 90); do grep -q "bridge ready" $L/stellar/fix/freighter-bridge.out 2>/dev/null && break; sleep 1; done
bun stn.ts realfr > $L/stellar/fix/stn-realfr.log 2>&1
touch $F/bridge/done-auth; wait $BR
bun stn.ts summary > $L/stellar/fix/stn-summary.log 2>&1
bun verify-stellar.ts > $L/stellar/fix/verify-stellar.log 2>&1
log "stellar: $(grep -E '[0-9]+/[0-9]+ passed' $L/stellar/fix/stn-summary.log | tail -1)"

log "EVM fork"
cd $W/swig-spike
[ -f state-pkn.json ] && mv state-pkn.json state-pkn.round8.json
$HOME/.foundry/bin/anvil --fork-url https://sepolia.base.org --port 8547 --silent > $L/evm/anvil-8547-r9b.log 2>&1 &
A=$!
sleep 12
bun pkn.ts > $L/evm/pkn.fork-r9b.log 2>&1
log "evm fork: $(grep -a -E '^[0-9]+/[0-9]+ passed' $L/evm/pkn.fork-r9b.log | tail -1)"
BE_FORK=1 bun bytecode-eq.ts > $L/evm/bytecode-eq.fork-r9b.log 2>&1; log "evm bytecode: $(grep -c 'local build (immutables masked): true' $L/evm/bytecode-eq.fork-r9b.log)/3 equal"
BE_FORK=1 bun verify-evm.ts > $L/evm/verify-evm.fork-r9b.log 2>&1; log "evm verify: exit $?"
BE_FORK=1 bun roles-why.ts > $L/evm/roles-why.fork.log 2>&1
kill $A; sleep 2

log "SOLANA"
rm -rf ledger-r9
# Optional paired compute-unit samples: R8SO is a build of the previous program (loaded at the id psn.ts expects).
R8ARGS=(); PSN_R8_FLAG=""
if [ -n "${R8SO:-}" ] && [ -f "$R8SO" ]; then R8ARGS=(--bpf-program 8xSaCrq6HidyjmE3khJ9DYewWdYNfn93nQEkYvqTEpig "$R8SO"); PSN_R8_FLAG=1; fi
PATH=$SOL:$PATH solana-test-validator --ledger ledger-r9 --rpc-port 8899 --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G $W/prime-session/target/deploy/prime_session.so \
  --bpf-program J38gUL2YFo91GDBnDXwVDaGpk6XWSJUhs7RuditRdiVo $W/prime-session/target/deploy/prime_session.so \
  "${R8ARGS[@]}" --quiet > validator-r9.log 2>&1 &
VPID=$!
sleep 30
PSN_R8=$PSN_R8_FLAG bun psn.ts > $L/solana/psn-local.log 2>&1
log "solana: $(grep -E '^[0-9]+/[0-9]+ passed' $L/solana/psn-local.log | tail -1)"
bun pdhash.ts > $L/solana/pdhash-local.log 2>&1; log "solana program hash: $(tail -2 $L/solana/pdhash-local.log | tr '\n' ' ')"
kill $VPID; sleep 2
log "DONE"

# Live runs, once the relayers are funded (not run in round 9):
#   PKN_LIVE=1 bun pkn.ts                        (Base Sepolia, about 0.0005 ETH in the relayer)
#   solana program deploy ... then PSN_NET=devnet bun psn.ts and PSN_NET=devnet bun pdhash.ts   (about 1.6 SOL in the payer)
