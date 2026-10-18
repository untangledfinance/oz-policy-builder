#!/usr/bin/env bash
# ladder-diff.sh <gate|session> <seed> <n>: builds each ladder rung (r01..) as the new side of the differential test against the original and runs n scenarios per kind.
# Uses a scratch crate in /tmp/ld-<kind> (delete it afterwards: the build target is about 300 MB).
set -u
K=$1; SEED=$2; N=$3; D=$(cd "$(dirname "$0")" && pwd); W=/tmp/ld-$K
SRC=$D/$( [ $K = gate ] && echo diff || echo session/diff )
mkdir -p $W/src; cp $SRC/Cargo.* $W/; cp $SRC/src/main.rs $W/src/
SED=(-e 's/^entrypoint!(process);$//' -e 's/^solana_program::entrypoint!(process);$//' -e 's/^fn process(/pub fn process(/' -e 's/^\(const \(SQUADS\|TOKEN\)\)/pub \1/')
sed "${SED[@]}" $D/$K/variants/old.rs > $W/src/old.rs
export PRIME_CLUSTER=localnet CARGO_TARGET_DIR=$W/target
for r in $D/$K/ladder/r[0-9][0-9].rs; do
  [ $(basename $r) = r00.rs ] && continue
  echo "== $(basename $r .rs)"; sed "${SED[@]}" $r > $W/src/new.rs
  (cd $W && cargo build --release --offline 2>&1 | grep -E '^error' -A8 | head -20)
  BIN=$W/target/release/$( [ $K = gate ] && echo diff || echo sdiff )
  for kind in $( [ $K = gate ] && echo create transfer allow release || echo move revoke ); do KIND=$kind QUIET=1 $BIN $N $SEED | tail -1 | sed "s/^/$kind /" | cut -c1-80; done
done
