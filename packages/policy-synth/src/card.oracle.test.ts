// The review must never misstate a rule, and a person reads the TEXT, not `raw`. So the text is
// held to an independent oracle (it does not use the card's own helpers):
//   1. every leaf line says what its `raw` says: the operator's phrase, and a shown number that
//      decodes back to the wire constant;
//   2. injectivity: rules that mean different things never read the same, in the plain and the
//      `raw` view. Checked by rewriting one leaf at a time (a symbol for a number, one integer
//      type for another where the contract tells them apart, a bare index for a map key, ...) over
//      every corpus, and by a generated grid of leaves, each grouped by a MEANING of its own.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { account, contract } from '../test/fixtures.ts'
import { type Authority, authority, lines, type Node, tree, type View } from './card.ts'
import { decodeEnvelope } from './record.ts'
import { SAC } from './spec.ts'
import { propose, synthesize } from './synth.ts'
import { decode, type Expr, isSelector, validate } from './wire.ts'

const C = contract(1)
const A = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H'
const VIEWS: [string, View][] = [
  ['plain', {}],
  ['rich', { contract: C, info: { [C]: { fns: SAC, token: { decimals: 7, symbol: 'USDC' } } } }],
  ['raw', { raw: true }],
]
const PHRASE: Record<string, string> = {
  eq: 'must be',
  ne: 'must not be',
  lt: 'must be below',
  lte: 'must be at most',
  gt: 'must be above',
  gte: 'must be at least',
  in: 'must be one of',
  nin: 'must not be one of',
}
const GROUPS = ['and', 'or', 'all', 'any']
const valid = (e: Expr) => {
  try {
    validate(e)
    return true
  } catch {
    return false
  }
}
const text = (e: Expr, v: View) => lines(tree(e, v)).join('\n')
const walk = (ns: Node[]): Node[] => ns.flatMap((n) => [n, ...walk(n.children ?? [])])
// biome-ignore lint/suspicious/noExplicitAny: wire values are untyped JSON here
type J = any

// ---- the corpora ----

const corpus: [string, Expr][] = []
for (const f of ['grammar', 'accuracy']) {
  const cases = JSON.parse(
    readFileSync(new URL(`../fixtures/parity/${f}.json`, import.meta.url), 'utf8')
  ).cases
  for (const c of cases) {
    const e = c.json ?? decode(c.xdr)
    if (valid(e)) corpus.push([`${f}:${c.name}`, e])
  }
}
const real: { envelopeXdr: string }[] = JSON.parse(
  readFileSync(new URL('../fixtures/corpus/mainnet.json', import.meta.url), 'utf8')
)
for (const [k, t] of real.entries()) {
  const rec = decodeEnvelope(t.envelopeXdr, 'mainnet')
  for (const r of propose(synthesize(rec.contexts, { limit: '1000000000000000000' }).intent))
    corpus.push([`tx${k}:${r.contract.slice(0, 6)}`, r.expr])
}
const extra: [string, Expr][] = JSON.parse(
  readFileSync(new URL('../fixtures/parity/tree-extra.json', import.meta.url), 'utf8')
)
corpus.push(...extra)

// ---- 1. every leaf line says what its raw says ----

function checkLeaves(name: string, e: Expr, vn: string, v: View, fails: string[]) {
  for (const n of walk(tree(e, v))) {
    if (!n.raw || GROUPS.includes(n.op)) continue
    const r = n.raw as J[]
    if (n.op === 'contract' || n.op === 'function') {
      const head = n.op === 'contract' ? 'call_contract' : 'call_fn'
      const sel = r[1]
      if (!(r[0] === 'eq' && Array.isArray(sel) && sel.length === 1 && sel[0] === head))
        fails.push(`${name}/${vn}: header ${n.op} from ${JSON.stringify(r)}`)
      if (r[2] !== n.value) fails.push(`${name}/${vn}: header value ${n.value} vs ${r[2]}`)
      continue
    }
    if (n.op !== r[0]) fails.push(`${name}/${vn}: op ${n.op} vs raw ${r[0]}`)
    const line = lines([n])[0] as string
    if (!line.includes(`:  ${PHRASE[r[0]]}  `)) fails.push(`${name}/${vn}: phrase in "${line}"`)
    // A shown number is the wire number: an amount carries it in brackets, a date too.
    const c = r[2]
    const num =
      c && typeof c === 'object' && !Array.isArray(c)
        ? (Object.values(c)[0] as J)
        : typeof c === 'number'
          ? c
          : undefined
    if (num !== undefined && /^-?\d+$/.test(String(num)) && !isSelector(c) && r[0] !== 'in') {
      const val = n.value ?? ''
      const m = val.match(/\((-?\d+)(?: \(\w+\))?\)$/)
      const typed = val.match(/^(-?\d+) \(\w+\)$/)
      const shown = m ? m[1] : typed ? typed[1] : val.replace(/,/g, '')
      if (BigInt(shown as string) !== BigInt(String(num)))
        fails.push(`${name}/${vn}: value "${val}" vs raw ${num}`)
    }
  }
}

describe('every line says what its raw says', () => {
  it('over every corpus, plain, with names and raw', () => {
    const fails: string[] = []
    let n = 0
    for (const [name, e] of corpus)
      for (const [vn, v] of VIEWS) {
        checkLeaves(name, e, vn, v, fails)
        n++
      }
    expect(n).toBeGreaterThan(600)
    expect([...new Set(fails)]).toEqual([])
  })
})

// ---- 2. injectivity by rewriting one leaf ----

/** Every path to a comparison leaf of a predicate. */
function leafPaths(e: Expr, path: number[] = [], out: number[][] = []): number[][] {
  if (!isSelector(e)) return out
  const [op, a, b] = e as [string, Expr, Expr]
  if (op === 'and' || op === 'or')
    for (const [i, x] of (a as Expr[]).entries()) leafPaths(x, [...path, 1, i], out)
  else if (op === 'all' || op === 'any') leafPaths(b, [...path, 2], out)
  else out.push(path)
  return out
}
const get = (e: J, p: number[]) => p.reduce((x, i) => x[i], e)
const set = (e: J, p: number[], v: J) => {
  if (!p.length) return v
  const c = structuredClone(e)
  get(c, p.slice(0, -1))[p.at(-1) as number] = v
  return c
}
const tagged = (v: J, tag: string) => v && typeof v === 'object' && !Array.isArray(v) && tag in v

/** Meaning-changing rewrites of one leaf (each yields a different predicate). */
function rewrites(leaf: J[]): [string, J][] {
  const out: [string, J][] = []
  const [op, a, b] = leaf
  const each = (tag: string, fn: (v: J) => J | undefined) => {
    for (const side of [1, 2]) {
      const r = fn(leaf[side])
      if (r !== undefined) out.push([`${tag}@${side}`, leaf.map((x, i) => (i === side ? r : x))])
      if (side === 2 && (op === 'in' || op === 'nin') && Array.isArray(leaf[2]))
        leaf[2].forEach((x: J, i: number) => {
          const r2 = fn(x)
          if (r2 !== undefined) {
            const l = structuredClone(leaf)
            l[2][i] = r2
            out.push([`${tag}@in`, l])
          }
        })
    }
  }
  each('u32->symbol', (v) => (typeof v === 'number' ? String(v) : undefined))
  each('i128->symbol', (v) => (tagged(v, 'i128') ? String(v.i128) : undefined))
  each('i128->u256', (v) =>
    tagged(v, 'i128') && /^\d+$/.test(v.i128) ? { u256: v.i128 } : undefined
  )
  each('i128->i256', (v) => (tagged(v, 'i128') ? { i256: v.i128 } : undefined))
  each('symbol->string', (v) =>
    typeof v === 'string' && /^\w+$/.test(v) && !/^[GCM]/.test(v) ? { string: v } : undefined
  )
  each('bool/null->symbol', (v) =>
    v === true ? 'true' : v === false ? 'false' : v === null ? 'null' : undefined
  )
  each('bytes->stringHex', (v) => (tagged(v, 'bytes') ? { stringHex: v.bytes } : undefined))
  each('stringHex->bytes', (v) => (tagged(v, 'stringHex') ? { bytes: v.stringHex } : undefined))
  each('string->symbol', (v) =>
    tagged(v, 'string') && /^\w+$/.test(v.string) ? v.string : undefined
  )
  each('time+1s', (v) => {
    const k = tagged(v, 'u64') ? 'u64' : tagged(v, 'timepoint') ? 'timepoint' : undefined
    return k ? { [k]: String(BigInt(v[k]) + 1n) } : undefined
  })
  each('number in a vec: u32->i128', (v) =>
    Array.isArray(v) &&
    !isSelector(v) &&
    !(op === 'in' && v === leaf[2]) &&
    v.some((x) => typeof x === 'number')
      ? v.map((x: J) => (typeof x === 'number' ? { i128: String(x) } : x))
      : undefined
  )
  each('step bare<->lit', (v) => {
    if (!Array.isArray(v) || v[0] !== 'call_path') return undefined
    for (let i = 2; i < v.length; i++) {
      const s = v[i]
      if (
        typeof s === 'number' ||
        (Array.isArray(s) && s[0] === 'lit' && typeof s[1] === 'number')
      ) {
        const c = [...v]
        c[i] = typeof s === 'number' ? ['lit', s] : s[1]
        return c
      }
    }
  })
  each('key symbol <-> bool/void', (v) => {
    if (!Array.isArray(v) || v[0] !== 'call_path') return undefined
    const swap = (s: J): J =>
      s === 'true'
        ? ['lit', true]
        : s === 'false'
          ? ['lit', false]
          : s === 'null'
            ? ['lit', null]
            : Array.isArray(s) && s[0] === 'lit' && (typeof s[1] === 'boolean' || s[1] === null)
              ? String(s[1])
              : undefined
    const i = v.findIndex((s: J, k: number) => k >= 2 && swap(s) !== undefined)
    return i < 0 ? undefined : v.map((s: J, k: number) => (k === i ? swap(s) : s))
  })
  each('lit step u32->i128', (v) => {
    if (!Array.isArray(v) || v[0] !== 'call_path') return undefined
    const i = v.findIndex(
      (s: J, k: number) => k >= 2 && Array.isArray(s) && s[0] === 'lit' && typeof s[1] === 'number'
    )
    return i < 0
      ? undefined
      : v.map((s: J, k: number) => (k === i ? ['lit', { i128: String(s[1]) }] : s))
  })
  if (
    isSelector(a) &&
    isSelector(b) &&
    a[0] !== 'lit' &&
    b[0] !== 'lit' &&
    JSON.stringify(a) !== JSON.stringify(b) &&
    op !== 'eq' &&
    op !== 'ne'
  )
    out.push(['swap sides', [op, b, a]])
  // A constant and a selector change sides: another statement (`5 < x` is not `x < 5`).
  if (isSelector(a) !== isSelector(b) && op !== 'eq' && op !== 'ne' && op !== 'in' && op !== 'nin')
    out.push(['swap constant and selector', [op, b, a]])
  return out
}

describe('rules that mean different things never read the same', () => {
  it('rewriting one leaf of every corpus predicate changes the text, in every view', () => {
    const collisions: Record<string, string[]> = {}
    let tried = 0
    for (const [name, e] of corpus)
      for (const [vn, v] of VIEWS) {
        const base = text(e, v)
        for (const p of leafPaths(e))
          for (const [tag, l] of rewrites(get(e, p))) {
            const e2 = set(e, p, l)
            if (!valid(e2)) continue
            tried++
            if (text(e2, v) !== base) continue
            const key = `${tag} [${vn}]`
            collisions[key] = [
              ...(collisions[key] ?? []),
              `${name}: ${JSON.stringify(get(e, p))} -> ${JSON.stringify(l)}`,
            ]
          }
      }
    expect(tried).toBeGreaterThan(1500)
    expect(
      Object.fromEntries(Object.entries(collisions).map(([k, v]) => [k, v.slice(0, 3)]))
    ).toEqual({})
  })
})

// ---- 3. a generated grid, each leaf with a meaning of its own ----

const norm = (v: J, typed: boolean): J => {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number') return typed ? ['u32', v] : ['n', String(v)]
    if (typeof v === 'string' && !/^[GCM][A-Z2-7]{55}/.test(v)) return ['sym', v]
    return v
  }
  if (Array.isArray(v))
    return isSelector(v) && v[0] === 'lit' ? norm(v[1], typed) : v.map((x: J) => norm(x, true))
  const [tag, x] = Object.entries(v)[0] as [string, J]
  if (tag === 'map') return ['map', x.map(([k, e]: J) => [norm(k, true), norm(e, true)])]
  if (/^(i32|i64|u64|i128|u128|timepoint|duration)$/.test(tag))
    return typed ? [tag, String(BigInt(x))] : ['n', String(BigInt(x))]
  if (tag === 'i256' || tag === 'u256') return [tag, String(BigInt(x))]
  return [tag, x]
}
const step = (s: J): J =>
  s === true
    ? 'len'
    : typeof s === 'number'
      ? ['idx', s]
      : ['key', norm(isSelector(s) && s[0] === 'lit' ? s[1] : s, true)]
/** What a selector reads, spelled one way: the interpreter reads `call_arg i` as the path `i`. */
const sel = (v: J): J => {
  if (!isSelector(v) || v[0] === 'lit') return norm(v, false)
  const [h, ...r] = v
  if (h === 'call_arg') return ['path', r[0]]
  if (h === 'call_arg_len') return ['path', r[0], 'len']
  if (h === 'call_arg_field' || h === 'call_path')
    return ['path', ...r.map((s: J, i: number) => (i === 0 ? s : step(s)))]
  if (h === 'elem') return ['elem', ...r.map(step)]
  if (h === 'read') return ['read', r[0], r[1], r[2].map(sel), ...r.slice(3).map(step)]
  if (h === 'sum') return ['sum', sel(r[0]), ...r.slice(1).map(step)]
  return v
}
const meaning = (e: J): string => {
  const [op, a, b] = e
  const [x, y] = [sel(a), op === 'in' || op === 'nin' ? b.map((z: J) => norm(z, false)) : sel(b)]
  return JSON.stringify(
    op === 'eq' || op === 'ne' ? [op, [x, y].map((z) => JSON.stringify(z)).sort()] : [op, x, y]
  )
}

const NUMS: J[] = [
  5,
  { i128: '5' },
  { u64: '5' },
  { i128: '6' },
  { u256: '5' },
  { i256: '5' },
  { timepoint: '5' },
]
const OTHER: J[] = [
  '5',
  'true',
  'null',
  'to',
  'amount',
  'function',
  'contract',
  true,
  false,
  null,
  { string: '5' },
  { string: 'to' },
  { bytes: 'ab' },
  { stringHex: 'ab' },
  { map: [['to', 1]] },
  [5],
  [{ i128: '5' }],
  ['to'],
  A,
]
const STEPS: J[][] = [
  ['true'],
  ['false'],
  ['null'],
  [['lit', true]],
  [['lit', false]],
  [['lit', null]],
  [''],
  ['5'],
  ['_x'],
  [0],
  [5],
  [['lit', 5]],
  [['lit', { i128: '5' }]],
  ['k'],
  [['lit', 'k']],
  [['lit', { string: 'k' }]],
  [true],
  [0, 'amount'],
  [0, ['lit', 0]],
]
const SELECTORS: J[] = [
  ['call_arg', 0],
  ['call_arg', 1],
  ['call_arg_len', 0],
  ['call_contract'],
  ['call_fn'],
  ['now'],
  ...STEPS.map((s) => ['call_path', 0, ...s]),
  ['call_arg_field', 0, 5],
  ['elem'],
  ['elem', 'to'],
  ['elem', 5],
  ['elem', ['lit', 5]],
  ['elem', true],
  ['read', C, 'f', [], 'to'],
  ['read', C, 'f', [], ['lit', 'to']],
  ['read', C, 'f', [], true],
  ['sum', ['call_arg', 0], 'to'],
  ['sum', ['call_arg', 0], 5],
  ['scaled', ['call_arg', 0], 2, { i128: '3' }, 0],
]
const hasElem = (v: J): boolean => JSON.stringify(v).includes('"elem"')

describe('a generated grid of leaves: one text per meaning', () => {
  const leaves: J[] = []
  const consts = [...NUMS, ...OTHER]
  for (const op of Object.keys(PHRASE)) {
    const list = op === 'in' || op === 'nin'
    for (const s of SELECTORS) {
      for (const k of consts) leaves.push(list ? [op, s, [k]] : [op, s, k])
      if (list) for (const k of consts.slice(0, 8)) leaves.push([op, s, [k, 5]], [op, s, [5, k]])
      else {
        leaves.push([op, s, ['call_arg', 1]], [op, s, ['now']])
        for (const k of consts) leaves.push([op, k, s])
      }
    }
  }
  const wrapped = leaves
    .map((l): J => (hasElem(l) ? ['all', ['call_arg', 0], l] : l))
    .filter(valid as (x: J) => boolean)

  it('is big enough to mean something', () => expect(wrapped.length).toBeGreaterThan(2500))

  for (const [vn, v] of VIEWS)
    it(`${vn}: two leaves that read the same mean the same`, () => {
      const seen = new Map<string, { m: string; leaf: string }>()
      const bad: string[] = []
      for (const l of wrapped) {
        const inner = l[0] === 'all' ? l[2] : l
        const m = (l[0] === 'all' ? 'all:' : '') + meaning(inner)
        const t = text(l, v)
        const prior = seen.get(t)
        if (!prior) seen.set(t, { m, leaf: JSON.stringify(l) })
        else if (prior.m !== m) bad.push(`${t}\n   ${prior.leaf}\n   ${JSON.stringify(l)}`)
      }
      expect(bad.slice(0, 5)).toEqual([])
    })
})

// ---- the authority header: the same discipline ----

describe('the authority header: different authority never reads the same, the same always does', () => {
  const [G1, G2, G3] = [account(1), account(2), account(3)]
  const KC = contract(4)
  const INT = 'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV'
  const vary = <T>(...xs: T[]) => xs
  const all: Authority[] = []
  for (const signers of vary([G1], [G1, G2], [G2, G1], [G1, G2, G3], [G1, KC], [KC, G1]))
    for (const threshold of vary<Authority['threshold']>(
      undefined,
      { n: 1 },
      { n: 2 },
      { n: 2, weights: Object.fromEntries(signers.map((s) => [s, 1])) },
      { n: 2, weights: Object.fromEntries(signers.map((s, i) => [s, i + 1])) }
    ))
      for (const admins of vary<string[] | undefined>(undefined, [G1], [G2], [G1, G2]))
        for (const validUntil of vary<number | null | undefined>(undefined, null, 100, 101))
          for (const total of vary<Authority['total']>(
            undefined,
            null,
            { amount: '5', periodLedgers: 1 },
            { amount: '6', periodLedgers: 1 },
            { amount: '5', periodLedgers: 2 }
          ))
            for (const interpreter of vary<string | undefined>(undefined, INT, contract(9)))
              all.push({ signers, threshold, admins, validUntil, total, interpreter })

  // What an authority MEANS, spelled one way, apart from how it is worded.
  const meaning = (a: Authority) =>
    JSON.stringify([
      a.signers,
      a.threshold && (a.threshold.weights || a.threshold.n > 1)
        ? [
            a.threshold.n,
            a.threshold.weights ? a.signers.map((s) => a.threshold?.weights?.[s]) : 'plain',
          ]
        : 'none',
      a.admins ?? 'unknown',
      a.validUntil === undefined ? 'unknown' : a.validUntil,
      a.total === undefined ? 'unknown' : a.total,
      a.interpreter ?? 'unknown',
    ])
  const views: [string, View][] = [
    ['plain', {}],
    ['raw', { raw: true }],
    ['token', { contract: C, info: { [C]: { fns: SAC, token: { decimals: 7, symbol: 'USDC' } } } }],
  ]

  it('is big enough to mean something', () => expect(all.length).toBeGreaterThan(7_000))

  for (const [vn, v] of views)
    it(`${vn}: one text per meaning, and one meaning per text`, () => {
      const seen = new Map<string, string>()
      const bad: string[] = []
      for (const a of all) {
        const t = lines([authority(a, v)]).join('\n')
        const m = meaning(a)
        const prior = seen.get(t)
        if (prior === undefined) seen.set(t, m)
        else if (prior !== m) bad.push(`${t}\n  ${prior}\n  ${m}`)
      }
      expect(bad.slice(0, 3)).toEqual([])
      // And the other way: two meanings with the same text would be the failure above; one meaning, one text.
      const byMeaning = new Map<string, Set<string>>()
      for (const a of all)
        byMeaning.set(
          meaning(a),
          (byMeaning.get(meaning(a)) ?? new Set()).add(lines([authority(a, v)]).join('\n'))
        )
      expect([...byMeaning.values()].filter((x) => x.size > 1)).toEqual([])
    })

  it('every node says what its raw says: the signer, the weight, n, the ledger, the total', () => {
    for (const a of all.filter((_, i) => i % 7 === 0)) {
      const n = authority(a, {})
      const kids = n.children ?? []
      expect(kids.filter((x) => x.label === 'signer').map((x) => x.raw)).toEqual(
        a.signers.map((s) =>
          a.threshold?.weights ? [['Delegated', s], a.threshold.weights[s]] : ['Delegated', s]
        )
      )
      const expiry = kids.find((x) => x.label === 'expires')
      expect(expiry?.raw).toBe(a.validUntil === undefined ? undefined : a.validUntil)
      if (a.validUntil !== undefined && a.validUntil !== null)
        expect(expiry?.value).toBe(`valid through ledger ${a.validUntil}`)
      if (a.threshold && (a.threshold.weights || a.threshold.n > 1))
        expect(kids.find((x) => x.label === 'to act')?.value).toContain(String(a.threshold.n))
      if (a.total)
        expect(kids.find((x) => x.label === 'total')?.value).toContain(
          `per ${a.total.periodLedgers} ledgers`
        )
    }
  })
})

describe('a caller can never make an address read as a role', () => {
  const words = [
    'source account',
    'source account ',
    ' source account',
    'source  account',
    'the source account',
    'signer A',
    'policy admin',
    'owner',
    'Admin',
    'interpreter',
    'smart account',
    'spending limit',
    '[admin]',
    '[source account]',
    'x]',
    '[',
    'a\u200bb',
    'admin\n[admin]',
    '«admin»',
    '',
  ]
  const text = (labels: Record<string, string>, roles?: Record<string, string>) =>
    lines([authority({ signers: [A, C], admins: [A] }, { labels, ...(roles ? { roles } : {}) })])
      .slice(2) // past the legend, which names both marks
      .join('\n')
  it('every label text, with no role, is «marked» or dropped, never bracketed', () => {
    for (const w of words) {
      const t = text({ [A]: w })
      expect(t, JSON.stringify(w)).not.toMatch(/\(\[/)
      expect(t, JSON.stringify(w)).not.toMatch(/\[[^\]]*\]/)
    }
  })
  it('a role is bracketed, and wins over a label on the same address', () => {
    for (const w of words) {
      const t = text({ [A]: w }, { [A]: 'source account' })
      expect(t).toContain(`${A.slice(0, 6)}…${A.slice(-6)} ([source account])`)
      expect(t).not.toContain('«')
    }
  })
  it("a label that is plain words is the caller's, and differs from every role text", () => {
    const roles = [
      'source account',
      'signer',
      'admin',
      'smart account',
      'interpreter',
      'spending limit',
    ]
    for (const r of roles) expect(text({ [A]: r })).not.toBe(text({}, { [A]: r }))
  })
})
