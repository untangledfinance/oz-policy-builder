#!/usr/bin/env bash
# Compares a built artifact's sha256 with the value recorded in build-hashes.json.
# Usage: check-build-hash.sh <contract, e.g. solana/custody-gate> <built artifact>
set -euo pipefail

contract="$1"
artifact="$2"
record="$(dirname "$0")/build-hashes.json"

built=$(sha256sum "$artifact" | cut -d' ' -f1)
pinned=$(jq -r --arg c "$contract" '.sha256[$c] // empty' "$record")
echo "built:  $built"
echo "pinned: $pinned"
if [ -z "$pinned" ]; then
  echo "no hash recorded for $contract in $record"
  exit 1
fi
if [ "$built" != "$pinned" ]; then
  echo ""
  echo "The recorded $contract build is not the artifact this tree builds."
  echo "Either the source changed without the record, or the toolchain moved."
  echo "Update $record together with the source, and the README build table."
  exit 1
fi
