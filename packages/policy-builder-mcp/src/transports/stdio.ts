// packages/policy-builder-mcp/src/transports/stdio.ts
//
// stdio transport (Claude Desktop / local agents). The MCP SDK reads JSON-RPC
// from stdin and writes to stdout. Each process serves ONE client and exits
// when the client closes the stream. No key custody, no global state; the
// per-call state lives entirely in the McpServer instance.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from '../server.ts'

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // The transport owns the process from here; no shutdown signal handling -
  // SIGPIPE / EOF on stdin terminates the loop naturally.
}
