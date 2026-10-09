#!/bin/bash
# usage: run-evm.sh <port> <name> '<options js object>'
cd /home/ubuntu/work/wallet-matrix/real
EVT=600 ./ev.sh $1 "const m = await import(H+'/lib/evm-flow.mjs?'+Date.now()); return await m.evmFlow(ctx, id, '$2', $3)" > out/run-$2.txt 2>&1
