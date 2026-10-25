#!/usr/bin/env bash
# Runs a test command and fails unless it passed at least <minimum> tests and skipped or ignored none, so a CI step
# that finds no tests, or whose tests all skip, cannot pass green. Reads the summary lines of `cargo test` (one per test
# binary, summed) and `forge test`.
#
# Usage: contracts/assert-tests.sh <minimum> <command...>
#   contracts/assert-tests.sh 1 cargo test --locked
#   contracts/assert-tests.sh 1 env FORK_URL=https://sepolia.base.org forge test
set -euo pipefail

if [ $# -lt 2 ] || ! [[ $1 =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <minimum> <command...>" >&2
  exit 2
fi
min=$1
shift

log=$(mktemp)
trap 'rm -f "$log"' EXIT
"$@" 2>&1 | tee "$log"

# cargo: "test result: ok. 46 passed; 0 failed; 0 ignored; ..."
# forge: "Ran 2 test suites in 38ms (9ms CPU time): 51 tests passed, 0 failed, 1 skipped (52 total tests)"
counts=$(
  {
    sed -nE 's/^test result: ok\. ([0-9]+) passed; [0-9]+ failed; ([0-9]+) ignored;.*/\1 \2/p' "$log"
    sed -nE 's/^Ran [0-9]+ test suites?.*: ([0-9]+) tests passed, [0-9]+ failed, ([0-9]+) skipped.*/\1 \2/p' "$log"
  } | awk '{ p += $1; s += $2 } END { print p + 0, s + 0 }'
)
read -r passed skipped <<<"$counts"

echo ""
echo "assert-tests: ${passed} passed, ${skipped} skipped or ignored (minimum ${min} passed, none skipped)"
if [ "$passed" -lt "$min" ]; then
  echo "assert-tests: fewer tests ran than the minimum; a test step that runs nothing must not pass" >&2
  exit 1
fi
if [ "$skipped" -gt 0 ]; then
  echo "assert-tests: tests were skipped or ignored; run them (for the EVM fork suite, set FORK_URL)" >&2
  exit 1
fi
