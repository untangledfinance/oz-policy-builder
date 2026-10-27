// One JSON-RPC client for the Solana and EVM chain reads: a POST per call over the operator's
// endpoint, bounded in time, and every failure a retryable refusal. A tool never takes the
// endpoint as input (an answer binds to whoever served it); the operator sets it in the
// environment, and a library caller may pass its own function instead.

import { messageOf, Refusal } from './envelope.ts'

/** A JSON-RPC call: the result, or a thrown `RpcError` (the node answered with an error) or
 *  `Refusal` (it could not be asked). */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

/** An error the node answered with (an `eth_call` revert, for one): the node was reached. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/

/** Whether `url` is a loopback endpoint (a local validator or fork, or a test's replay server). */
export const isLoopback = (url: string): boolean => LOOPBACK.test(url)

/** A client for `url`: https, or plain http to a loopback host only. */
export function httpRpc(
  url: string,
  o: { timeoutMs?: number; signal?: AbortSignal | undefined; what: string }
): Rpc {
  if (!url.startsWith('https://') && !isLoopback(url))
    throw new Refusal('INVALID_INPUT', `the ${o.what} RPC endpoint must be https`)
  let id = 0
  return async (method, params) => {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 20_000)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      body = (await res.json()) as typeof body
    } catch (e) {
      throw new Refusal(
        'SIMULATION_ERROR',
        `the ${o.what} RPC did not answer ${method}: ${messageOf(e)}`,
        {
          retryable: true,
        }
      )
    }
    if (body === null || typeof body !== 'object')
      throw new Refusal(
        'SIMULATION_ERROR',
        `the ${o.what} RPC answered ${method} with no JSON-RPC body`,
        {
          retryable: true,
        }
      )
    if (body.error)
      throw new RpcError(
        Number(body.error.code ?? 0),
        `${method}: ${String(body.error.message ?? 'error')}`.slice(0, 512),
        body.error.data
      )
    if (!('result' in body))
      throw new Refusal('SIMULATION_ERROR', `the ${o.what} RPC answered ${method} with no result`, {
        retryable: true,
      })
    return body.result
  }
}

/** A node error where a read had to succeed: the review cannot be made, so it is refused (retryable). */
export const unread = (what: string, e: unknown): Refusal =>
  e instanceof Refusal
    ? e
    : new Refusal('SIMULATION_ERROR', `could not read ${what}: ${messageOf(e)}`, {
        retryable: true,
      })
