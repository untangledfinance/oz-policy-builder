// A JSON-RPC endpoint for tests: replays what a live run recorded. With
// OPB_LIVE=1 it forwards to the network instead and rewrites the recording, so
// the same tests are the live tests and CI runs them offline.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { RPC_URL } from '../src/config.ts'

export const LIVE = process.env.OPB_LIVE === '1'

const key = (b: { method: string; params: unknown }) =>
  `${b.method}:${createHash('sha256').update(JSON.stringify(b.params)).digest('hex').slice(0, 16)}`

export function recorded(name: string) {
  const file = new URL(`../fixtures/rpc/${name}.json`, import.meta.url)
  const store: Record<string, { result?: unknown; error?: unknown }> = LIVE
    ? {}
    : JSON.parse(readFileSync(file, 'utf8'))
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params: unknown }
      const k = key(body)
      if (LIVE) {
        const res = await fetch(RPC_URL.testnet, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = (await res.json()) as { result?: unknown; error?: unknown }
        store[k] = { result: j.result, error: j.error }
      }
      const hit = store[k]
      if (!hit)
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -1, message: `no recording for ${k}` },
        })
      return Response.json({ jsonrpc: '2.0', id: body.id, ...hit })
    },
  })
  return {
    endpoint: {
      network: 'testnet' as const,
      rpcUrl: `http://127.0.0.1:${server.port}`,
      allowUnpinnedRpcUrl: true,
    },
    stop() {
      server.stop(true)
      if (LIVE) writeFileSync(file, `${JSON.stringify(store, null, 1)}\n`)
    },
  }
}
