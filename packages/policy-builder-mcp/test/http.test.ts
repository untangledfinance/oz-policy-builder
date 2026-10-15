import { afterAll, describe, expect, it } from 'bun:test'
import { startHttpServer } from '../src/http.ts'

const server = await startHttpServer({ port: 0 })
afterAll(() => server.close())
const url = `http://127.0.0.1:${server.port}${server.path}`
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}
const post = (body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })

describe('Streamable HTTP, stateless', () => {
  it('serves tools/list and a tool call, one server per request', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }
    expect((await post(init)).status).toBe(200)
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(await list.text()).toContain('get_interpreter_info')
    const call = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_interpreter_info', arguments: {} },
    })
    expect(await call.text()).toContain('grammarVersion')
  })

  it.each([
    [
      'another path',
      () => fetch(`http://127.0.0.1:${server.port}/other`, { method: 'POST', headers, body: '{}' }),
      404,
    ],
    ['GET', () => fetch(url), 405],
    ['invalid JSON', () => fetch(url, { method: 'POST', headers, body: '{' }), 400],
    ['a batch', () => post([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]), 400],
    [
      'a body over 1 MiB',
      () =>
        fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }),
        }),
      413,
    ],
  ])('answers %s with %d', async (_n, send, status) => expect((await send()).status).toBe(status))

  it('binds loopback only, unless the caller opts in to being exposed', async () => {
    await expect(startHttpServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/refusing to bind/)
    const open = await startHttpServer({ port: 0, host: '0.0.0.0', allowExternalHost: true })
    await open.close()
  })
})
