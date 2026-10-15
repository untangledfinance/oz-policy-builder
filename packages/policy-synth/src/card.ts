// The review: a rule as a tree a person can read. It is built from the expression alone
// (the wire shape, so a rule written by hand, synthesised or read off the chain is described
// the same way), plus display help that is never evidence: the names of a contract's
// parameters, a token's decimals, labels for addresses. Every node carries `raw`, the exact
// wire leaf or subtree it was read from, and a leaf that cannot be named keeps today's
// "argument N" wording. Nothing a name says can change what the rule enforces.

import { INTERPRETER, type Network, SPENDING_LIMIT, safeRead } from './config.ts'
import { type Info, SAC, type Ty } from './spec.ts'
import { type Expr, intOf, isAddress, isSelector, isTagged, unlit, type Val } from './wire.ts'

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
  contract?: string | undefined
  /** The network the rule is for: a read of an oracle on its safe list is not marked as a live value. */
  network?: Network | undefined
  /** Names for addresses, from the request. */
  labels?: Record<string, string>
  /** Full addresses and values as written, and the wire index of every name. */
  raw?: boolean | undefined
  /** Inside the tree: the function in force, and the type of the item of a quantifier. */
  fn?: string | undefined
  item?: Ty | undefined
}
interface Sub {
  name: string
  index?: string
  kind?: 'amount' | 'time' | undefined
  ty?: Ty | undefined
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
const KNOWN: Record<string, string> = Object.fromEntries([
  ...Object.values(SPENDING_LIMIT).map((a) => [a, 'spending limit']),
  ...Object.values(INTERPRETER).flatMap((p) => (p ? [[p.address, 'interpreter']] : [])),
])
/** What a request may call an address: plain words, so a label cannot carry a line of its own. */
const LABEL = /^[A-Za-z][\w .-]{0,23}$/
/** The integer types the contract reads as one kind of number (`5u32` is `5i128`); the 256-bit
 *  ones are not numbers to it, and inside a vector or a map every type is its own. */
const NUMBER = /^(i32|i64|u64|i128|u128|timepoint|duration)$/

/** An address shortened, or whole under `raw`. */
const short = (a: string, c: View) => (c.raw ? a : `${a.slice(0, 6)}…${a.slice(-6)}`)
/** The package's own name for an address, else the request's, marked as the caller's («...»). */
const named = (a: string, c: View) => {
  const given = c.labels?.[a]
  return KNOWN[a] ?? (given !== undefined && LABEL.test(given) ? `«${given}»` : undefined)
}
/** An address with its name in brackets. */
const addr = (a: string, c: View) => `${short(a, c)}${named(a, c) ? ` (${named(a, c)})` : ''}`
/** What is known of the contract in force. */
const known = (c: View) => c.info?.[c.contract ?? '']
/** Text between quotes. Anything but printable ASCII is written as its code point: what a person
 *  cannot see (zero-width, soft hyphen, marks, bidi, tags, odd spaces) cannot make two texts alike. */
const quoted = (s: string, q: string) =>
  q +
  JSON.stringify(s)
    .slice(1, -1)
    .replace(/[^\x20-\x7e]/gu, (ch) => {
      const n = ch.codePointAt(0) as number
      return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, '0')}`
    }) +
  q

/** A constant, so that two constants the contract tells apart never read alike: a symbol is
 *  'quoted', a string "quoted", bytes 0x.., a string of non-text bytes hex"..", an integer of
 *  a kind it does not read as a number carries its type, and so does every number nested in a
 *  vector or map (and every number under `raw`). */
function constant(v: Val, c: View, typed = c.raw): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return isAddress(v) ? addr(v, c) : quoted(v, "'")
  if (typeof v === 'number') return typed ? `${v} (u32)` : String(v)
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map((x) => constant(x, c, true)).join(', ')}]`
  const [tag, x] = Object.entries(v)[0] as [string, string | [Val, Val][]]
  if (tag === 'bytes') return `0x${x}`
  if (tag === 'stringHex') return `hex"${x}"`
  if (tag === 'string') return quoted(x as string, '"')
  if (tag === 'map')
    return `{${(x as [Val, Val][]).map(([k, e]) => `${constant(k, c, true)}: ${constant(e, c, true)}`).join(', ')}}`
  return NUMBER.test(tag) && !typed ? String(x) : `${x} (${tag})`
}

/** A token amount as `5,000 USDC:GATA…V56 (50000000000)`: the unit is the token's, the raw number stays. */
function money(x: string, { decimals: d, symbol }: NonNullable<Info['token']>, type = ''): string {
  const n = x.replace('-', '').padStart(d + 1, '0')
  const frac = n.slice(n.length - d).replace(/0+$/, '')
  const whole = n.slice(0, n.length - d).replace(/\B(?=(\d{3})+$)/g, ',')
  return `${x < '0' ? '-' : ''}${whole}${frac && `.${frac}`} ${symbol} (${x}${type})`
}

/** A constant, in the unit its other side is read in. */
function show(v: Val, kind: Sub['kind'], c: View): string {
  const x = unlit(v)
  const number = typeof x === 'number' || (isTagged(x) && NUMBER.test(Object.keys(x)[0] ?? ''))
  const [n, t] = [number ? intOf(x) : undefined, known(c)?.token]
  if (!c.raw && kind === 'time' && n !== undefined && n >= 0n && n <= 253402300799n)
    return `${new Date(Number(n) * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC (${n})`
  // Every integer the contract reads as a number is in the unit; one that is not an i128 says so.
  if (!c.raw && kind === 'amount' && t && n !== undefined)
    return money(
      String(n),
      t,
      isTagged(x) && 'i128' in x
        ? ''
        : ` (${typeof x === 'number' ? 'u32' : Object.keys(x as object)[0]})`
    )
  return constant(x, c)
}

/** A step of a path: an index `[0]`, a key (a symbol as a name when it reads as one, else quoted,
 *  so `'true'` is not the bool key; anything else as a typed constant). */
const step = (s: Val, c: View) => {
  const k = unlit(s)
  return typeof s === 'number'
    ? `[${s}]`
    : typeof k === 'string' && !isAddress(k) && /^(?!(true|false|null)$)[A-Za-z_]\w*$/.test(k)
      ? k
      : constant(k, c, true)
}

/** What an operand reached through `steps` from `first` (a parameter, or the item) of type `ty`
 *  is called: struct fields by name, vector and tuple items by index (a bare number only), map
 *  entries by key. Anything else (no type, a field that is not there, an index into a map, a key
 *  into a vector) keeps the wire wording `index`. */
function resolve(c: View, index: string, steps: Val[], first?: string, ty?: Ty): Sub {
  const names = first ? [first] : []
  for (const s of steps) {
    const [key, t]: [Val, { vec?: Ty; map?: Ty; tuple?: Ty[]; fields?: Record<string, Ty> }] = [
      unlit(s),
      typeof ty === 'object' ? ty : {},
    ]
    const field = typeof key === 'string' && t.fields && Object.hasOwn(t.fields, key)
    const next = field
      ? t.fields?.[key as string]
      : typeof s !== 'number'
        ? t.map
        : t.fields
          ? undefined
          : (t.vec ?? t.tuple?.[s])
    if (!next) return { name: index, index }
    names.push(step(s, c))
    ty = next
  }
  return ty ? { name: names.join(' › '), index, ty } : { name: index, index }
}

const params = (c: View) => {
  const f = known(c)?.fns
  return c.fn && f && Object.hasOwn(f, c.fn) ? f[c.fn] : undefined
}

/** What an operand is called: a name where the interface gives one, else the wire wording. */
function operand(v: Val, c: View, kind?: Sub['kind']): Sub {
  if (!isSelector(v) || v[0] === 'lit') return { name: show(v, kind, c) }
  const [head, ...r] = v
  // A path ends in `true` for the number of items (`call_arg_len` always does).
  const count = head === 'call_arg_len' || r.at(-1) === true
  const path = head === 'call_arg_len' ? r : count ? r.slice(0, -1) : r
  // Under `raw` a name is followed by where it came from on the wire, wherever it stands.
  const counted = (s: Sub): Sub => {
    const named = c.raw && s.index && s.name !== s.index ? `${s.name} (${s.index})` : s.name
    return count
      ? { ...s, name: `the number of items in ${named}`, index: s.index ?? s.name }
      : { ...s, name: named }
  }
  switch (head) {
    case 'call_contract':
      return { name: 'the contract' }
    case 'call_fn':
      return { name: 'the function' }
    case 'now':
      return { name: 'the ledger time', kind: 'time' }
    case 'call_arg':
    case 'call_arg_len':
    case 'call_arg_field':
    case 'call_path': {
      const [i, ...rest] = path
      const index = [`argument ${i}`, ...rest.map((s) => step(s, c))].join(' › ')
      const p = typeof i === 'number' ? params(c)?.[i] : undefined
      const s = resolve(c, index, rest, p?.[0], p?.[1])
      // The SEP-41 `amount` of a token's own function is in the token's unit; nothing else is.
      const own = rest.length === 0 && p?.[0] === 'amount' && p[1] === 'i128'
      const unit = own && c.fn !== undefined && Object.hasOwn(SAC, c.fn) && known(c)?.token
      return counted(unit ? { ...s, kind: 'amount' } : s)
    }
    case 'elem': {
      const index = ['the item', ...path.map((s) => step(s, c))].join(' › ')
      return counted(resolve(c, index, path, 'the item', c.item))
    }
    case 'sum': {
      const [src, ...steps] = path as Val[]
      const of = steps.length ? `${steps.map((x) => step(x, c)).join(' › ')} in ` : ''
      return counted({ name: `the total of ${of}${operand(src as Val, c).name}` })
    }
    case 'scaled': {
      const [src, num, den, add] = r as Val[]
      const part = (x: Val) =>
        isSelector(x) && ['scaled', 'read', 'sum'].includes(x[0] as string)
          ? `(${operand(x, c).name})`
          : operand(x, c).name
      const tail = operand(add as Val, c).name === '0' ? '' : ` + ${part(add as Val)}`
      return { name: `${part(src as Val)} × ${part(num as Val)} ÷ ${part(den as Val)}${tail}` }
    }
    case 'read': {
      const [target, fn, args, ...steps] = path as [string, string, Val[], ...Val[]]
      const on = `${fn}(${args.map((x) => operand(x, c).name).join(', ')}) on ${addr(target, c)}`
      const live =
        c.network && safeRead(c.network, target, fn)
          ? ''
          : ' (live value, movable within one transaction)'
      return counted({ name: [on + live, ...steps.map((s) => step(s, c))].join(' › ') })
    }
  }
  return { name: JSON.stringify(v) }
}

function leaf(e: Expr, c: View): Node {
  if (!isSelector(e)) return { label: constant(e, c), op: 'lit', raw: e }
  const [op, a, b] = e as [string, Val, Val]
  const [l, r] = [operand(a, c), isSelector(b) ? operand(b, c) : undefined]
  const side = (x: Val) => operand(x, c, l.kind ?? r?.kind).name
  const list = (op === 'in' || op === 'nin') && Array.isArray(b)
  const index = l.index ?? r?.index
  return {
    label: side(a),
    op,
    value: list ? `[${b.map(side).join(', ')}]` : side(b),
    raw: e,
    ...(index === undefined ? {} : { index }),
  }
}

// ---- the tree ----

/** Where `list` pins `head` (`call_contract`, `call_fn`) to a plain constant: the first such leaf. */
const pin = (list: Expr[], head: string) =>
  list.findIndex(
    (x) =>
      JSON.stringify(x).startsWith(`["eq",["${head}"],"`) &&
      isAddress((x as Val[])[2]) === (head === 'call_contract') &&
      (x as Val[])[2] !== ''
  )
const kids = (children: Node[]) => (children.length > 0 ? { children } : {})

/** The conditions of one `and`. A pin on the contract or the function is lifted into a header
 *  holding the rest; nothing else is merged, moved or dropped. */
function conj(list: Expr[], c: View): Node[] {
  const [ci, fi] = [pin(list, 'call_contract'), pin(list, 'call_fn')]
  const at = (i: number) => (list[i] as [string, Val, string])[2]
  const inner: View = { ...c, contract: ci < 0 ? c.contract : at(ci), fn: fi < 0 ? c.fn : at(fi) }
  let out = list.flatMap((x, i) => (i === ci || i === fi ? [] : [branch(x, inner)]))
  if (fi >= 0) {
    const p = params(inner)
    const label = p ? `${at(fi)}(${p.map((x) => x[0]).join(', ')})` : at(fi)
    out = [{ label, op: 'function', value: at(fi), raw: list[fi] as Expr, ...kids(out) }]
  }
  return ci < 0
    ? out
    : [{ label: header(inner), op: 'contract', value: at(ci), raw: list[ci] as Expr, ...kids(out) }]
}

const header = (c: View, a = c.contract as string) =>
  `${named(a, c) ? `${named(a, c)}  ` : ''}${short(a, c)}${known(c)?.token ? '  (token)' : ''}`

/** One node for a branch: its conditions, as a group when there are several. */
const branch = (e: Expr, c: View, ns = nodes(e, c)): Node =>
  ns.length === 1 ? (ns[0] as Node) : { label: 'all of', op: 'and', raw: e, ...kids(ns) }

function nodes(e: Expr, c: View): Node[] {
  if (!isSelector(e)) return [leaf(e, c)]
  const [op, a, b] = e as [string, Val, Val]
  if (op === 'and') return conj(a as Expr[], c)
  if (op === 'or')
    return [{ label: 'any one of', op, raw: e, ...kids((a as Expr[]).map((x) => branch(x, c))) }]
  if (op === 'all' || op === 'any') {
    const s = operand(a, c)
    const item = typeof s.ty === 'object' && 'vec' in s.ty ? s.ty.vec : c.item
    const label = `${op === 'all' ? 'every' : 'some'} item of ${s.name}`
    const children = kids(nodes(b, { ...c, item }))
    return [{ label, op, raw: e, ...(s.index ? { index: s.index } : {}), ...children }]
  }
  return [leaf(e, c)]
}

/** Every contract a predicate pins: the ones whose interface can name its arguments. */
const PINNED = /\["eq",\["call_contract"\],"(C\w{55})"/g
export const contractsOf = (e: Val) => Array.from(JSON.stringify(e).matchAll(PINNED), (m) => m[1])

/** The tree of a predicate. `view.contract` is the contract its rule is scoped to: a header for it
 *  (with `raw: null`) wraps the tree unless the predicate itself pins exactly that contract. */
export function tree(expr: Expr, view: View = {}): Node[] {
  const body = nodes(expr, view)
  // A pin on another contract than the rule's scope can never be met; say so, on every such node.
  const never = (ns: Node[]) => {
    for (const n of ns) {
      if (view.contract && n.op === 'contract' && n.value !== view.contract)
        n.label += `  (never matches: the rule is scoped to ${short(view.contract, view)})`
      never(n.children ?? [])
    }
  }
  never(body)
  const [first] = body
  // The scope is always said, unless the predicate's own pin is that very contract.
  const same = body.length === 1 && first?.op === 'contract' && first.value === view.contract
  return view.contract && !same
    ? [{ label: header(view), op: 'contract', value: view.contract, raw: null, ...kids(body) }]
    : body
}

/** The tree as text, box-drawn: a condition as `name:  phrase  value`. */
export function lines(nodes: Node[], prefix = '', child = false): string[] {
  return nodes.flatMap((n, i) => {
    const end = i === nodes.length - 1
    const cond = n.value !== undefined && n.op !== 'contract' && n.op !== 'function'
    const text = cond
      ? `${n.label}:  ${Object.hasOwn(COMPARE, n.op) ? COMPARE[n.op] : n.op}  ${n.value}`
      : n.label
    return [
      `${prefix}${child ? (end ? '└─ ' : '├─ ') : ''}${text}`,
      ...lines(n.children ?? [], prefix + (child ? (end ? '   ' : '│  ') : ''), true),
    ]
  })
}

/** The review of a predicate, one line per node. */
export const card = (expr: Expr, view: View = {}): string[] => lines(tree(expr, view))
