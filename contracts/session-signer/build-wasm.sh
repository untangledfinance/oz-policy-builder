#!/usr/bin/env bash
# Reproducible release build of this contract's wasm, printing its sha256.
#
# The same build as contracts/policy-interpreter/build-wasm.sh, which says why:
# a bare cargo build bakes the crate root and registry paths into the wasm, so
# its hash differs per machine. Remapping both makes the output depend on the
# source alone - on Linux. macOS builds a different hash from the same source,
# so a hash that is deployed, pinned in the app or compared in CI comes from a
# Linux build (CI, or a rust:1.97.1 container).
set -euo pipefail

cd "$(dirname "$0")"
crate_root="$(pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"

export RUSTFLAGS="--remap-path-prefix=${cargo_home}/registry/src=/cargo --remap-path-prefix=${crate_root}=/src ${RUSTFLAGS:-}"

cargo build --release --target wasm32v1-none "$@"

wasm="target/wasm32v1-none/release/session_signer.wasm"
sha256sum "$wasm" | cut -d' ' -f1
