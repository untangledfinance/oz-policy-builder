// The review: a rule as a tree a person can read. It is built from the expression alone (the
// wire shape, so a rule written by hand, synthesised or read off the chain is described the same
// way), plus labels for addresses that are never evidence. Every node carries `raw`, the exact
// wire leaf or subtree it was read from, and an operand reads as where it is on the wire
// (`argument 2 › amount`). Nothing a label says can change what the rule enforces.

import { INTERPRETER, type Network, SPENDING_LIMIT, safeRead } from './config.ts'
import { delegated, meetsAlone, spendingParams } from './install.ts'
import { type Expr, isAddress, isSelector, unlit, type Val } from './wire.ts'

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
/** A node that groups others, and a fact (`label:  value`). */
export const group = (label: string, op: string, children: Node[], raw: Expr | null = null) =>
  ({ label, op, raw, children }) as Node
export const fact = (label: string, value: string, raw: Val = null): Node => ({
  label,
  op: 'fact',
  value,
  raw,
})
export interface View {
  /** The contract the rule is scoped to, when its predicate does not say. */
  contract?: string | undefined
  /** The network the rule is for: a read of an oracle on its safe list is not marked as a live value. */
  network?: Network | undefined
  /** What the package knows an address to be in this request (source account, signer, ...). */
  roles?: Record<string, string>
  /** Names for addresses, from the request (the caller's words). */
  labels?: Record<string, string>
  /** Full addresses, and values as written. */
  raw?: boolean | undefined
}
interface Sub {
  name: string
  index?: string
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
  fact: '', // a fact of the authority header reads `label:  value`
}
/** The package's own names are [bracketed]; a caller's are «marked» and, being plain words, can
 *  never hold a bracket: no caller text can read as a role. */
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
/** The package's own name for an address ([role]), else the request's, marked as the caller's («...»). */
const named = (a: string, c: View) => {
  const [role, given] = [KNOWN[a] ?? c.roles?.[a], c.labels?.[a]]
  return role !== undefined
    ? `[${role}]`
    : given !== undefined && LABEL.test(given)
      ? `«${given}»`
      : undefined
}
/** An address with its name in brackets. */
export const addr = (a: string, c: View) =>
  `${short(a, c)}${named(a, c) ? ` (${named(a, c)})` : ''}`
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

/** What an operand is called: where it is on the wire. */
function operand(v: Val, c: View): Sub {
  if (!isSelector(v) || v[0] === 'lit') return { name: constant(unlit(v), c) }
  const [head, ...r] = v
  // A path ends in `true` for the number of items (`call_arg_len` always does).
  const count = head === 'call_arg_len' || r.at(-1) === true
  const path = head === 'call_arg_len' ? r : count ? r.slice(0, -1) : r
  const counted = (s: Sub): Sub =>
    count ? { name: `the number of items in ${s.name}`, index: s.index ?? s.name } : s
  switch (head) {
    case 'call_contract':
      return { name: 'the contract' }
    case 'call_fn':
      return { name: 'the function' }
    case 'now':
      return { name: 'the ledger time' }
    case 'call_arg':
    case 'call_arg_len':
    case 'call_arg_field':
    case 'call_path':
    case 'elem': {
      const [first, ...rest] = head === 'elem' ? ['the item', ...path] : path
      const index = [head === 'elem' ? first : `argument ${first}`, ...rest.map((s) => step(s, c))]
      return counted({ name: index.join(' › '), index: index.join(' › ') })
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
        c.network && safeRead(c.network, target, fn, args)
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
  const side = (x: Val) => operand(x, c).name
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
  const inner: View = { ...c, contract: ci < 0 ? c.contract : at(ci) }
  let out = list.flatMap((x, i) => (i === ci || i === fi ? [] : [branch(x, inner)]))
  if (fi >= 0)
    out = [{ label: at(fi), op: 'function', value: at(fi), raw: list[fi] as Expr, ...kids(out) }]
  return ci < 0
    ? out
    : [{ label: header(inner), op: 'contract', value: at(ci), raw: list[ci] as Expr, ...kids(out) }]
}

const header = (c: View, a = c.contract as string) =>
  `${named(a, c) ? `${named(a, c)}  ` : ''}${short(a, c)}`

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
    const label = `${op === 'all' ? 'every' : 'some'} item of ${s.name}`
    return [{ label, op, raw: e, ...(s.index ? { index: s.index } : {}), ...kids(nodes(b, c)) }]
  }
  return [leaf(e, c)]
}

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

/** What a rule lets its signers do, as the install builds it (or as an account reports it). */
export interface Authority {
  signers: string[]
  /** A threshold policy beside the interpreter: `n` signers, or (with `weights`) weights totalling `n`. */
  threshold?: { n: number; weights?: Record<string, number>; raw?: Val } | undefined
  admins?: string[] | undefined
  /** `null`: never expires; else the ledger it lapses after. */
  validUntil?: number | null | undefined
  /** `null`: no rolling total. */
  total?: { amount: string; periodLedgers: number } | null | undefined
  interpreter?: string | undefined
  /** What that interpreter was deployed with: the caps every predicate under it is held to. */
  limits?: Readonly<Record<string, number>> | undefined
}

/** Who can act under a rule, by what rule, until when, up to how much in total: the head of an
 *  install's review. Names and labels are display; `raw` is the wire value each line came from. */
export function authority(a: Authority, c: View): Node {
  const [k, t, w] = [a.signers.length, a.threshold, a.threshold?.weights]
  if (t && !(t.n >= 1)) throw new Error('a threshold without its number cannot be described')
  const who = (x: string) => `${x.startsWith('C') ? 'contract ' : ''}${addr(x, c)}`
  // A threshold one signer meets alone is 1-of-n: the weight of each signer is what says who.
  const alone = t && w && k > 1 ? meetsAlone(a.signers, w, t.n) : []
  const act =
    !t || (!w && t.n <= 1)
      ? `${k === 1 ? 'the signer' : `any ONE of these ${k} signers`} acts alone`
      : `${w ? `signers whose weights total at least ${t.n}` : `any ${t.n} of these ${k} signers`} must approve${
          alone.length
            ? ` (${alone.length > 1 ? 'each of ' : ''}${alone.map(who).join(', ')} can act alone)`
            : ''
        }`
  const legend: [string, string, Val] = [
    'legend',
    "[…] the package's roles; «…» labels given in the request",
    null,
  ]
  const facts: [string, string, Val][] = [
    legend,
    ...a.signers.map((s): [string, string, Val] => [
      'signer',
      who(s) + (w ? `  weight ${w[s]}` : ''),
      w ? [delegated(s), w[s] as number] : delegated(s),
    ]),
  ]
  facts.push(['to act', act, t?.raw ?? t?.n ?? null])
  if (a.admins)
    facts.push([
      'admins',
      `${a.admins.map(who).join(', ')} (all of them together: alone, may uninstall the predicate, which stops the rule; with the account, may re-install, replace the admins or bind an executor)`,
      a.admins.map(delegated),
    ])
  const v = a.validUntil
  if (v !== undefined)
    facts.push(['expires', v === null ? 'never expires' : `valid through ledger ${v}`, v])
  if (a.total !== undefined) {
    const { amount: x, periodLedgers: p } = a.total ?? { amount: '', periodLedgers: 0 }
    const per = `at most ${x} in total per ${p} ledgers (rolling, OZ spending_limit)`
    facts.push([
      'total',
      a.total ? per : 'no total limit: each call may move up to its own cap',
      a.total && spendingParams(a.total),
    ])
  }
  const caps = a.limits
    ? ` (${Object.entries(a.limits)
        .map(([k, v]) => `${k.replace('max_', '')} ≤ ${v}`)
        .join(', ')})`
    : ''
  if (a.interpreter) facts.push(['interpreter', addr(a.interpreter, c) + caps, a.interpreter])
  return group(
    'Authority',
    'authority',
    facts.map(([label, value, raw]) => fact(label, value, raw))
  )
}

/** A rule that follows another rule's predicate: which rule, what that means, and what it holds
 *  now (`nonce` and `predicateHash` absent: not read). The predicate tree that follows it, if any,
 *  is that rule's as it is now. */
export function followed(
  f: { account: string; ruleId: number; nonce?: number; predicateHash?: string },
  c: View
): Node {
  const now =
    f.nonce === undefined
      ? 'not read: what this rule permits is not shown'
      : `install nonce ${f.nonce}, predicate hash ${f.predicateHash ?? 'unknown'} (shown below as it is now)`
  return group(
    `Follows rule ${f.ruleId} of ${addr(f.account, c)}`,
    'follows',
    [
      fact(
        'predicate',
        "none of its own: at every call the interpreter checks that rule's predicate as it is then",
        [f.account, f.ruleId]
      ),
      fact(
        'who changes it',
        "that rule's admins, with its account, can re-install it at any time without this account's signature: what this rule permits changes with it"
      ),
      fact('now', now, f.nonce ?? null),
      fact(
        'if it is removed',
        'every call under this rule is refused (206) until this rule is re-installed'
      ),
    ],
    [f.account, f.ruleId]
  )
}

/** The overrides a request set, each with the refusal it waived: the first node of a review, so the
 *  owner reads what was waived before anything else. */
export const overridden = (o: { flag: string; waived: string | null }[]): Node =>
  group(
    'Overrides set in the request',
    'overrides',
    o.map((x) =>
      fact(x.flag, x.waived === null ? 'set, though nothing was refused' : `waived: ${x.waived}`)
    )
  )

/** The tree as text, box-drawn: a condition as `name:  phrase  value`. */
export function lines(nodes: Node[], prefix = '', child = false): string[] {
  return nodes.flatMap((n, i) => {
    const end = i === nodes.length - 1
    const cond = n.value !== undefined && n.op !== 'contract' && n.op !== 'function'
    const phrase = Object.hasOwn(COMPARE, n.op) ? COMPARE[n.op] : n.op
    const text = cond ? [`${n.label}:`, phrase, n.value].filter(Boolean).join('  ') : n.label
    return [
      `${prefix}${child ? (end ? '└─ ' : '├─ ') : ''}${text}`,
      ...lines(n.children ?? [], prefix + (child ? (end ? '   ' : '│  ') : ''), true),
    ]
  })
}

/** The review of a predicate, one line per node. */
export const card = (expr: Expr, view: View = {}): string[] => lines(tree(expr, view))
