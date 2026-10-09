#!/bin/bash
# Local validator cloned from devnet on 8899 for psn.ts (programs A and B = the current prime-session .so).
cd /home/ubuntu/work/swig-spike
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
rm -rf /tmp/ledger-native
exec solana-test-validator --ledger /tmp/ledger-native --rpc-port 8899 --faucet-port 9911 --gossip-port 8121 --dynamic-port-range 8122-8180 --url https://api.devnet.solana.com \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus \
  --bpf-program FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G /home/ubuntu/work/prime-session/target/deploy/prime_session.so \
  --bpf-program J38gUL2YFo91GDBnDXwVDaGpk6XWSJUhs7RuditRdiVo /home/ubuntu/work/prime-session/target/deploy/prime_session.so --quiet
