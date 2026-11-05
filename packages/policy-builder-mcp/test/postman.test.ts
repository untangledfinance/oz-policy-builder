import { describe, expect, it } from 'bun:test'
import { TOOLS } from '@crediolabs/policy-synth/run'
import collection from '../postman/oz-policy-builder-mcp.postman_collection.json' with {
  type: 'json',
}

// The Postman collection is a document, so nothing else would notice it going stale. It must name
// every tool the server registers, and each request's arguments (with the collection's variables
// filled in) must pass that tool's own input schema.

interface Item {
  name: string
  item?: Item[]
  request?: { body: { raw: string } }
}
const flat = (items: Item[]): Item[] => items.flatMap((i) => (i.item ? flat(i.item) : [i]))
const vars = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]))
const fill = (raw: string) =>
  raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`the collection uses an undeclared variable ${k}`)
    // Review needs some bytes; the real value is set by install_policy at run time.
    return k === 'unsignedXdr' ? 'AAAA' : (vars[k] as string)
  })

const requests = flat(collection.item as Item[]).map((i) => ({
  name: i.name,
  body: JSON.parse(fill((i.request as { body: { raw: string } }).body.raw)) as {
    method: string
    params?: { name: string; arguments: unknown }
  },
}))
const calls = requests.filter((r) => r.body.method === 'tools/call')

describe('the Postman collection matches the MCP server', () => {
  it('has the initialize and tools/list requests', () => {
    const methods = requests.map((r) => r.body.method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('tools/list')
  })

  it('calls every registered tool, and no other', () => {
    const named = new Set(calls.map((r) => r.body.params?.name))
    expect([...named].sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })

  for (const r of calls) {
    it(`${r.name}: the arguments are the tool's input`, () => {
      const tool = TOOLS.find((t) => t.name === r.body.params?.name)
      if (!tool) throw new Error(`no tool ${r.body.params?.name}`)
      const parsed = tool.schema.safeParse(r.body.params?.arguments)
      expect(parsed.success).toBe(true)
    })
  }
})
