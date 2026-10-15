// The MCP server: every tool in the policy-synth table, registered as it is.
// Stateless: a server per transport, nothing cached, no key material.

import { TOOLS } from '@crediolabs/policy-synth/run'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Kept in step with package.json by server.test.ts (a literal, because the CJS build cannot import JSON). */
export const VERSION = '2.0.0'

/** `stop` aborts what a tool is doing (the HTTP client went away), beside the
 *  client's own cancellation. */
export function createMcpServer(stop?: AbortSignal): McpServer {
  // Registering a tool declares the `tools` capability.
  const server = new McpServer({ name: 'policy-builder-mcp', version: VERSION })
  for (const t of TOOLS) {
    // The tool's own strict schema: the SDK's default would strip an unknown key (a typo of
    // `admins` would become the default), where `run` and the CLI refuse it.
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.schema },
      async (args, extra) => {
        const res = await t.run(args, stop ? AbortSignal.any([extra.signal, stop]) : extra.signal)
        const payload = res.ok ? res.data : res.error
        return {
          isError: !res.ok,
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload as Record<string, unknown>,
        }
      }
    )
  }
  return server
}
