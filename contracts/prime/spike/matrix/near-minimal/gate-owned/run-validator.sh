#!/usr/bin/env bash
# gate-spike a4-min: local validator on rpc 9081 with its own ledger, the mainnet feature set (--clone-feature-set, read-only mainnet RPC), the mainnet Squads Smart Account build and
# program config, the mainnet Token-2022 build, both gate builds (gate-owned, gate-owned-thr), every mutant in mut/ at its own program id (MUTANTS=1), the venue mock (twice), the hostile fixture and
# prime-session. VENUES=1 also clones the Orca Whirlpool and Kamino lending programs and the accounts in venues/accounts.txt from mainnet, with the patched USDC mint.
# Writes the PID to validator.pid. Stop it with stop-validator.sh (by PID file only).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
L=/home/ubuntu/work/prime-refine/logs/gate/a4
MAINNET=https://api.mainnet-beta.solana.com
mkdir -p "$L"
rm -rf "$D/ledger"
EXTRA=()
if [ "${VENUES:-0}" = 1 ]; then
  EXTRA+=(--clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --clone-upgradeable-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD)
  while read -r k; do [ -n "$k" ] && EXTRA+=(--clone "$k"); done < "$D/venues/accounts.txt"
  for f in "$D"/venues/patched/*.json; do EXTRA+=(--account "$(basename "$f" .json)" "$f"); done
fi
if [ "${MUTANTS:-0}" = 1 ]; then
  for so in "$D"/mut/*.so; do n=$(basename "$so" .so); EXTRA+=(--bpf-program "$(solana-keygen pubkey "$D/secrets/$n.json")" "$so"); done
fi
nohup solana-test-validator --ledger "$D/ledger" --rpc-port 9081 --faucet-port 10081 --gossip-port 8281 --dynamic-port-range 19800-19860 --limit-ledger-size 20000 \
  --url "$MAINNET" --clone-feature-set \
  --upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG "$D/squads-mainnet/squads.so" HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2 \
  --account GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus "$D/squads-mainnet/config.json" \
  --upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$D/token-mainnet/token2022.so" HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2 \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/gate-owned.json")" "$D/so/gate-owned.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/gate-owned-thr.json")" "$D/so/gate-owned-thr.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/venue.json")" "$D/fixtures/venue.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/venue-b.json")" "$D/fixtures/venue.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/hostile.json")" "$D/fixtures/hostile.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/prime-session.json")" "$D/fixtures/prime_session.so" \
  "${EXTRA[@]}" \
  --quiet > "$L/validator.log" 2>&1 &
echo $! > "$D/validator.pid"
echo "validator pid $(cat "$D/validator.pid") rpc 9081"
