// What an account already lets its keys do, and whether a new rule can bind them.
//
// OpenZeppelin lets the caller name which context rule authorises a call, so a key
// that sits on a tight rule and on a looser (or unpoliced) one simply names the
// looser: the tight rule never runs. `overlaps` finds every rule a shared signer
// could name instead, and says which of them make the new rule a decoration.
// `readRules` reads them from the chain: the account's rules by simulation, the
// interpreter's stored predicates and the spending caps as one batch of ledger
// entries (the interpreter keeps one record per rule, keyed (account, rule id)).

import { Address, type rpc, xdr } from '@stellar/stellar-sdk'
import { dataKey, entries, pool, read } from './chain.ts'
import { type Network, SPENDING_LIMIT } from './config.ts'
import { decode, type Expr, fromScVal, isSelector, unlit, type Val } from './wire.ts'

export type Scope =
  | { kind: 'default' }
  | { kind: 'call_contract'; contract: string }
  | { kind: 'create_contract'; wasmHash: string }
export interface Cap {
  amount: string
  periodLedgers: number
}
export interface ObservedRule {
  id: number
  scope: Scope
  /** Signers as stable keys: `G...`, or `External:<verifier>:<key>`. */
  signers: string[]
  policies: string[]
  /** The stored predicate, for a rule our interpreter polices. */
  expr?: Expr
  cap?: Cap
}
export interface Intended {
  scope: Scope
  signers: string[]
  expr: Expr
  cap?: Cap
}
export interface Overlap {
  ruleId: number
  /** `refuse`: the new rule cannot bind a shared signer. `review`: it may, read the advice. */
  severity: 'refuse' | 'review'
  why: 'unpoliced' | 'looser' | 'uncapped' | 'unreadable' | 'other'
  advice: string
}

// ---- reading the account ----

const MAX_RULE_ID = 512
const WIDTH = 6
type Fields = Record<string, Val>
const fields = (v: Val | undefined): Fields =>
  Object.fromEntries(
    v && typeof v === 'object' && !Array.isArray(v) && 'map' in v
      ? v.map.map(([k, x]) => [String(k), x])
      : []
  )

function signerKey(s: Val): string {
  const [tag, a, key] = s as [string, string, { bytes: string }?]
  return tag === 'Delegated' ? a : `External:${a}:${key?.bytes ?? ''}`
}

function scopeOf(v: Val): Scope {
  const [tag, x] = (Array.isArray(v) ? v : ['Default']) as [string, Val?]
  if (tag === 'CallContract') return { kind: 'call_contract', contract: String(x) }
  if (tag === 'CreateContract')
    return { kind: 'create_contract', wasmHash: String((x as { bytes: string }).bytes) }
  // An unrecognised scope reads as the widest, so overlap is over-reported, never missed.
  return { kind: 'default' }
}

/** Every context rule on `account`, with the stored predicate filled in for those
 *  our interpreter polices. `complete` is false when ids ran out before every live
 *  rule was found: the list is then a subset and must not be read as safety. */
export async function readRules(
  server: rpc.Server,
  network: Network,
  account: string,
  interpreter: string
): Promise<{ rules: ObservedRule[]; complete: boolean; unreadable: number[] }> {
  const count = Number((await read(server, network, account, 'get_context_rules_count')).u32())
  const rules: ObservedRule[] = []
  // Ids are not contiguous (a removed id is never reused), so walk upward in
  // batches until every live rule has been seen.
  for (let from = 0; rules.length < count && from < MAX_RULE_ID; from += WIDTH * 2) {
    const ids = Array.from({ length: WIDTH * 2 }, (_, i) => from + i)
    const got = await pool(ids, WIDTH, (id) =>
      read(server, network, account, 'get_context_rule', xdr.ScVal.scvU32(id)).then(
        fromScVal,
        () => undefined
      )
    )
    for (const raw of got) {
      const f = fields(raw)
      if (f.id === undefined) continue
      rules.push({
        id: f.id as number,
        scope: scopeOf(f.context_type as Val),
        signers: (f.signers as Val[]).map(signerKey),
        policies: f.policies as string[],
      })
    }
  }
  const mine = rules.filter((r) => r.policies.includes(interpreter))
  const capped = rules.filter((r) => r.policies.includes(SPENDING_LIMIT[network]))
  const rid = (r: ObservedRule) => xdr.ScVal.scvU32(r.id)
  const acct = new Address(account).toScVal()
  const [docs, caps] = await Promise.all([
    entries(
      server,
      mine.map((r) => dataKey(interpreter, xdr.ScVal.scvVec([acct, rid(r)])))
    ),
    entries(
      server,
      capped.map((r) =>
        dataKey(
          SPENDING_LIMIT[network],
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('AccountContext'), acct, rid(r)])
        )
      )
    ),
  ])
  const unreadable: number[] = []
  mine.forEach((r, i) => {
    const bytes = (
      fields(docs[i] && fromScVal(docs[i] as xdr.ScVal)).predicate_bytes as
        | { bytes: string }
        | undefined
    )?.bytes
    try {
      if (!bytes) throw new Error('no stored predicate')
      r.expr = decode(Buffer.from(bytes, 'hex').toString('base64'))
    } catch {
      unreadable.push(r.id)
    }
  })
  capped.forEach((r, i) => {
    const f = fields(caps[i] && fromScVal(caps[i] as xdr.ScVal))
    const limit = f.spending_limit as { i128: string } | undefined
    if (limit && typeof f.period_ledgers === 'number')
      r.cap = { amount: limit.i128, periodLedgers: f.period_ledgers }
  })
  return { rules, complete: rules.length >= count, unreadable }
}

// ---- which calls a rule can serve ----

interface Sel {
  contract: string
  fn: string
}
const ANY = '*'
const WILD: Sel = { contract: ANY, fn: ANY }

function meet(a: Sel[], b: Sel[]): Sel[] {
  const pick = (x: string, y: string) => (x === ANY ? y : y === ANY || x === y ? x : null)
  return a.flatMap((x) =>
    b.flatMap((y) => {
      const [contract, fn] = [pick(x.contract, y.contract), pick(x.fn, y.fn)]
      return contract !== null && fn !== null ? [{ contract, fn }] : []
    })
  )
}

/** The (contract, function) pairs an expression can permit, over-approximated:
 *  anything it does not pin on those two leaves is a wildcard. */
export function selectors(e: Expr): Sel[] {
  if (!isSelector(e)) return [WILD]
  const [op, a, b] = e as [string, Val, Val]
  if (op === 'and') return (a as Expr[]).reduce<Sel[]>((acc, c) => meet(acc, selectors(c)), [WILD])
  if (op === 'or') return (a as Expr[]).flatMap(selectors)
  const leaf = isSelector(a) ? a[0] : undefined
  const values = op === 'eq' ? [b] : op === 'in' ? (b as Val[]) : []
  if ((leaf === 'call_contract' || leaf === 'call_fn') && values.length > 0) {
    return values.map((v) =>
      leaf === 'call_contract'
        ? { contract: String(unlit(v)), fn: ANY }
        : { contract: ANY, fn: String(unlit(v)) }
    )
  }
  return [WILD]
}

const scopeSel = (s: Scope): Sel[] =>
  s.kind === 'default'
    ? [WILD]
    : s.kind === 'call_contract'
      ? [{ contract: s.contract, fn: ANY }]
      : []

// ---- is one rule at least as permissive as another? ----

const num = (v: Val | undefined): bigint | undefined => {
  const x = typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.values(v)[0] : v
  return typeof x === 'number' || (typeof x === 'string' && /^-?\d+$/.test(x))
    ? BigInt(x)
    : undefined
}
const key = (v: Val) => JSON.stringify(v)

/** `nc` (a conjunct of the new rule) allows nothing `oc` (of the old) forbids. */
export function implies(nc: Expr, oc: Expr): boolean {
  if (key(nc) === key(oc)) return true
  const [[no, na, nb], [oo, oa, ob]] = [nc, oc] as [[string, Val, Val], [string, Val, Val]]
  if (!isSelector(nc) || !isSelector(oc) || key(na) !== key(oa)) return false
  const [x, y] = [num(nb), num(ob)]
  const strict = (o: string) => o === 'lt' || o === 'gt'
  if (
    x !== undefined &&
    y !== undefined &&
    ['lte', 'lt'].includes(no) &&
    ['lte', 'lt'].includes(oo)
  ) {
    return strict(oo) ? x < y || (no === 'lt' && x <= y) : strict(no) ? x <= y + 1n : x <= y
  }
  if (
    x !== undefined &&
    y !== undefined &&
    ['gte', 'gt'].includes(no) &&
    ['gte', 'gt'].includes(oo)
  ) {
    return strict(oo) ? x > y || (no === 'gt' && x >= y) : strict(no) ? x >= y - 1n : x >= y
  }
  const inSet = (set: Val[], v: Val) => set.some((s) => key(unlit(s)) === key(unlit(v)))
  if (oo === 'in' && no === 'in') return (nb as Val[]).every((v) => inSet(ob as Val[], v))
  return oo === 'in' && no === 'eq' ? inSet(ob as Val[], nb) : false
}

/** Each branch of an expression as its list of conjuncts. */
const branches = (e: Expr): Expr[][] => {
  const kids = (x: Expr): Expr[] => (isSelector(x) && x[0] === 'and' ? (x[1] as Expr[]) : [x])
  return isSelector(e) && e[0] === 'or' ? (e[1] as Expr[]).map(kids) : [kids(e)]
}

/** The old rule permits every call the new one does. */
export function covers(old: Expr, mine: Expr): boolean {
  return branches(mine).every((nb) =>
    branches(old).some((ob) => ob.every((oc) => nb.some((nc) => implies(nc, oc))))
  )
}

// ---- the scan ----

/** Every rule a shared signer could name instead of the new one, and what that does
 *  to it. A rule that serves none of the same calls, or shares no signer, is not listed. */
export function overlaps(
  mine: Intended,
  existing: ObservedRule[],
  interpreter: string,
  network: Network
): Overlap[] {
  const calls = meet(scopeSel(mine.scope), selectors(mine.expr))
  return existing.flatMap((old): Overlap[] => {
    if (!old.signers.some((s) => mine.signers.includes(s))) return []
    const shared = meet(
      calls,
      old.expr ? meet(scopeSel(old.scope), selectors(old.expr)) : scopeSel(old.scope)
    )
    if (shared.length === 0) return []
    const out = (severity: Overlap['severity'], why: Overlap['why'], advice: string): Overlap[] => [
      { ruleId: old.id, severity, why, advice: `rule ${old.id}: ${advice}` },
    ]
    const recognised = old.policies.every((p) => p === interpreter || p === SPENDING_LIMIT[network])
    if (old.policies.length === 0) {
      return out(
        'refuse',
        'unpoliced',
        'has no policy, so a shared signer makes these calls with no constraint and the new rule never runs; remove the shared signer from it or attach a policy'
      )
    }
    if (mine.cap && recognised && !old.cap) {
      return out(
        'refuse',
        'uncapped',
        'serves some of the same calls with no spend cap, so the new rolling total does not bind a shared signer; a cap is per rule, not per key'
      )
    }
    if (!old.policies.includes(interpreter) || !old.expr) {
      const unreadable = old.policies.includes(interpreter)
      return out(
        'review',
        unreadable ? 'unreadable' : 'other',
        unreadable
          ? 'its stored predicate cannot be read, so what it permits is unknown'
          : 'is policed by a contract this tool cannot decode, so its authority over these calls is unknown'
      )
    }
    if (covers(old.expr, mine.expr)) {
      return out(
        'refuse',
        'looser',
        'permits everything the new rule does and more, so a shared signer names it instead; edit that rule to tighten it rather than adding a second'
      )
    }
    return out(
      'review',
      'other',
      'serves some of the same calls under different conditions; a shared signer may name either'
    )
  })
}
