// Streamable HTTP, stateless: one server and transport per POST. The surface has
// no authentication, so only a loopback host is bound unless `allowExternalHost`
// says the caller has put its own in front.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createMcpServer } from './server.ts'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const MAX_BODY = 1_048_576

export interface HttpOptions {
  port: number
  host?: string
  path?: string
  allowExternalHost?: boolean
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY) throw new RangeError('too large')
    chunks.push(c as Buffer)
  }
  return total === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startHttpServer(opts: HttpOptions) {
  const host = opts.host ?? '127.0.0.1'
  const path = opts.path ?? '/mcp'
  if (!LOOPBACK.has(host) && opts.allowExternalHost !== true) {
    throw new Error(
      `refusing to bind ${host}: the MCP surface is unauthenticated; pass allowExternalHost to opt in`
    )
  }
  const http = createServer(async (req, res) => {
    if (new URL(req.url ?? '/', `http://${host}`).pathname !== path)
      return send(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    let body: unknown
    try {
      body = await json(req)
    } catch (e) {
      return send(res, e instanceof RangeError ? 413 : 400, {
        error: e instanceof RangeError ? 'request body too large' : 'invalid JSON body',
      })
    }
    if (Array.isArray(body))
      return send(res, 400, { error: 'JSON-RPC batch requests are not supported' })
    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport()
    res.on('close', () => void Promise.allSettled([transport.close(), server.close()]))
    try {
      await server.connect(transport as unknown as Transport)
      await transport.handleRequest(req as IncomingMessage & { auth?: never }, res, body)
    } catch {
      if (res.headersSent) res.end()
      else send(res, 500, { error: 'internal server error' })
    }
  })
  await new Promise<void>((resolve, reject) =>
    http.once('error', reject).listen(opts.port, host, resolve)
  )
  return {
    port: (http.address() as AddressInfo).port,
    host,
    path,
    close: () => new Promise<void>((r) => http.close(() => r())),
  }
}
