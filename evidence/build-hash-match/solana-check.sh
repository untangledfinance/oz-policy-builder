#!/usr/bin/env bash
# Build-hash match of the Solana devnet programs Prime configures against the commits
# docs/solana.md cites. Needs Docker, solana-verify 0.5.2 and the Solana CLI.
#
#   KLEND_DIR=<Kamino-Finance/klend checkout> SMRT_DIR=<Squads smart-account-program checkout> \
#     ./solana-check.sh
#
# Each checkout is built in a clean detached worktree at the commit, with solana-verify's
# Docker image: klend with the image solana-verify picks from its Cargo.lock (Solana
# 1.17.18, as Kamino's CI does), the Squads program with the image its README pins for
# the verified mainnet build. Reads devnet only; sends nothing.
set -euo pipefail
KLEND_DIR=${KLEND_DIR:?klend checkout}
SMRT_DIR=${SMRT_DIR:?smart-account-program checkout}
WORK=${WORK:-$(mktemp -d)}
URL=${URL:-https://api.devnet.solana.com}
KLEND_COMMITS=${KLEND_COMMITS:-e921c64}
SMRT_COMMITS=${SMRT_COMMITS:-0e51082}
SMRT_IMAGE=solanafoundation/solana-verifiable-build@sha256:1388b6e423013b0a4a1b67b3481b1c35f5a13034af97d9059439d923c19f1c87
KLEND=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
SMRT=SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG

echo "date $(date -u +%FT%TZ)  $(solana-verify --version)  $(solana --version | head -1)"
for p in $KLEND $SMRT; do
  pd=$(curl -s "$URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$p\",{\"encoding\":\"jsonParsed\"}]}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["value"]["data"]["parsed"]["info"]["programData"])')
  info=$(curl -s "$URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$pd\",{\"encoding\":\"jsonParsed\",\"dataSlice\":{\"offset\":0,\"length\":0}}]}")
  echo "devnet $p programData $pd $(echo "$info" | python3 -c 'import json,sys; i=json.load(sys.stdin)["result"]["value"]["data"]["parsed"]["info"]; print("deploySlot", i["slot"], "authority", i["authority"])')"
  echo "devnet $p program hash $(solana-verify get-program-hash -u "$URL" "$p")"
done

build() { # repo commit library-name image-args...
  local repo=$1 commit=$2 lib=$3; shift 3
  local dir="$WORK/$(basename "$repo")-$commit"
  [ -d "$dir" ] || git -C "$repo" worktree add --detach "$dir" "$commit" >/dev/null
  (cd "$dir" && solana-verify build "$@" >"$dir.build.log" 2>&1)
  echo "build $(basename "$repo") $(git -C "$dir" rev-parse HEAD) $lib.so $(stat -c %s "$dir/target/deploy/$lib.so") B executable hash $(solana-verify get-executable-hash "$dir/target/deploy/$lib.so")"
}
for c in $KLEND_COMMITS; do build "$KLEND_DIR" "$c" kamino_lending; done
for c in $SMRT_COMMITS; do build "$SMRT_DIR" "$c" squads_smart_account_program --library-name squads_smart_account_program --base-image "$SMRT_IMAGE"; done
