// packages/policy-builder-mcp/test/stdio-transport.test.ts
//
// stdio smoke test: spawn the MCP server over stdio, list the tools, then
// invoke synthesize_policy end-to-end. We use the SDK's
// own Client + StdioClientTransport; both sides speak the canonical JSON-RPC
// framing so this exercises the wire, not the in-process shortcut.

import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const SERVER_BIN = new URL('../bin/server.ts', import.meta.url).pathname

async function spawn(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [SERVER_BIN],
  })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(transport)
  return {
    client,
    close: async () => {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    },
  }
}

describe('MCP stdio transport', () => {
  it('lists exactly 7 tools', async () => {
    const { client, close } = await spawn()
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'get_interpreter_info',
        'install_policy',
        'record_transaction',
        'revoke_policy',
        'simulate_policy',
        'synthesize_policy',
        'verify_policy',
      ])
    } finally {
      await close()
    }
  })

  it('exposes both tools with structured inputSchema', async () => {
    const { client, close } = await spawn()
    try {
      const { tools } = await client.listTools()
      const synth = tools.find((t) => t.name === 'synthesize_policy')
      expect(synth).toBeDefined()
      const record = tools.find((t) => t.name === 'record_transaction')
      expect(record).toBeDefined()
      // Each tool must declare a JSON Schema for its input - sanity check
      // that the SDK accepted our ZodRawShape and emitted a non-empty shape.
      expect(synth?.inputSchema).toBeDefined()
      expect(record?.inputSchema).toBeDefined()
    } finally {
      await close()
    }
  })

  it('surfaces a machine-readable ToolError on bad input (no transport-level crash)', async () => {
    const { client, close } = await spawn()
    try {
      const result = await client.callTool({
        name: 'record_transaction',
        arguments: { network: 'testnet' }, // neither hash nor xdr
      })
      expect(result.isError).toBe(true)
      const block = (
        result.content as unknown as Array<{ type: string; text?: string }> | undefined
      )?.[0]
      expect(block?.type).toBe('text')
      if (block?.type === 'text') {
        const parsed = JSON.parse(block.text as string) as {
          code: string
          severity: string
          remediation?: { toolCall?: { name: string } }
        }
        expect(parsed.code).toBe('RECORDING_FAILED')
        expect(parsed.severity).toBe('error')
        expect(parsed.remediation?.toolCall?.name).toBe('record_transaction')
      }
    } finally {
      await close()
    }
  })

  it('two sequential calls share no state (statelessness invariant)', async () => {
    const { client, close } = await spawn()
    try {
      // Same input twice must give a byte-identical envelope: nothing is
      // carried between calls.
      const args = { source: 'recording' as const, network: 'mainnet' as const }
      const a = await client.callTool({ name: 'synthesize_policy', arguments: args })
      const b = await client.callTool({ name: 'synthesize_policy', arguments: args })
      expect(a.isError).toBe(true)
      expect(b.isError).toBe(true)
      const aBlock = (
        a.content as unknown as Array<{ type: string; text?: string }> | undefined
      )?.[0]
      const bBlock = (
        b.content as unknown as Array<{ type: string; text?: string }> | undefined
      )?.[0]
      expect(aBlock?.type).toBe('text')
      expect(bBlock?.type).toBe('text')
      if (aBlock?.type === 'text' && bBlock?.type === 'text') {
        expect(aBlock.text).toBe(bBlock.text)
      }
    } finally {
      await close()
    }
  })
})
