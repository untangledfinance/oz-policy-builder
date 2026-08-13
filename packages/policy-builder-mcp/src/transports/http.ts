// packages/policy-builder-mcp/src/transports/http.ts
//
// Streamable HTTP transport (hosted). Uses the Node http module directly so
// the package stays thin - no express / hono dep. We run in STATELESS mode
// (sessionIdGenerator: undefined) so each POST /mcp is its own transaction:
// this matches the brief's "stateless across calls" invariant.
//
// Single endpoint: POST /mcp (the SDK also accepts GET for SSE streaming, but
// the T1 surface does not emit server-initiated messages so we omit it).
// Listens on 127.0.0.1 by default.
//
// SECURITY BOUNDARY: the MCP server has NO auth - any request is processed.
// Binding to a non-loopback interface (e.g. `0.0.0.0`, `::`, an external
// NIC) would expose that unauthenticated surface to every reachable host
// (LAN peers, public cloud metadata, the open internet on a misconfigured
// VPS). The host boundary is therefore FAIL-CLOSED: only loopback
// (`127.0.0.1`, `::1`, `localhost`) is accepted by default. A caller that
// KNOWS they want to expose the server MUST pass `allowExternalHost: true`
// explicitly - the flag is the auditable intent. Test runners and the
// in-process CLI client do not need it; they bind 127.0.0.1 already.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ToolError } from '@crediolabs/policy-synth'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from '../server.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export interface StartHttpServerOptions {
  port: number
  host?: string
  /** Path the server mounts the MCP endpoint at. Default `/mcp`. */
  path?: string
  /** Opt-in to binding a NON-loopback host (e.g. `0.0.0.0` to expose the
   *  server on a LAN / public NIC). The MCP surface is unauthenticated, so
   *  this is gated behind a flag: the default refuse-then-opt-in shape
   *  keeps the security boundary auditable in code review. A caller that
   *  sets this is taking responsibility for downstream auth / firewall. */
  allowExternalHost?: boolean
}

export interface RunningHttpServer {
  port: number
  host: string
  path: string
  close: () => Promise<void>
}

/** Stateless Streamable HTTP server. Resolves once the server is listening.
 *  The returned handle exposes `close()` for tests + clean shutdown. */
export async function startHttpServer(opts: StartHttpServerOptions): Promise<RunningHttpServer> {
  const host = opts.host ?? '127.0.0.1'
  const path = opts.path ?? '/mcp'
  // Default-deny: refuse to bind a non-loopback host unless the caller has
  // explicitly opted in. The MCP server has no auth, so the only thing
  // standing between this binary and an open attack surface on `0.0.0.0` is
  // this check; we would rather fail loudly here than silently expose it.
  if (!LOOPBACK_HOSTS.has(host) && opts.allowExternalHost !== true) {
    throw new Error(
      `startHttpServer: refusing to bind host ${host}: the MCP surface is unauthenticated, so only loopback (127.0.0.1, ::1, localhost) is permitted by default. Pass \`allowExternalHost: true\` to opt in to a non-loopback bind.`
    )
  }
  const server = createMcpServer()
  // One transport per server (the SDK reuses the transport for every request
  // in stateless mode). We connect it once at startup and reuse it.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  await server.connect(transport)

  const httpServer: Server = createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: 'missing url' })
      return
    }
    const url = new URL(req.url, `http://${host}`)
    if (url.pathname !== path) {
      sendJson(res, 404, { error: 'not found', path: url.pathname })
      return
    }
    if (req.method !== 'POST') {
      // The SDK ignores non-POST in stateless mode (no GET/SSE needed in T1).
      sendJson(res, 405, { error: 'method not allowed', method: req.method ?? null })
      return
    }

    // Reject an over-cap body fast via Content-Length; the streaming reader is
    // the backstop for chunked/unknown-length requests.
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: 'request body too large' })
      return
    }

    // Read the JSON-RPC body. The SDK accepts a pre-parsed body, so we parse
    // it here rather than the SDK trying to re-stream the raw req.
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'request body too large' })
      } else {
        sendJson(res, 400, { error: 'invalid JSON body' })
      }
      return
    }
    // The T1 surface is one request per call. A JSON-RPC batch (array) is
    // rejected explicitly rather than silently dropping the extra calls.
    if (Array.isArray(body)) {
      sendJson(res, 400, {
        error: 'JSON-RPC batch requests are not supported; send one request per call',
      })
      return
    }

    try {
      // `handleRequest` writes the response and returns once the message has
      // been dispatched. No shared state across calls in stateless mode.
      await transport.handleRequest(req as IncomingMessage & { auth?: never }, res, body)
    } catch {
      // The SDK normally writes structured errors itself; this is a belt +
      // braces guard so a thrown error does not leave the socket hanging.
      if (res.headersSent) {
        res.end()
      } else {
        const error: ToolError = {
          code: 'SYNTHESIS_ERROR',
          message: 'internal server error',
          severity: 'error',
          retryable: false,
        }
        sendJson(res, 500, { error })
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(opts.port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  return {
    port: opts.port,
    host,
    path,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Reject bodies larger than this before buffering the whole payload - a
 *  recorded transaction is far smaller, so this only stops abusive requests. */
const MAX_BODY_BYTES = 1_048_576

/** Distinguishes an over-cap body from a malformed one so the handler can send
 *  a 413 rather than a misleading 400. */
class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}
