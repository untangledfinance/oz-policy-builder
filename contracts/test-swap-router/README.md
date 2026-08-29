# test-swap-router

A swap-shaped stub, **for testnet verification only**.

A slippage floor bounds one argument of a call against another
(`out >= in * 99/100`), so evidencing it on chain needs a target whose call
carries two numeric arguments in that order. SoroSwap publishes no testnet
router, and the address this repository names for mainnet has no contract
deployed on testnet, so without a stub the floor could only ever be shown from
the deny-case harness.

This stub plays that role. `swap(amount_in, amount_out, to)` calls
`to.require_auth()` and returns; it does not swap, price, or move anything. The
`require_auth` is the point - the OZ account only consults the policy when the
auth context is non-empty, so without it the call would be permitted for the
wrong reason and the test would prove nothing.

The argument **order** is the contract: the predicate reads the input at index 0
and the output at index 1, so a stub taking them the other way round would make
the floor pass while bounding the wrong number.

It is **not** a router and is never deployed to mainnet. See the rationale in
[`Cargo.toml`](./Cargo.toml) and the file-level comment of
[`src/lib.rs`](./src/lib.rs).
