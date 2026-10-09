#!/usr/bin/env bash
cd /home/ubuntu/work/seat-spike/stellar
export SST_U32=1 SST_LOCAL=1 SST_STATE=/home/ubuntu/work/seat-spike/stellar/state-sst-u32.json SST_WASM=/home/ubuntu/work/seat-spike/stellar/prime-seat-u32/target/wasm32v1-none/release/prime_seat_u32.wasm
for p in setup rules baseline votes summary; do bun sst.ts $p > local-u32-$p.log 2>&1; done
echo finished > local-u32.done
