#!/usr/bin/env bash
# bld.sh <variant.rs> <out-name>: builds the variant in gate/ and copies the .so to so/<out-name>.so
set -e
D=$(cd "$(dirname "$0")" && pwd)
export PATH=/home/ubuntu/work/swig-spike/solana-release/bin:$PATH
cp "$1" "$D/gate/src/lib.rs"
cd "$D/gate"
cargo-build-sbf --offline > "$D/so/build-$2.log" 2>&1 || { tail -30 "$D/so/build-$2.log"; exit 1; }
cp target/deploy/gate.so "$D/so/$2.so"
echo "$2 $(stat -c %s "$D/so/$2.so") $(sha256sum "$D/so/$2.so" | cut -c1-16)"
