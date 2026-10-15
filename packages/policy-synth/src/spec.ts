// What names a call's arguments: a contract's interface (the `contractspecv0` of its wasm, or
// the SEP-41 table for a Stellar Asset Contract) and, for a token, the unit its amounts are in.
// A token is known only by what cannot be chosen by the contract: a Stellar Asset Contract
// (always 7 decimals, named by its `name()`, `CODE:ISSUER`) or one in the package's own list.
// They only make a review readable, so every step is best effort and bounded: a failure, a
// timeout or an abort leaves the plain wording, and nothing here can touch a verdict.

import { type rpc, contract as soroban, xdr } from '@stellar/stellar-sdk'
import { connect, dataKey, type Endpoint, entries, pool, read } from './chain.ts'
import { type Network, TOKENS } from './config.ts'
import { Refusal } from './envelope.ts'

/** A parameter's type, as far as a path can walk it. An option is its value, an enum or any
 *  type that cannot be walked is its name, and a type that refers back to itself is `deep`. */
export type Ty =
  | string
  | { vec: Ty }
  | { tuple: Ty[] }
  | { map: Ty }
  | { fields: Record<string, Ty> }
export type Fns = Record<string, [name: string, ty: Ty][]>
export interface Info {
  fns?: Fns | undefined
  /** Present for a token whose unit is known; its amounts read in `decimals`, named `symbol`. */
  token?: { decimals: number; symbol: string } | undefined
}

const WASM_MAX = 131_072 // the largest wasm the network accepts
const CONTRACTS_MAX = 16
const WAIT_MS = 2_000
const CACHE_MAX = 64

/** SEP-41, as a Stellar Asset Contract exposes it (it has no wasm, so no spec to read). */
const SEP41 = {
  transfer: 'from to amount',
  transfer_from: 'spender from to amount',
  approve: 'from spender amount expiration_ledger',
  burn: 'from amount',
  burn_from: 'spender from amount',
  mint: 'to amount',
  clawback: 'from amount',
  balance: 'id',
  allowance: 'from spender',
}
const TYPES: Record<string, string> = { amount: 'i128', expiration_ledger: 'u32' }
export const SAC: Fns = Object.fromEntries(
  Object.entries(SEP41).map(([f, ps]) => [f, ps.split(' ').map((p) => [p, TYPES[p] ?? 'address'])])
) as Fns

// Process-lifetime caches, bounded: a spec by its wasm hash (null: a wasm with none to use),
// a Stellar Asset Contract's token by network and address (null: not one). Only an answer is
// kept, never a failure to ask.
const specs = new Map<string, Fns | null>()
const tokens = new Map<string, NonNullable<Info['token']> | null>()
const keep = <V>(m: Map<string, V>, k: string, v: V): V => {
  if (m.size >= CACHE_MAX) m.delete(m.keys().next().value as string)
  return m.set(k, v).get(k) as V
}

/** The functions of a wasm's spec, or null when it has none or is too big to read. */
export function interfaceOf(wasm: Buffer): Fns | null {
  if (wasm.length > WASM_MAX) return null
  try {
    const spec = soroban.Spec.fromWasm(wasm)
    const str = (x: { name(): string | Buffer }) => x.name().toString()
    // Names reach a review as text: only plain identifiers are used.
    const safe = (xs: { name(): string | Buffer }[]) =>
      xs.every((x) => /^(?!(true|false|null)$)[A-Za-z_]\w{0,29}$/.test(str(x)))
    const memo = new Map<string, Ty>()
    const udt = (n: string): Ty => {
      if (memo.has(n)) return memo.get(n) as Ty
      memo.set(n, 'deep') // while it is being read, a reference back to it is a cycle
      const s = spec.entries
        .find((e) => e.switch().name === 'scSpecEntryUdtStructV0' && str(e.udtStructV0()) === n)
        ?.udtStructV0()
        .fields()
      const fields = s && safe(s) && s.map((f) => [str(f), ty(f.type())])
      return memo.set(n, fields ? { fields: Object.fromEntries(fields) } : 'udt').get(n) as Ty
    }
    const ty = (t: xdr.ScSpecTypeDef): Ty => {
      const k = t.switch().name.slice('scSpecType'.length).toLowerCase()
      if (k === 'option') return ty(t.option().valueType())
      if (k === 'vec') return { vec: ty(t.vec().elementType()) }
      if (k === 'map') return { map: ty(t.map().valueType()) }
      if (k === 'tuple') return { tuple: t.tuple().valueTypes().map(ty) }
      return k === 'udt' ? udt(str(t.udt())) : k
    }
    return Object.fromEntries(
      spec
        .funcs()
        .flatMap((f) =>
          safe([f, ...f.inputs()]) ? [[str(f), f.inputs().map((i) => [str(i), ty(i.type())])]] : []
        )
    )
  } catch {
    return null
  }
}

/** The unit of a Stellar Asset Contract: 7 decimals, named by its `name()` (`CODE:ISSUER`, or
 *  `native`), the issuer shortened. Read once; a contract that answers anything else is no token,
 *  and a failure to ask (a rate limit, a dropped connection) is not remembered as an answer. */
async function sacToken(server: rpc.Server, network: Network, address: string) {
  const id = `${network}:${address}`
  if (tokens.has(id)) return tokens.get(id) ?? undefined
  try {
    const v = await read(server, network, address, 'name')
    const name = v.switch().name === 'scvString' ? v.str().toString() : ''
    const m = name.match(/^(?:(native)|([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55}))$/)
    const symbol = m?.[1] ?? (m ? `${m[2]}:${m[3]?.slice(0, 4)}…${m[3]?.slice(-4)}` : '')
    return keep(tokens, id, symbol ? { decimals: 7, symbol } : null) ?? undefined
  } catch (e) {
    return e instanceof Refusal ? (keep(tokens, id, null) ?? undefined) : undefined
  }
}

/** The interface and token details of each contract (at most 16), one fetch per contract: the
 *  instances in one read, the wasm of each hash not yet known in another, then the token reads.
 *  Never throws; what could not be learned in time (or before `signal` aborts) is left out. */
export async function infoFor(
  e: Endpoint,
  addresses: Iterable<string | undefined>,
  signal?: AbortSignal
): Promise<Record<string, Info>> {
  const list = [...new Set(addresses)].filter((a) => a !== undefined).slice(0, CONTRACTS_MAX)
  const out: Record<string, Info> = {}
  const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(WAIT_MS)])
  const run = async () => {
    const server = connect(e)
    const keys = list.map((c) => dataKey(c, xdr.ScVal.scvLedgerKeyContractInstance()))
    const instances = await entries(server, keys)
    // Each contract's wasm hash, or '' for a Stellar Asset Contract.
    const code = list.flatMap((c, i) => {
      const x = instances[i]?.instance().executable()
      const wasm = x?.switch().name === 'contractExecutableWasm'
      return x ? [[c, wasm ? Buffer.from(x.wasmHash()).toString('hex') : ''] as const] : []
    })
    const missing = [...new Set(code.map((c) => c[1]))].filter((h) => h && !specs.has(h))
    await pool(
      missing,
      4,
      async (h) => {
        const wasm = await server.getContractWasmByHash(h, 'hex').catch(() => undefined)
        if (wasm) keep(specs, h, interfaceOf(wasm))
      },
      stop
    )
    await pool(
      code,
      4,
      async ([c, h]) => {
        const token = h ? TOKENS[e.network][c] : await sacToken(server, e.network, c)
        out[c] = { fns: h ? (specs.get(h) ?? undefined) : SAC, token }
      },
      stop
    )
  }
  await Promise.race([
    run().catch(() => undefined),
    new Promise((done) => (stop.aborted ? done(0) : stop.addEventListener('abort', done))),
  ])
  return { ...out }
}
