import { describe, expect, it } from 'bun:test'

describe('stdio', () => {
  it('speaks line-delimited JSON-RPC: initialize, then tools/list', async () => {
    const proc = Bun.spawn(['bun', new URL('../bin/server.ts', import.meta.url).pathname], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const send = (m: object) => proc.stdin.write(`${JSON.stringify(m)}\n`)
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await proc.stdin.flush()
    const reader = proc.stdout.getReader()
    let text = ''
    while (!text.includes('"id":2')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    proc.kill()
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0].result.serverInfo.name).toBe('policy-builder-mcp')
    expect(lines[1].result.tools.map((t: { name: string }) => t.name)).toContain('install_policy')
  })
})
