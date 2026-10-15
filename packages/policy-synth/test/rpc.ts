// A JSON-RPC endpoint for tests: replays what a live run recorded. With
// OPB_LIVE=1 it forwards to the network instead and rewrites the recording, so
// the same tests are the live tests and CI runs them offline.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { RPC_URL } from '../src/config.ts'

export const LIVE = process.env.OPB_LIVE === '1'

const key = (b: { method: string; params: unknown }) =>
  `${b.method}:${createHash('sha256').update(JSON.stringify(b.params)).digest('hex').slice(0, 16)}`

// What no caller reads and the ledger header makes huge.
const slim = (r: unknown) =>
  r && typeof r === 'object'
    ? Object.fromEntries(
        Object.entries(r).filter(
          ([k]) =>
            !['metadataXdr', 'headerXdr', 'events', 'stateChanges', 'diagnosticEventsXdr'].includes(
              k
            )
        )
      )
    : r

export function recorded(name: string) {
  const file = new URL(`../fixtures/rpc/${name}.json`, import.meta.url)
  // A key can be asked more than once with different answers (the latest ledger
  // moves on), so each key keeps its answers in the order they were given.
  const store: Record<string, { result?: unknown; error?: unknown }[]> = LIVE
    ? {}
    : JSON.parse(readFileSync(file, 'utf8'))
  const seen: Record<string, number> = {}
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
        store[k] = [...(store[k] ?? []), { result: slim(j.result), error: j.error }]
      }
      const tape = store[k] ?? []
      const hit = tape[Math.min(seen[k] ?? 0, tape.length - 1)]
      seen[k] = (seen[k] ?? 0) + 1
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
