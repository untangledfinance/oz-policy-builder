// Simulate and verify, both through the contract's own `check`: there is no copy
// of the evaluator here. A call is permitted or denied by what the interpreter
// says about it, with the code it would raise.
//
// Verify asks a rule two things of one permitted call. Does every constraint bind?
// Each leaf of the rule is turned against the call (the value that would break it
// is derived from the leaf itself) and the rule must deny it. And is each
// conjunct needed? Drop it, re-run, and the call it was guarding must now pass.

import { rpc, StrKey, xdr } from '@stellar/stellar-sdk'
import { pool, reasonOf, simulate } from './chain.ts'
import type { Network } from './config.ts'
import { Refusal } from './envelope.ts'
import { and } from './intent.ts'
import type { Call } from './record.ts'
import { selectors } from './rules.ts'
import {
  BITS,
  intOf as big,
  branches,
  conjuncts,
  type Expr,
  encode,
  isTagged as isObj,
  isSelector as isSel,
  toScVal,
  unlit,
  type Val,
} from './wire.ts'

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

/** `Context::Contract(ContractContext { args, contract, fn_name })`. */
const context = (c: Call): xdr.ScVal =>
  toScVal([
    'Contract',
    {
      map: [
        ['args', c.args],
        ['contract', c.contract],
        ['fn_name', c.fn],
      ],
    },
  ])

/** What `interpreter.check` says: it always fails, and the contract error is the
 *  verdict (`Error(Contract, #0)` permits), so a submitted `check` commits nothing. */
async function verdictOf(
  server: rpc.Server,
  network: Network,
  interpreter: string,
  predicate: xdr.ScVal,
  call: xdr.ScVal
): Promise<number> {
  const sim = await simulate(server, network, interpreter, 'check', predicate, call)
  const said = rpc.Api.isSimulationError(sim)
    ? /^HostError: Error\(Contract, #(\d+)\)/.exec(sim.error)
    : null
  if (!said)
    throw new Refusal(
      'SIMULATION_ERROR',
      `check: no verdict (${rpc.Api.isSimulationError(sim) ? reasonOf(sim.error) : 'it returned'}); is ${interpreter} the interpreter?`
    )
  return Number(said[1])
}

/** Ask `interpreter.check(predicate, call)` for each call, a few at a time. */
export async function runChecks(
  server: rpc.Server,
  network: Network,
  interpreter: string,
  encoded: string,
  calls: Call[],
  signal?: AbortSignal
): Promise<Verdict[]> {
  if (calls.length > MAX_CHECKS)
    throw new Refusal('SIMULATION_ERROR', `at most ${MAX_CHECKS} calls per request`)
  const bytes = xdr.ScVal.scvBytes(Buffer.from(encoded, 'base64'))
  return pool(
    calls,
    WIDTH,
    async (c) => {
      const code = await verdictOf(server, network, interpreter, bytes, context(c))
      return { permitted: code === 0, code, reason: REASONS[code] ?? `code ${code}` }
    },
    signal
  )
}

// ---- deny cases: each leaf of the rule, turned against a permitted call ----

type Num = bigint
const same = (a: Val, b: Val) => JSON.stringify(a) === JSON.stringify(b)

/** An integer written the way `like` was written (a u32 stays a u32 while it fits). */
function as(like: Val | undefined, n: Num): Val {
  if (typeof like === 'number' && n >= 0n && n <= 0xffffffffn) return Number(n)
  const tag = isObj(like) ? Object.keys(like)[0] : undefined
  if (tag === 'i32') return { i32: Number(n) }
  return { [tag && tag in BITS ? tag : 'i128']: n.toString() } as Val
}

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
): { get: () => Val | undefined; set: (v: Val) => Call | undefined } | undefined {
  if (!isSel(sel)) return undefined
  const head = sel[0]
  if (head === 'call_contract')
    return { get: () => call.contract, set: (v) => ({ ...call, contract: String(v) }) }
  if (head === 'call_fn') return { get: () => call.fn, set: (v) => ({ ...call, fn: String(v) }) }
  const steps = stepsOf(sel)
  if (!steps) return undefined
  const get = (): Val | undefined => walk(call.args, steps)
  return {
    get,
    set: (v) => {
      const args = put(call.args, steps, v)
      return args === undefined ? undefined : { ...call, args: args as Val[] }
    },
  }
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

/** The longest vec a deny case grows to: a bound is tool input, so a case is never
 *  built from it unchecked (a length of ten million is not a request). */
const MAX_GROW = 256

/** `v` with `x` at `steps`, or undefined when that cannot be built. */
function put(v: Val, steps: Val[], x: Val): Val | undefined {
  const [s, ...rest] = steps
  if (s === undefined) return x
  if (s === true && Array.isArray(v)) {
    const n = Number(big(x))
    return n >= 0 && n <= MAX_GROW
      ? Array.from({ length: n }, (_, i) => v[i] ?? v[v.length - 1] ?? 0)
      : undefined
  }
  let failed = false
  const into = (e: Val): Val => {
    const r = put(e, rest, x)
    failed ||= r === undefined
    return r as Val
  }
  const out: Val =
    Array.isArray(v) && typeof s === 'number'
      ? v.map((e, i) => (i === s ? into(e) : e))
      : isObj(v) && 'map' in v
        ? { map: (v.map as [Val, Val][]).map(([k, e]) => [k, same(k, unlit(s)) ? into(e) : e]) }
        : v
  return failed ? undefined : out
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
/** An address of the same kind with one byte of its key changed. */
function otherAddress(a: string): string {
  const [decode, encode] =
    a[0] === 'C'
      ? [StrKey.decodeContract, StrKey.encodeContract]
      : a[0] === 'M'
        ? [StrKey.decodeMed25519PublicKey, StrKey.encodeMed25519PublicKey]
        : [StrKey.decodeEd25519PublicKey, StrKey.encodeEd25519PublicKey]
  const raw = Buffer.from(decode(a))
  raw[0] = (raw[0] ?? 0) ^ 1
  return encode(raw)
}

/** The value `leaf` evaluates to against `call`, for what can be known without a
 *  ledger: constants, arguments, and scaled arithmetic over them. */
function value(call: Call, leaf: Val): Val | undefined {
  if (!isSel(leaf)) return leaf
  const [head, ...r] = leaf
  if (head === 'lit') return r[0]
  if (head === 'scaled') {
    const [s, n, d, a] = r.map((x) => big(value(call, x as Val)))
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

/** How far past an ordering's bound a value must move to break it. */
const SHIFT: Record<string, Num> = { lte: 1n, lt: 0n, gte: -1n, gt: 0n }
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
  const [n, shift] = [big(bound), SHIFT[op]]
  if (op === 'eq' || op === 'ne') return t.set(op === 'eq' ? other(bound) : bound)
  return n === undefined || shift === undefined ? undefined : t.set(as(now, n + shift))
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
  const shift = SHIFT[op]
  if (shift === undefined) return undefined
  const want = bound + shift
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
    const base = stepsOf(a as Val) ?? []
    const abs = (x: Val): Val =>
      isSel(x) && x[0] === 'elem' ? (['call_path', ...base, 0, ...x.slice(1)] as Val) : x
    for (const leaf of conjuncts(b as Expr)) {
      if (!isSel(leaf)) continue
      const broken = breakConjunct(call, [leaf[0], abs(leaf[1] as Val), abs(leaf[2] as Val)])
      if (broken) return broken
    }
    return undefined
  }
  return ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op) ? breakCompare(call, c) : undefined
}

const phrase = (c: Expr): string => JSON.stringify(c).slice(0, 80)

/** One deny case per conjunct, derived from the leaf and the call it must refuse. */
export function denyCases(conjuncts: Expr[], permit: Call): DenyCase[] {
  return conjuncts.flatMap((conjunct) => {
    const call = breakConjunct(permit, conjunct)
    return call ? [{ label: `breaks ${phrase(conjunct)}`, call, conjunct }] : []
  })
}

export interface Verification {
  /** The calls were permitted, every case was refused, every branch of an `or` was
   *  exercised by a call (a branch nothing took could permit anything), and no conjunct
   *  holding an `or` went untested (it too could permit anything). */
  ok: boolean
  /** `ok`, and nothing is left untested either. */
  complete: boolean
  /** The first call's verdict; `permits` has them all. */
  permit: Verdict
  permits: Verdict[]
  cases: { label: string; denied: boolean; verdict: Verdict }[]
  /** No conjunct was found redundant: each one tried is needed, because without it its
   *  own case gets through (or the rule would no longer install). */
  minimal: boolean
  redundant: string[]
  /** Branches of an `or` that no call took, so nothing was tried against them. */
  unexamined: string[]
  /** Conjuncts nothing was tried against: no case can be derived (a read, the clock, a
   *  nested `or`), the case budget ran out, or another conjunct on the same argument
   *  denies the same case, so whether this one is needed cannot be told. */
  untested: string[]
  /** Calls put to the interpreter. */
  checks: number
}

const MAX_CASES = 24

/** An `or` anywhere inside `e`. */
const hasOr = (e: Val): boolean =>
  Array.isArray(e) && ((isSel(e) && e[0] === 'or') || e.some((x) => hasOr(x as Val)))

/** `branch i` of the rule without `dropped`, the other branches as they are; undefined
 *  when that leaves the branch empty (it would permit everything). */
function without(all: Expr[][], i: number, dropped: Expr): Expr | undefined {
  const kept = (all[i] as Expr[]).filter((c) => c !== dropped)
  if (kept.length === 0) return undefined
  const branch = all.map((b, j) => and(j === i ? kept : b))
  return branch.length === 1 ? (branch[0] as Expr) : ['or', branch]
}

/** The leaf a comparison is about (its first operand that is a selector). */
const subject = (c: Expr): string =>
  JSON.stringify(isSel(c) ? [c[1], c[2]].find((x) => isSel(x as Val)) : c)

/** Verify `expr` against calls it must permit: each is permitted, each conjunct of the
 *  branch a call takes is turned against it and refused, and each conjunct is dropped
 *  in turn to see that its own case then gets through. At most `MAX_CHECKS` calls in all. */
export async function verifyRule(
  server: rpc.Server,
  network: Network,
  interpreter: string,
  expr: Expr,
  permits: Call[],
  signal?: AbortSignal
): Promise<Verification> {
  const all = branches(expr)
  const or = all.length > 1
  let asked = 0
  let refused = false
  const ask = async (e: Expr, call: Call): Promise<Verdict | undefined> => {
    if (refused) return undefined
    asked++
    return (await runChecks(server, network, interpreter, encode(e), [call], signal))[0] as Verdict
  }
  const run = <T>(jobs: (() => Promise<T>)[]) => pool(jobs, WIDTH, (j) => j(), signal)
  // Each permitted call: the whole rule, and when it is an `or`, each branch it can
  // take (a branch pins the contract and function of its call, so the rest are not asked).
  const probes = permits
    .flatMap((call, k) => [
      { k, i: -1, e: expr, call },
      ...(or
        ? all.flatMap((b, i) =>
            selectors(and(b)).some(
              (s) =>
                (s.contract === '*' || s.contract === call.contract) &&
                (s.fn === '*' || s.fn === call.fn)
            )
              ? [{ k, i, e: and(b), call }]
              : []
          )
        : []),
    ])
    .slice(0, MAX_CHECKS)
  const probe = probes.map((p) => async () => {
    const v = await ask(p.e, p.call)
    refused ||= p.i === -1 && v !== undefined && !v.permitted
    return v
  })
  // Which call stands for each branch, once one is permitted by it.
  const stand = (got: (Verdict | undefined)[]) =>
    all.flatMap((b, i) => {
      const at = probes.findIndex((p, n) => (or ? p.i === i : p.i === -1) && got[n]?.permitted)
      return at < 0 ? [] : [{ i, b, call: probes[at]?.call as Call }]
    })
  const plan = (live: ReturnType<typeof stand>, budget: number) =>
    live
      .flatMap(({ i, b, call }) => denyCases(b, call).map((c) => ({ ...c, i })))
      .slice(0, Math.min(MAX_CASES, budget >> 1))
  const two = (c: ReturnType<typeof plan>[number]) => [
    () => ask(expr, c.call),
    async () => {
      const e = without(all, c.i, c.conjunct)
      return e === undefined ? undefined : ask(e, c.call)
    },
  ]
  let got: (Verdict | undefined)[]
  let cases: ReturnType<typeof plan>
  let answers: (Verdict | undefined)[]
  if (or) {
    got = await run(probe)
    cases = plan(stand(got), MAX_CHECKS - probes.length)
    answers = refused ? [] : await run(cases.flatMap(two))
  } else {
    // Nothing the cases need is learnt from the permit, so all are asked together: a
    // denied call stops the rest from being sent.
    cases = plan(
      [{ i: 0, b: all[0] as Expr[], call: permits[0] as Call }],
      MAX_CHECKS - probes.length
    )
    const both = await run([...probe, ...cases.flatMap(two)])
    got = both.slice(0, probes.length)
    answers = both.slice(probes.length)
  }
  const permitted = permits.map((_, k) => got[probes.findIndex((p) => p.k === k && p.i === -1)])
  const live = stand(got)
  const results = cases.flatMap((c, n) => {
    const v = answers[2 * n]
    return v ? [{ label: c.label, denied: !v.permitted, verdict: v }] : []
  })
  const redundant: string[] = []
  const untested: string[] = []
  cases.forEach((c, n) => {
    const v = answers[2 * n + 1]
    // Dropping a conjunct can leave a rule the contract refuses (2xx): then it is needed.
    // Still denied (1xx): redundant, unless another conjunct of the branch is about the
    // same leaf, whose own denial this may be.
    if (v === undefined || v.permitted || v.code >= 200) return
    const others = (all[c.i] as Expr[]).filter((x) => x !== c.conjunct)
    const twin = others.some((x) => same(x, c.conjunct))
    const kin = others.some((x) => subject(x) === subject(c.conjunct))
    ;(kin && !twin ? untested : redundant).push(phrase(c.conjunct))
  })
  const tried = new Set(cases.map((c) => c.conjunct))
  const left = live.flatMap(({ b }) => b.filter((c) => !tried.has(c)))
  untested.push(...left.map(phrase))
  const unexamined = or
    ? all.filter((_, i) => !live.some((l) => l.i === i)).map((b) => phrase(and(b)))
    : []
  const ok =
    permitted.every((v) => v?.permitted) &&
    results.length > 0 &&
    results.every((r) => r.denied) &&
    unexamined.length === 0 &&
    // A conjunct nothing was tried against that holds an `or` can permit what none of the
    // cases reached; a clock or a read can only narrow, so those leave `ok` alone.
    !left.some(hasOr)
  return {
    ok,
    complete: ok && untested.length === 0,
    permit: permitted[0] as Verdict,
    permits: permitted.filter((v) => v !== undefined),
    cases: results,
    minimal: redundant.length === 0,
    redundant,
    unexamined,
    untested,
    checks: asked,
  }
}
