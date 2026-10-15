// What names a call's arguments: a contract's interface (the `contractspecv0` of its wasm, or
// the SEP-41 table for a Stellar Asset Contract) and, for a token, its decimals and symbol.
// They only make a review readable, so every step is best effort and bounded: a failure, a
// timeout or an abort leaves the plain wording, and nothing here can touch a verdict.

import { type rpc, contract as soroban, xdr } from '@stellar/stellar-sdk'
import { connect, dataKey, type Endpoint, entries, pool, read } from './chain.ts'
import type { Network } from './config.ts'

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
  /** Present for a token; the decimals and symbol are absent when they could not be read. */
  token?: { decimals?: number; symbol?: string }
}

const WASM_MAX = 262_144 // twice the largest wasm the network accepts
const CONTRACTS_MAX = 16
const WAIT_MS = 5_000
const CACHE_MAX = 256

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
// a token by network and address. Only an answer is kept, never a failure to ask.
const specs = new Map<string, Fns | null>()
const tokens = new Map<string, NonNullable<Info['token']>>()
const keep = <V>(m: Map<string, V>, k: string, v: V): V => {
  if (m.size >= CACHE_MAX) m.delete(m.keys().next().value as string)
  return m.set(k, v).get(k) as V
}

/** The functions of a wasm's spec, or null when it has none or is too big to read. */
export function interfaceOf(wasm: Buffer): Fns | null {
  if (wasm.length > WASM_MAX) return null
  try {
    const { entries } = soroban.Spec.fromWasm(wasm)
    // Names reach a review as text: only plain identifiers are used.
    const safe = (n: string) => /^\w{1,32}$/.test(n)
    const of = (e: xdr.ScSpecEntry, kind: string) => e.switch().name === kind
    const structs = new Map(
      entries.flatMap((e) =>
        of(e, 'scSpecEntryUdtStructV0') &&
        e
          .udtStructV0()
          .fields()
          .every((f) => safe(f.name().toString()))
          ? [[e.udtStructV0().name().toString(), e.udtStructV0()] as const]
          : []
      )
    )
    const memo = new Map<string, Ty>()
    const udt = (n: string): Ty => {
      if (memo.has(n)) return memo.get(n) as Ty
      memo.set(n, 'deep') // while it is being read, a reference back to it is a cycle
      const fields = structs
        .get(n)
        ?.fields()
        .map((f) => [f.name().toString(), ty(f.type())])
      return memo.set(n, fields ? { fields: Object.fromEntries(fields) } : 'udt').get(n) as Ty
    }
    const ty = (t: xdr.ScSpecTypeDef): Ty => {
      const k = t.switch().name.slice('scSpecType'.length).toLowerCase()
      if (k === 'option') return ty(t.option().valueType())
      if (k === 'vec') return { vec: ty(t.vec().elementType()) }
      if (k === 'map') return { map: ty(t.map().valueType()) }
      if (k === 'tuple') return { tuple: t.tuple().valueTypes().map(ty) }
      return k === 'udt' ? udt(t.udt().name().toString()) : k
    }
    return Object.fromEntries(
      entries.flatMap((e) => {
        const f = of(e, 'scSpecEntryFunctionV0') ? e.functionV0() : undefined
        const ps = f?.inputs().map((i) => [i.name().toString(), i.type()] as const) ?? []
        return f && [f.name().toString(), ...ps.map((p) => p[0])].every(safe)
          ? [[f.name().toString(), ps.map(([n, t]) => [n, ty(t)])]]
          : []
      })
    )
  } catch {
    return null
  }
}

/** A token's decimals and symbol, read once. A contract can answer with anything, so a
 *  decimals above 38 or an odd symbol is not used. */
async function tokenOf(server: rpc.Server, network: Network, address: string) {
  const [d, s] = await Promise.allSettled(
    ['decimals', 'symbol'].map((f) => read(server, network, address, f))
  )
  const decimals = d?.status === 'fulfilled' ? Number(d.value.u32()) : 99
  const symbol = s?.status === 'fulfilled' ? s.value.str().toString() : ''
  return keep(tokens, `${network}:${address}`, {
    ...(decimals <= 38 ? { decimals } : {}),
    ...(/^[A-Za-z0-9._-]{1,12}$/.test(symbol) ? { symbol } : {}),
  })
}

/** The interface and token details of each contract (at most 16), one fetch per contract: the
 *  instances in one read, the wasm of each hash not yet known in another, then the token reads.
 *  Never throws; what could not be learned in time (or before `signal` aborts) is left out. */
export async function infoFor(
  e: Endpoint,
  addresses: Iterable<string>,
  signal?: AbortSignal
): Promise<Record<string, Info>> {
  const list = [...new Set(addresses)].slice(0, CONTRACTS_MAX)
  const out: Record<string, Info> = {}
  const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(WAIT_MS)])
  const run = async () => {
    const server = connect(e)
    const instances = await entries(
      server,
      list.map((c) => dataKey(c, xdr.ScVal.scvLedgerKeyContractInstance()))
    )
    // Each contract's wasm hash, or '' for a Stellar Asset Contract.
    const code = list.flatMap((c, i) => {
      const x = instances[i]?.instance().executable()
      const wasm = x?.switch().name === 'contractExecutableWasm'
      return x ? [[c, wasm ? Buffer.from(x.wasmHash()).toString('hex') : ''] as const] : []
    })
    const missing = [...new Set(code.map((c) => c[1]))].filter((h) => h && !specs.has(h))
    const keys = missing.map((h) => new xdr.LedgerKeyContractCode({ hash: Buffer.from(h, 'hex') }))
    const wasms = keys.length
      ? await server.getLedgerEntries(...keys.map((k) => xdr.LedgerKey.contractCode(k)))
      : { entries: [] }
    for (const w of wasms.entries) {
      const c = w.val.contractCode()
      keep(specs, Buffer.from(c.hash()).toString('hex'), interfaceOf(Buffer.from(c.code())))
    }
    await pool(code, 4, async ([c, h]) => {
      const fns = h ? (specs.get(h) ?? undefined) : SAC
      const token = !h || (fns && Object.hasOwn(fns, 'decimals') && Object.hasOwn(fns, 'symbol'))
      out[c] = {
        fns,
        ...(token
          ? { token: tokens.get(`${e.network}:${c}`) ?? (await tokenOf(server, e.network, c)) }
          : {}),
      }
    })
  }
  await Promise.race([
    run(),
    new Promise((_, no) =>
      stop.aborted
        ? no(stop.reason)
        : stop.addEventListener('abort', () => no(stop.reason), { once: true })
    ),
  ]).catch(() => undefined)
  return { ...out }
}
