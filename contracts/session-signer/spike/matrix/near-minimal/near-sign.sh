#!/bin/bash
# usage: near-sign.sh <freighter|phantom> <domain 0|1> <path> [hex]
N=/home/ubuntu/work/near-session-spike/secrets/near.json
export NEAR_NETWORK=testnet NEAR_ACCOUNT_ID=$(python3 -c "import json;print(json.load(open('$N'))['accountId'])") NEAR_PRIVATE_KEY=$(python3 -c "import json;print(json.load(open('$N'))['secret'])")
export SEP53_CODE_HASH=5LVYEYWkNFZ9FM86Ge7RAVDjL3zzoYMfNnbRGdU2HgKQ TEXT_CODE_HASH=CBSiykn7pJdPm1DpqQmALPdftzZbfH1VZq2C4WfhyU5z
export WALLET=$1 DOMAIN=$2 SPIKE_PATH=$3
[ -n "$4" ] && export SPIKE_SIGN_HEX=$4
exec /home/ubuntu/work/near-wallet-spike/intents/target/debug/examples/matrix_sign
