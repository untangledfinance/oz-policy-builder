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
export const BITS: Record<string, [number, boolean]> = {
  i128: [128, true],
  u128: [128, false],
  i64: [64, true],
  u64: [64, false],
  i256: [256, true],
  u256: [256, false],
  timepoint: [64, false],
  duration: [64, false],
}
/** `scvI128` -> `i128`, `scvTimepoint` -> `timepoint`: the JSON tag of an ScVal type. */
const tagOf = (type: string): string => type.slice(3).toLowerCase()

export class WireError extends Error {}

export const isAddress = (v: unknown): v is string => typeof v === 'string' && ADDRESS.test(v)
export const isTagged = (v: unknown): v is Tagged =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
/** A `{map}` as a record keyed by the keys' text; anything else as an empty one. */
export const fields = (v: Val | undefined): Record<string, Val> =>
  Object.fromEntries(isTagged(v) && 'map' in v ? v.map.map(([k, x]) => [String(k), x]) : [])

/** The integer a value carries (a u32, or a tagged integer, timepoint or duration), else undefined. */
export function intOf(v: Val | undefined): bigint | undefined {
  if (typeof v === 'number') return BigInt(v)
  const [tag, x] = isTagged(v) ? (Object.entries(v)[0] as [string, unknown]) : []
  const known = tag !== undefined && (tag in BITS || tag === 'i32')
  return known && /^-?\d+$/.test(String(x)) ? BigInt(String(x)) : undefined
}

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
  const big = tagOf(name) in BITS
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
  const tag = tagOf(type)
  if (!(tag in BITS)) throw new WireError(`no JSON form for ${type}`)
  return { [tag]: scValToBigInt(s).toString() } as Tagged
}

/** The canonical bytes the contract stores, as base64 XDR. */
export const encode = (e: Expr): string => toScVal(e).toXDR('base64')
export const decode = (b64: string): Expr => fromScVal(xdr.ScVal.fromXDR(b64, 'base64'))
/** sha256 of the stored bytes, hex: the `predicate_hash` install is checked against. */
export const hashOf = (b64: string): string =>
  createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')

// ---- the contract's decode refusals, mirrored ----

/** `dsl.rs`: the caps decode enforces. A quantifier body and a `sum` weigh `elems` leaves. */
export const CAPS = {
  depth: 5,
  leaves: 200,
  entries: 32,
  reads: 4,
  bytes: 32 * 1024,
  steps: 8,
  elems: 32,
} as const
const MAX_DEN = 10n ** 18n

/** Exact arity of a selector, head included; the path selectors take their own minimum. */
const ARITY: Record<string, number> = {
  call_contract: 1,
  call_fn: 1,
  now: 1,
  call_arg: 2,
  call_arg_len: 2,
  call_arg_field: 4,
  scaled: 5,
  lit: 2,
}
const PATH_MIN: Record<string, number> = { call_path: 2, read: 4, elem: 1, sum: 2 }
const COMPARE = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])
/** A leaf that reads the call: every known selector named `call_*`. */
const isCall = (head: string) => head.startsWith('call_')

/** A constant's value when the contract reads it as a number (any integer of up
 *  to 128 bits, a timepoint or a duration; not a 256-bit integer), else undefined. */
const numOf = (v: Val) => (isTagged(v) && ('i256' in v || 'u256' in v) ? undefined : intOf(v))

interface Walk {
  weight: number
  reads: Set<string>
  selector: boolean
}

/** Throws `WireError` for what the contract's decoder refuses at install (201, 216),
 *  and for an oversized encoding (207). Everything it accepts the contract may
 *  still refuse for a reason this does not model (`check` is the authority). */
export function validate(expr: Expr): void {
  const w: Walk = { weight: 0, reads: new Set(), selector: false }
  node(expr, 1, false, w)
  if (w.weight > CAPS.leaves) bad(`${w.weight} leaves, at most ${CAPS.leaves}`)
  if (w.reads.size > CAPS.reads) bad(`${w.reads.size} distinct reads, at most ${CAPS.reads}`)
  if (!w.selector) bad('no leaf reads the call: the rule would constrain nothing')
  if (Buffer.from(encode(expr), 'base64').length > CAPS.bytes)
    bad(`encoding over ${CAPS.bytes} bytes`)
}

const bad = (m: string): never => {
  throw new WireError(m)
}

/** A constant, by the contract's reading: a `lit`, or anything that is not a selector. */
const isConstant = (v: Val): boolean => !isSelector(v) || v[0] === 'lit'
export const unlit = (v: Val): Val => (isSelector(v) && v[0] === 'lit' ? (v[1] as Val) : v)

export function isSelector(v: Val): v is [string, ...Val[]] {
  return Array.isArray(v) && typeof v[0] === 'string' && !ADDRESS.test(v[0])
}

function node(e: Expr, depth: number, body: boolean, w: Walk): void {
  if (depth > CAPS.depth) bad(`nested deeper than ${CAPS.depth}`)
  if (!isSelector(e)) bad('not a node')
  const [op, ...r] = e as [string, ...Val[]]
  const [a, b] = r as Val[]
  const list = (x: Val | undefined): Val[] =>
    Array.isArray(x) && x.length > 0 ? x : bad(`${op}: needs a non-empty list`)
  if (op === 'and' || op === 'or') {
    if (r.length !== 1) bad(`${op}: one list of children`)
    for (const c of list(a)) node(c, depth + 1, body, w)
  } else if (COMPARE.has(op) && r.length === 2) {
    leaf(a as Val, 1, body, w)
    leaf(b as Val, 1, body, w)
    const ordering = op !== 'eq' && op !== 'ne'
    if (
      ordering &&
      [a, b].some((x) => isConstant(x as Val) && numOf(unlit(x as Val)) === undefined)
    ) {
      bad(`${op}: an ordering needs numbers`)
    }
  } else if ((op === 'in' || op === 'nin') && r.length === 2) {
    leaf(a as Val, 1, body, w)
    const entries = list(b)
    if (entries.length > CAPS.entries) bad(`${op}: more than ${CAPS.entries} entries`)
    for (const x of entries) {
      if (!isConstant(x)) bad(`${op}: entries are constants`)
      leaf(x, 1, body, w)
    }
  } else if ((op === 'all' || op === 'any') && r.length === 2) {
    if (body) bad('a quantifier inside a quantifier')
    leaf(a as Val, 1, false, w)
    const inner: Walk = { weight: 0, reads: w.reads, selector: false }
    node(b as Val, depth + 1, true, inner)
    // Every leaf of the body is walked once per element.
    w.weight += inner.weight * CAPS.elems
    w.selector ||= inner.selector
  } else {
    bad(`unknown operator or wrong arity: ${op}/${r.length}`)
  }
}

function leaf(v: Val, nest: number, body: boolean, w: Walk): void {
  if (nest > CAPS.depth) bad(`leaf nested deeper than ${CAPS.depth}`)
  w.weight += 1
  if (!isSelector(v)) {
    constant(v, nest)
    return
  }
  const [head, ...r] = v
  const exact = ARITY[head]
  const min = PATH_MIN[head]
  if (exact !== undefined ? v.length !== exact : min === undefined || v.length < min) {
    bad(`unknown selector or wrong arity: ${head}/${r.length}`)
  }
  const next = (x: Val) => leaf(x, nest + 1, body, w)
  if (isCall(head)) w.selector = true
  if (head === 'elem' && !body) bad('elem outside a quantifier body')
  if (head === 'call_path' || head === 'elem') steps(r)
  if (head === 'sum') {
    if (body) bad('a sum inside a quantifier')
    w.weight += CAPS.elems
    next(r[0] as Val)
    steps(r.slice(1))
  }
  if (head === 'scaled') {
    const den = r[2] as Val
    const n = isTagged(den) && 'i128' in den ? den.i128 : null
    if (n === null || BigInt(n) < 1n || BigInt(n) > MAX_DEN)
      bad('scaled: den must be an i128 in 1..10^18')
    for (const x of [r[0], r[1], r[3]] as Val[]) {
      next(x)
      if (isConstant(x) && numOf(unlit(x)) === undefined) bad('scaled: operands are numbers')
    }
    for (const x of [r[0], r[1]] as Val[]) {
      if ((numOf(unlit(x)) ?? 1n) <= 0n) bad('scaled: a constant factor must be positive')
    }
  }
  if (head === 'read') {
    const [target, fn, args] = r as [Val, Val, Val]
    if (typeof target !== 'string' || !target.startsWith('C')) bad('read: target is a contract')
    if (typeof fn !== 'string' || !Array.isArray(args)) bad('read: (contract, fn, [args], path...)')
    steps(r.slice(3))
    for (const x of args as Val[]) {
      if (isSelector(x) && !isCall(x[0]) && x[0] !== 'now' && x[0] !== 'lit') {
        bad('read: an argument is a constant or a plain leaf')
      }
      next(x)
    }
    // Reads of one call with constant arguments are one call; a read with an
    // argument taken from the call is its own, whatever it resembles.
    const fixed = (args as Val[]).every(isConstant)
    w.reads.add(JSON.stringify([target, fn, fixed ? args : w.reads.size]))
  }
}

/** A bare constant: a value, or a non-empty vec of them (never a selector or a map). */
function constant(v: Val, nest: number): void {
  if (nest > CAPS.depth) bad('a constant is nested too deep')
  if (Array.isArray(v)) {
    if (v.length === 0) bad('an empty vec constant')
    for (const x of v) {
      if (isSelector(x)) bad('a bare vec holds plain values: write lit([...])')
      constant(x, nest + 1)
    }
  } else if (isTagged(v) && 'map' in v) {
    bad('a bare map: write lit({...})')
  }
}

/** A path: u32 indexes, a symbol or `lit` key, and a final `true` (the length). */
function steps(s: Val[]): void {
  if (s.length > CAPS.steps) bad(`a path of at most ${CAPS.steps} steps`)
  s.forEach((x, i) => {
    if (x === true && i !== s.length - 1) bad('the length step is last')
    if (isSelector(x) && x[0] !== 'lit') bad('a path step is not a selector')
  })
}
