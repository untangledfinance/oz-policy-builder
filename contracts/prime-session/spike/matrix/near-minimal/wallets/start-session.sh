#!/bin/bash
# usage: start-session.sh <wallet> <port>
cd /home/ubuntu/work/wallet-matrix/real
export DISPLAY=:87
nohup node session.mjs $1 $2 > session-$1.log 2>&1 &
echo $! > session-$1.pid
sleep ${3:-9}; cat session-$1.log | head -3
