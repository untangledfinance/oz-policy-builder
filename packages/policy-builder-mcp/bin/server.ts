#!/usr/bin/env node
// `policy-builder-mcp` serves stdio; `--http [--http-port N]` serves Streamable HTTP on loopback.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startHttpServer } from '../src/http.ts'
import { createMcpServer } from '../src/server.ts'

const args = process.argv.slice(2)
if (args.includes('--http')) {
  const n = Number(args[args.indexOf('--http-port') + 1])
  await startHttpServer({ port: Number.isInteger(n) && n > 0 && n < 65536 ? n : 3001 })
} else {
  await createMcpServer().connect(new StdioServerTransport())
}
