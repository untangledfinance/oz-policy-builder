#!/bin/bash
# Starts the seat-spike validator (rpc 8949) with a fresh ledger. Usage: run-validator.sh [full|ng]. Writes the PID to /home/ubuntu/work/seat-spike/solana/validator.pid
set -u
W=/home/ubuntu/work
D=$W/seat-spike/solana
V=${1:-full}
R=${2:-8949}   # rpc port; faucet = R+1000, gossip = R-800
L=${3:-ledger-seat}
PIDF=${4:-validator.pid}
SO=$D/prime-seat/target/deploy/prime_seat.so
[ "$V" = ng ] && SO=$D/prime-seat-ng/target/deploy/prime_seat_ng.so
export PATH=$W/swig-spike/solana-release/bin:$PATH
A=$(solana-keygen pubkey $D/secrets/prime-seat-keypair.json)
B=$(solana-keygen pubkey $D/secrets/prime-seat-b.json)
rm -rf $D/$L
cd $D
nohup solana-test-validator --ledger $D/$L --rpc-port $R --faucet-port $((R+1000)) --gossip-port $((R-800)) --dynamic-port-range $((18600+(R-8949)*10))-$((18660+(R-8949)*10)) --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program $A $SO --bpf-program $B $SO --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G $W/prime-session/target/deploy/prime_session.so --quiet > $D/$L.log 2>&1 &
echo $! > $D/$PIDF
echo "validator pid $(cat $D/$PIDF) variant $V rpc $R program A $A B $B"
