#!/usr/bin/env bash
# bld-pino.sh <variant.rs> <out-name> [crate dir]: builds the variant in the Pinocchio crate (gate-pino/ next to this script's parent) and copies the .so to so/<out-name>.so
set -e
D=$(cd "$(dirname "$0")" && pwd)
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
C=${3:-$D/../gate-pino}
cp "$1" "$C/src/lib.rs"
cd "$C"
cargo-build-sbf --offline > "$D/so/build-$2.log" 2>&1 || { tail -40 "$D/so/build-$2.log"; exit 1; }
cp target/deploy/gate.so "$D/so/$2.so"
echo "$2 $(stat -c %s "$D/so/$2.so") $(sha256sum "$D/so/$2.so" | cut -c1-16)"
