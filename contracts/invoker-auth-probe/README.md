# invoker-auth-probe

TEST FIXTURE ONLY. Never deployed to mainnet, and nothing depends on it at
runtime.

Two designs in this repository rest on Soroban's contract-invoker rule — that
`require_auth()` is satisfied for free when the address being asked is the
contract that made the call:

- the **custody gate** holds the SAC allowance and calls `transfer_from` with
  itself as spender;
- the gate admits only one caller, by asking that caller to authorise.

Nothing in the repository proved either, so this contract asks the live network
instead. `scripts/verify-invoker-auth-testnet.ts` deploys two instances of it
and runs three cases: the spender case, the caller case, and — so the second is
not vacuous — the same check against an address that did not authorise, which
must be refused.

Build:

    cargo build --release --target wasm32v1-none
