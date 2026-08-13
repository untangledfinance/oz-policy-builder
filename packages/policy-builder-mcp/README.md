# @crediolabs/policy-builder-mcp

MCP server exposing the OZ Policy Builder toolchain to agents. It wraps
[`@crediolabs/policy-synth`](https://www.npmjs.com/package/@crediolabs/policy-synth):
an agent records a Soroban transaction, synthesises the minimal policy that
permits exactly that flow, verifies and simulates it, and receives an
unsigned install transaction for the user's wallet to sign.

## Run

```sh
# stdio (default; Claude Desktop and local agents)
bunx @crediolabs/policy-builder-mcp

# Streamable HTTP on localhost:3001
bunx @crediolabs/policy-builder-mcp --http
bunx @crediolabs/policy-builder-mcp --http --http-port 8080
```

Claude Desktop / Claude Code configuration:

```json
{
  "mcpServers": {
    "policy-builder": {
      "command": "bunx",
      "args": ["@crediolabs/policy-builder-mcp"]
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `record_transaction` | Decode a transaction (hash or envelope XDR) into a `RecordedTransaction`. |
| `synthesize_policy` | Synthesise a `ProposedPolicy` from a recording or a `MandateSpec`. |
| `simulate_policy` | Replay a recording against a proposed predicate; run the deny-case battery. |
| `verify_policy` | Static minimality check on a proposed predicate. |
| `install_policy` | Build the unsigned `add_context_rule` transaction XDR. |
| `revoke_policy` | Build the unsigned `remove_context_rule` transaction XDR. |
| `get_interpreter_info` | Pinned interpreter address, grammar version and wasm sha256, optionally verified live. |

Failures come back as machine-readable tool errors (stable `code`,
`severity`, `retryable`), never as transport-level throws, so an agent can
branch on them.

## Security model

- **Stateless, no key material.** Install and revoke return *unsigned* XDR;
  the wallet signature is the user-confirmation step.
- **Loopback only by default.** The HTTP transport refuses to bind a
  non-loopback host; it serves `127.0.0.1`, `::1` or `localhost` unless the
  embedding caller explicitly opts out (`allowExternalHost: true` via the
  programmatic API), because the surface is unauthenticated by design.
- See the
  [architecture document](https://github.com/untangledfinance/oz-policy-builder/blob/main/docs/architecture.md)
  for what the on-chain interpreter does and does not enforce, and the
  [repository README](https://github.com/untangledfinance/oz-policy-builder#readme)
  for the contracts' audit status.

## License

MIT
