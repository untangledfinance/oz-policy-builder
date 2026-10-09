#!/usr/bin/env bash
# Remaining parts of the real run under one hold of the shared NEAR lock (the harness resumes from state-sst.json).
cd /home/ubuntu/work/seat-spike/stellar
L=/home/ubuntu/work/prime-refine/logs/seat/stellar
for p in "$@"; do
  echo "== $p start $(date -u +%T)" >> $L/run.out
  bun sst.ts $p > $L/sst-$p.log 2>&1
  echo "== $p exit $? $(date -u +%T)" >> $L/run.out
done
bun verify-sst.ts > $L/verify-sst.log 2>&1; echo "== verify exit $? $(date -u +%T)" >> $L/run.out
cp state-sst.json $L/state-sst.json
echo "== done $(date -u +%T)" >> $L/run.out
