// packages/policy-builder-mcp/test/http-transport.test.ts
//
// Streamable HTTP smoke test: start the server in-process, POST initialize
// + tools/list + tools/call directly over the wire, assert canonical shapes.
// Avoids the in-process Client shortcut so the wire framing is exercised.

import { describe, expect, it } from 'bun:test'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { startHttpServer } from '../src/transports/http.ts'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

interface ToolCallResult {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
}

async function postJson(
  port: number,
  body: unknown
): Promise<{ status: number; json: JsonRpcResponse | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: JsonRpcResponse | null = null
  // Streamable HTTP returns SSE by default; the JSON-RPC frame is one event.
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        json = JSON.parse(line.slice('data: '.length)) as JsonRpcResponse
      } catch {
        // ignore non-JSON SSE events (heartbeats)
      }
    }
  }
  return { status: res.status, json }
}

async function waitForPort(port: number, maxMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })
      // Any response (even 4xx) means the listener is up.
      void res
      return
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  throw new Error(`port ${port} did not become ready in ${maxMs}ms`)
}

describe('MCP HTTP transport', () => {
  it('initializes, lists exactly 4 tools, and invokes synthesize_policy', async () => {
    const port = 3891
    const running = await startHttpServer({ port, host: '127.0.0.1' })
    try {
      await waitForPort(port)

      // 1. initialize
      const init = await postJson(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      })
      expect(init.status).toBe(200)
      expect(init.json?.result).toBeDefined()

      // 2. tools/list
      const list = await postJson(port, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })
      const listResult = list.json?.result as { tools: Array<{ name: string }> } | undefined
      expect(listResult?.tools.length).toBe(7)
      const names = listResult?.tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'get_interpreter_info',
        'install_policy',
        'record_transaction',
        'revoke_policy',
        'simulate_policy',
        'synthesize_policy',
        'verify_policy',
      ])

      // 3. tools/call - synthesize_policy with a mandate
      const call = await postJson(port, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'synthesize_policy',
          arguments: {
            source: 'mandate',
            mandate: {
              chain: 'stellar',
              contract: 'CTOKEN',
              spendingLimit: { token: 'CTOKEN', limit: '1', windowSeconds: 60 },
            },
          },
        },
      })
      const callResult = call.json?.result as ToolCallResult | undefined
      expect(callResult).toBeDefined()
      expect(callResult?.isError).toBeFalsy()
      const block = callResult?.content?.[0]
      expect(block?.type).toBe('text')
      if (block?.type === 'text') {
        const parsed = JSON.parse(block.text as string) as {
          contextRule: { contextRuleType: { kind: string } }
          policyRefs: Array<{ kind: string }>
        }
        expect(parsed.contextRule.contextRuleType.kind).toBe('call_contract')
      }
    } finally {
      await running.close()
    }
  })

  it('returns a structured ToolError over HTTP on bad input', async () => {
    const port = 3892
    const running = await startHttpServer({ port, host: '127.0.0.1' })
    try {
      await waitForPort(port)
      // Note: tools/call on its own requires a session id in stateful mode,
      // but in stateless mode the SDK accepts it directly.
      const call = await postJson(port, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'record_transaction',
          arguments: { network: 'testnet' }, // neither hash nor xdr
        },
      })
      const callResult = call.json?.result as ToolCallResult | undefined
      expect(callResult?.isError).toBe(true)
      const block = callResult?.content?.[0]
      if (block?.type === 'text') {
        const parsed = JSON.parse(block.text as string) as { code: string; severity: string }
        expect(parsed.code).toBe('RECORDING_FAILED')
        expect(parsed.severity).toBe('error')
      }
    } finally {
      await running.close()
    }
  })

  it('rejects a JSON-RPC batch (array) instead of silently dropping calls', async () => {
    const port = 3894
    const running = await startHttpServer({ port, host: '127.0.0.1' })
    try {
      await waitForPort(port)
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        ]),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: string }
      expect(String(body.error)).toContain('batch')
    } finally {
      await running.close()
    }
  })

  it('returns 413 for a request body over the size cap', async () => {
    const port = 3895
    const running = await startHttpServer({ port, host: '127.0.0.1' })
    try {
      await waitForPort(port)
      const huge = 'x'.repeat(1_048_577) // one byte over the 1 MiB cap
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: huge,
      })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error?: string }
      expect(String(body.error)).toContain('too large')
    } finally {
      await running.close()
    }
  })

  it('sanitizes unexpected handler errors in HTTP 500 responses', async () => {
    const secretMessage = 'database password leaked from exception'
    const privateStack = 'PRIVATE_STACK_TRACE'
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest
    StreamableHTTPServerTransport.prototype.handleRequest = async () => {
      const error = new Error(secretMessage)
      error.stack = privateStack
      throw error
    }

    const port = 3893
    const running = await startHttpServer({ port, host: '127.0.0.1' })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
      })
      const responseText = await response.text()

      expect(response.status).toBe(500)
      expect(responseText).not.toContain(secretMessage)
      expect(responseText).not.toContain(privateStack)
      expect(JSON.parse(responseText)).toEqual({
        error: {
          code: 'SYNTHESIS_ERROR',
          message: 'internal server error',
          severity: 'error',
          retryable: false,
        },
      })
    } finally {
      StreamableHTTPServerTransport.prototype.handleRequest = originalHandleRequest
      await running.close()
    }
  })
})

// TS-F2: non-loopback host is REFUSED unless the caller opts in.
//
// The MCP surface has no auth, so binding to `0.0.0.0` (or any non-loopback
// host) would expose the unauthenticated surface to every reachable network
// peer. We fail-closed here - a misconfigured deployment crashes instead of
// silently opening the door.
describe('startHttpServer - host binding boundary (TS-F2)', () => {
  it('refuses a non-loopback host (0.0.0.0) without the explicit opt-in', async () => {
    expect(() => startHttpServer({ port: 0, host: '0.0.0.0' })).toThrow(
      /refusing to bind host 0\.0\.0\.0/
    )
  })

  it('refuses a non-loopback host (::) without the explicit opt-in', async () => {
    expect(() => startHttpServer({ port: 0, host: '::' })).toThrow(/refusing to bind host ::/)
  })

  it('accepts 127.0.0.1 without the opt-in (loopback is the default boundary)', async () => {
    const running = await startHttpServer({ port: 0, host: '127.0.0.1' })
    expect(running.host).toBe('127.0.0.1')
    await running.close()
  })

  it('accepts ::1 without the opt-in (IPv6 loopback is the default boundary)', async () => {
    const running = await startHttpServer({ port: 0, host: '::1' })
    expect(running.host).toBe('::1')
    await running.close()
  })

  it('accepts a non-loopback host with the explicit opt-in (auditable intent)', async () => {
    // We bind to the IPv6 unspecified address `::` (== `0.0.0.0` for IPv4)
    // with `allowExternalHost: true`. The test asserts the boundary accepts
    // the flag rather than re-refusing; binding succeeds because `::` is a
    // valid Node listener host.
    const running = await startHttpServer({
      port: 0,
      host: '::',
      allowExternalHost: true,
    })
    expect(running.host).toBe('::')
    await running.close()
  })
})
