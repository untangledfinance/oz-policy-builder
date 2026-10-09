#!/usr/bin/env bash
# run-diff.sh <binary> <out> <seed> kind...: one million scenarios per kind
BIN=$1; OUT=$2; SEED=$3; shift 3
for k in "$@"; do echo "== $k"; KIND=$k QUIET=1 $BIN 1000000 $SEED; done > $OUT 2>&1
