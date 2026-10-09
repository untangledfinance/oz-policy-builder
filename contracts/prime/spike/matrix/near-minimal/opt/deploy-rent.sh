#!/usr/bin/env bash
# deploy-rent.sh: deploys every binary listed below on a plain local validator (default rent: 6,960 lamports per byte) and prints the payer's cost and the rent held by the program and
# program-data accounts (the mainnet feature set is cloned: the builds need the sbpf version it enables, which a validator with default features refuses at deploy time), then the same rent at devnet's 5,080 lamports per byte (the rate measured by the devnet run in reports/solana-devnet.md). Uses its own validator at port 9117.
set -u
D=$(cd "$(dirname "$0")" && pwd)
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
P=9117; L=$D/ledger-deploy; rm -rf "$L"
nohup solana-test-validator --ledger "$L" --rpc-port $P --faucet-port $((P + 1000)) --gossip-port $((P - 800)) --dynamic-port-range 20700-20760 --limit-ledger-size 20000 --url https://api.mainnet-beta.solana.com --clone-feature-set --quiet > "$D/deploy-validator.log" 2>&1 &
echo $! > "$D/deploy-validator.pid"
for i in $(seq 1 600); do curl -s -m 2 localhost:$P -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && break; sleep 1; done
URL=http://127.0.0.1:$P
K=$(mktemp -d); solana-keygen new --no-bip39-passphrase --silent -o $K/payer.json
solana airdrop 500 $(solana-keygen pubkey $K/payer.json) --url $URL || { echo 'airdrop failed'; kill $(cat "$D/deploy-validator.pid"); exit 1; }
bal() { solana balance "$1" --url $URL --keypair $K/payer.json --lamports | awk '{print $1}'; }
printf "%-28s %9s %14s %14s %14s %14s\n" build bytes payer_cost_lamports rent_local_lamports rent_devnet_lamports rent_devnet_SOL
while read -r name so; do
  solana-keygen new --no-bip39-passphrase --silent -o $K/$name.json
  b0=$(bal $(solana-keygen pubkey $K/payer.json))
  solana program deploy "$so" --program-id $K/$name.json --keypair $K/payer.json --url $URL --use-rpc > $K/$name.out 2>&1 || { echo "$name deploy failed: $(tail -2 $K/$name.out)"; continue; }
  b1=$(bal $(solana-keygen pubkey $K/payer.json))
  pid=$(solana-keygen pubkey $K/$name.json)
  pd=$(solana program show $pid --url $URL --keypair $K/payer.json | awk '/ProgramData Address/ {print $3}')
  rent=$(( $(bal $pid) + $(bal $pd) )); n=$(stat -c %s "$so")
  dev=$(( (n + 45 + 128) * 5080 + (36 + 128) * 5080 ))
  printf "%-28s %9d %14d %14d %14d %14s\n" $name $n $((b0 - b1)) $rent $dev $(python3 -c "print(round($dev/1e9,4))")
done <<LIST
gate-today $D/gate/old/gate-owned.a4.so
gate-linecut $D/gate/so/gate-lc.so
gate-pinocchio $D/gate/so/gate-pino.so
session-today $D/session/so/today-localnet.so
session-pinocchio $D/session/so/pino-localnet.so
LIST
kill $(cat "$D/deploy-validator.pid") 2>/dev/null; rm -f "$D/deploy-validator.pid"; sleep 2; rm -rf "$L" "$K"
