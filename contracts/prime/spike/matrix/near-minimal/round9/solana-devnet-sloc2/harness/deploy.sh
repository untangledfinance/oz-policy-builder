#!/bin/bash
# usage: deploy.sh <so> <len> <program-keypair> <buffer-keypair> <log>
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
PAYER=/home/ubuntu/work/swig-spike/secrets/payer-keypair.json
SO=$1; LEN=$2; PK=$3; BK=$4; LOG=$5
{
solana -u devnet --keypair $PAYER program write-buffer $SO --buffer $BK --with-compute-unit-price 0 2>&1 | grep -v 'seed phrase\|^[a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]* [a-z]*$'
solana -u devnet --keypair $PAYER program deploy --buffer $BK --program-id $PK --max-len $LEN --upgrade-authority $PAYER 2>&1
} >> $LOG
