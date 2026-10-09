#!/bin/bash
# usage: run-stellar.sh <port> <name> '<options js object>'
cd /home/ubuntu/work/wallet-matrix/real
EVT=600 ./ev.sh $1 "const m = await import(H+'/lib/stellar-flow.mjs?'+Date.now()); return await m.stellarFlow(ctx, id, '$2', $3)" > out/run-$2.txt 2>&1
