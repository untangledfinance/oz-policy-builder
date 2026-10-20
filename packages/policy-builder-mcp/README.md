# @crediolabs/policy-builder-mcp

An [MCP](https://modelcontextprotocol.io) server for the OZ Policy Builder.
It registers the eight tools of
[`@crediolabs/policy-synth`](../policy-synth/README.md)
exactly as that package defines them (`record_transaction`, `synthesize_policy`,
`simulate_policy`, `verify_policy`, `install_policy`, `revoke_policy`,
`get_interpreter_info`, `review_unsigned`): name, description and input schema come from its table,
and so does every answer. A result is the tool's data as JSON text and as
`structuredContent`; a refusal sets `isError` and carries the error envelope
(`code`, `message`, `severity`, `retryable`).

## Run

Run it from a checkout of the repository: build `policy-synth` and this package
(`bun run --cwd packages/<name> build`), then point the client at the built
server. The builds on npm are older than this tree.

```json
{ "mcpServers": { "policy-builder": {
  "command": "node", "args": ["/path/to/oz-policy-builder/packages/policy-builder-mcp/dist/bin/server.js"] } } }
```

`policy-builder-mcp` serves stdio. `policy-builder-mcp --http [--http-port N]`
serves stateless Streamable HTTP at `POST /mcp` on loopback; the surface has no
authentication, so a non-loopback host is refused unless the embedding code passes
`allowExternalHost` (`startHttpServer`).

The server holds no key material: install and revoke return unsigned XDR for a
wallet to sign. See the [agent manual](../../.claude/skills/oz-policy-builder/SKILL.md)
for which tool to call for which intent, and the policy-synth README for the
limits, the install guardrails and the operator's environment variables.

## License

MIT
