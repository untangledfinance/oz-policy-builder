// What an account already lets its keys do, and whether a new rule can bind them.
//
// OpenZeppelin lets the caller name which context rule authorises a call, so a key
// that sits on a tight rule and on a looser (or unpoliced) one simply names the
// looser: the tight rule never runs. `overlaps` finds every rule a shared signer
// could name instead, and says which of them make the new rule a decoration.
// `readRules` reads them from the chain: the account's rules by simulation, the
// interpreter's stored predicates and the spending caps as one batch of ledger
// entries (the interpreter keeps one record per rule, keyed (account, rule id)).

import { Address, type rpc, StrKey, xdr } from '@stellar/stellar-sdk'
import { dataKey, entries, pool, read } from './chain.ts'
import { INTERPRETERS, type Network, SPENDING_LIMIT } from './config.ts'
import { type ErrorCode, Refusal } from './envelope.ts'
import {
  branches,
  type Caps,
  decode,
  type Expr,
  fields,
  fromScVal,
  hashOf,
  intOf,
  isConstant,
  isSelector,
  type Reference,
  unlit,
  type Val,
  validate,
} from './wire.ts'

export type Scope =
  | { kind: 'default' }
  | { kind: 'call_contract'; contract: string }
  | { kind: 'create_contract'; wasmHash: string }
export interface RollingTotal {
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
  /** Our interpreter polices it, but its stored predicate could not be read (or decoded). */
  unreadable?: boolean
  /** It carries no predicate of its own: it follows this rule's, read at every call. `expr` is
   *  then that rule's predicate as it is now, which that rule's admins can change. */
  follows?: Followed
  /** The executor the interpreter's record binds the rule to (`bind_executor`). */
  executor?: string
  /** The rule's Policy Signer role as the interpreter keeps it (`master_set`): Delegated addresses,
   *  any other signer kind as its wire JSON. */
  admins?: string[]
  cap?: RollingTotal
}
/** The rule another follows, with what it holds now (absent when it could not be read). */
export interface Followed extends Reference {
  /** The followed rule's install nonce: it grows with every re-install of it. */
  nonce?: number
  /** sha256 of the followed rule's predicate bytes, hex. */
  predicateHash?: string
}
/** The rule about to be installed. */
export type Intended = Pick<ObservedRule, 'scope' | 'signers' | 'cap' | 'follows'> & { expr: Expr }
export interface RulesRead {
  rules: ObservedRule[]
  /** False when ids ran out before every live rule was found: the list is a subset. */
  complete: boolean
  /** Rules our interpreter polices whose stored record could not be read. */
  unreadable: number[]
}
export interface Overlap {
  ruleId: number
  /** `refuse`: the new rule cannot bind a shared signer. `review`: it may, read the advice. */
  severity: 'refuse' | 'review'
  why: 'unpoliced' | 'looser' | 'uncapped' | 'rolling' | 'unreadable' | 'follows' | 'other'
  advice: string
}

// ---- reading the account ----

const MAX_RULE_ID = 512
const WIDTH = 8
const ENTRY_BATCH = 200

export function signerKey(s: Val): string {
  const [tag, a, key] = s as [string, string, { bytes: string }?]
  if (tag === 'Delegated') return a
  // An ed25519 key (32 bytes) enrolled as an External signer is the key of the G account
  // that holds it: the same signer, whichever way it is enrolled.
  return key?.bytes.length === 64
    ? StrKey.encodeEd25519PublicKey(Buffer.from(key.bytes, 'hex'))
    : `External:${a}:${key?.bytes ?? ''}`
}

function scopeOf(v: Val): Scope {
  const [tag, x] = (Array.isArray(v) ? v : ['Default']) as [string, Val?]
  if (tag === 'CallContract') return { kind: 'call_contract', contract: String(x) }
  if (tag === 'CreateContract')
    return { kind: 'create_contract', wasmHash: String((x as { bytes: string }).bytes) }
  // An unrecognised scope reads as the widest, so overlap is over-reported, never missed.
  return { kind: 'default' }
}

/** The context rule `id` on `account` (with its stored predicate when `interpreter` polices it), or undefined when there is none. Only the account's
 *  own "no such rule" (`Error(Contract, #3000)`) means none: any other failure (a rate limit,
 *  a trap) is an error, so it is never read as an empty account. */
export async function readRule(
  server: rpc.Server,
  network: Network,
  account: string,
  id: number,
  interpreter?: string
): Promise<ObservedRule | undefined> {
  let raw: Val
  try {
    raw = fromScVal(await read(server, network, account, 'get_context_rule', xdr.ScVal.scvU32(id)))
  } catch (e) {
    if (e instanceof Refusal && e.message.includes('Error(Contract, #3000)')) return undefined
    throw e
  }
  const f = fields(raw)
  if (f.id === undefined) return undefined
  // An account that answers for another rule than it was asked for is not read.
  if (f.id !== id)
    throw new Refusal('SIMULATION_ERROR', `rule ${id}: the account answered for rule ${f.id}`)
  const rule: ObservedRule = {
    id: f.id as number,
    scope: scopeOf(f.context_type as Val),
    signers: (f.signers as Val[]).map(signerKey),
    policies: f.policies as string[],
  }
  // Its predicate too, when `interpreter` polices it; a rule read only to be described is not
  // refused over it, but says so.
  if (interpreter) {
    const lost = await readPredicates(server, interpreter, account, [rule]).catch(() => [id])
    if (lost.length > 0) rule.unreadable = true
  }
  return rule
}

/** The interpreter's record of rule `id` on `account` (its `StoredDoc`), as a field record. */
const docKey = (interpreter: string, r: Reference) =>
  dataKey(
    interpreter,
    xdr.ScVal.scvVec([new Address(r.account).toScVal(), xdr.ScVal.scvU32(r.ruleId)])
  )
const docOf = (v: xdr.ScVal | undefined) => (v ? fields(fromScVal(v)) : undefined)

/** Where a stored record's predicate is: its own bytes (`inline`), another rule's, or neither
 *  (`bad`). A record with no `source` field is from a build that has no references: inline. */
function sourceOf(doc: Record<string, Val>): 'inline' | 'bad' | Reference {
  const s = doc.source
  if (s === undefined) return 'inline'
  if (!Array.isArray(s)) return 'bad'
  if (s.length === 1 && s[0] === 'Inline') return 'inline'
  const [tag, account, ruleId] = s
  return s.length === 3 &&
    tag === 'Rule' &&
    typeof account === 'string' &&
    typeof ruleId === 'number'
    ? { account, ruleId }
    : 'bad'
}

/** A record's own predicate, decoded: throws when it carries none the package can read. */
function ownPredicate(doc: Record<string, Val>): { expr: Expr; b64: string } {
  const bytes = (doc.predicate_bytes as { bytes?: string } | undefined)?.bytes
  if (!bytes) throw new Error('no stored predicate')
  const b64 = Buffer.from(bytes, 'hex').toString('base64')
  return { expr: decode(b64), b64 }
}

/** Fill in the stored predicate of each of `rules` that `interpreter` polices (the interpreter
 *  keeps one record per account and rule id). A rule that follows another rule's predicate gets
 *  that rule's predicate as it is now, and `follows`; a followed rule that is missing, itself a
 *  reference or undecodable leaves it unread, as the interpreter would refuse it (206, 201). The
 *  ids whose predicate could not be read. */
export async function readPredicates(
  server: rpc.Server,
  interpreter: string,
  account: string,
  rules: ObservedRule[]
): Promise<number[]> {
  const mine = rules.filter((r) => r.policies.includes(interpreter))
  const docs = (
    await entries(
      server,
      mine.map((r) => docKey(interpreter, { account, ruleId: r.id }))
    )
  ).map(docOf)
  const sources = docs.map((d) => (d ? sourceOf(d) : 'bad'))
  // Every followed rule in one more batch, each once (the RPC refuses a key asked twice): one level
  // only, so nothing further is read.
  const name = (r: Reference) => `${r.account}:${r.ruleId}`
  const refs = [
    ...new Map(
      sources.filter((x): x is Reference => typeof x === 'object').map((r) => [name(r), r])
    ).values(),
  ]
  const followed = (
    await entries(
      server,
      refs.map((r) => docKey(interpreter, r))
    )
  ).map(docOf)
  const unreadable: number[] = []
  mine.forEach((r, i) => {
    const doc = docs[i]
    const source = sources[i] ?? 'bad'
    if (doc && typeof doc.executor === 'string') r.executor = doc.executor
    if (doc && Array.isArray(doc.master_set))
      r.admins = doc.master_set.map((s) =>
        Array.isArray(s) && s[0] === 'Delegated' && typeof s[1] === 'string'
          ? s[1]
          : JSON.stringify(s)
      )
    try {
      if (!doc || source === 'bad') throw new Error('no stored record')
      if (source === 'inline') {
        r.expr = ownPredicate(doc).expr
        return
      }
      const f: Followed = { ...source }
      r.follows = f
      const theirs = followed[refs.findIndex((x) => name(x) === name(source))]
      if (!theirs || sourceOf(theirs) !== 'inline') throw new Error('the followed rule is not read')
      const { expr, b64 } = ownPredicate(theirs)
      r.expr = expr
      f.predicateHash = hashOf(b64)
      if (typeof theirs.nonce === 'number') f.nonce = theirs.nonce
    } catch {
      unreadable.push(r.id)
    }
  })
  return unreadable
}

/** The rule `r` on `interpreter`, read to be followed: its predicate now (validated against `caps`),
 *  its encoding and hash, and its nonce. Refused (with `code`) when the interpreter has no such
 *  record (it would refuse with 206), when its records carry no source (a build with no references),
 *  when that rule itself follows another (one level only: 201), or when its predicate does not decode. */
export async function readFollowed(
  server: rpc.Server,
  interpreter: string,
  r: Reference,
  caps: Caps,
  code: ErrorCode
): Promise<{ expr: Expr; encoded: string; follows: Required<Followed> }> {
  const [raw] = await entries(server, [docKey(interpreter, r)])
  const doc = docOf(raw)
  const which = `rule ${r.ruleId} of ${r.account}`
  if (!doc)
    throw new Refusal(
      code,
      `${interpreter} holds no ${which}: there is nothing to follow (the interpreter refuses it, 206)`
    )
  if (doc.source === undefined)
    throw new Refusal(
      code,
      `${interpreter} keeps no predicate source in its records: it is a build with no rule references, so no rule on it can follow another`
    )
  const source = sourceOf(doc)
  if (source !== 'inline')
    throw new Refusal(
      code,
      `${which} itself follows another rule's predicate: a rule follows one that carries its own (one level only; the interpreter refuses a chain, 201)`
    )
  let got: { expr: Expr; b64: string }
  try {
    got = ownPredicate(doc)
    validate(got.expr, caps)
  } catch (e) {
    throw new Refusal(
      'MALFORMED_PREDICATE',
      `${which} holds a predicate this package cannot read: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (typeof doc.nonce !== 'number')
    throw new Refusal(code, `${which}: its record carries no install nonce`)
  return {
    expr: got.expr,
    encoded: got.b64,
    follows: { ...r, nonce: doc.nonce, predicateHash: hashOf(got.b64) },
  }
}

const NEXT_ID = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('NextId')]).toXDR('base64')

/** The id the account will give its next rule (`NextId`, in its instance storage): no rule
 *  has an id at or past it. Past the bound when the account's own data does not say. */
async function nextId(server: rpc.Server, account: string): Promise<number> {
  const [i] = await entries(server, [dataKey(account, xdr.ScVal.scvLedgerKeyContractInstance())])
  if (i?.switch().name !== 'scvContractInstance') return MAX_RULE_ID + 1
  // No NextId means no rule was ever added (the account counts from 0).
  const v = i
    .instance()
    .storage()
    ?.find((e) => e.key().toXDR('base64') === NEXT_ID)
    ?.val()
  return !v ? 0 : v.switch().name === 'scvU32' ? v.u32() : MAX_RULE_ID + 1
}

/** Which of the ids below `next` still have a context rule: one ledger-entry batch per
 *  `ENTRY_BATCH` ids (the RPC's limit on keys per call). */
async function liveIds(server: rpc.Server, account: string, next: number): Promise<number[]> {
  const found: number[] = []
  for (let from = 0; from < next; from += ENTRY_BATCH) {
    const ids = Array.from({ length: Math.min(ENTRY_BATCH, next - from) }, (_, i) => from + i)
    const keys = ids.map((id) =>
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ContextRuleData'), xdr.ScVal.scvU32(id)])
    )
    const got = await entries(
      server,
      keys.map((k) => dataKey(account, k))
    )
    found.push(...ids.filter((_, j) => got[j]))
  }
  return found
}

/** Every context rule on `account`, with the stored predicate filled in for those
 *  our interpreter polices. `complete` is false when the rules found are not all the
 *  account counts (or it has more ids than the bound): the list is then a subset and
 *  must not be read as safety. At most 1 + 1 + ceil(NextId / 200) calls to find them
 *  and one simulation per live rule. */
export async function readRules(
  server: rpc.Server,
  network: Network,
  account: string,
  interpreter: string,
  signal?: AbortSignal
): Promise<RulesRead> {
  // The account counts its rules and keeps the next id it will hand out (a removed id is never
  // reused, so every rule that ever existed has an id below it). Ask which of those ids still
  // have a rule in one batch of ledger entries, then read only those: a gap of removed ids costs
  // nothing, and an account that claims more ids than the bound is not read at all.
  const [count, next] = await Promise.all([
    read(server, network, account, 'get_context_rules_count').then((v) => Number(v.u32())),
    nextId(server, account),
  ])
  const ids = next > MAX_RULE_ID || count > MAX_RULE_ID ? [] : await liveIds(server, account, next)
  const got = await pool(ids, WIDTH, (id) => readRule(server, network, account, id), signal)
  const rules = got.filter((r) => r !== undefined)
  // Complete only when what was found is exactly what the account counts: a rule whose entry
  // is archived or unreadable would otherwise vanish from the list unreported.
  const complete = next <= MAX_RULE_ID && rules.length === count && ids.length === count
  const capped = rules.filter((r) => r.policies.includes(SPENDING_LIMIT[network]))
  const acct = new Address(account).toScVal()
  const [unreadable, caps] = await Promise.all([
    readPredicates(server, interpreter, account, rules),
    entries(
      server,
      capped.map((r) =>
        dataKey(
          SPENDING_LIMIT[network],
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('AccountContext'), acct, xdr.ScVal.scvU32(r.id)])
        )
      )
    ),
  ])
  capped.forEach((r, i) => {
    const f = fields(caps[i] && fromScVal(caps[i] as xdr.ScVal))
    const limit = f.spending_limit as { i128: string } | undefined
    if (limit && typeof f.period_ledgers === 'number')
      r.cap = { amount: limit.i128, periodLedgers: f.period_ledgers }
  })
  return { rules, complete, unreadable }
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
  const [op, a, b] = constantLast(e) as [string, Val, Val]
  if (op === 'and') return (a as Expr[]).reduce<Sel[]>((acc, c) => meet(acc, selectors(c)), [WILD])
  if (op === 'or') return (a as Expr[]).flatMap(selectors)
  const leaf = isSelector(a) ? a[0] : undefined
  // Only a constant names a call: `eq(call_fn, read(...))` serves any function.
  const values = op === 'eq' && isConstant(b) ? [b] : op === 'in' ? (b as Val[]) : []
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

const key = (v: Val) => JSON.stringify(v)

export const FLIP: Record<string, string> = {
  lt: 'gt',
  lte: 'gte',
  gt: 'lt',
  gte: 'lte',
  eq: 'eq',
  ne: 'ne',
}

/** A comparison with its constant on the right: `gte(5, x)` is `lte(x, 5)`. */
export function constantLast(e: Expr): Expr {
  if (!isSelector(e) || !(e[0] in FLIP) || e.length !== 3) return e
  const [op, a, b] = e as [string, Val, Val]
  return isConstant(a) && !isConstant(b) ? [FLIP[op] as string, b, a] : e
}

/** A selector as the contract reads it: `call_arg(i)` and `call_arg_len(i)` are paths. */
export const canon = (v: Val): string => {
  const [head, ...r] = isSelector(v) ? v : []
  return key(
    head === 'call_arg' || head === 'call_arg_field'
      ? ['call_path', ...r]
      : head === 'call_arg_len'
        ? ['call_path', ...r, true]
        : v
  )
}

/** The same constant, as the contract compares: a lit is its value, numbers by value. */
const same = (x: Val, y: Val): boolean => {
  const [a, b] = [intOf(unlit(x)), intOf(unlit(y))]
  return a !== undefined && b !== undefined ? a === b : key(unlit(x)) === key(unlit(y))
}

/** `nc` (a conjunct of the new rule) allows nothing `oc` (of the old) forbids. */
export function implies(a: Expr, b: Expr): boolean {
  const [nc, oc] = [constantLast(a), constantLast(b)]
  if (key(nc) === key(oc)) return true
  if (!isSelector(nc) || !isSelector(oc)) return false
  const [no, na, nb] = nc as [string, Val, Val]
  const [oo, oa, ob] = oc as [string, Val, Val]
  if (canon(na) !== canon(oa)) return false
  const [x, y] = [intOf(unlit(nb)), intOf(unlit(ob))]
  const strict = (o: string) => o === 'lt' || o === 'gt'
  // An upper bound as is, a lower bound negated: `x >= y` is `-x <= -y`.
  const sign = (o: string) =>
    o === 'lte' || o === 'lt' ? 1n : o === 'gte' || o === 'gt' ? -1n : 0n
  const s = sign(no)
  if (x !== undefined && y !== undefined && s !== 0n && s === sign(oo)) {
    const [a, b] = [s * x, s * y]
    return strict(oo) ? a < b : strict(no) ? a <= b + 1n : a <= b
  }
  const inSet = (set: Val[], v: Val) => set.some((e) => same(e, v))
  if (oo === 'in' && no === 'in') return (nb as Val[]).every((v) => inSet(ob as Val[], v))
  if (oo === 'in' && no === 'eq') return inSet(ob as Val[], nb)
  return oo === 'eq' && no === 'eq' && same(nb, ob)
}

/** The neighbour's predicate with the one thing its scope guarantees written in: a rule
 *  scoped to a contract only ever sees that contract's calls. */
const within = (old: ObservedRule): Expr => {
  const e = old.expr as Expr
  if (old.scope.kind !== 'call_contract') return e
  const pin: Expr = ['eq', ['call_contract'], old.scope.contract]
  const bs = branches(e).map((b) => ['and', [pin, ...b]] as Expr)
  return bs.length === 1 ? (bs[0] as Expr) : ['or', bs]
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
  // A new rule that follows another may permit anything its scope allows tomorrow, as a neighbour that
  // follows does.
  const calls = mine.follows
    ? scopeSel(mine.scope)
    : meet(scopeSel(mine.scope), selectors(mine.expr))
  return existing.flatMap((old): Overlap[] => {
    // A rule with no signer at all may be open to any key (OZ lets a policy stand alone): shared.
    if (old.signers.length > 0 && !old.signers.some((s) => mine.signers.includes(s))) return []
    // A neighbour that follows another rule may permit anything its scope allows tomorrow.
    const shared = meet(
      calls,
      old.expr && !old.follows
        ? meet(scopeSel(old.scope), selectors(old.expr))
        : scopeSel(old.scope)
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
        "serves some of the same calls with no spend cap, so the new rolling total does not bind a shared signer; each rule keeps its own total, and a key's spend under one rule does not count against another"
      )
    }
    // A neighbour that follows another rule's predicate permits whatever that rule's admins
    // install next, without this account: judged on what it permits now, it could widen later.
    if (old.follows) {
      return out(
        'refuse',
        'follows',
        `follows rule ${old.follows.ruleId} of ${old.follows.account}, whose admins can change what it permits without this account, so a shared signer may name it and escape the new rule's limits; take the shared signer off one of the two rules`
      )
    }
    // What the scan cannot read it cannot judge, and a rule it cannot judge may be the one a
    // shared signer names instead: refused (`allowOverlap` is the override), never "review".
    if (!old.expr) {
      const reads = old.policies.some((p) => p === interpreter || INTERPRETERS.has(p))
      return out(
        'refuse',
        reads ? 'unreadable' : 'other',
        old.policies.includes(interpreter)
          ? 'its stored predicate cannot be read, so what it permits is unknown'
          : reads
            ? 'is policed by an interpreter this tool cannot decode, so what it permits is unknown'
            : "has no predicate this tool can read (only other policies), so a shared signer may make these calls under none of the new rule's limits"
      )
    }
    // Rolling totals accumulate per rule: a shared key that names this neighbour spends against
    // its window (whatever size), never the new one. Refused however tight its predicate is.
    if (mine.cap) {
      return out(
        'refuse',
        'rolling',
        "serves some of the same calls under its own spend window, so the new rolling total does not bind a shared signer; each rule keeps its own total, and a key's spend under one rule does not count against another"
      )
    }
    if (covers(old.expr, mine.expr)) {
      return out(
        'refuse',
        'looser',
        'permits everything the new rule does and more, so a shared signer names it instead; tighten that rule itself'
      )
    }
    // Anything else that overlaps lets a shared key do something the new rule forbids, unless
    // the neighbour is provably the tighter of the two (it then adds no authority).
    if (!covers(mine.expr, within(old))) {
      return out(
        'refuse',
        'other',
        'permits some calls the new rule forbids (or cannot be shown not to), so a shared signer names it and escapes the new limits; tighten or remove it, or install the new rule on other signers'
      )
    }
    // The new rule's predicate is another rule's, which its admins can tighten below this
    // neighbour without the account: a shared signer would then name the neighbour instead.
    if (mine.follows) {
      return out(
        'refuse',
        'follows',
        `is tighter than the new rule now, but the new rule follows rule ${mine.follows.ruleId} of ${mine.follows.account}, whose admins can tighten it below this one without the account, and a shared signer would then name this rule instead; take the shared signer off one of the two rules`
      )
    }
    return out(
      'review',
      'other',
      'is tighter than the new rule on the calls they share; it adds no authority, listed for information'
    )
  })
}
