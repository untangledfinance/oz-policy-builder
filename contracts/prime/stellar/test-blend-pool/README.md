# test-blend-pool

A Blend-`submit`-shaped stub, **for testnet verification only**.

The OZ account's `__check_auth` only consults the policy when the auth
context is non-empty, so the integration suites need a call target that
invokes `require_auth` the way a real Blend `submit(from, spender, to,
requests)` would. This stub plays that role: same entry-point shape, same
name-keyed `Request` struct, but it moves no tokens and returns `Void`.

Two deployed instances act as "real Blend" and "evil twin" in the
interpreter's integration tests - identical `submit` shape, different
contract address - so the policy's `eq(call_contract, ...)` constraint is
what separates PERMIT from DENY.

It is **not** a production pool and is never deployed to mainnet. See the
rationale in [`Cargo.toml`](./Cargo.toml) and the file-level comment of
[`src/lib.rs`](./src/lib.rs).
