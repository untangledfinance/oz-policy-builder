#!/bin/bash
# usage: run-solana.sh <port> <name> '<options js object>'
cd /home/ubuntu/work/wallet-matrix/real
EVT=600 ./ev.sh $1 "const m = await import(H+'/lib/sol-flow.mjs?'+Date.now()); return await m.solFlow(ctx, id, '$2', $3)" > out/run-$2.txt 2>&1
