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

/** `Host` and `Origin` values that name this server. A page on another site that rebinds its
 *  own name to 127.0.0.1 sends its own, so any other is refused (the MCP transport rule). */
const ours = (port: number) =>
  new Set([...LOOPBACK].flatMap((h) => [`${h}:${port}`, `[${h}]:${port}`]))

export interface HttpOptions {
  port: number
  host?: string
  path?: string
  allowExternalHost?: boolean
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** The body as JSON, or a RangeError past MAX_BODY. It stops reading without destroying the
 *  request: leaving a `for await` over it early destroys it, and Bun 1.3 then answers 200 with an
 *  empty body before the 413 can be written. */
function json(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const onData = (c: Buffer) => {
      total += c.length
      if (total <= MAX_BODY) return void chunks.push(c)
      req.off('data', onData).off('end', onEnd).pause()
      reject(new RangeError('too large'))
    }
    const onEnd = () => {
      try {
        resolve(total === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    }
    req.on('data', onData).on('end', onEnd).on('error', reject)
  })
}

export async function startHttpServer(opts: HttpOptions) {
  const host = opts.host ?? '127.0.0.1'
  const path = opts.path ?? '/mcp'
  if (!LOOPBACK.has(host) && opts.allowExternalHost !== true) {
    throw new Error(
      `refusing to bind ${host}: the MCP surface is unauthenticated; pass allowExternalHost to opt in`
    )
  }
  // Behind the caller's own front end (allowExternalHost) the names are theirs to check.
  const guard = LOOPBACK.has(host)
  // Read once at listen time: `http.address()` is null after close, and a null port would turn
  // the DNS-rebinding guard's name set into garbage on a late request.
  let boundPort = opts.port
  // The whole body runs inside one try/catch so no input can crash the process: a malformed
  // request target, a header the guard reads, or a handler fault all answer with a status.
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // The DNS-rebinding guard runs FIRST, before anything that could throw: an untrusted page may
    // send any target or headers, and a request that fails the guard is refused unconditionally.
    const origin = req.headers.origin
    if (guard) {
      const names = ours(boundPort)
      if (
        !names.has(req.headers.host ?? '') ||
        (origin !== undefined && !names.has(origin.replace(/^https?:\/\//, '')))
      )
        return send(res, 403, { error: 'forbidden host or origin' })
    }
    // The path without parsing a URL: `req.url` may be a target the URL constructor rejects
    // (`//[`, a bad port, an authority-form value), and the server must not throw on it.
    const pathname = (req.url ?? '/').split(/[?#]/, 1)[0]
    if (pathname !== path) return send(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    let body: unknown
    try {
      body = await json(req)
    } catch (e) {
      if (!(e instanceof RangeError)) return send(res, 400, { error: 'invalid JSON body' })
      // The rest of the body is never read, so the connection cannot carry another request.
      res.setHeader('connection', 'close')
      return send(res, 413, { error: 'request body too large' })
    }
    if (Array.isArray(body))
      return send(res, 400, { error: 'JSON-RPC batch requests are not supported' })
    const gone = new AbortController()
    const server = createMcpServer(gone.signal)
    const transport = new StreamableHTTPServerTransport()
    res.on('close', () => {
      gone.abort()
      void Promise.allSettled([transport.close(), server.close()])
    })
    await server.connect(transport as unknown as Transport)
    await transport.handleRequest(req as IncomingMessage & { auth?: never }, res, body)
  }
  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.end()
      else send(res, 500, { error: 'internal server error' })
    })
  })
  await new Promise<void>((resolve, reject) =>
    http.once('error', reject).listen(opts.port, host, resolve)
  )
  boundPort = (http.address() as AddressInfo).port
  return {
    port: boundPort,
    host,
    path,
    close: () => new Promise<void>((r) => http.close(() => r())),
  }
}
