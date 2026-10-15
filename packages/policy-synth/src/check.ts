// Simulate and verify, both through the contract's own `check`: there is no copy
// of the evaluator here. A call is permitted or denied by what the interpreter
// says about it, with the code it would raise.
//
// Verify asks a rule two things of one permitted call. Does every constraint bind?
// Each leaf of the rule is turned against the call (the value that would break it
// is derived from the leaf itself) and the rule must deny it. And is each
// conjunct needed? Drop it, re-run, and the call it was guarding must now pass.

import { Address, type rpc, StrKey, xdr } from '@stellar/stellar-sdk'
import { pool, read } from './chain.ts'
import type { Network } from './config.ts'
import { Refusal } from './envelope.ts'
import type { Call } from './record.ts'
import { type Expr, isSelector as isSel, type Tagged, toScVal, unlit, type Val } from './wire.ts'

export const REASONS: Record<number, string> = {
  0: 'PERMIT',
  100: 'ARG_MISMATCH',
  101: 'CONTRACT_SCOPE',
  102: 'ARITHMETIC_OVERFLOW',
  103: 'UNSUPPORTED_NODE',
  105: 'NOT_IN_ALLOWLIST',
  201: 'MALFORMED_PREDICATE',
  207: 'PREDICATE_TOO_LARGE',
  216: 'SELECTOR_LEAF_REQUIRED',
}

export interface Verdict {
  permitted: boolean
  code: number
  reason: string
}

/** Calls one verify may put to the interpreter, and how many run at once. */
export const MAX_CHECKS = 64
const WIDTH = 8

const sym = (s: string) => xdr.ScVal.scvSymbol(s)

/** `Context::Contract(ContractContext { args, contract, fn_name })`. */
const context = (c: Call): xdr.ScVal =>
  xdr.ScVal.scvVec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym('args'), val: toScVal(c.args) }),
      new xdr.ScMapEntry({ key: sym('contract'), val: new Address(c.contract).toScVal() }),
      new xdr.ScMapEntry({ key: sym('fn_name'), val: sym(c.fn) }),
    ]),
  ])

/** Ask `interpreter.check(predicate, call)` for each call, a few at a time. */
export async function runChecks(
  server: rpc.Server,
  network: Network,
  interpreter: string,
  encoded: string,
  calls: Call[]
): Promise<Verdict[]> {
  if (calls.length > MAX_CHECKS)
    throw new Refusal('SIMULATION_ERROR', `at most ${MAX_CHECKS} calls per request`)
  const bytes = xdr.ScVal.scvBytes(Buffer.from(encoded, 'base64'))
  return pool(calls, WIDTH, async (c) => {
    const code = (await read(server, network, interpreter, 'check', bytes, context(c))).u32()
    return { permitted: code === 0, code, reason: REASONS[code] ?? `code ${code}` }
  })
}

// ---- deny cases: each leaf of the rule, turned against a permitted call ----

type Num = bigint
const isObj = (v: Val | undefined): v is Tagged =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: Val, b: Val) => JSON.stringify(a) === JSON.stringify(b)

/** The integer a value carries, whatever its type, or undefined. */
function big(v: Val | undefined): Num | undefined {
  if (typeof v === 'number') return BigInt(v)
  if (
    isObj(v) &&
    typeof Object.values(v as object)[0] === 'string' &&
    /^-?\d+$/.test(Object.values(v as object)[0] as string)
  ) {
    return BigInt(Object.values(v as object)[0] as string)
  }
  return undefined
}
/** An integer written the way `like` was written (a u32 stays a u32 while it fits). */
function as(like: Val | undefined, n: Num): Val {
  if (typeof like === 'number' && n >= 0n && n <= 0xffffffffn) return Number(n)
  const tag = isObj(like) ? Object.keys(like)[0] : undefined
  if (tag === 'i32') return { i32: Number(n) }
  const wide = tag && BIG_TAGS.has(tag) ? tag : 'i128'
  return { [wide]: n.toString() } as Val
}

const BIG_TAGS = new Set(['i128', 'u128', 'i64', 'u64', 'i256', 'u256', 'timepoint', 'duration'])

/** The argument steps a leaf reaches, or undefined for a leaf that is not a path. */
function stepsOf(sel: Val): Val[] | undefined {
  if (!isSel(sel)) return undefined
  const [head, ...r] = sel
  if (head === 'call_arg') return [r[0] as Val]
  if (head === 'call_path') return r
  return head === 'call_arg_len' ? [r[0] as Val, true] : undefined
}

/** A path into the call: `Call` fields first, then argument steps. */
function target(
  call: Call,
  sel: Val
): { get: () => Val | undefined; set: (v: Val) => Call } | undefined {
  if (!isSel(sel)) return undefined
  const head = sel[0]
  if (head === 'call_contract')
    return { get: () => call.contract, set: (v) => ({ ...call, contract: String(v) }) }
  if (head === 'call_fn') return { get: () => call.fn, set: (v) => ({ ...call, fn: String(v) }) }
  const steps = stepsOf(sel)
  if (!steps) return undefined
  const get = (): Val | undefined => walk(call.args, steps)
  return { get, set: (v) => ({ ...call, args: put(call.args, steps, v) as Val[] }) }
}

function walk(v: Val | undefined, steps: Val[]): Val | undefined {
  return steps.reduce<Val | undefined>((cur, s) => {
    if (cur === undefined) return undefined
    if (s === true) return Array.isArray(cur) ? cur.length : undefined
    if (Array.isArray(cur)) return typeof s === 'number' ? cur[s] : undefined
    if (isObj(cur) && 'map' in cur)
      return (cur.map as [Val, Val][]).find(([k]) => same(k, unlit(s)))?.[1]
    return undefined
  }, v)
}

function put(v: Val, steps: Val[], x: Val): Val {
  const [s, ...rest] = steps
  if (s === undefined) return x
  if (s === true && Array.isArray(v)) {
    const n = Number(big(x))
    return Array.from({ length: n }, (_, i) => v[i] ?? v[v.length - 1] ?? 0)
  }
  if (Array.isArray(v) && typeof s === 'number')
    return v.map((e, i) => (i === s ? put(e, rest, x) : e))
  if (isObj(v) && 'map' in v) {
    return {
      map: (v.map as [Val, Val][]).map(
        ([k, e]) => [k, same(k, unlit(s)) ? put(e, rest, x) : e] as [Val, Val]
      ),
    }
  }
  return v
}

/** A value of `v`'s type that is not `v`. */
function other(v: Val): Val {
  const n = big(v)
  if (n !== undefined) return as(v, n + 1n)
  if (typeof v === 'boolean') return !v
  if (typeof v === 'string') return v.length >= 56 ? otherAddress(v) : `${v.slice(0, 30)}_x`
  if (Array.isArray(v)) return [...v, v.at(-1) ?? 0]
  if (isObj(v) && 'bytes' in v) return { bytes: `${v.bytes}00` }
  if (isObj(v) && 'string' in v) return { string: `${v.string}x` }
  return null
}
/** An address of the same kind with one byte changed. */
function otherAddress(a: string): string {
  const contract = a.startsWith('C')
  const raw = Buffer.from(contract ? StrKey.decodeContract(a) : StrKey.decodeEd25519PublicKey(a))
  raw[0] = (raw[0] ?? 0) ^ 1
  return contract ? StrKey.encodeContract(raw) : StrKey.encodeEd25519PublicKey(raw)
}

/** The value `leaf` evaluates to against `call`, for what can be known without a
 *  ledger: constants, arguments, and scaled arithmetic over them. */
function value(call: Call, leaf: Val): Val | undefined {
  if (!isSel(leaf)) return leaf
  const [head, ...r] = leaf
  if (head === 'lit') return r[0]
  if (head === 'scaled') {
    const [s, n, d, a] = [
      value(call, r[0] as Val),
      value(call, r[1] as Val),
      value(call, r[2] as Val),
      value(call, r[3] as Val),
    ].map(big)
    return s === undefined || n === undefined || d === undefined || a === undefined
      ? undefined
      : as({ i128: '' }, (s * n) / d + a)
  }
  return target(call, leaf)?.get()
}

export interface DenyCase {
  /** What the case breaks, in words. */
  label: string
  call: Call
  /** The conjunct it breaks. */
  conjunct: Expr
}

const FLIP: Record<string, string> = {
  lt: 'gt',
  lte: 'gte',
  gt: 'lt',
  gte: 'lte',
  eq: 'eq',
  ne: 'ne',
}

/** A copy of `call` that breaks the comparison `[op, a, b]`, or undefined when a
 *  value to break it cannot be derived (a read, the clock, a quantifier). */
function breakCompare(call: Call, e: Expr[]): Call | undefined {
  let [op, a, b] = e as [string, Val, Val]
  if (isSel(a) && a[0] === 'sum') return breakSum(call, op, a, b)
  if (isSel(b) && b[0] !== 'lit' && b[0] !== 'scaled' && !isSel(a))
    [op, a, b] = [FLIP[op] as string, b, a]
  const t = target(call, a)
  const bound = value(call, b)
  const now = t?.get()
  if (!t || bound === undefined || now === undefined) return undefined
  const n = big(bound)
  const to: Val | undefined =
    op === 'eq'
      ? other(bound)
      : op === 'ne'
        ? bound
        : n === undefined
          ? undefined
          : op === 'lte'
            ? as(now, n + 1n)
            : op === 'lt'
              ? as(now, n)
              : op === 'gte'
                ? as(now, n - 1n)
                : op === 'gt'
                  ? as(now, n)
                  : undefined
  return to === undefined ? undefined : t.set(to)
}

/** Push the first element's field up (or down) until the total crosses the bound. */
function breakSum(call: Call, op: string, sum: [string, ...Val[]], b: Val): Call | undefined {
  const [vec, ...field] = sum.slice(1) as [Val, ...Val[]]
  const base = stepsOf(vec)
  const items = value(call, vec)
  const bound = big(value(call, b))
  if (!base || !Array.isArray(items) || items.length === 0 || bound === undefined) return undefined
  const part = (x: Val) => big(walk(x, field)) ?? 0n
  const total = items.reduce<bigint>((t, x) => t + part(x), 0n)
  const want = op === 'lte' ? bound + 1n : op === 'lt' ? bound : op === 'gte' ? bound - 1n : bound
  if (op !== 'lte' && op !== 'lt' && op !== 'gte' && op !== 'gt') return undefined
  const first = walk(items[0] as Val, field)
  const t = target(call, ['call_path', ...base, 0, ...field])
  return t?.set(as(first, (big(first) ?? 0n) + want - total))
}

/** A copy of `call` that breaks the conjunct, or undefined when none can be derived. */
function breakConjunct(call: Call, c: Expr): Call | undefined {
  if (!isSel(c)) return undefined
  const [op, a, b] = c
  if (op === 'in' || op === 'nin') {
    const t = target(call, a as Val)
    const set = (b as Val[]).map(unlit)
    if (!t || set.length === 0) return undefined
    if (op === 'nin') return t.set(set[0] as Val)
    let v = other(set[0] as Val)
    for (let i = 0; i < set.length && set.some((s) => same(s, v)); i++) v = other(v)
    return t.set(v)
  }
  if (op === 'all' || op === 'any') {
    // Break the element at index 0 (all), or empty the vec (any: nothing satisfies it).
    const v = target(call, a as Val)
    const vec = v?.get()
    if (!v || !Array.isArray(vec) || vec.length === 0) return undefined
    if (op === 'any') return v.set([])
    const first = (body: Expr): Expr[] =>
      isSel(body) && body[0] === 'and' ? (body[1] as Expr[]) : [body]
    const base = stepsOf(a as Val) ?? []
    const abs = (x: Val): Val =>
      isSel(x) && x[0] === 'elem' ? (['call_path', ...base, 0, ...x.slice(1)] as Val) : x
    for (const leaf of first(b as Expr)) {
      if (!isSel(leaf)) continue
      const broken = breakConjunct(call, [leaf[0], abs(leaf[1] as Val), abs(leaf[2] as Val)])
      if (broken) return broken
    }
    return undefined
  }
  return ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op) ? breakCompare(call, c) : undefined
}

const phrase = (c: Expr): string => JSON.stringify(c).slice(0, 80)

/** The conjuncts of each branch the permitted call can take: the children of a
 *  top-level `and`, one branch per child of a top-level `or`. */
export function branches(expr: Expr): Expr[][] {
  const kids = (e: Expr): Expr[] => (isSel(e) && e[0] === 'and' ? (e[1] as Expr[]) : [e])
  return isSel(expr) && expr[0] === 'or' ? (expr[1] as Expr[]).map(kids) : [kids(expr)]
}

/** One deny case per conjunct, derived from the leaf and the call it must refuse. */
export function denyCases(conjuncts: Expr[], permit: Call): DenyCase[] {
  return conjuncts.flatMap((conjunct) => {
    const call = breakConjunct(permit, conjunct)
    return call ? [{ label: `breaks ${phrase(conjunct)}`, call, conjunct }] : []
  })
}

export interface Verification {
  ok: boolean
  permit: Verdict
  cases: { label: string; denied: boolean; verdict: Verdict }[]
  /** Every conjunct that was tried is needed: dropping it lets its own case through. */
  minimal: boolean
  redundant: string[]
  /** Calls put to the interpreter. */
  checks: number
}

const MAX_CASES = 24
const rebuild = (all: Expr[][], dropped?: Expr): Expr => {
  const keep = (cs: Expr[]) => cs.filter((c) => c !== dropped)
  const ands = all.map((cs) =>
    keep(cs).length === 1 ? (keep(cs)[0] as Expr) : (['and', keep(cs)] as Expr)
  )
  return ands.length === 1 ? (ands[0] as Expr) : ['or', ands]
}

export async function verifyRule(
  server: rpc.Server,
  network: Network,
  interpreter: string,
  expr: Expr,
  encode: (e: Expr) => string,
  permit: Call
): Promise<Verification> {
  const one = async (e: Expr, call: Call) =>
    (await runChecks(server, network, interpreter, encode(e), [call]))[0] as Verdict
  const all = branches(expr)
  // The calls are asked together, WIDTH at a time. Which branch of an `or` the
  // permitted call takes has to be known before its conjuncts are turned against it.
  const first = await pool(
    [expr, ...(all.length > 1 ? all.map((b) => rebuild([b])) : [])],
    WIDTH,
    (e) => one(e, permit)
  )
  const permitVerdict = first[0] as Verdict
  const live = all.length > 1 ? all.filter((_, i) => first[i + 1]?.permitted) : all
  const cases = live.flatMap((b) => denyCases(b, permit)).slice(0, MAX_CASES)
  // Each deny case twice: against the whole rule (it must refuse), and against the
  // rule without the conjunct it breaks (it must now get through: the conjunct is needed).
  const answers = await pool(
    cases.flatMap((c) => [() => one(expr, c.call), () => one(rebuild(all, c.conjunct), c.call)]),
    WIDTH,
    (job) => job()
  )
  const redundant = cases
    .filter((_, i) => !answers[2 * i + 1]?.permitted)
    .map((c) => phrase(c.conjunct))
  const results = cases.map((c, i) => ({
    label: c.label,
    denied: !answers[2 * i]?.permitted,
    verdict: answers[2 * i] as Verdict,
  }))
  return {
    ok: permitVerdict.permitted && results.length > 0 && results.every((r) => r.denied),
    permit: permitVerdict,
    cases: results,
    minimal: redundant.length === 0,
    redundant,
    checks: first.length + 2 * cases.length,
  }
}
