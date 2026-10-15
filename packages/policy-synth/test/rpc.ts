// A JSON-RPC endpoint for tests: replays what a live run recorded. With
// OPB_LIVE=1 it forwards to the network instead and rewrites the recording, so
// the same tests are the live tests and CI runs them offline.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { RPC_URL } from '../src/config.ts'

export const LIVE = process.env.OPB_LIVE === '1'

/** Point a network's endpoint at `url` for the process; returns the undo. */
export function pointAt(network: 'testnet' | 'mainnet', url: string): () => void {
  const name = `POLICY_BUILDER_RPC_URL_${network.toUpperCase()}`
  const before = process.env[name]
  process.env[name] = url
  return () => {
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
}

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
  // The tools read their endpoint from the environment, as an operator configures it.
  const restore = pointAt('testnet', `http://127.0.0.1:${server.port}`)
  return {
    endpoint: { network: 'testnet' as const, rpcUrl: `http://127.0.0.1:${server.port}` },
    stop() {
      restore()
      server.stop(true)
      if (LIVE) writeFileSync(file, `${JSON.stringify(store, null, 1)}\n`)
    },
  }
}

// ---- a network that is only an interpreter: no recording, no account ----

import { Address, xdr } from '@stellar/stellar-sdk'

/** A JSON-RPC endpoint where `address` is a contract running `wasm` and speaking
 *  `grammar`, and every `check` answers `verdict`. `asked` lists the methods the
 *  server was called with (`check` for a verdict, else the RPC method). */
export function fakeInterpreter(address: string, wasm: string, grammar = 7, verdict = 0) {
  const asked: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        id: number
        method: string
        params: { transaction: string }
      }
      let result: unknown
      if (body.method === 'getLedgerEntries') {
        asked.push(body.method)
        const key = xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(address).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
          })
        )
        const data = xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
            contract: new Address(address).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
            val: xdr.ScVal.scvContractInstance(
              new xdr.ScContractInstance({
                executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, 'hex')),
                storage: null,
              })
            ),
          })
        )
        result = {
          latestLedger: 1,
          entries: [
            {
              key: key.toXDR('base64'),
              xdr: data.toXDR('base64'),
              lastModifiedLedgerSeq: 1,
            },
          ],
        }
      } else if (body.method === 'simulateTransaction') {
        const env = xdr.TransactionEnvelope.fromXDR(body.params.transaction, 'base64')
        const op = env.v1().tx().operations()[0]?.body().invokeHostFunctionOp()
        const fn = op?.hostFunction().invokeContract().functionName().toString()
        asked.push(fn === 'check' ? 'check' : `simulate ${fn}`)
        result =
          fn === 'grammar_version'
            ? {
                latestLedger: 1,
                results: [{ xdr: xdr.ScVal.scvU32(grammar).toXDR('base64'), auth: [] }],
              }
            : {
                latestLedger: 1,
                error: `HostError: Error(Contract, #${verdict})\n\nEvent log (newest first):`,
              }
      } else if (body.method === 'getTransaction') {
        asked.push(body.method)
        result = {
          status: 'NOT_FOUND',
          latestLedger: 1,
          oldestLedger: 1,
          latestLedgerCloseTime: '1',
          oldestLedgerCloseTime: '1',
        }
      } else {
        asked.push(body.method)
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: `no ${body.method}` },
        })
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
  return {
    endpoint: { network: 'mainnet' as const, rpcUrl: `http://127.0.0.1:${server.port}` },
    /** Make the tools' mainnet endpoint this one. */
    use: () => pointAt('mainnet', `http://127.0.0.1:${server.port}`),
    asked,
    port: server.port,
    stop: () => server.stop(true),
  }
}
