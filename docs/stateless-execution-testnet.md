# Stateless execution — testnet deployment

Deployed and verified on 2026-09-16 from contract source commit `47df478`,
branch `feat/policy-signer`. Network: Stellar testnet. Mainnet unchanged.

| Contract | Address |
| --- | --- |
| Interpreter v5 | `CBIQGAHIGCIAC6JJBYQQBTDFNNWQCGPECWRI7NO2PHIYDQV6QDLG6I2W` |
| Stateless adapter | `CBXI2P2YTFSP26YETY3OTUNTD22COI2LRETTEYIFOW3DGJNZFJJPIRSY` |
| Test Prime account | `CD7SCJO5TDK6EZIDSIZ7WH7O56QDFCGNSRAHNLHQJAMMOZWMNMQAVCGJ` |

The interpreter is reusable. This adapter address belongs to the test Prime;
each other Prime deploys its own adapter using Prime as deployer, no constructor,
and salt SHA256("prime.execution.adapter.v1").

## Verified live

Thirteen checks passed. Thirty transaction receipts were independently fetched:
29 successful transactions and one intentionally failed batch.

- Deterministic Prime-authorized adapter deployment succeeds.
- Deployed interpreter/adapter hashes equal the locally tested WASM hashes.
- Adapter instance storage has zero entries.
- Supply of 0.1 testnet XLM into Blend succeeds with allowance to Prime only.
- Withdrawal closes the Prime position and returns funds directly to the wallet.
- Prime and adapter token balances remain zero after successful execution.
- A no-funding action succeeds without consuming wallet allowance.
- Incomplete batch, mismatched funding/supply, excessive amount, wrong recipient,
  direct venue impersonation, and wrong Prime attempts are rejected.
- A transaction deliberately reaches the venue's failure after a wallet pull.
  Its FAILED receipt contains the venue's act trap; wallet, allowance, position,
  and other observed state match their immediate pre-execution snapshot.
- Remaining test allowance was revoked; both allowances and the position are zero.

The rollback check's original evidence `before` snapshot predates the owner's
fixture-configuration transaction. That owner transaction pays its own fee.
The actual rollback assertion compares `after` with a second snapshot taken
immediately before submitting the failed agent transaction. The harness now
records both snapshots explicitly for future runs.

The pool used is
`CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`.
Funding used newly generated Friendbot-funded wallets, not customer funds.
No-funding and deliberate-failure operations use a dedicated test fixture.

## Flow

1. Owner activates the deterministic adapter and installs execution policies.
   Bind all child rules before enabling agent root permissions.
2. Wallet keeps its token allowance to Prime. No adapter allowance is needed.
3. Agent submits the ordered request to the adapter.
4. Adapter declares exact call-context grants and asks Prime to authorize the
   complete request. Interpreter v5 checks existing predicates and the binding.
5. Funds move wallet → adapter → venue; Prime owns the venue position. The batch
   is atomic. No-funding actions skip the token movement.
6. Withdrawals return to the configured wallet.

This is the contract-level flow. UI/SDK rollout and production deployment are
separate. Interpreter production growth remains 24 net lines relative to afa2f18.

## Evidence and reproduction

- [Deployment and flow receipts](stateless-execution-testnet.json)
- [Independent receipt/code/state verification](stateless-execution-testnet-verification.json)
- [Local verification](stateless-execution-verification.md)
- [Adapter API and policy requirements](../contracts/execution-adapter/README.md)

Run `bun scripts/verify-stateless-testnet.ts` from the repository root to perform
read-only verification; RPC transaction retention limits apply to old receipts.

The deployment harness is `scripts/stateless-execution-testnet.ts`. It is fixed
to TESTNET and creates disposable keys in a private file outside the repository.
Use a fresh PRIME_STATE path for a new experiment and PRIME_BUILD for the release
WASM directory. Public reports contain no private keys.
