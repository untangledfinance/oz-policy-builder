// The grammar-7 wire shape, as JSON.
//
// A predicate is an ScVal, and this file speaks that ScVal as JSON, one way, for
// everything: an expression, a constant, a call argument. A node is a tagged
// vector, `["lte", ["call_arg", 2], {"i128": "100"}]`. There is no per-operator
// code anywhere: `toScVal` and `fromScVal` are structural, and the contract
// decides what the operators mean. `validate` mirrors only the contract's decode
// refusals (known operators, arity, caps), so a malformed rule fails here,
// before a round trip.
//
//   JSON            ScVal
//   "eq", "pay"     Symbol
//   "G...", "C..."  Address (strkey; a symbol is at most 32 characters, so a
//                   56-character name is never a symbol)
//   5               U32
//   true / null     Bool / Void
//   [..]            Vec (a vec whose head is a symbol is a selector or node)
//   {"i128": "5"}   a one-key object for every other type: i128 u128 i64 u64 i256
//                   u256 timepoint duration (decimal strings), i32 (a number),
//                   bytes (hex), string, map ([[k, v], ...])
//
// Parity with the contract is checked against the corpus the contract's own test
// writes (`fixtures/parity/grammar7.json`).

import { createHash } from 'node:crypto'
import { Address, nativeToScVal, scValToBigInt, xdr } from '@stellar/stellar-sdk'

export type Tagged =
  | { i128: string }
  | { u128: string }
  | { i64: string }
  | { u64: string }
  | { i256: string }
  | { u256: string }
  | { timepoint: string }
  | { duration: string }
  | { i32: number }
  | { bytes: string }
  | { string: string }
  | { map: [Val, Val][] }
export type Val = null | boolean | number | string | Val[] | Tagged
/** An expression is a value: the node tree and its constants are one thing. */
export type Expr = Val

const ADDRESS = /^(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})$/
const SYMBOL = /^[A-Za-z0-9_]{1,32}$/
const BITS: Record<string, [number, boolean]> = {
  i128: [128, true],
  u128: [128, false],
  i64: [64, true],
  u64: [64, false],
  i256: [256, true],
  u256: [256, false],
  timepoint: [64, false],
  duration: [64, false],
}
const BIG_TYPES: Record<string, string> = {
  scvI128: 'i128',
  scvU128: 'u128',
  scvI64: 'i64',
  scvU64: 'u64',
  scvI256: 'i256',
  scvU256: 'u256',
  scvTimepoint: 'timepoint',
  scvDuration: 'duration',
}

export class WireError extends Error {}

export const isAddress = (v: unknown): v is string => typeof v === 'string' && ADDRESS.test(v)

export function toScVal(v: Val): xdr.ScVal {
  if (v === null) return xdr.ScVal.scvVoid()
  if (typeof v === 'boolean') return xdr.ScVal.scvBool(v)
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new WireError(`not a u32: ${v}`)
    return xdr.ScVal.scvU32(v)
  }
  if (typeof v === 'string') {
    if (ADDRESS.test(v)) return new Address(v).toScVal()
    if (!SYMBOL.test(v)) throw new WireError(`not a symbol or address: ${JSON.stringify(v)}`)
    return xdr.ScVal.scvSymbol(v)
  }
  if (Array.isArray(v)) return xdr.ScVal.scvVec(v.map(toScVal))
  const keys = Object.keys(v)
  const tag = keys[0]
  if (typeof v !== 'object' || keys.length !== 1 || tag === undefined) {
    throw new WireError(`not a value: ${JSON.stringify(v)}`)
  }
  const x = (v as Record<string, unknown>)[tag]
  const bits = BITS[tag]
  if (bits !== undefined) {
    const [width, signed] = bits
    if (typeof x !== 'string' || !/^-?\d+$/.test(x)) throw new WireError(`${tag}: not an integer`)
    const n = BigInt(x)
    if ((signed ? BigInt.asIntN(width, n) : BigInt.asUintN(width, n)) !== n) {
      throw new WireError(`${tag}: out of range`)
    }
    return nativeToScVal(n, { type: tag })
  }
  if (tag === 'i32' && typeof x === 'number' && Number.isInteger(x) && x === (x | 0)) {
    return xdr.ScVal.scvI32(x)
  }
  if (tag === 'bytes' && typeof x === 'string' && /^(?:[0-9a-f]{2})*$/i.test(x)) {
    return xdr.ScVal.scvBytes(Buffer.from(x, 'hex'))
  }
  if (tag === 'string' && typeof x === 'string') return xdr.ScVal.scvString(x)
  if (tag === 'map' && Array.isArray(x)) {
    const entries = x.map(([k, val]: [Val, Val]) => ({ key: toScVal(k), val: toScVal(val) }))
    // The host keeps map keys sorted and unique; an unsorted map would not load.
    entries.sort((a, b) => order(a.key, b.key))
    if (entries.some((e, i) => i > 0 && order(entries[i - 1]?.key as xdr.ScVal, e.key) === 0)) {
      throw new WireError('map: duplicate key')
    }
    return xdr.ScVal.scvMap(entries.map((e) => new xdr.ScMapEntry(e)))
  }
  throw new WireError(`not a value: ${JSON.stringify(v)}`)
}

/** The host's order for map keys: by type, then by value (a number by value,
 *  text and bytes byte by byte; the XDR length prefix would sort them wrong). */
function order(a: xdr.ScVal, b: xdr.ScVal): number {
  const [ta, tb] = [a.switch().value, b.switch().value]
  if (ta !== tb) return ta - tb
  const name = a.switch().name
  const big = name in BIG_TYPES
  const raw = (s: xdr.ScVal) =>
    big ? scValToBigInt(s) : name === 'scvU32' ? s.u32() : name === 'scvI32' ? s.i32() : undefined
  const [x, y] = [raw(a), raw(b)]
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0
  const bytes = (s: xdr.ScVal) =>
    name === 'scvSymbol' ? s.sym() : name === 'scvString' ? s.str() : s.toXDR()
  return Buffer.compare(Buffer.from(bytes(a)), Buffer.from(bytes(b)))
}

export function fromScVal(s: xdr.ScVal): Val {
  const type = s.switch().name
  switch (type) {
    case 'scvVoid':
      return null
    case 'scvBool':
      return s.b()
    case 'scvU32':
      return s.u32()
    case 'scvI32':
      return { i32: s.i32() }
    case 'scvSymbol':
      return s.sym().toString()
    case 'scvAddress':
      return Address.fromScAddress(s.address()).toString()
    case 'scvVec':
      return (s.vec() ?? []).map(fromScVal)
    case 'scvBytes':
      return { bytes: Buffer.from(s.bytes()).toString('hex') }
    case 'scvString':
      return { string: s.str().toString() }
    case 'scvMap':
      return { map: (s.map() ?? []).map((e) => [fromScVal(e.key()), fromScVal(e.val())]) }
  }
  const tag = BIG_TYPES[type]
  if (tag === undefined) throw new WireError(`no JSON form for ${type}`)
  return { [tag]: scValToBigInt(s).toString() } as Tagged
}

/** The canonical bytes the contract stores, as base64 XDR. */
export const encode = (e: Expr): string => toScVal(e).toXDR('base64')
export const decode = (b64: string): Expr => fromScVal(xdr.ScVal.fromXDR(b64, 'base64'))
/** sha256 of the stored bytes, hex: the `predicate_hash` install is checked against. */
export const hashOf = (b64: string): string =>
  createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')

// ---- the contract's decode refusals, mirrored ----

/** `dsl.rs`: the caps decode enforces. */
export const CAPS = {
  depth: 5,
  leaves: 200,
  entries: 32,
  reads: 4,
  bytes: 32 * 1024,
  steps: 8,
  elems: 32,
  bodyLeaves: 6,
  sums: 6,
} as const
const MAX_DEN = 10n ** 18n

/** Arity of each selector, head included: [min, max]. */
const SELECTORS: Record<string, [number, number]> = {
  call_contract: [1, 1],
  call_fn: [1, 1],
  now: [1, 1],
  call_arg: [2, 2],
  call_arg_len: [2, 2],
  call_arg_field: [4, 4],
  call_path: [2, 1 + CAPS.steps],
  read: [4, 4 + CAPS.steps],
  scaled: [5, 5],
  elem: [1, 1 + CAPS.steps],
  sum: [2, 2 + CAPS.steps],
  lit: [2, 2],
}
const ORDERING = new Set(['lt', 'lte', 'gt', 'gte'])
const COMPARE = new Set(['eq', 'ne', ...ORDERING])
const CALL_LEAVES = new Set([
  'call_contract',
  'call_fn',
  'call_arg',
  'call_arg_len',
  'call_arg_field',
  'call_path',
])

/** A constant's value when the contract reads it as a number (any integer of up
 *  to 128 bits, a timepoint or a duration; not a 256-bit integer), else null. */
function numOf(v: Val): bigint | null {
  if (typeof v === 'number') return BigInt(v)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const [tag, x] = Object.entries(v)[0] as [string, string | number]
  return tag in BITS && BITS[tag]?.[0] !== 256 ? BigInt(x) : tag === 'i32' ? BigInt(x) : null
}

interface Walk {
  weight: number
  reads: Set<string>
  sums: number
  selector: boolean
}

/** Throws `WireError` for what the contract's decoder refuses at install (201),
 *  and for an oversized encoding (207). Everything it accepts the contract may
 *  still refuse for a reason this does not model (`check` is the authority). */
export function validate(expr: Expr): void {
  const w: Walk = { weight: 0, reads: new Set(), sums: 0, selector: false }
  node(expr, 1, false, w)
  if (w.weight > CAPS.leaves) throw new WireError(`${w.weight} leaves, at most ${CAPS.leaves}`)
  if (w.reads.size > CAPS.reads) throw new WireError(`${w.reads.size} distinct reads, at most 4`)
  if (w.sums > CAPS.sums) throw new WireError(`${w.sums} sums, at most ${CAPS.sums}`)
  if (!w.selector) throw new WireError('no leaf reads the call: the rule would constrain nothing')
  if (Buffer.from(encode(expr), 'base64').length > CAPS.bytes) {
    throw new WireError(`encoding over ${CAPS.bytes} bytes`)
  }
}

const bad = (m: string): never => {
  throw new WireError(m)
}

function node(e: Expr, depth: number, body: boolean, w: Walk): void {
  if (depth > CAPS.depth) bad(`nested deeper than ${CAPS.depth}`)
  const [op, ...r] = Array.isArray(e) && typeof e[0] === 'string' ? e : bad('not a node')
  const [a, b] = r as Val[]
  const children = (x: Val | undefined): Val[] =>
    Array.isArray(x) && x.length > 0 ? x : bad(`${op}: needs a non-empty list`)
  if (op === 'and' || op === 'or') {
    if (r.length !== 1) bad(`${op}: one list of children`)
    for (const c of children(a)) node(c, depth + 1, body, w)
  } else if (COMPARE.has(op as string) && r.length === 2) {
    leaf(a as Val, 1, body, w)
    leaf(b as Val, 1, body, w)
    if (
      ORDERING.has(op as string) &&
      [a, b].some((x) => isConstant(x as Val) && numOf(unlit(x as Val)) === null)
    ) {
      bad(`${op}: an ordering needs numbers`)
    }
  } else if ((op === 'in' || op === 'nin') && r.length === 2) {
    leaf(a as Val, 1, body, w)
    const entries = children(b)
    if (entries.length > CAPS.entries) bad(`${op}: more than ${CAPS.entries} entries`)
    for (const x of entries) {
      if (!isConstant(x)) bad(`${op}: entries are constants`)
      leaf(x, 1, body, w)
    }
  } else if ((op === 'all' || op === 'any') && r.length === 2) {
    if (body) bad('a quantifier inside a quantifier')
    leaf(a as Val, 1, false, w)
    const inner: Walk = { weight: 0, reads: w.reads, sums: 0, selector: false }
    node(b as Val, depth + 1, true, inner)
    if (inner.sums > 0) bad('a sum inside a quantifier')
    if (inner.weight > CAPS.bodyLeaves) bad(`quantifier body of ${inner.weight} leaves, at most 6`)
    w.weight += inner.weight * CAPS.elems
    w.selector ||= inner.selector
  } else {
    bad(`unknown operator or wrong arity: ${String(op)}/${r.length}`)
  }
}

/** A constant, by the contract's reading: a `lit`, or anything that is not a selector. */
const isConstant = (v: Val): boolean => !isSelector(v) || v[0] === 'lit'
const unlit = (v: Val): Val => (isSelector(v) && v[0] === 'lit' ? (v[1] as Val) : v)

function isSelector(v: Val): v is [string, ...Val[]] {
  return Array.isArray(v) && typeof v[0] === 'string' && !ADDRESS.test(v[0])
}

function leaf(v: Val, nest: number, body: boolean, w: Walk): void {
  if (nest > CAPS.depth) bad(`leaf nested deeper than ${CAPS.depth}`)
  w.weight += 1
  if (!isSelector(v)) {
    constant(v, nest)
    return
  }
  const [head, ...r] = v
  const arity = SELECTORS[head]
  if (arity === undefined || v.length < arity[0] || v.length > arity[1]) {
    bad(`unknown selector or wrong arity: ${head}/${r.length}`)
  }
  const next = (x: Val) => leaf(x, nest + 1, body, w)
  if (head === 'lit') return
  if (CALL_LEAVES.has(head)) w.selector = true
  if (head === 'elem' && !body) bad('elem outside a quantifier body')
  if (head === 'sum') {
    w.sums += 1
    w.weight += CAPS.elems
    if (body) bad('a sum inside a quantifier')
    next(r[0] as Val)
  }
  if (head === 'call_path') steps(r, 0)
  if (head === 'elem') steps(r, 0)
  if (head === 'sum') steps(r.slice(1), 0)
  if (head === 'scaled') {
    const den = r[2] as Val
    const n =
      typeof den === 'object' && den !== null && !Array.isArray(den) && 'i128' in den
        ? den.i128
        : null
    if (n === null || BigInt(n) < 1n || BigInt(n) > MAX_DEN)
      bad('scaled: den must be an i128 in 1..10^18')
    for (const x of [r[0], r[1], r[3]] as Val[]) {
      next(x)
      if (isConstant(x) && numOf(unlit(x)) === null) bad('scaled: operands are numbers')
    }
    for (const x of [r[0], r[1]] as Val[]) {
      if ((numOf(unlit(x)) ?? 1n) <= 0n) bad('scaled: a constant factor must be positive')
    }
  }
  if (head === 'read') {
    const [target, fn, args] = r as [Val, Val, Val]
    if (typeof target !== 'string' || !target.startsWith('C')) bad('read: target is a contract')
    if (typeof fn !== 'string' || !Array.isArray(args)) bad('read: (contract, fn, [args], path...)')
    steps(r.slice(3), 0)
    for (const x of args as Val[]) {
      const ok =
        !isSelector(x) || CALL_LEAVES.has(x[0] as string) || x[0] === 'now' || x[0] === 'lit'
      if (!ok) bad('read: an argument is a constant or a plain leaf')
      next(x)
    }
    const fixed = (args as Val[]).every((x) => !isSelector(x) || x[0] === 'lit')
    w.reads.add(JSON.stringify([target, fn, fixed ? args : w.reads.size]))
  }
}

function constant(v: Val, nest: number): void {
  if (Array.isArray(v)) {
    if (nest > CAPS.depth || v.length === 0) bad('a constant vec is non-empty and shallow')
    for (const x of v) {
      if (isSelector(x)) bad('a bare vec holds plain values: write lit([...])')
      if (typeof x === 'object' && x !== null && !Array.isArray(x) && 'map' in x)
        bad('a bare vec holds no map')
      constant(x, nest + 1)
    }
  } else if (typeof v === 'object' && v !== null && 'map' in v) {
    bad('a bare map: write lit({...})')
  }
}

/** A path: u32 indexes, a symbol or `lit` key, and a final `true` (the length). */
function steps(s: Val[], min: number): void {
  if (s.length < min || s.length > CAPS.steps) bad(`a path of ${min}..${CAPS.steps} steps`)
  s.forEach((x, i) => {
    if (x === true && i !== s.length - 1) bad('the length step is last')
    if (isSelector(x) && x[0] !== 'lit') bad('a path step is not a selector')
  })
}
