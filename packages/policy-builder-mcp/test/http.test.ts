import { afterAll, describe, expect, it } from 'bun:test'
import { request as httpRequest } from 'node:http'
import { startHttpServer } from '../src/http.ts'
import { MAX_TOOL_INPUT_ELEMENTS } from '../src/server.ts'

// Hermetic: the tool call below (get_interpreter_info) asks the RPC for the pin's limits and waits up
// to 5 s before it falls back to the recorded ones. Against the public testnet RPC that wait met bun's
// 5 s test timeout whenever the RPC was slow (CI, three times). A closed loopback port refuses at once,
// so the call answers from the recorded limits without the network.
process.env.POLICY_BUILDER_RPC_URL_TESTNET = 'http://127.0.0.1:9'

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

  it('refuses an over-limit tools/call before validating it, with a small answer', async () => {
    // Close to the 1 MiB body cap: half a million elements. Validated one by one, this costs
    // hundreds of MB and answers with one issue per element (tens of MB).
    const n = 500_000
    const body = `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"simulate_policy","arguments":{"calls":[${Array(n).fill('0').join(',')}]}}}`
    expect(body.length).toBeLessThan(1_048_576)
    const t0 = performance.now()
    const res = await fetch(url, { method: 'POST', headers, body })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text.length).toBeLessThan(1024)
    expect(text).toContain('"isError":true')
    expect(text).toContain(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`)
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  it('still validates a call under the limit against its schema', async () => {
    const calls = Array(MAX_TOOL_INPUT_ELEMENTS - 10).fill(0)
    const text = await (
      await post({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'simulate_policy', arguments: { calls } },
      })
    ).text()
    expect(text).toContain('"isError":true')
    expect(text).not.toContain('maximum of')
  })

  it('binds loopback only, unless the caller opts in to being exposed', async () => {
    await expect(startHttpServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/refusing to bind/)
    const open = await startHttpServer({ port: 0, host: '0.0.0.0', allowExternalHost: true })
    await open.close()
  })
})

describe('a web page cannot drive the tools (DNS rebinding)', () => {
  const list = { jsonrpc: '2.0', id: 9, method: 'tools/list' }
  const withHeaders = (h: Record<string, string>) =>
    // fetch refuses to set Host, so go through a raw socket request.
    new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: server.path,
          method: 'POST',
          headers: { ...headers, ...h },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify(list))
    })

  it('refuses a Host that is not this server, and an Origin that is not loopback', async () => {
    expect(await withHeaders({ host: `rebind.attacker.example:${server.port}` })).toBe(403)
    expect(
      await withHeaders({ host: `127.0.0.1:${server.port}`, origin: 'http://evil.example' })
    ).toBe(403)
    expect(await withHeaders({ host: `127.0.0.1:${server.port}`, origin: 'null' })).toBe(403)
  })

  it('serves loopback names and a caller with no Origin (a program, not a page)', async () => {
    expect(await withHeaders({ host: `127.0.0.1:${server.port}` })).toBe(200)
    expect(await withHeaders({ host: `localhost:${server.port}` })).toBe(200)
    expect(
      await withHeaders({
        host: `localhost:${server.port}`,
        origin: `http://localhost:${server.port}`,
      })
    ).toBe(200)
  })
})
