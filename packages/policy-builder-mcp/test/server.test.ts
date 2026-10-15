import { describe, expect, it } from 'bun:test'
import { TOOLS } from '@crediolabs/policy-synth/run'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pkg from '../package.json' with { type: 'json' }
import { createMcpServer, VERSION } from '../src/server.ts'

async function client() {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createMcpServer().connect(b)
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(a)
  return c
}
const CONTRACT = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

describe('the MCP server registers the table as it is', () => {
  it('reports the published version', () => expect(VERSION).toBe(pkg.version))

  it("lists exactly the seven tools, with the table's descriptions and required inputs", async () => {
    const { tools } = await (await client()).listTools()
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
    for (const t of tools) {
      expect(t.description).toBe(TOOLS.find((x) => x.name === t.name)?.description)
      expect(t.inputSchema.type).toBe('object')
    }
    expect(tools.find((t) => t.name === 'install_policy')?.inputSchema.required).toEqual([
      'smartAccount',
      'sourceAccount',
      'signers',
    ])
  })

  it("a result is the tool's data, as text and as structured content", async () => {
    const r = await (await client()).callTool({ name: 'get_interpreter_info', arguments: {} })
    expect(r.isError).toBe(false)
    expect((r.structuredContent as { grammarVersion: number }).grammarVersion).toBe(7)
    expect(JSON.parse((r.content as { text: string }[])[0]?.text ?? '')).toEqual(
      r.structuredContent
    )
  })

  it('an input key the tool does not know is refused, as it is by run and the CLI (a typo of admins must not become a default)', async () => {
    const intent = { calls: [{ contract: CONTRACT, fn: 'pay' }] }
    const r = await (await client())
      .callTool({ name: 'synthesize_policy', arguments: { intent, typoKey: 1 } })
      .catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }))
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('typoKey')
  })

  it('a refusal is the error envelope: code, message, severity, retryable', async () => {
    const r = await (await client()).callTool({ name: 'synthesize_policy', arguments: {} })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({
      code: 'INVALID_INPUT',
      severity: 'error',
      retryable: false,
    })
    expect((r.structuredContent as { message: string }).message).toContain('exactly one')
  })

  it('synthesizes from an intent end to end', async () => {
    const intent = {
      calls: [{ contract: CONTRACT, fn: 'pay', where: [{ constraint: 'cap', at: [0], max: '5' }] }],
    }
    const r = await (await client()).callTool({ name: 'synthesize_policy', arguments: { intent } })
    const rules = (r.structuredContent as { rules: { review: string[] }[] }).rules
    expect(rules[0]?.review.at(-1)).toBe('argument 0 must be at most 5')
  })
})
