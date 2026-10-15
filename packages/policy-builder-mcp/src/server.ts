// The MCP server: every tool in the policy-synth table, registered as it is.
// Stateless: a server per transport, nothing cached, no key material.

import { TOOLS } from '@crediolabs/policy-synth/run'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Kept in step with package.json by server.test.ts (a literal, because the CJS build cannot import JSON). */
export const VERSION = '2.0.0'

export function createMcpServer(): McpServer {
  // Registering a tool declares the `tools` capability.
  const server = new McpServer({ name: 'policy-builder-mcp', version: VERSION })
  for (const t of TOOLS) {
    server.tool(t.name, t.description, t.shape, async (args) => {
      const res = await t.run(args)
      const payload = res.ok ? res.data : res.error
      return {
        isError: !res.ok,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload as Record<string, unknown>,
      }
    })
  }
  return server
}
