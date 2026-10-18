#!/bin/bash
# usage: ./d.sh '{"cmd":"text"}'
curl -s -m 60 -X POST http://127.0.0.1:8820 -d "$1"; echo
