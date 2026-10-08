#!/usr/bin/env bash
# opt gate: local validator with its own ledger, the mainnet feature set (--clone-feature-set, read-only mainnet RPC), the mainnet Squads Smart Account build and program config, the
# mainnet Token-2022 build, every gate build in so/ (each at its own program id, secrets/<name>.json), every mutant in mut/ (MUTANTS=1, mut/<id>.so with secrets/<id>.json), the venue mock
# (twice), the hostile fixture and prime-session (PS_SO, default fixtures/prime_session.so). VENUES=1 also clones the Orca Whirlpool and Kamino lending programs and the accounts in
# venues/accounts.txt from mainnet, with the patched USDC mint.
# VPORT picks the rpc port (default 9101; faucet VPORT+1000, gossip VPORT-800, dynamic ports 19900+ (VPORT-9101)*100 .. +60). MUTSET limits the mutants loaded to the ids starting with it.
# SO_DIR points at a directory of <name>.so files to load as the gate builds (default so/): a CU comparison loads each build at the same program id by copying it as gate-owned.so into its own directory.
# The cloned mainnet feature set makes the validator install the Token program mainnet runs today (p-token, SIMD-0266, epoch 971): `solana program dump` of the local Token program has the same SHA-256 as token-mainnet/token.so.
# Writes the PID to validator.<VPORT>.pid. Stop it with stop-validator.sh (by PID file only).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
VPORT=${VPORT:-9101}
L=$D/logs
MAINNET=https://api.mainnet-beta.solana.com
mkdir -p "$L"
LEDGER=${LEDGER:-$D/ledger-$VPORT}
rm -rf "$LEDGER"
DYN=$((19900 + (VPORT - 9101) * 100))
PS_SO=${PS_SO:-$D/fixtures/prime_session.so}
EXTRA=()
if [ "${VENUES:-0}" = 1 ]; then
  EXTRA+=(--clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --clone-upgradeable-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD)
  while read -r k; do [ -n "$k" ] && EXTRA+=(--clone "$k"); done < "$D/venues/accounts.txt"
  for f in "$D"/venues/patched/*.json; do EXTRA+=(--account "$(basename "$f" .json)" "$f"); done
fi
for so in "${SO_DIR:-$D/so}"/*.so; do n=$(basename "$so" .so); [ -f "$D/secrets/$n.json" ] && EXTRA+=(--bpf-program "$(solana-keygen pubkey "$D/secrets/$n.json")" "$so"); done
if [ "${MUTANTS:-0}" = 1 ]; then
  for so in "$D"/mut/${MUTSET:-}*.so; do n=$(basename "$so" .so); EXTRA+=(--bpf-program "$(solana-keygen pubkey "$D/secrets/$n.json")" "$so"); done
fi
nohup solana-test-validator --ledger "$LEDGER" --rpc-port "$VPORT" --faucet-port $((VPORT + 1000)) --gossip-port $((VPORT - 800)) --dynamic-port-range "$DYN-$((DYN + 60))" --limit-ledger-size 20000 \
  --url "$MAINNET" --clone-feature-set \
  --upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG "$D/squads-mainnet/squads.so" HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2 \
  --account GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus "$D/squads-mainnet/config.json" \
  --upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$D/token-mainnet/token2022.so" HT3JknwuufXdtVJggz5Z9JcnYtanPpLzTCqLWsVX1Vu2 \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/venue.json")" "$D/fixtures/venue.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/venue-b.json")" "$D/fixtures/venue.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/hostile.json")" "$D/fixtures/hostile.so" \
  --bpf-program "$(solana-keygen pubkey "$D/secrets/prime-session.json")" "$PS_SO" \
  "${EXTRA[@]}" \
  --quiet > "$L/validator-$VPORT.log" 2>&1 &
echo $! > "$D/validator.$VPORT.pid"
echo "validator pid $(cat "$D/validator.$VPORT.pid") rpc $VPORT"
