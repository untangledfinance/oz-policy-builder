// An Intent says which calls a rule lets through and what each argument must
// satisfy; `intentExprs` lowers it to wire expressions, one per contract (a rule
// is scoped to one contract, and the interpreter refuses a Default scope). It is
// the one place a rule is written down: a recording becomes an Intent
// (`synth.ts`), a declaration is one, and a template (`registry.ts`) returns one.
//
// A rule's `at` is a path into the call's arguments: a number indexes a vec (the
// first is the argument), a string keys a map. Inside `each` and `some` the path
// is relative to the element. Lowering is a table, one row per rule: a new rule
// is a new row, not new code.

import type { Expr, Val } from './wire.ts'

export type Path = (number | string)[]
export type Arg = { arg: Path }
export type Cmp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

export type Rule =
  | { rule: 'pin'; at: Path; to: Val }
  | { rule: 'not'; at: Path; to: Val }
  | { rule: 'allow'; at: Path; in: Val[] }
  | { rule: 'deny'; at: Path; nin: Val[] }
  | { rule: 'cap'; at: Path; max: string }
  | { rule: 'floor'; at: Path; min: string }
  /** The vec at `at` has at most `max` elements. */
  | { rule: 'length'; at: Path; max: number }
  /** The value at `at` is at least `of` * num / den, `of` being another argument. */
  | { rule: 'minOut'; at: Path; of: Path; num: string; den: string }
  /** Every (`each`) or some (`some`) element of the vec at `at` satisfies `where`. */
  | { rule: 'each'; at: Path; where: Rule[] }
  | { rule: 'some'; at: Path; where: Rule[] }
  /** What `of` reaches in each element of the vec at `at` adds up to at most `max`. */
  | { rule: 'total'; at: Path; of?: Path; max: string }
  /** A value read from another contract: `contract.fn(args)` at `path`, compared with `to`. */
  | {
      rule: 'read'
      contract: string
      fn: string
      args?: (Val | Arg)[]
      path?: Path
      op: Cmp
      to: Val
    }
  /** The ledger clock (unix seconds) is at or before / at or after `ts`. */
  | { rule: 'until'; ts: number }
  | { rule: 'from'; ts: number }

export interface CallIntent {
  contract: string
  fn: string
  where?: Rule[]
}
export interface Intent {
  calls: CallIntent[]
}

const num = (s: string): Val => ({ i128: s })
const isArg = (v: unknown): v is Arg => typeof v === 'object' && v !== null && 'arg' in v

/** A constant as the contract wants it: a bare scalar, or `lit` for what a bare
 *  value cannot carry (a vec, a map, bytes, text, a bool or a void). */
export function konst(v: Val): Val {
  const bare =
    typeof v === 'number' ||
    typeof v === 'string' ||
    (typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      !('map' in v) &&
      !('bytes' in v) &&
      !('string' in v))
  return bare ? v : ['lit', v]
}

/** The value at `at`: the call's argument, or inside a quantifier the element. */
export function ref(at: Path, body: boolean, len = false): Expr {
  const steps = len ? [...at, true] : at
  if (body) return ['elem', ...steps] as Expr
  return !len && at.length === 1 && typeof at[0] === 'number'
    ? ['call_arg', at[0]]
    : (['call_path', ...steps] as Expr)
}

const and = (xs: Expr[]): Expr => (xs.length === 1 ? (xs[0] as Expr) : ['and', xs])
const operand = (a: Val | Arg): Expr => (isArg(a) ? ref(a.arg, false) : konst(a))

const LOWER: { [K in Rule['rule']]: (r: Extract<Rule, { rule: K }>, body: boolean) => Expr } = {
  pin: (r, b) => ['eq', ref(r.at, b), konst(r.to)],
  not: (r, b) => ['ne', ref(r.at, b), konst(r.to)],
  allow: (r, b) => ['in', ref(r.at, b), r.in.map(konst)],
  deny: (r, b) => ['nin', ref(r.at, b), r.nin.map(konst)],
  cap: (r, b) => ['lte', ref(r.at, b), num(r.max)],
  floor: (r, b) => ['gte', ref(r.at, b), num(r.min)],
  length: (r, b) => ['lte', ref(r.at, b, true), r.max],
  minOut: (r, b) => [
    'gte',
    ref(r.at, b),
    ['scaled', ref(r.of, b), num(r.num), num(r.den), num('0')],
  ],
  each: (r) => ['all', ref(r.at, false), and(r.where.map((w) => lower(w, true)))],
  some: (r) => ['any', ref(r.at, false), and(r.where.map((w) => lower(w, true)))],
  total: (r, b) => ['lte', ['sum', ref(r.at, b), ...(r.of ?? [])], num(r.max)],
  read: (r) => [
    r.op,
    ['read', r.contract, r.fn, (r.args ?? []).map(operand), ...(r.path ?? [])],
    konst(r.to),
  ],
  until: (r) => ['lte', ['now'], { u64: String(r.ts) }],
  from: (r) => ['gte', ['now'], { u64: String(r.ts) }],
}

export function lower(r: Rule, body = false): Expr {
  const row = LOWER[r.rule] as (r: Rule, body: boolean) => Expr
  return row(r, body)
}

/** `call_contract` and `call_fn` pinned, then the rules, in the order written. */
export function callExpr(c: CallIntent): Expr {
  return and([
    ['eq', ['call_contract'], c.contract],
    ['eq', ['call_fn'], c.fn],
    ...(c.where ?? []).map((r) => lower(r)),
  ])
}

/** One expression per contract: a call is permitted when any call of the
 *  contract's group holds. */
export function intentExprs(intent: Intent): Map<string, Expr> {
  const groups = new Map<string, CallIntent[]>()
  for (const c of intent.calls) groups.set(c.contract, [...(groups.get(c.contract) ?? []), c])
  return new Map(
    [...groups].map(([contract, cs]) => [
      contract,
      cs.length === 1 ? callExpr(cs[0] as CallIntent) : ['or', cs.map(callExpr)],
    ])
  )
}
