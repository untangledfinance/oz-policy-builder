#!/usr/bin/env bash
# Dry run of every part with local keys (no NEAR): SST_LOCAL=1.
cd /home/ubuntu/work/seat-spike/stellar
for p in "$@"; do SST_LOCAL=1 bun sst.ts $p > local-$p.log 2>&1; done
echo finished > local-run.done
