// src/record/rpc.ts - isolates the network side-effect from the rest of the recorder.
//
// Everything else in the recorder (decode, movements, freshness, validate) is pure.
// Unit tests inject a fetcher so they never hit the network; the integration test
// uses the real Soroban RPC through `createRpcServer`.

import { rpc, type xdr } from '@stellar/stellar-sdk'
import type { Network } from '../types.ts'

/** A trimmed-down view of `rpc.Api.GetSuccessfulTransactionResponse` plus the
 *  failed-shape variant. Both are produced by Soroban RPC `getTransaction` on
 *  a successful or failed tx; missing/pending returns `null`. */
export interface SorobanTxResponse {
  status: 'SUCCESS' | 'FAILED'
  ledger: number
  createdAt: number
  txHash: string
  envelopeXdr: xdr.TransactionEnvelope
  resultXdr?: xdr.TransactionResult
  resultMetaXdr?: xdr.TransactionMeta
  events: rpc.Api.TransactionEvents
}

export type RpcFetcher = (hash: string) => Promise<SorobanTxResponse | null>

/** Exported so the on-chain spec lookup reads from the SAME endpoint the
 *  recorder fetched the transaction from. Two different endpoints could
 *  disagree about what a contract is. */
export const PUBLIC_RPC_URLS: Record<Network, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  // The brief pins testnet; mainnet is left to the caller via injection. We keep
  // a public default that matches the brief's note ("e.g. https://mainnet.sorobanrpc.com").
  mainnet: 'https://mainnet.sorobanrpc.com',
}

/** Build a fetcher backed by the public Soroban RPC for the given network.
 *  Injectable by tests via the `fetcher` parameter to `recordTransaction`. */
export function createRpcServer(network: Network): RpcFetcher {
  const server = new rpc.Server(PUBLIC_RPC_URLS[network], { allowHttp: false })
  return async (hash: string): Promise<SorobanTxResponse | null> => {
    const resp = await server.getTransaction(hash)
    if (resp.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return null
    }
    if (resp.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        status: 'SUCCESS',
        ledger: resp.ledger,
        createdAt: resp.createdAt,
        txHash: resp.txHash,
        envelopeXdr: resp.envelopeXdr,
        resultXdr: resp.resultXdr,
        resultMetaXdr: resp.resultMetaXdr,
        events: resp.events,
      }
    }
    return {
      status: 'FAILED',
      ledger: resp.ledger,
      createdAt: resp.createdAt,
      txHash: resp.txHash,
      envelopeXdr: resp.envelopeXdr,
      resultXdr: resp.resultXdr,
      resultMetaXdr: resp.resultMetaXdr,
      events: resp.events,
    }
  }
}

/** Lightweight reachability probe used by the integration test to decide whether
 *  to run or self-skip. Sends a JSON-RPC `getHealth` to the public endpoint. */
export async function probeNetwork(network: Network, timeoutMs = 3000): Promise<boolean> {
  const url = PUBLIC_RPC_URLS[network]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    })
    if (!resp.ok) return false
    const json = (await resp.json()) as { result?: { status?: string } }
    return json.result?.status === 'healthy'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
