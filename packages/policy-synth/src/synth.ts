// From the calls a transaction made to an Intent: who is pinned, how much is
// capped, what is left open. The registry says what each argument IS; where it
// says nothing, every argument that is not an amount is pinned to what was
// recorded, which is tight rather than loose.

import { Refusal } from './envelope.ts'
import type { CallIntent, Constraint, Intent, Path } from './intent.ts'
import { and, callExpr, intentExprs } from './intent.ts'
import type { Call } from './record.ts'
import { identify, type Kind, PROTOCOLS } from './registry.ts'
import { canon, constantLast, FLIP, selectors } from './rules.ts'
import {
  branches,
  CEILINGS,
  conjuncts,
  DECODE_LIMITS,
  type Expr,
  encode,
  fields,
  hashOf,
  intOf,
  isConstant,
  isMap,
  isSelector,
  isTagged,
  unlit,
  type Val,
  validate,
} from './wire.ts'

/** What the recording cannot say, supplied by the person who knows. */
export interface Answers {
  /** A cap for every argument that is an amount. */
  limit?: string | undefined
  /** Caps by argument name or position (`requests.amount` for a field of a vec of structs). */
  limits?: Record<string, string> | undefined
  /** A list of values an argument may take instead of the one recorded. */
  allow?: Record<string, Val[]> | undefined
}

export interface Synthesis {
  intent: Intent
  /** Questions whose answers change what the rule permits. */
  ambiguities: { code: 'AMOUNT_BOUND_MISSING' | 'SLIPPAGE_FLOOR_MISSING'; question: string }[]
  warnings: string[]
}

export function synthesize(contexts: Call[], answers: Answers = {}): Synthesis {
  const out: Synthesis = { intent: { calls: [] }, ambiguities: [], warnings: [] }
  if (contexts.length === 0) throw new Refusal('SYNTHESIS_ERROR', 'no call to scope a policy to')
  for (const c of contexts) out.intent.calls.push(callIntent(c, answers, out))
  const contracts = new Set(contexts.map((c) => c.contract))
  if (contracts.size > 1) {
    out.warnings.push(
      `the transaction authorises calls on ${contracts.size} contracts; a rule covers one, so each needs its own install`
    )
  }
  return out
}

function callIntent(c: Call, a: Answers, out: Synthesis): CallIntent {
  const known = identify(c.fn, c.args)
  if (!known) {
    // A function the registry knows BY NAME but recorded with the WRONG NUMBER of arguments is
    // refused, never treated as unknown: its arguments no longer line up with the roles the registry
    // gives them, so the amount cap or slippage floor the real function needs would be missed and the
    // gate would pass an uncapped rule. A matching count whose shape differs is pinned
    // as recorded (every argument fixed to its exact value), which is tight, so it is allowed through.
    const rows = Object.values(PROTOCOLS).flatMap((fns) =>
      Object.hasOwn(fns, c.fn) ? [fns[c.fn] as [string, Kind][]] : []
    )
    if (rows.length > 0 && !rows.some((r) => r.length === c.args.length)) {
      const r = rows[0] as [string, Kind][]
      throw new Refusal(
        'SYNTHESIS_ERROR',
        `${c.contract}.${c.fn}: recorded with ${c.args.length} argument(s), but ${c.fn} takes ${r.length} (${r
          .map(([n]) => n)
          .join(
            ', '
          )}); the recorded call does not match the function the registry knows, so no rule is scoped to it`
      )
    }
    out.warnings.push(
      `${c.contract}.${c.fn} is not a function the registry knows: every argument that is not an amount is pinned to its recorded value`
    )
  }
  const build = (flat: boolean): CallIntent => {
    const where: Constraint[] = []
    c.args.forEach((v, i) => {
      const [name, kind]: [string, Kind] = known?.args[i] ?? [String(i), kindOf(v)]
      const listed = a.allow?.[name] ?? a.allow?.[String(i)]
      const bound = a.limits?.[name] ?? a.limits?.[String(i)] ?? a.limit
      if (listed && kind === 'who') where.push({ constraint: 'allow', at: [i], in: listed })
      else if (kind === 'who' || kind === 'exact') where.push({ constraint: 'pin', at: [i], to: v })
      else if (kind === 'amount') {
        if (bound === undefined) out.ambiguities.push(missing(c, name))
        else where.push({ constraint: 'cap', at: [i], max: bound })
      } else if (kind === 'min') out.ambiguities.push(slippage(c, name))
      else if (kind === 'requests') where.push(...requests([i], v as Val[], a, c, name, out, flat))
    })
    return { contract: c.contract, fn: c.fn, where }
  }
  // A quantifier body weighs 32 leaves per leaf of the 200 a rule has; when the
  // recorded vec does not fit one, each element is pinned in turn instead.
  const fits = (x: CallIntent) => {
    try {
      validate(callExpr(x))
      return true
    } catch {
      return false
    }
  }
  const quantified = build(false)
  if (fits(quantified)) return quantified
  const mark = [out.ambiguities.length, out.warnings.length] as const
  const flat = build(true)
  out.ambiguities.length = mark[0]
  out.warnings.length = mark[1]
  return flat
}

/** The registry row for a function name, in whichever protocol has it. */
const rowOf = (fn: string) =>
  Object.values(PROTOCOLS).find((fns) => Object.hasOwn(fns, fn))?.[fn] ?? []

/** The amount questions an intent leaves open: a function the registry knows by name,
 *  one of whose arguments is an amount (or a vec of structs that carries one), and no
 *  cap on it: an amount needs a cap on the argument itself, a vec of structs one whose
 *  path ends in `amount` (a cap on `request_type` bounds nothing that moves).
 *  What a recording is asked, an intent is asked too. */
export function unbounded(intent: Intent): Synthesis['ambiguities'] {
  // The paths the rules named `kinds` reach, `each`/`some` bodies relative to their vec.
  const reach = (r: Constraint, kinds: string[]): Path[] => {
    if (r.constraint === 'each' || r.constraint === 'some')
      return r.where.flatMap((w) => reach(w, kinds)).map((p) => [...r.at, ...p])
    if (
      r.constraint === 'read' ||
      r.constraint === 'until' ||
      r.constraint === 'from' ||
      !kinds.includes(r.constraint)
    )
      return []
    // A floor of zero or less admits every output.
    if (r.constraint === 'floor' && BigInt(r.min) <= 0n) return []
    return [r.constraint === 'total' ? [...r.at, ...(r.of ?? [])] : r.at]
  }
  return intent.calls.flatMap((c) => {
    const [caps, floors] = [
      ['cap', 'total'],
      ['floor', 'minOut'],
    ].map((k) => (c.where ?? []).flatMap((r) => reach(r, k))) as [Path[], Path[]]
    const [asked, floored] = [{ contract: c.contract, fn: c.fn, args: [] as Val[] }, floors]
    return rowOf(c.fn).flatMap(([name, kind], i) => {
      const whole = (ps: Path[]) => ps.some((p) => p.length === 1 && p[0] === i)
      if (kind === 'amount') return whole(caps) ? [] : [missing(asked, name)]
      if (kind === 'min') return whole(floored) ? [] : [slippage(asked, name)]
      return kind === 'requests' && !caps.some((p) => p[0] === i && p.at(-1) === 'amount')
        ? [missing(asked, name)]
        : []
    })
  })
}

/** A bound a branch puts on a leaf: `op` against `to`, `to` being a constant or a leaf. */
interface Bound {
  op: string
  at: Val
  to: Val
}

/** The bounds a conjunct list guarantees: those of an `and`'s children, and of an `all` body
 *  (as `elem` leaves, returned under `each` with the vec they range over). An `or` guarantees
 *  none of its children's bounds, so it adds nothing. */
function bounds(conj: Expr[], out: { top: Bound[]; each: { over: string; b: Bound }[] }) {
  for (const e of conj) {
    if (!isSelector(e)) continue
    if (e[0] === 'and') bounds(e[1] as Expr[], out)
    else if (e[0] === 'all') {
      const inner = { top: [] as Bound[], each: [] as typeof out.each }
      bounds(conjuncts(e[2] as Expr), inner)
      for (const b of inner.top) out.each.push({ over: canon(e[1] as Val), b })
    } else if (e[0] in FLIP && e.length === 3) {
      const [op, at, to] = constantLast(e) as [string, Val, Val]
      out.top.push({ op, at, to })
    }
  }
}

/** The same question of a finished predicate, asked of each branch of it: for each
 *  function a branch can serve that the registry knows, the branch itself must put an
 *  upper bound (`lte`/`lt` against a constant) on each amount argument, a lower bound that
 *  is more than zero on a least output, and for requests a bound on every element. */
export function unboundedExpr(expr: Expr): Synthesis['ambiguities'] {
  const asked = new Map<string, Synthesis['ambiguities'][number]>()
  for (const branch of branches(expr)) {
    const got = { top: [] as Bound[], each: [] as { over: string; b: Bound }[] }
    bounds(branch, got)
    const upper = got.top.filter((b) => (b.op === 'lte' || b.op === 'lt') && isConstant(b.to))
    const num = (b: Bound) => {
      const n = intOf(unlit(b.to))
      return n === undefined ? undefined : b.op === 'lt' ? n - 1n : n
    }
    const named = [...new Set(selectors(and(branch)).map((s) => s.fn))]
    const fns = named.filter((f) => f !== '*')
    // The leaves that carry the call's amount arguments, for a `scaled` slippage floor: a floor is a
    // ratio OF THE INPUT AMOUNT, so its source must be one of these, not the output itself, a
    // deadline or anything else (SYNTH-CORE-02).
    const amountLeaves = (fn: string) =>
      rowOf(fn).flatMap(([, k], j) => (k === 'amount' ? [canon(['call_arg', j])] : []))
    // A branch that names no function serves every function, with any amount.
    if (named.includes('*')) {
      const q = {
        code: 'AMOUNT_BOUND_MISSING' as const,
        question:
          'no function pinned: the rule permits every function of the contract with any amount. Pin one with call_fn, or allow it deliberately.',
      }
      asked.set(q.question, q)
    }
    for (const fn of fns)
      rowOf(fn).forEach(([name, kind], i) => {
        const at = canon(['call_arg', i])
        const ask = { contract: '', fn, args: [] as Val[] }
        let q: Synthesis['ambiguities'][number] | undefined
        if (kind === 'amount')
          q = upper.some((b) => canon(b.at) === at) ? undefined : missing(ask, name)
        else if (kind === 'min') {
          // More than nothing: `>= 0` and `> -1` admit every output. A `scaled` floor is a ratio of
          // the INPUT AMOUNT: its source must be an amount argument of the call (never the output
          // itself, a deadline, or another leaf), and its additive term must be non-negative, or the
          // floor can be driven to zero (`out >= in * 1/10^18`, `out >= in * 1 - 2^126`, or a scaled
          // of the wrong argument all admit an output of 0).
          const amounts = amountLeaves(fn)
          const floor = (b: Bound) => {
            if (canon(b.at) !== at || !(b.op === 'gte' || b.op === 'gt')) return false
            if (isSelector(b.to) && b.to[0] === 'scaled') {
              const addN = intOf(unlit(b.to[4] as Val))
              return amounts.includes(canon(b.to[1] as Val)) && addN !== undefined && addN >= 0n
            }
            const n = intOf(unlit(b.to))
            return isConstant(b.to) && n !== undefined && (b.op === 'gte' ? n > 0n : n >= 0n)
          }
          q = got.top.some(floor) ? undefined : slippage(ask, name)
        } else if (kind === 'requests') {
          // Every request is capped: by an `all` over the vec, or by a length bound and a cap on each.
          const len = upper.find((b) => canon(b.at) === canon(['call_path', i, true]))
          const n = len === undefined ? undefined : num(len)
          const eachCap = got.each.some(
            (e) =>
              e.over === at &&
              (e.b.op === 'lte' || e.b.op === 'lt') &&
              isConstant(e.b.to) &&
              canon(e.b.at) === canon(['elem', 'amount'])
          )
          const flat =
            n !== undefined &&
            n <= BigInt(DECODE_LIMITS.max_elems) &&
            Array.from({ length: Number(n) }, (_, k) => k).every((k) =>
              upper.some((b) => canon(b.at) === canon(['call_path', i, k, 'amount']))
            )
          q = eachCap || flat ? undefined : missing(ask, name)
        }
        if (q) asked.set(q.question, q)
      })
  }
  return [...asked.values()]
}

/** The question of a swap's least output: nothing says what the account must get back. */
const slippage = (c: Call, name: string): Synthesis['ambiguities'][number] => ({
  code: 'SLIPPAGE_FLOOR_MISSING',
  question: `${c.fn}: what is the least \`${name}\` may be? Nothing sets it, so a trade at any price is permitted: set a floor or a minOut ratio on it, or allow it deliberately.`,
})

const kindOf = (v: Val): Kind => (isTagged(v) && ('i128' in v || 'u128' in v) ? 'amount' : 'exact')

const missing = (c: Call, name: string): Synthesis['ambiguities'][number] => ({
  code: 'AMOUNT_BOUND_MISSING',
  question: `${c.fn}: what is the most \`${name}\` may be? Without a cap the rule bounds everything about the call except how much it moves.`,
})

/** A vec of structs (Blend's requests): at most as many as recorded, and each
 *  field kept to what was seen - an address or kind to the recorded values, an
 *  amount under a cap. A quantifier states that once for any length; flat, each
 *  recorded element is pinned in turn. */
function requests(
  at: Path,
  vec: Val[],
  a: Answers,
  c: Call,
  name: string,
  out: Synthesis,
  flat: boolean
): Constraint[] {
  // Refuse an oversized vec of structs before building any constraint: a 4000-request submit whose
  // elements carry 4000 keys each would pin 16M fields and exhaust memory. Both forms the builder
  // can take are bounded by the ceilings (the most any interpreter allows): a quantifier body
  // weighs one leaf per field times `max_elems`, and the flat form one leaf per recorded field in
  // all. When neither can fit `max_leaves`, the rule can never install, so it is refused here from
  // the element sizes alone (an O(n) count, never the fields themselves), not built and then
  // rejected. The real per-interpreter limits are still enforced by `validate` on the result.
  const perElem = vec.map((el) => (isMap(el) ? el.map.length : 0))
  const flatLeaves = perElem.reduce((n, k) => n + k, 0)
  const maxKeys = perElem.reduce((n, k) => Math.max(n, k), 0)
  if (maxKeys * CEILINGS.max_elems > CEILINGS.max_leaves && flatLeaves > CEILINGS.max_leaves)
    throw new Refusal(
      'SYNTHESIS_ERROR',
      `${c.fn}.${name}: ${vec.length} requests of up to ${maxKeys} fields exceed the interpreter's ceilings (at most ${CEILINGS.max_leaves} leaves, ${CEILINGS.max_elems} per quantified element); record a smaller batch`
    )
  // Every element is a map: that is the shape `requests` is recognised by.
  const maps = vec.map(fields)
  const names = [...new Set(maps.flatMap((m) => Object.keys(m)))]
  // Small elements can still name many fields between them: 4000 requests of one key each, every
  // key different, pass the check above, yet both forms build one constraint per distinct field
  // (the flat form once per element too, 16M here). So the same test is made again on the distinct
  // field count, which is what the builder iterates: a quantifier body of `names` leaves times
  // `max_elems`, and the flat form `names` leaves per element. Every field but an uncapped amount
  // compiles to a comparison of two leaves, so each bound is under the real weight once there are
  // two fields or more (and refusing needs 13): this never refuses a rule `validate` would accept.
  if (
    names.length * CEILINGS.max_elems > CEILINGS.max_leaves &&
    vec.length * names.length > CEILINGS.max_leaves
  )
    throw new Refusal(
      'SYNTHESIS_ERROR',
      `${c.fn}.${name}: ${vec.length} requests with ${names.length} distinct fields exceed the interpreter's ceilings (at most ${CEILINGS.max_leaves} leaves, ${CEILINGS.max_elems} per quantified element); record a smaller batch`
    )
  const bound = a.limits?.[`${name}.amount`] ?? a.limit
  // The question is asked from the function's definition (this argument is a `requests` vec, which
  // carries an amount per element), not from whether the recorded elements happen to include an
  // `amount` key: a submit recorded with the amount omitted must still be capped.
  if (bound === undefined) out.ambiguities.push(missing(c, `${name}.amount`))
  const field = (f: string, seen: Val[], path: Path): Constraint[] => {
    if (f === 'amount')
      return bound === undefined ? [] : [{ constraint: 'cap', at: path, max: bound }]
    const one = seen.length === 1
    return [
      one
        ? { constraint: 'pin', at: path, to: seen[0] as Val }
        : { constraint: 'allow', at: path, in: seen },
    ]
  }
  const rules: Constraint[] = [{ constraint: 'length', at, max: vec.length }]
  if (!flat) {
    const seen = (f: string) => [
      ...new Map(maps.map((m) => [JSON.stringify(m[f]), m[f] as Val])).values(),
    ]
    return [
      ...rules,
      { constraint: 'each', at, where: names.flatMap((f) => field(f, seen(f), [f])) },
    ]
  }
  const one = maps.flatMap((m, i) => names.flatMap((f) => field(f, [m[f] as Val], [...at, i, f])))
  return [...rules, ...one]
}

export interface ProposedRule {
  contract: string
  expr: Expr
  encoded: string
  hash: string
}

/** One rule per contract the intent covers, each checked against the decode refusals of the
 *  interpreter whose `caps` they are, so nothing leaves here that install would refuse. */
export function propose(intent: Intent, caps = DECODE_LIMITS): ProposedRule[] {
  return [...intentExprs(intent)].map(([contract, expr]) => {
    try {
      validate(expr, caps)
    } catch (e) {
      throw new Refusal('MALFORMED_PREDICATE', `${contract}: ${(e as Error).message}`)
    }
    const encoded = encode(expr)
    return { contract, expr, encoded, hash: hashOf(encoded) }
  })
}
