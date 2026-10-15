// The review: a rule as a tree a person can read. It is built from the expression alone
// (the wire shape, so a rule written by hand, synthesised or read off the chain is described
// the same way), plus display help that is never evidence: the names of a contract's
// parameters, a token's decimals, labels for addresses. Every node carries `raw`, the exact
// wire leaf or subtree it was read from, and a leaf that cannot be named keeps today's
// "argument N" wording. Nothing a name says can change what the rule enforces.

import { INTERPRETER, SPENDING_LIMIT } from './config.ts'
import type { Info, Ty } from './spec.ts'
import {
  type Expr,
  intOf,
  isAddress,
  isConstant,
  isSelector,
  isTagged,
  unlit,
  type Val,
} from './wire.ts'

export interface Node {
  label: string
  /** A condition's wire operator; `and` `or` `all` `any` for a group; `contract` and `function`
   *  for a header made of a pin the rule holds (or, with `raw: null`, the rule's own scope). */
  op: string
  value?: string
  /** The wire leaf or subtree this node stands for. */
  raw: Expr | null
  /** Where the label came from on the wire (`argument 2`). */
  index?: string
  children?: Node[]
}
export interface View {
  /** What is known of each contract (see `infoFor`). */
  info?: Record<string, Info>
  /** The contract the rule is scoped to, when its predicate does not say. */
  contract?: string
  /** Names for addresses, from the request. */
  labels?: Record<string, string>
  /** Full addresses and values as written, and the wire index of every name. */
  raw?: boolean | undefined
  /** Inside the tree: the function in force, and the type of the item of a quantifier. */
  fn?: string
  item?: Ty
}
interface Sub {
  name: string
  index?: string
  kind?: 'amount' | 'time' | undefined
  ty?: Ty
}

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
const KNOWN: Record<string, string> = {
  ...Object.fromEntries(Object.values(SPENDING_LIMIT).map((a) => [a, 'spending limit'])),
  ...Object.fromEntries(
    Object.values(INTERPRETER).flatMap((p) => (p ? [[p.address, 'interpreter']] : []))
  ),
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const named = (a: string, c: View) => c.labels?.[a] ?? KNOWN[a]
/** An address as shortened, or whole under `raw`, with its name in brackets. */
const addr = (a: string, c: View) =>
  `${c.raw ? a : short(a)}${named(a, c) ? ` (${named(a, c)})` : ''}`
const tok = (c: View) => (c.contract ? c.info?.[c.contract]?.token : undefined)

function constant(v: Val, c: View): string {
  if (v === null) return 'nothing'
  if (typeof v === 'string') return isAddress(v) ? addr(v, c) : v
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) return `[${v.map((x) => constant(x, c)).join(', ')}]`
  const [tag, x] = Object.entries(v)[0] as [string, unknown]
  if (tag === 'bytes' || tag === 'stringHex') return `0x${x}`
  if (tag === 'string') return JSON.stringify(x)
  if (tag === 'map')
    return `{${(x as [Val, Val][]).map(([k, e]) => `${constant(k, c)}: ${constant(e, c)}`).join(', ')}}`
  return String(x)
}

/** A token amount as `5,000 USDC (50000000000)`; the number alone when the decimals are unknown. */
function money(x: string, { decimals: d, symbol }: NonNullable<Info['token']>): string {
  if (d === undefined) return x
  const n = x.replace('-', '').padStart(d + 1, '0')
  const frac = n.slice(n.length - d).replace(/0+$/, '')
  const whole = n.slice(0, n.length - d).replace(/\B(?=(\d{3})+$)/g, ',')
  return `${x < '0' ? '-' : ''}${whole}${frac && `.${frac}`}${symbol ? ` ${symbol}` : ''} (${x})`
}

/** A constant, in the unit its other side is read in. */
function show(v: Val, kind: Sub['kind'], c: View): string {
  const [x, n] = [unlit(v), intOf(unlit(v))]
  const t = tok(c)
  if (!c.raw && kind === 'time' && n !== undefined && n >= 0n && n <= 253402300799n)
    return `${new Date(Number(n) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  if (!c.raw && kind === 'amount' && t && isTagged(x) && 'i128' in x) return money(x.i128, t)
  return constant(x, c)
}

/** What `steps` reach inside `ty`: struct fields by name, vector and tuple items as `[i]`, map
 *  entries by key. Anything else (a field that is not there, a number walked into) is undefined,
 *  and the caller keeps the wire wording. */
function through(ty: Ty, steps: Val[], c: View): { names: string[]; ty: Ty } | undefined {
  const names: string[] = []
  for (const s of steps.map(unlit)) {
    const t = typeof ty === 'object' ? ty : undefined
    const field = t && 'fields' in t && typeof s === 'string' && Object.hasOwn(t.fields, s)
    const next =
      t && 'fields' in t
        ? field && (t.fields[s as string] as Ty)
        : t && 'map' in t
          ? t.map
          : t && typeof s === 'number'
            ? 'vec' in t
              ? t.vec
              : t.tuple[s]
            : undefined
    if (!next) return undefined
    names.push(t && 'map' in t ? constant(s, c) : field ? (s as string) : `[${s}]`)
    ty = next
  }
  return { names, ty }
}

const params = (c: View) => {
  const f = c.contract ? c.info?.[c.contract]?.fns : undefined
  return c.fn && f && Object.hasOwn(f, c.fn) ? f[c.fn] : undefined
}
const step = (s: Val, c: View) => constant(unlit(s), c)

/** What an operand is called: a name where the interface gives one, else the wire wording. */
function sub(v: Val, c: View): Sub {
  if (!isSelector(v) || v[0] === 'lit') return { name: constant(unlit(v), c) }
  const [head, ...r] = v
  /** `first` (a parameter) and `steps` into its type `ty`, named; or the wire wording `index`. */
  const resolve = (index: string, first: string | undefined, ty: Ty | undefined, steps: Val[]) => {
    const hit = ty && through(ty, steps, c)
    if (!hit) return { name: index, index }
    const name = [...(first ? [first] : []), ...hit.names]
    const last = name.at(-1) as string
    const amount = hit.ty === 'i128' && /^(amount|.+_amount|amount_.+)$/.test(last) && tok(c)
    return {
      name: name.join(' › '),
      index,
      ty: hit.ty,
      kind: amount ? ('amount' as const) : undefined,
    }
  }
  switch (head) {
    case 'call_contract':
      return { name: 'contract' }
    case 'call_fn':
      return { name: 'function' }
    case 'now':
      return { name: 'ledger time', kind: 'time' }
    case 'call_arg':
    case 'call_arg_len':
    case 'call_arg_field':
    case 'call_path': {
      const all = head === 'call_arg_len' ? [...r, true] : r
      const count = all.at(-1) === true
      const [i, ...rest] = count ? all.slice(0, -1) : all
      const index = `argument ${i}${rest.map((s) => ` > ${step(s, c)}`).join('')}`
      const p = typeof i === 'number' ? params(c)?.[i] : undefined
      const s = p ? resolve(index, p[0], p[1], rest) : { name: index, index }
      return count ? { name: `the number of items in ${s.name}`, index } : s
    }
    case 'elem': {
      const index =
        r.length === 0 ? 'the item' : `the item's ${r.map((s) => step(s, c)).join(' > ')}`
      return c.item
        ? resolve(index, r.length ? undefined : 'item', c.item, r)
        : { name: index, index }
    }
    case 'sum': {
      const [src, ...steps] = r as Val[]
      return {
        name: `the total of ${steps.length ? `${steps.map((x) => step(x, c)).join(' > ')} in ` : ''}${sub(src as Val, c).name}`,
      }
    }
    case 'scaled': {
      const [src, num, den, add] = r as Val[]
      const part = (x: Val) =>
        isSelector(x) && x[0] === 'scaled' ? `(${sub(x, c).name})` : sub(x, c).name
      const tail = sub(add as Val, c).name === '0' ? '' : ` + ${part(add as Val)}`
      return { name: `${part(src as Val)} × ${part(num as Val)} ÷ ${part(den as Val)}${tail}` }
    }
    case 'read': {
      const [target, fn, args, ...steps] = r as [string, string, Val[], ...Val[]]
      const on = `${named(target, c) ? `${named(target, c)} ` : ''}${c.raw ? target : short(target)}`
      const path = steps.map((s) => ` › ${step(s, c)}`).join('')
      return { name: `${fn}(${args.map((x) => sub(x, c).name).join(', ')}) on ${on}${path}` }
    }
  }
  return { name: JSON.stringify(v) }
}

function leaf(e: Expr, c: View): Node {
  if (!isSelector(e)) return { label: constant(e, c), op: 'lit', raw: e }
  const [op, a, b] = e as [string, Val, Val]
  const l = sub(a, c)
  const kind = l.kind ?? (isSelector(b) ? sub(b, c).kind : undefined)
  const side = (x: Val) => (isConstant(x) ? show(x, kind, c) : sub(x, c).name)
  const list = (op === 'in' || op === 'nin') && Array.isArray(b)
  return {
    label: side(a),
    op,
    value: list ? `[${b.map(side).join(', ')}]` : side(b),
    raw: e,
    ...(l.index === undefined ? {} : { index: l.index }),
  }
}

// ---- the tree ----

/** Where `list` pins `head` (`call_contract`, `call_fn`) to a plain constant: the first such leaf. */
const pin = (list: Expr[], head: string) =>
  list.findIndex(
    (x) =>
      isSelector(x) &&
      x[0] === 'eq' &&
      String(x[1]) === head &&
      typeof x[2] === 'string' &&
      isAddress(x[2]) === (head === 'call_contract')
  )
const kids = (children: Node[]) => (children.length > 0 ? { children } : {})

/** The conditions of one `and`. A pin on the contract or the function is lifted into a header
 *  holding the rest; nothing else is merged, moved or dropped. */
function conj(list: Expr[], c: View): Node[] {
  const [ci, fi] = [pin(list, 'call_contract'), pin(list, 'call_fn')]
  const at = (i: number) => (list[i] as [string, Val, string])[2]
  const inner: View = {
    ...c,
    ...(ci >= 0 ? { contract: at(ci) } : {}),
    ...(fi >= 0 ? { fn: at(fi) } : {}),
  }
  let out = list.flatMap((x, i) => (i === ci || i === fi ? [] : [one(x, inner)]))
  if (fi >= 0) {
    const p = params(inner)
    const label = p ? `${at(fi)}(${p.map((x) => x[0]).join(', ')})` : at(fi)
    out = [{ label, op: 'function', value: at(fi), raw: list[fi] as Expr, ...kids(out) }]
  }
  return ci < 0
    ? out
    : [{ label: header(inner), op: 'contract', value: at(ci), raw: list[ci] as Expr, ...kids(out) }]
}

const header = (c: View) => {
  const a = c.contract as string
  return `${named(a, c) ? `${named(a, c)}  ` : ''}${c.raw ? a : short(a)}${c.info?.[a]?.token ? '  (token)' : ''}`
}

/** One node for a branch: its conditions, as a group when there are several. */
const one = (e: Expr, c: View): Node => {
  const ns = top(e, c)
  return ns.length === 1 ? (ns[0] as Node) : { label: 'all of', op: 'and', raw: e, ...kids(ns) }
}

function top(e: Expr, c: View): Node[] {
  if (!isSelector(e)) return [leaf(e, c)]
  const [op, a, b] = e as [string, Val, Val]
  if (op === 'and') return conj(a as Expr[], c)
  if (op === 'or')
    return [{ label: 'any one of', op, raw: e, ...kids((a as Expr[]).map((x) => one(x, c))) }]
  if (op === 'all' || op === 'any') {
    const s = sub(a, c)
    const item = s.ty && typeof s.ty === 'object' && 'vec' in s.ty ? s.ty.vec : undefined
    const label = `${op === 'all' ? 'every' : 'some'} item of ${s.name}`
    return [
      {
        label,
        op,
        raw: e,
        ...(s.index ? { index: s.index } : {}),
        ...kids(top(b, { ...c, ...(item ? { item } : {}) })),
      },
    ]
  }
  return [leaf(e, c)]
}

/** Every contract a predicate names: its pins and the targets of its reads. */
export const contractsOf = (e: Val): string[] =>
  Array.from(
    JSON.stringify(e).matchAll(/\["call_contract"\],"(C\w{55})"|\["read","(C\w{55})"/g),
    (m) => (m[1] ?? m[2]) as string
  )

/** The tree of a predicate. `view.contract` is the contract its rule is scoped to: a header for it
 *  (with `raw: null`) wraps the tree when the predicate pins no contract itself. */
export function tree(expr: Expr, view: View = {}): Node[] {
  const nodes = top(expr, view)
  const pinned = (ns: Node[]): boolean =>
    ns.some((n) => n.op === 'contract' || pinned(n.children ?? []))
  return view.contract && !pinned(nodes)
    ? [{ label: header(view), op: 'contract', value: view.contract, raw: null, ...kids(nodes) }]
    : nodes
}

/** The tree as text, box-drawn: a condition as `name:  phrase  value`. */
export function lines(nodes: Node[], raw = false, prefix = '', child = false): string[] {
  return nodes.flatMap((n, i) => {
    const end = i === nodes.length - 1
    const label = `${n.label}${raw && n.index ? ` (${n.index})` : ''}`
    const cond = n.value !== undefined && n.op !== 'contract' && n.op !== 'function'
    const text = cond
      ? `${label}:  ${Object.hasOwn(COMPARE, n.op) ? COMPARE[n.op] : n.op}  ${n.value}`
      : label
    return [
      `${prefix}${child ? (end ? '└─ ' : '├─ ') : ''}${text}`,
      ...lines(n.children ?? [], raw, prefix + (child ? (end ? '   ' : '│  ') : ''), true),
    ]
  })
}

/** The review of a predicate, one line per node. */
export const card = (expr: Expr, view: View = {}): string[] => lines(tree(expr, view), view.raw)
