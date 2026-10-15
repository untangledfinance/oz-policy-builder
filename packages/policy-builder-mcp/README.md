# @crediolabs/policy-builder-mcp

An [MCP](https://modelcontextprotocol.io) server for the OZ Policy Builder
(grammar 7). It registers the seven tools of
[`@crediolabs/policy-synth`](https://www.npmjs.com/package/@crediolabs/policy-synth)
exactly as that package defines them (`record_transaction`, `synthesize_policy`,
`simulate_policy`, `verify_policy`, `install_policy`, `revoke_policy`,
`get_interpreter_info`): name, description and input schema come from its table,
and so does every answer. A result is the tool's data as JSON text and as
`structuredContent`; a refusal sets `isError` and carries the error envelope
(`code`, `message`, `severity`, `retryable`).

## Run

```json
{ "mcpServers": { "policy-builder": {
  "command": "npx", "args": ["-y", "@crediolabs/policy-builder-mcp"] } } }
```

`policy-builder-mcp` serves stdio. `policy-builder-mcp --http [--http-port N]`
serves stateless Streamable HTTP at `POST /mcp` on loopback; the surface has no
authentication, so a non-loopback host is refused unless the embedding code passes
`allowExternalHost` (`startHttpServer`).

The server holds no key material: install and revoke return unsigned XDR for a
wallet to sign. See the [agent manual](../../.claude/skills/oz-policy-builder/SKILL.md)
for which tool to call for which intent.

## License

MIT
