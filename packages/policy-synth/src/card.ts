// The review card: a rule in words, rendered from the expression alone by two
// tables (what an operator says, what an operand is called). It reads the wire
// shape, so a rule written by hand, synthesised or installed on chain is
// described the same way, and nothing in it can differ from what is enforced.

import { type Expr, isSelector, type Val } from './wire.ts'

const COMPARE: Record<string, string> = {
  eq: 'must be',
  ne: 'must not be',
  lt: 'must be below',
  lte: 'must be at most',
  gt: 'must be above',
  gte: 'must be at least',
  in: 'must be one of',
  nin: 'must not be one of',
}
const GROUP: Record<string, string> = {
  or: 'Any one of:',
  all: 'For every item in',
  any: 'For at least one item in',
}

const path = (steps: Val[]): string =>
  steps.map((s) => (s === true ? '(count)' : String(constant(s)))).join(' > ')

/** What an operand is, in words. */
export function operand(v: Val): string {
  if (!isSelector(v)) return constant(v)
  const [head, ...r] = v
  switch (head) {
    case 'call_contract':
      return 'the contract'
    case 'call_fn':
      return 'the function'
    case 'now':
      return 'the ledger time'
    case 'call_arg':
      return `argument ${r[0]}`
    case 'call_arg_len':
      return `the number of items in argument ${r[0]}`
    case 'call_arg_field':
      return `argument ${r[0]} > ${path(r.slice(1))}`
    case 'call_path':
      return r.at(-1) === true
        ? `the number of items in argument ${path(r.slice(0, -1))}`
        : `argument ${path(r)}`
    case 'elem':
      return r.length === 0 ? 'the item' : `the item's ${path(r)}`
    case 'lit':
      return constant(r[0] as Val)
    case 'sum':
      return `the total of ${r.length > 1 ? `${path(r.slice(1))} in ` : ''}${operand(r[0] as Val)}`
    case 'scaled': {
      const [src, num, den, add] = r as Val[]
      const tail = JSON.stringify(constant(add as Val)) === '"0"' ? '' : ` + ${operand(add as Val)}`
      return `(${operand(src as Val)} x ${operand(num as Val)} / ${operand(den as Val)}${tail})`
    }
    case 'read': {
      const [target, fn, args, ...steps] = r as [string, string, Val[], ...Val[]]
      const given = args.length > 0 ? args.map(operand).join(', ') : ''
      return `${fn}(${given}) on ${target}${steps.length > 0 ? ` > ${path(steps)}` : ''}`
    }
  }
  return JSON.stringify(v)
}

function constant(v: Val): string {
  if (v === null) return 'nothing'
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) return `[${v.map(constant).join(', ')}]`
  const [tag, x] = Object.entries(v)[0] as [string, unknown]
  if (tag === 'bytes') return `0x${x}`
  if (tag === 'string') return JSON.stringify(x)
  if (tag === 'map')
    return `{${(x as [Val, Val][]).map(([k, e]) => `${constant(k)}: ${constant(e)}`).join(', ')}}`
  return String(x)
}

/** One line per condition, nested conditions indented. */
export function card(expr: Expr, depth = 0): string[] {
  const pad = '  '.repeat(depth)
  if (!isSelector(expr)) return [`${pad}${constant(expr)}`]
  const [op, a, b] = expr as [string, Val, Val]
  if (op === 'and') return (a as Expr[]).flatMap((c) => card(c, depth))
  if (op === 'or') return [`${pad}${GROUP.or}`, ...(a as Expr[]).flatMap((c) => card(c, depth + 1))]
  if (op === 'all' || op === 'any')
    return [`${pad}${GROUP[op]} ${operand(a)}:`, ...card(b, depth + 1)]
  const rhs = op === 'in' || op === 'nin' ? `[${(b as Val[]).map(operand).join(', ')}]` : operand(b)
  return [`${pad}${operand(a)} ${COMPARE[op] ?? op} ${rhs}`]
}
