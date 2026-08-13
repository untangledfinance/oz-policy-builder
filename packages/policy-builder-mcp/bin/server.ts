#!/usr/bin/env node

// packages/policy-builder-mcp/bin/server.ts - CLI entry point selecting the transport.
//
// Usage:
//   policy-builder-mcp                (stdio - default; Claude Desktop / local agents)
//   policy-builder-mcp --http         (Streamable HTTP transport; localhost:PORT)
//   policy-builder-mcp --http-port N  (override the HTTP port; default 3001)

import { startHttpServer } from '../src/transports/http.ts'
import { startStdioServer } from '../src/transports/stdio.ts'

const args = process.argv.slice(2)
const wantsHttp = args.includes('--http')
let port = 3001
const portIdx = args.indexOf('--http-port')
if (portIdx >= 0 && args[portIdx + 1]) {
  const n = Number(args[portIdx + 1])
  if (Number.isInteger(n) && n > 0 && n < 65536) port = n
}

if (wantsHttp) {
  await startHttpServer({ port })
} else {
  await startStdioServer()
}
