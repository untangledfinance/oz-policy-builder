#!/usr/bin/env bash
# Local validator for the contract-call spike: port 8969, own ledger, Smart Account program and config cloned from devnet.
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd)
exec solana-test-validator --reset --ledger /tmp/ledger-calls --rpc-port 8969 --faucet-port 9970 --gossip-port 8101 --dynamic-port-range 18800-18860 \
  --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G "$HERE/prime_session.r9.so" \
  --bpf-program 7kSEx7WsFL6MnqmqkESwgMpThjjPR2GwSQZp5JBewaBg "$HERE/venue/target/deploy/calls_venue.so" \
  --bpf-program 9kNMihGbC2Ej4o4bfhBfhnZRE4JSPVYCBE2umySjSHoW "$HERE/venue/target/deploy/calls_venue.so"
