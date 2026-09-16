# Stateless execution verification — 2026-09-16

Branch: `feat/policy-signer`. Baseline: `afa2f18`.
No deployment, network transaction, allowance change, app pin update, or other
repository change was made.

## Production delta

Interpreter: lib.rs +23/-1; storage.rs +2/-0: **24 net lines**, including comments
and blank lines after rustfmt. No unrelated deletions. Tests are separate.

Adapter: no constructor or storage; per-Prime identity derived from
Prime deployer + SHA256("prime.execution.adapter.v1"). Prime remains the wallet
allowance spender. The new adapter does not use ExecutionPolicy.

## Results

- Interpreter: 138 tests pass (including owner/admin binding authorization,
  binding preservation on reinstall, and document removal on uninstall).
- Adapter: 6 unit tests, 16 authorization integration tests, 1 shared projection
  fixture test pass.
- All 16 integration tests also pass with the compiled adapter AND interpreter
  WASM, alongside real OZ account WASM.
- Regression mutation: removing only the executor authorization gate makes
  `rejects_extra_prime_context_absent_from_approved_batch` fail because the hidden
  venue operation succeeds. Restoring the gate makes it pass.
- Child-policy regression deliberately installs a root that permits amount 11
  while the child retains its <10 restriction; execution is rejected.
- Prime-only allowance supply/withdraw passes with the SDK default budget:
  supply CPU 26,595,337 / memory 7,740,534 bytes; withdrawal CPU 21,957,291 /
  memory 6,086,473 bytes. Adapter allowance is zero. Prime and adapter token
  balances end at zero.
- TypeScript/Rust fixtures agree for nested vectors/maps, authorization trees,
  large i128 values, symbols, addresses, bytes, booleans, strings, and u64.
- All 5 new TypeScript tests and repository TypeScript typechecking pass.
- Full Bun suite: 766 pass, 1 skip, 3 failures. The identical three failures
  reproduce in the untouched baseline's corresponding test files (42 pass,
  3 fail): simulate-verify and install-by-hash depend on an unavailable testnet
  recording; grammar-version-parity sees pre-existing builder v4 vs contract v5.
  They are not silently suppressed or fixed by changing deployed pins.

## Build artifacts

Release target: wasm32v1-none, locked dependencies, offline build.

- Adapter SHA256: `57bf132b9537f0d35b9de4327e047f920938eac655e7d140c108e84da3b03474`
- Interpreter SHA256: `cc05ac55747d2472f6da1fc229a2f9f8083607ba8c08bf5eaeac7cd73ef6fb66`

## Boundaries

This is local host/WASM verification, not a network deployment or a live Blend
trade. Venues and tokens are local fixtures; the agent signer accepts arbitrary
requests intentionally. Execution authorization is enforced; only installation
is mocked. Default-budget success is not a measurement of current network
resource settings.

Safety requires a complete root predicate, all usable child rules bound, and
atomic binding setup or disabled agent permissions until setup is complete.
Grants bind exact context values/counts, not nested-tree positions. A fresh
interpreter deployment is required because StoredDoc changed. Existing v4
generic builder/deployment defaults are unchanged; the new execution builder
explicitly returns grammarVersion 5.

Independent review found no exploitable blocker under those assumptions and
identified the child-predicate test gap, which was corrected.
