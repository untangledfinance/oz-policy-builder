// From the calls a transaction made to an Intent: who is pinned, how much is
// capped, what is left open. The registry says what each argument IS; where it
// says nothing, every argument that is not an amount is pinned to what was
// recorded, which is tight rather than loose.

import { Refusal } from './envelope.ts'
import type { CallIntent, Intent, Path, Rule } from './intent.ts'
import { callExpr, intentExprs } from './intent.ts'
import type { Call } from './record.ts'
import { identify, type Kind } from './registry.ts'
import { type Expr, encode, hashOf, type Val, validate } from './wire.ts'

/** What the recording cannot say, supplied by the person who knows. */
export interface Answers {
  /** A cap for every argument that is an amount. */
  limit?: string
  /** Caps by argument name or position (`requests.amount` for a field of a vec of structs). */
  limits?: Record<string, string>
  /** A list of values an argument may take instead of the one recorded. */
  allow?: Record<string, Val[]>
}

export interface Synthesis {
  intent: Intent
  /** Questions whose answers change what the rule permits. */
  ambiguities: { code: 'AMOUNT_BOUND_MISSING'; question: string }[]
  warnings: string[]
}

const isMap = (v: Val): v is { map: [Val, Val][] } =>
  typeof v === 'object' && v !== null && 'map' in v

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
    out.warnings.push(
      `${c.contract}.${c.fn} is not a function the registry knows: every argument that is not an amount is pinned to its recorded value`
    )
  }
  const build = (flat: boolean): CallIntent => {
    const where: Rule[] = []
    c.args.forEach((v, i) => {
      const [name, kind]: [string, Kind] = known?.args[i] ?? [String(i), kindOf(v)]
      const listed = a.allow?.[name] ?? a.allow?.[String(i)]
      const bound = a.limits?.[name] ?? a.limits?.[String(i)] ?? a.limit
      if (listed && kind === 'who') where.push({ rule: 'allow', at: [i], in: listed })
      else if (kind === 'who' || kind === 'exact') where.push({ rule: 'pin', at: [i], to: v })
      else if (kind === 'amount') {
        if (bound === undefined) out.ambiguities.push(missing(c, name))
        else where.push({ rule: 'cap', at: [i], max: bound })
      } else if (kind === 'min') {
        out.warnings.push(
          `${c.fn}: \`${name}\` is left open, so no minimum output is enforced; declare a minOut ratio to bound slippage`
        )
      } else if (kind === 'requests')
        where.push(...requests([i], v as Val[], a, c, name, out, flat))
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

const kindOf = (v: Val): Kind =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && ('i128' in v || 'u128' in v)
    ? 'amount'
    : 'exact'

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
): Rule[] {
  const maps = vec
    .filter(isMap)
    .map((m) => Object.fromEntries(m.map.map(([k, x]) => [String(k), x])))
  const fields = [...new Set(maps.flatMap((m) => Object.keys(m)))]
  const bound = a.limits?.[`${name}.amount`] ?? a.limit
  if (fields.includes('amount') && bound === undefined)
    out.ambiguities.push(missing(c, `${name}.amount`))
  const field = (f: string, seen: Val[], path: Path): Rule[] => {
    if (f === 'amount') return bound === undefined ? [] : [{ rule: 'cap', at: path, max: bound }]
    const one = seen.length === 1
    return [
      one ? { rule: 'pin', at: path, to: seen[0] as Val } : { rule: 'allow', at: path, in: seen },
    ]
  }
  const rules: Rule[] = [{ rule: 'length', at, max: vec.length }]
  if (!flat) {
    const seen = (f: string) => [
      ...new Map(maps.map((m) => [JSON.stringify(m[f]), m[f] as Val])).values(),
    ]
    return [...rules, { rule: 'each', at, where: fields.flatMap((f) => field(f, seen(f), [f])) }]
  }
  const one = maps.flatMap((m, i) => fields.flatMap((f) => field(f, [m[f] as Val], [...at, i, f])))
  return [...rules, ...one]
}

export interface ProposedRule {
  contract: string
  expr: Expr
  encoded: string
  hash: string
}

/** One rule per contract the intent covers, each checked against the contract's
 *  decode refusals so nothing leaves here that install would refuse. */
export function propose(intent: Intent): ProposedRule[] {
  return [...intentExprs(intent)].map(([contract, expr]) => {
    try {
      validate(expr)
    } catch (e) {
      throw new Refusal('MALFORMED_PREDICATE', `${contract}: ${(e as Error).message}`)
    }
    const encoded = encode(expr)
    return { contract, expr, encoded, hash: hashOf(encoded) }
  })
}
