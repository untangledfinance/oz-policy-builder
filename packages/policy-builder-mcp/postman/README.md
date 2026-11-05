# Postman collection

`oz-policy-builder-mcp.postman_collection.json` drives the MCP server over its
Streamable HTTP transport, one request per tool. It is written for the nine
tools of `@crediolabs/policy-builder-mcp` at version 5.2.0 (`record_transaction`,
`synthesize_policy`, `simulate_policy`, `verify_policy`, `install_policy`,
`revoke_policy`, `bind_policy`, `get_interpreter_info`, `review_unsigned`).
[`test/postman.test.ts`](../test/postman.test.ts) fails when a tool is added,
renamed or given an input the collection does not match.

An earlier collection for the eight tools of the 1.x releases is at
[commit 3841372](https://github.com/untangledfinance/oz-policy-builder/blob/3841372/packages/policy-builder-mcp/postman/oz-policy-builder-mcp.postman_collection.json).
It no longer matches the server.

## Use

1. Start the server: `npx -y @crediolabs/policy-builder-mcp@5.2.0 --http --http-port 3011`.
   From a checkout, build `packages/policy-synth` first, then run
   `bun packages/policy-builder-mcp/bin/server.ts --http --http-port 3011`.
2. In Postman, choose Import and select the JSON file.
3. Run the requests in order, or run the collection. `install_policy` stores
   its unsigned transaction in `unsignedXdr`, which `review_unsigned` reads.

From a shell: `newman run oz-policy-builder-mcp.postman_collection.json`.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:3011` | where the server listens; the server refuses any other `Host` or `Origin` |
| `network` | `testnet` | `testnet` or `mainnet` |
| `token` | a testnet token contract | the contract the example rule is about |
| `capAmount` | `10000000` | the cap in the example rule, in the smallest unit |
| `recipient` | the reference account's rule 0 signer | the one address the example rule allows |
| `smartAccount` | the testnet reference account in `deployments/oz-accounts.json` | the account the unsigned transactions are for |
| `sourceAccount` | the rule 0 signer of that account | must sign rule 0 of `smartAccount` |
| `agentSigner` | a public key with no known secret | the signer `install_policy` gives the new rule |
| `executor` | the reference account's no-gate adapter | the adapter `bind_policy` binds |
| `revokeRuleId`, `bindRuleId` | `4`, `3` | rule ids on the reference account |
| `txHash` | a testnet transaction | replace it with a recent hash that invokes a contract function |
| `unsignedXdr` | empty | set by `install_policy` |

`txHash` must name a transaction the RPC still holds (about a week on testnet).
`record_transaction` and the transaction variant of `synthesize_policy` fail
with a recording error once it ages out.

## What it needs

The server holds no key and the collection signs nothing: `install_policy`,
`revoke_policy` and `bind_policy` return unsigned transactions. The checks
(`simulate_policy`, `verify_policy`, `get_interpreter_info` with `verifyLive`)
and the builders read the testnet RPC, so the machine running the server needs
network access. `POLICY_BUILDER_RPC_URL_TESTNET` points them at another
endpoint. The [policy-synth README](../../policy-synth/README.md) lists the
other environment variables.

Every reply is a Server-Sent Events stream with one `data:` line. The `Accept`
header must list both `application/json` and `text/event-stream`. A request
named "(refusal)" expects the tool to refuse (`isError` true).
