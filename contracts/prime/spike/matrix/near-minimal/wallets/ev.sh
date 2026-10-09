#!/bin/bash
# usage: ev.sh <port> '<js body>'
curl -s -m ${EVT:-110} -X POST --data-binary "$2" http://127.0.0.1:$1/eval; echo
