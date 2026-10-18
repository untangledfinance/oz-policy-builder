# @crediolabs/policy-builder-cli

Command line for the OZ Policy Builder (grammar 7). Every tool of
[`@crediolabs/policy-synth`](https://www.npmjs.com/package/@crediolabs/policy-synth)
is a command, registered from its table.

```sh
npm install -g @crediolabs/policy-builder-cli@next
```

`next` is 2.0.1, for grammar 7; `latest` is still 1.3.0 (grammar 4).

```sh
policy-builder <tool> [json | --file path | - | --field value ...] [--out path]
```

```sh
policy-builder record --network testnet --hash <tx>
policy-builder synthesize --network testnet --hash <tx> --limit 5000000
policy-builder synthesize '{"intent": {"calls": [{"contract": "C...", "fn": "pay", "where": [{"constraint": "cap", "at": [0], "max": "100"}]}]}}'
policy-builder verify --file verify.json
policy-builder info --verifyLive true
policy-builder review --network testnet --xdr <unsigned XDR>
```

Call a tool by its full name or by a unique start or end of it (`record`,
`synthesize`, `simulate`, `verify`, `install`, `revoke`, `info`, `review`). Input is a JSON
argument, `--file`, `-` (stdin) or `--field value` pairs (a value that is JSON is
read as JSON). One JSON envelope goes to stdout, the same one the MCP server
returns: `{ ok: true, data }` or `{ ok: false, error: { code, message, severity,
retryable } }`. The exit code is 0, 1 for a refusal and 2 for bad usage; `--out`
also writes the envelope to a file.

The CLI holds no key material and signs nothing: `install` and `revoke` return
unsigned XDR. The operator's settings are environment variables:
`POLICY_BUILDER_RPC_URL_TESTNET` / `_MAINNET`, `POLICY_BUILDER_OUT_DIR`,
`POLICY_BUILDER_SAFE_READS_TESTNET` / `_MAINNET`,
`POLICY_BUILDER_ALLOW_SPOT_READS`, `POLICY_BUILDER_ALLOW_OVERRIDES` (mainnet
honours an `allow*` override only with it set to 1), and the bounds on what a wallet signs,
`POLICY_BUILDER_AUTH_LEDGERS` (default 300) and `POLICY_BUILDER_MAX_RESOURCE_FEE`
(default 10 XLM). The tools, their limits and the install
guardrails (threshold or `anyOne`, the spending-limit guard, the read-safety lint,
the overlap scan) are described in the policy-synth README.

`policy-builder review` is for the account owner: it reads an unsigned install or
removal from its bytes alone, with no RPC. It lists the problems it finds in the
bytes (`problems`, `signable`), then a review rebuilt from those bytes: the
transaction, the Authority node and the predicate. `signable` does not mean safe:
an agent can rewrite the bytes consistently, so the owner reads the Authority
node against what they meant (see "The owner's review" in the policy-synth
README).

## License

MIT
