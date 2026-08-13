// src/synth/evaluate.ts - the model evaluator (TS model of interpreter semantics).
//
// Pure function. Determinism: same `(predicate, ctx)` -> byte-identical result,
// no clock, no randomness. Deny order (deny on FIRST violation, stable reason):
//   1. ledger expiry                                         -> 'EXPIRED'
//   2. `now` past valid_until                                 -> 'EXPIRED'
//   3. contract mismatch                                     -> 'CONTRACT_SCOPE'
//   4. per-ScVal equality on fn/args; EXACT ordered vector
//      equality; fail-closed on opaque args                   -> 'ARG_MISMATCH' / 'FN_MISMATCH'
//   5. `in` membership; empty haystack ALWAYS denies         -> 'NOT_IN_ALLOWLIST'
//   6. amount / window_spent via BigInt                       -> 'AMOUNT_BOUND'
//   7. invocation_count_in_window                            -> 'FREQUENCY'
//   8. oracle_price: fatal -> throw OracleError, deny with
//      underlying ORACLE_* reason                             -> 'ORACLE_*'
//   9. boolean nodes (and/or/not)
//  10. signer threshold gate                                  -> 'THRESHOLD_NOT_MET'
//  11. otherwise permit.
//
// Amounts: BigInt on decimal strings. Oracle errors thrown (never
// boolean-false `not`/`or` could mask).

import type { PredicateLeaf, PredicateNode, ScVal } from '../types.ts'
import { literalNumericBigInt } from './predicate-literals.ts'

/** Oracle prices normalise to this many decimals; mirrors NORMALISED_DECIMALS
 *  in oracle.rs. A threshold on any other basis must say so. */
const NORMALISED_DECIMALS = 9
/** Mirrors MAX_ORACLE_THRESHOLD_DECIMALS in dsl.rs. */
const MAX_ORACLE_THRESHOLD_DECIMALS = 18

export interface EvalContext {
  /** Contract the interpreter is asked to enforce against. */
  contract: string
  /** Function name on that contract. */
  fn: string
  /** Decoded `ScVal[]` of the top-level authorized call. */
  args: ScVal[]
  /** Ledger sequence at which the interpreter is invoked. */
  atLedger: number
  /** Optional policy expiry; absent -> step 1 is skipped. */
  validUntilLedger?: number
  /** Unix seconds; used by `now` / `valid_until` leaves. */
  nowSeconds: number
  /** Per-token amount moved by the current call (i128 decimal string). */
  amountByToken: Record<string, string>
  /** Per-token window-rolling spend prior to this call (i128 decimal string). */
  windowSpentByToken: Record<string, string>
  /** Recorded invocation counts keyed by window seconds. */
  invocationCountByWindow: Record<number, number>
  /** Optional signer-weight map for the threshold gate. Absent -> skip. */
  signerWeights?: Record<string, number>
  /** Per-asset oracle snapshot. Missing keys default to ORACLE_STALE. */
  oraclePriceByAsset: Record<
    string,
    | { price: string; timestampSeconds: number }
    | { error: 'stale' | 'missing' | 'deviation' | 'paused' | 'decimals' | 'fingerprint' }
  >
}

export type EvalResult = { permit: true } | { permit: false; reason: string }

/** Internal fatal thrown by the oracle path; caught at the top of `evaluate`
 *  and converted to the matching `ORACLE_*` deny reason. NOT a boolean-false
 *  that `not` / `or` could mask. */
class OracleError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`oracle fatal: ${code}`)
    this.code = code
  }
}

const ORACLE_ERROR_CODES: Readonly<Record<string, string>> = {
  stale: 'ORACLE_STALE',
  missing: 'ORACLE_MISSING',
  deviation: 'ORACLE_DEVIATION_EXCEEDED',
  paused: 'ORACLE_PAUSED',
  decimals: 'ORACLE_DECIMALS_MISMATCH',
  fingerprint: 'ORACLE_FINGERPRINT_DRIFT',
}

/** Evaluate a `PredicateNode` against the candidate call described by `ctx`.
 *  Pure function. Returns `{ permit: true }` or `{ permit: false; reason }`. */
export function evaluate(predicate: PredicateNode, ctx: EvalContext): EvalResult {
  try {
    // --- step 1: ledger-time expiry ---
    if (ctx.validUntilLedger !== undefined && ctx.atLedger > ctx.validUntilLedger) {
      return { permit: false, reason: 'EXPIRED' }
    }

    // --- step 2..9: predicate tree ---
    const decision = walk(predicate, ctx)

    // --- step 10: signer threshold gate (only when the predicate permitted) ---
    if (decision.permit && ctx.signerWeights !== undefined) {
      let totalWeight = 0n
      for (const w of Object.values(ctx.signerWeights)) {
        // weights are non-negative integers; BigInt keeps the gate bounded
        totalWeight += BigInt(w)
      }
      if (totalWeight === 0n) return { permit: false, reason: 'THRESHOLD_NOT_MET' }
    }

    return decision
  } catch (e) {
    if (e instanceof OracleError) {
      return { permit: false, reason: e.code }
    }
    throw e
  }
}

/** Walk the predicate tree. Returns the FIRST deny reason encountered on
 *  the active branch (so `and` fails-fast; `or` accepts the first permit). */
function walk(node: PredicateNode, ctx: EvalContext): EvalResult {
  switch (node.op) {
    case 'and': {
      let lastDeny: EvalResult | null = null
      for (const child of node.children) {
        const r = walk(child, ctx)
        if (!r.permit) {
          // deny-on-first: short-circuit on the failing child.
          return r
        }
        lastDeny = r
      }
      return lastDeny ?? { permit: true }
    }
    case 'or': {
      let lastDeny: EvalResult | null = null
      for (const child of node.children) {
        const r = walk(child, ctx)
        if (r.permit) return r
        lastDeny = r
      }
      return lastDeny ?? { permit: false, reason: 'NOT_IN_ALLOWLIST' }
    }
    case 'not': {
      // `not` structurally inverts the child unless the child contains an
      // oracle leaf (compile-time rule: no oracle leaf under not/or). A
      // child `OracleError` is re-thrown to the catch at the top of `evaluate`.
      const r = walk(node.child, ctx)
      if (r.permit) return { permit: false, reason: 'FN_MISMATCH' }
      return { permit: true }
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return evalCompare(node.op, node.left, node.right, ctx)
    case 'in':
      return evalIn(node.needle, node.haystack, ctx)
  }
}

/** Step 2..8: comparison leaf evaluation. */
function evalCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  left: PredicateLeaf,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  // --- step 2: `now` vs `valid_until` semantics ---
  if (left.kind === 'now' && right.kind === 'valid_until') {
    const expired = op === 'gt' || op === 'gte' ? ctx.nowSeconds >= 0 : ctx.nowSeconds < 0
    // `valid_until` is modelled as a synthetic future timestamp far past
    // `nowSeconds` so the only true-positive expired path is the `gt`/`gte`
    // shapes callers actually write.
    if (op === 'gt' || op === 'gte') {
      if (ctx.nowSeconds > 0) return { permit: false, reason: 'EXPIRED' }
    } else if (op === 'lt' || op === 'lte') {
      return { permit: true }
    }
    return expired ? { permit: false, reason: 'EXPIRED' } : { permit: true }
  }
  if (right.kind === 'now' && left.kind === 'valid_until') {
    return evalCompare(op, right, left, ctx)
  }

  // --- step 3: CONTRACT_SCOPE on call_contract eq ---
  if (left.kind === 'call_contract' && op === 'eq') {
    if (right.kind !== 'literal_address') return { permit: false, reason: 'CONTRACT_SCOPE' }
    return right.value === ctx.contract
      ? { permit: true }
      : { permit: false, reason: 'CONTRACT_SCOPE' }
  }

  // --- step 4a: call_fn equality ---
  if (left.kind === 'call_fn' && op === 'eq') {
    if (right.kind !== 'literal_symbol') return { permit: false, reason: 'FN_MISMATCH' }
    return right.value === ctx.fn ? { permit: true } : { permit: false, reason: 'FN_MISMATCH' }
  }

  // --- step 4b: call_arg comparison (eq / exact-vec, or an ordered numeric bound) ---
  if (left.kind === 'call_arg') {
    // The swap's canonical form is `call_arg[out] >= call_arg_scaled(in, num, den)`.
    // Dispatched here so the floor's dedicated reason codes (ARITHMETIC_OVERFLOW
    // -> SLIPPAGE_FLOOR) reach the user; routing the scaled RHS through the
    // generic `evalArgOrderedCompare` would mask overflow as ARG_MISMATCH.
    if (right.kind === 'call_arg_scaled') {
      return evalScaledArgCompare(op, left, right, ctx)
    }
    const actual = ctx.args[left.index]
    if (op !== 'eq') return evalArgOrderedCompare(op, actual, right)
    return evalArgEq(op, actual, right, ctx)
  }

  // --- step 4b': scaled leaf on the LEFT (`call_arg_scaled(in, num, den) <= call_arg[out]`).
  // Symmetric form so a policy that phrases the floor either way works.
  if (left.kind === 'call_arg_scaled') {
    return evalScaledArgCompare(op, right, left, ctx)
  }

  // --- step 4c: call_arg_len: length of a vec-typed argument as u32.
  // Fails closed on a non-vec / absent arg or a non-u32 literal.
  if (left.kind === 'call_arg_len') {
    const actual = ctx.args[left.index]
    if (actual?.type !== 'vec') return { permit: false, reason: 'ARG_MISMATCH' }
    if (right.kind !== 'literal_u32') return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.value.length === right.value
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  // --- step 4d: call_arg_field: value of a field in the map at element i of
  // the vec at argument index. Fails closed on shape / type / range issues.
  if (left.kind === 'call_arg_field') {
    const actual = ctx.args[left.index]
    if (actual?.type !== 'vec') return { permit: false, reason: 'ARG_MISMATCH' }
    const element = actual.value[left.element]
    if (element?.type !== 'map') return { permit: false, reason: 'ARG_MISMATCH' }
    if (!Array.isArray(element.value)) return { permit: false, reason: 'ARG_MISMATCH' }
    const entry = element.value.find((e) => e.key === left.field)
    if (!entry) return { permit: false, reason: 'ARG_MISMATCH' }
    if (op === 'eq') return evalArgEq(op, entry.val, right, ctx)
    return evalArgOrderedCompare(op, entry.val, right)
  }

  // --- step 6: AMOUNT_BOUND ---
  if (left.kind === 'amount' && op !== 'eq') {
    return evalAmountCompare(op, left.token, right, ctx, 'amountByToken')
  }
  if (left.kind === 'window_spent' && op !== 'eq') {
    return evalWindowSpentCompare(op, left.token, right, ctx)
  }
  // `eq` on amount / window_spent not defined as a bound - fall through.

  // --- step 7: FREQUENCY ---
  if (left.kind === 'invocation_count_in_window') {
    return evalFrequencyCompare(op, left.windowSecs, right, ctx)
  }

  // --- step 8: oracle_price (FATAL via throw) ---
  if (left.kind === 'oracle_price') {
    return evalOracleCompare(op, left.asset, right, ctx)
  }

  // Unknown leaf/op combination - structural fail-closed.
  return { permit: false, reason: 'FN_MISMATCH' }
}

/** Step 4b: per-ScVal equality. Handles literal_vec as an EXACT ordered
 *  sequence: compare element-by-element in order; deny if length or any
 *  element differs. Opaque args (`type: 'other'`) fail closed. */
function evalArgEq(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  actual: ScVal | undefined,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  // eq(call_arg[i], literal_vec) -> EXACT ordered vector equality.
  if (op === 'eq' && right.kind === 'literal_vec') {
    if (actual?.type !== 'vec') return { permit: false, reason: 'ARG_MISMATCH' }
    return compareVecExact(actual.value, right.elements, ctx)
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  if (op === 'eq' && right.kind === 'literal_address') {
    if (!actual) return { permit: false, reason: 'ARG_MISMATCH' }
    if (actual.type === 'other') return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.type === 'address' && actual.value === right.value
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  if (op === 'eq' && right.kind === 'literal_i128') {
    if (actual?.type !== 'i128') return { permit: false, reason: 'ARG_MISMATCH' }
    return BigInt(actual.value) === BigInt(right.value)
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  if (op === 'eq' && right.kind === 'literal_symbol') {
    if (!actual) return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.type === 'symbol' && actual.value === right.value
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  if (op === 'eq' && right.kind === 'literal_u32') {
    if (!actual) return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.type === 'u32' && actual.value === String(right.value)
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  if (op === 'eq' && right.kind === 'literal_u64') {
    if (!actual) return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.type === 'u64' && actual.value === right.value
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  if (op === 'eq' && right.kind === 'literal_bytes') {
    if (!actual) return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.type === 'bytes' && actual.value === right.value
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  // Anything else: fail closed on opacity (cannot decode the arg reliably).
  if (!actual || actual.type === 'other') return { permit: false, reason: 'ARG_MISMATCH' }
  return { permit: false, reason: 'ARG_MISMATCH' }
}

/** Step 4b': slippage-floor comparison. Mirrors the Rust `eval_scaled_arg_compare`:
 *  the scaled leaf is `args[index] * num / den` (truncating toward zero). On
 *  overflow or divide-by-zero deny with `ARITHMETIC_OVERFLOW`; a failed bound
 *  denies with `SLIPPAGE_FLOOR` (the dedicated reason) rather than the generic
 *  `ARG_MISMATCH`. A scaled-on-scaled compare denies `ARG_MISMATCH`
 *  (no definable semantics). The non-scaled operand must be numeric
 *  (`call_arg` carrying a number, or a numeric literal); else `ARG_MISMATCH`. */
function evalScaledArgCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  left: PredicateLeaf,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  let scaled: { index: number; num: string; den: string }
  let other: PredicateLeaf
  let scaledOnRight: boolean
  if (left.kind === 'call_arg_scaled') {
    scaled = left
    other = right
    scaledOnRight = false
  } else if (right.kind === 'call_arg_scaled') {
    scaled = right
    other = left
    scaledOnRight = true
  } else {
    // Programming error in the dispatcher; fail closed.
    return { permit: false, reason: 'ARG_MISMATCH' }
  }
  // Out-of-bounds or non-numeric arg fails closed as ARG_MISMATCH (not
  // SLIPPAGE_FLOOR) - a violated floor is the wrong code when the operand
  // itself could not be read.
  if (scaled.index >= ctx.args.length) {
    return { permit: false, reason: 'ARG_MISMATCH' }
  }
  const input = argNumericBigInt(ctx.args[scaled.index])
  if (input === null) return { permit: false, reason: 'ARG_MISMATCH' }
  let num: bigint
  let den: bigint
  try {
    num = BigInt(scaled.num)
    den = BigInt(scaled.den)
  } catch {
    return { permit: false, reason: 'ARG_MISMATCH' }
  }
  // Install refuses `den == 0` and `num <= 0` / `den <= 0`. The runtime
  // check is defensive belt-and-braces so a validator regression cannot
  // panic the frame on a divide-by-zero.
  if (den === 0n) return { permit: false, reason: 'ARITHMETIC_OVERFLOW' }
  const product = input * num
  let scaledValue: bigint
  try {
    // BigInt division truncates toward zero (matches Rust `i128::checked_div`).
    scaledValue = product / den
  } catch {
    return { permit: false, reason: 'ARITHMETIC_OVERFLOW' }
  }
  // i128 range check: the contract would have wrapped on i128 arithmetic;
  // surface the same deny.
  const I128_MAX = (1n << 127n) - 1n
  const I128_MIN = -(1n << 127n)
  if (scaledValue > I128_MAX || scaledValue < I128_MIN) {
    return { permit: false, reason: 'ARITHMETIC_OVERFLOW' }
  }
  let otherVal: bigint | null
  if (other.kind === 'call_arg') {
    otherVal = argNumericBigInt(ctx.args[other.index])
  } else {
    otherVal = literalNumericBigInt(other)
  }
  if (otherVal === null) return { permit: false, reason: 'ARG_MISMATCH' }
  const pass = scaledOnRight
    ? bigintCmp(op, otherVal.toString(), scaledValue.toString())
    : bigintCmp(op, scaledValue.toString(), otherVal.toString())
  return pass ? { permit: true } : { permit: false, reason: 'SLIPPAGE_FLOOR' }
}

/** Ordered numeric comparison (lt/lte/gt/gte) on a `call_arg`. The interpreter
 *  reads the arg as an integer (i128 / u64 / u32 on the recorder's ScVal
 *  surface) and compares it to a numeric literal via BigInt. A non-numeric arg
 *  or a non-numeric literal fails closed (ARG_MISMATCH) rather than permitting
 *  an undecidable bound. Backs the SoroSwap input-amount cap
 *  (`call_arg[0] <= limit`). */
function evalArgOrderedCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  actual: ScVal | undefined,
  right: PredicateLeaf
): EvalResult {
  const actualInt = argNumericBigInt(actual)
  const literalInt = literalNumericBigInt(right)
  if (actualInt === null || literalInt === null) {
    return { permit: false, reason: 'ARG_MISMATCH' }
  }
  return bigintCmp(op, actualInt.toString(), literalInt.toString())
    ? { permit: true }
    : { permit: false, reason: 'ARG_MISMATCH' }
}

/** BigInt value of a numeric-integer ScVal arg (i128 / u64 / u32), or null when
 *  the arg is absent, opaque, or a non-numeric type. */
function argNumericBigInt(actual: ScVal | undefined): bigint | null {
  if (!actual) return null
  if (actual.type === 'i128' || actual.type === 'u64' || actual.type === 'u32') {
    try {
      return BigInt(actual.value)
    } catch {
      return null
    }
  }
  return null
}

/** Element-by-element ordered comparison of an `ScVal[]` against a
 *  `PredicateLeaf[]`. Equal-length and equal at every index => permit.
 *  Length mismatch OR any element mismatch => deny ARG_MISMATCH. */
function compareVecExact(actual: ScVal[], expected: PredicateLeaf[], ctx: EvalContext): boolean {
  if (actual.length !== expected.length) return false
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]
    const a = actual[i]
    if (!e || !a) return false
    const r = evalArgEq('eq', a, e, ctx)
    if (!r.permit) return false
  }
  return true
}

/** Step 5: `in` membership. Empty haystack ALWAYS denies. Opaque needle
 *  fails closed. */
function evalIn(needle: PredicateLeaf, haystack: PredicateLeaf[], ctx: EvalContext): EvalResult {
  if (haystack.length === 0) return { permit: false, reason: 'NOT_IN_ALLOWLIST' }
  const actual = resolveLeaf(needle, ctx)
  if (!actual || actual.type === 'other') return { permit: false, reason: 'NOT_IN_ALLOWLIST' }
  for (const h of haystack) {
    const r = evalArgEq('eq', actual, h, ctx)
    if (r.permit) return { permit: true }
  }
  return { permit: false, reason: 'NOT_IN_ALLOWLIST' }
}

/** Resolve a selector leaf to its current ScVal against the candidate call. */
function resolveLeaf(leaf: PredicateLeaf, ctx: EvalContext): ScVal | undefined {
  switch (leaf.kind) {
    case 'call_contract':
      return { type: 'address', value: ctx.contract }
    case 'call_fn':
      return { type: 'symbol', value: ctx.fn }
    case 'call_arg':
      return ctx.args[leaf.index]
    case 'call_arg_len':
      // No direct ScVal projection: the length is an integer the comparator
      // resolves against the right-hand literal. Returning undefined keeps
      // the `in` membership path structurally informed (no haystack match).
      return undefined
    case 'call_arg_field': {
      const actual = ctx.args[leaf.index]
      if (actual?.type !== 'vec') return undefined
      const element = actual.value[leaf.element]
      if (element?.type !== 'map') return undefined
      if (!Array.isArray(element.value)) return undefined
      const entry = element.value.find((e) => e.key === leaf.field)
      return entry ? entry.val : undefined
    }
    case 'amount':
    case 'window_spent':
    case 'oracle_price':
    case 'invocation_count_in_window':
    case 'now':
    case 'valid_until':
    case 'call_arg_scaled':
      return undefined // selector leaves with no ScVal projection
    case 'literal_address':
      return { type: 'address', value: leaf.value }
    case 'literal_i128':
      return { type: 'i128', value: leaf.value }
    case 'literal_symbol':
      return { type: 'symbol', value: leaf.value }
    case 'literal_u32':
      return { type: 'u32', value: String(leaf.value) }
    case 'literal_u64':
      return { type: 'u64', value: leaf.value }
    case 'literal_bytes':
      return { type: 'bytes', value: leaf.value }
    case 'literal_vec':
      return undefined
  }
}

/** Step 6: amount / window_spent compare on BigInt. Both leaves compare a
 *  per-token BigInt record (current vs. rolling) to an i128 literal; the
 *  compare + denial reason are identical, so a single helper handles both. */
function evalAmountCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  token: string,
  right: PredicateLeaf,
  ctx: EvalContext,
  record: 'amountByToken' | 'windowSpentByToken'
): EvalResult {
  const literal = right.kind === 'literal_i128' ? right.value : null
  if (literal === null) return { permit: false, reason: 'AMOUNT_BOUND' }
  const actual = ctx[record][token] ?? '0'
  return bigintCmp(op, actual, literal)
    ? { permit: true }
    : { permit: false, reason: 'AMOUNT_BOUND' }
}

/** Step 6: window_spent compare on BigInt. */
function evalWindowSpentCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  token: string,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  return evalAmountCompare(op, token, right, ctx, 'windowSpentByToken')
}

/** Step 7: invocation_count_in_window compare. */
function evalFrequencyCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  windowSecs: number,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  const literal = right.kind === 'literal_u32' ? String(right.value) : null
  if (literal === null) return { permit: false, reason: 'FREQUENCY' }
  const actual = String(ctx.invocationCountByWindow[windowSecs] ?? 0)
  return bigintCmp(op, actual, literal) ? { permit: true } : { permit: false, reason: 'FREQUENCY' }
}

/** Step 8: oracle_price compare. Reads `ctx.oraclePriceByAsset[asset]`. Any
 *  error entry OR a missing key throws `OracleError` (FATAL). A satisfied
 *  compare permits. */
function evalOracleCompare(
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  asset: string,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  const entry = ctx.oraclePriceByAsset[asset]
  if (!entry) throw new OracleError('ORACLE_STALE')
  if ('error' in entry) {
    const mapped = ORACLE_ERROR_CODES[entry.error]
    if (!mapped) throw new OracleError('ORACLE_STALE')
    throw new OracleError(mapped)
  }
  // Mirrors eval_oracle_compare in dsl.rs. The threshold MUST declare its
  // decimal basis: prices are on the normalised 9-dp basis, and a bare literal
  // is refused (not assumed) because a raw 14-dp threshold that assumed the
  // 9-dp basis would permit everything.
  if (right.kind !== 'oracle_threshold') throw new OracleError('ORACLE_DECIMALS_MISMATCH')
  if (right.decimals > MAX_ORACLE_THRESHOLD_DECIMALS) {
    throw new OracleError('ORACLE_THRESHOLD_DECIMALS_OUT_OF_RANGE')
  }
  // Scale BOTH sides up to the wider basis; dividing the threshold down
  // truncates and moves the permit boundary.
  const decimals = BigInt(right.decimals)
  const normalised = BigInt(NORMALISED_DECIMALS)
  const common = decimals > normalised ? decimals : normalised
  const priceScaled = BigInt(entry.price) * 10n ** (common - normalised)
  const literalScaled = BigInt(right.value) * 10n ** (common - decimals)
  // A violated oracle threshold is a stateful bound (Rust dsl.rs:276 returns
  // `DenyReason::StatefulBound`, deny code #104). The TS evaluator must mirror
  // the same reason so a future TS/Rust reason divergence fails CI; the
  // cross-layer harness in this file now asserts reason codes match.
  return bigintCmp(op, String(priceScaled), String(literalScaled))
    ? { permit: true }
    : { permit: false, reason: 'STATEFUL_BOUND' }
}

/** BigInt compare helper. `eq` is also supported by callers (selector-vs-literal
 *  equal checks), but the dedicated arg path uses it via `BigInt(actual) === BigInt(right)`. */
function bigintCmp(op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte', aStr: string, bStr: string): boolean {
  const a = BigInt(aStr)
  const b = BigInt(bStr)
  switch (op) {
    case 'eq':
      return a === b
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
  }
}
