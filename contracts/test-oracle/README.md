# test-oracle

A Reflector-Pulse-compatible price feed, **for testnet verification only**.

Stellar testnet runs a real Reflector instance, but it carries no price
records for the assets the integration suites use, so every oracle read there
fails closed as `ORACLE_MISSING`. That proves the call binds but cannot
exercise the paths that matter: a price inside the bound, a price outside it,
a stale record, two rounds that deviate too far. This contract implements the
methods the interpreter calls (`decimals`, `resolution`, `base`, `prices`)
and lets a test seed exact records, so each path can be driven on a real
network.

It is **not** a production oracle: anyone may write to it. The interpreter
pins its feed address at compile time, so a build pointing here has a
different wasm hash than a mainnet build and the two cannot be confused.

The interpreter's oracle fingerprint pins `decimals`, `resolution` and
`base`; the stub must return the same `base` the interpreter build was
compiled with, or every read fails with `ORACLE_FINGERPRINT_DRIFT`. The
supported combinations are documented in the file-level comment of
[`src/lib.rs`](./src/lib.rs).
