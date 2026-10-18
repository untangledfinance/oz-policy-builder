#!/usr/bin/env bash
# mk.sh <old.rs> <new.rs>: installs both sources as host modules and builds the differential test
cd "$(dirname "$0")"
for w in old new; do f=$1; [ $w = new ] && f=$2
  sed -e 's/^entrypoint!(process);$//' -e 's/^fn process(/pub fn process(/' -e 's/^\(const \(SQUADS\|TOKEN\)\)/pub \1/' "$f" > src/$w.rs
done
CARGO_TARGET_DIR=$PWD/target cargo build --release --offline 2>&1 | grep -E '^(error|warning: unused)' -A6 | head -40
