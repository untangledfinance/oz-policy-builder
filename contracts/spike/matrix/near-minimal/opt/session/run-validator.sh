#!/usr/bin/env bash
# prime-session test validator: own ledger, mainnet feature set (--clone-feature-set from read-only mainnet RPC), mainnet Squads Smart Account build and program config (from ../gate),
# the build under test (SO=path) loaded at program A (FTNMFWi...) and at program B (J38gUL2..., the second program id of the two-program-id checks), and a no-op program (so/noop.so at AARnE8m3...) that section F4 of psn.x.ts uses as "another program".
# VPORT = rpc port (default 9103; rpc+1 is the websocket port). Writes validator.<VPORT>.pid. Stop with stop-validator.sh (PID file only).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
VPORT=${VPORT:-9103}
SO=${SO:?SO=path to the prime_session .so}
G=$D/../gate
LEDGER=$D/ledger-$VPORT
rm -rf "$LEDGER"
DYN=$((19900 + (VPORT - 9101) * 100))
nohup solana-test-validator --ledger "$LEDGER" --rpc-port "$VPORT" --faucet-port $((VPORT + 1000)) --gossip-port $((VPORT - 800)) --dynamic-port-range "$DYN-$((DYN + 60))" --limit-ledger-size 20000 \
  --url https://api.mainnet-beta.solana.com --clone-feature-set \
  --upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG "$G/squads-mainnet/squads.so" HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2 \
  --account GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus "$G/squads-mainnet/config.json" \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G "$SO" \
  --bpf-program J38gUL2YFo91GDBnDXwVDaGpk6XWSJUhs7RuditRdiVo "$SO" \
  --bpf-program AARnE8m37ewaTZq4ksPZhGJAsizXQD37JHiGf4mP3R6v "$D/so/noop.so" \
  --quiet > "$D/logs/validator-$VPORT.log" 2>&1 &
echo $! > "$D/validator.$VPORT.pid"
for i in $(seq 1 180); do curl -s -m 2 localhost:$VPORT -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && { echo "validator pid $(cat "$D/validator.$VPORT.pid") rpc $VPORT healthy"; exit 0; }; sleep 1; done
echo "validator not healthy"; exit 1
