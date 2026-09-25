#!/usr/bin/env bash
# Reproducible release build of the interpreter wasm.
#
# A plain `cargo build --release --target wasm32v1-none` is NOT reproducible:
# rustc bakes the absolute paths of the crate root and of the registry sources
# into the binary, so the same commit yields a different sha256 on every machine
# and the deployed bytecode cannot be checked against this source. Three builds
# of one commit produced three hashes before this script existed.
#
# `--remap-path-prefix` rewrites both roots to fixed strings, which makes the
# output independent of where the crate and CARGO_HOME happen to live. Verified
# byte-identical across differing source paths and differing CARGO_HOMEs.
#
# The output depends on the host OS: the same commit builds one hash on Linux
# (x86_64 CI and an aarch64 rust:1.97.1 container agree) and another on macOS.
# CI builds on Linux, so a hash meant to be compared there must come from a
# Linux build, e.g. `docker run --rm -v "$PWD":/w -w /w/contracts/policy-interpreter
# rust:1.97.1 sh -c 'rustup target add wasm32v1-none && ./build-wasm.sh'`.
#
# `trim-paths = "all"` in [profile.release] would be tidier, but it is still
# nightly-only on the pinned 1.97.1 toolchain and fails the build on stable.
#
# ALWAYS build through this script when the output is going to be deployed or
# compared against PINNED_INTERPRETER_WASM_SHA256. A bare cargo build is fine
# for tests, where the bytes do not matter.
set -euo pipefail

cd "$(dirname "$0")"
crate_root="$(pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"

export RUSTFLAGS="--remap-path-prefix=${cargo_home}/registry/src=/cargo --remap-path-prefix=${crate_root}=/src ${RUSTFLAGS:-}"

cargo build --release --target wasm32v1-none "$@"

wasm="target/wasm32v1-none/release/policy_interpreter.wasm"
sha256sum "$wasm" | cut -d' ' -f1
