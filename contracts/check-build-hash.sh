#!/usr/bin/env bash
# Compares a built artifact's sha256 with the value recorded in build-hashes.json.
# Usage: check-build-hash.sh <contract, e.g. stellar/prime-seat> <built artifact>
# For an EVM entry (evm/<name>:runtime or evm/<name>:creation) the artifact is
# forge's out/<File>.sol/<Contract>.json, and the hash covers the runtime
# (deployedBytecode) or creation (bytecode) code it holds.
set -euo pipefail

contract="$1"
artifact="$2"
record="$(dirname "$0")/build-hashes.json"

case "$contract" in
  evm/*:runtime) field=deployedBytecode ;;
  evm/*:creation) field=bytecode ;;
  evm/*)
    echo "an EVM entry names its code: $contract:runtime or $contract:creation"
    exit 1
    ;;
  *) field="" ;;
esac

if [ -n "$field" ]; then
  built=$(python3 -c '
import hashlib, json, sys
code = json.load(open(sys.argv[1]))[sys.argv[2]]["object"]
if not code.startswith("0x") or len(code) < 4:
    sys.exit("no " + sys.argv[2] + " in " + sys.argv[1])
print(hashlib.sha256(bytes.fromhex(code[2:])).hexdigest())
' "$artifact" "$field")
else
  built=$(sha256sum "$artifact" | cut -d' ' -f1)
fi
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
