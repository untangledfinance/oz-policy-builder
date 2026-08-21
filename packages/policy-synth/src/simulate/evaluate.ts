// src/simulate/evaluate.ts - TypeScript reference evaluator for grammar version 3.
//
// Pure function. Determinism: same `(predicate, ctx)` -> byte-identical result,
// no clock, no randomness. Deny order (deny on FIRST violation, stable reason):
//   1. contract mismatch                                     -> 'CONTRACT_SCOPE'
//   2. per-ScVal equality on fn/args; EXACT ordered vector
//      equality; fail-closed on opaque args                   -> 'ARG_MISMATCH'
//   3. `in` membership; empty haystack ALWAYS denies         -> 'NOT_IN_ALLOWLIST'
//   4. otherwise permit.
//
// Grammar version 3 nodes: and, eq, lte
// Grammar version 3 leaves: call_contract, call_fn, call_arg(i),
//   call_arg_len(i), call_arg_field(i, element, field),
//   literal_address, literal_i128, literal_symbol, literal_u32, literal_vec
// Grammar version 3 deny reasons: ARG_MISMATCH, CONTRACT_SCOPE,
//   UNSUPPORTED_NODE, NOT_IN_ALLOWLIST

import type { PredicateLeaf, PredicateNode, ScVal } from '../types.ts'

export interface EvalContext {
  /** Contract the interpreter is asked to enforce against. */
  contract: string
  /** Function name on that contract. */
  fn: string
  /** Decoded `ScVal[]` of the top-level authorized call. */
  args: ScVal[]
}

export type EvalResult = { permit: true } | { permit: false; reason: string }

/** Evaluate a `PredicateNode` against the candidate call described by `ctx`.
 *  Pure function. Returns `{ permit: true }` or `{ permit: false; reason }`. */
export function evaluate(predicate: PredicateNode, ctx: EvalContext): EvalResult {
  return walk(predicate, ctx)
}

/** Walk the predicate tree. Returns the FIRST deny reason encountered on
 *  the active branch (so `and` fails-fast). */
function walk(node: PredicateNode, ctx: EvalContext): EvalResult {
  switch (node.op) {
    case 'and': {
      let lastDeny: EvalResult | null = null
      for (const child of node.children) {
        const r = walk(child, ctx)
        if (!r.permit) return r
        lastDeny = r
      }
      return lastDeny ?? { permit: true }
    }
    case 'eq':
    case 'lte':
      return evalCompare(node.op, node.left, node.right, ctx)
    case 'in':
      return evalIn(node.needle, node.haystack, ctx)
  }
}

/** Comparison leaf evaluation. */
function evalCompare(
  op: 'eq' | 'lte',
  left: PredicateLeaf,
  right: PredicateLeaf,
  ctx: EvalContext
): EvalResult {
  // CONTRACT_SCOPE on call_contract eq
  if (left.kind === 'call_contract' && op === 'eq') {
    if (right.kind !== 'literal_address') return { permit: false, reason: 'CONTRACT_SCOPE' }
    return right.value === ctx.contract
      ? { permit: true }
      : { permit: false, reason: 'CONTRACT_SCOPE' }
  }

  // call_fn equality
  if (left.kind === 'call_fn' && op === 'eq') {
    if (right.kind !== 'literal_symbol') return { permit: false, reason: 'ARG_MISMATCH' }
    return right.value === ctx.fn ? { permit: true } : { permit: false, reason: 'ARG_MISMATCH' }
  }

  // call_arg comparison (eq / exact-vec, or lte ordered numeric bound)
  if (left.kind === 'call_arg') {
    const actual = ctx.args[left.index]
    if (op !== 'eq') return evalArgOrderedCompare(op, actual, right)
    return evalArgEq(op, actual, right, ctx)
  }

  // call_arg_len: length of a vec-typed argument as u32.
  // Fails closed on a non-vec / absent arg or a non-u32 literal.
  if (left.kind === 'call_arg_len') {
    const actual = ctx.args[left.index]
    if (actual?.type !== 'vec') return { permit: false, reason: 'ARG_MISMATCH' }
    if (right.kind !== 'literal_u32') return { permit: false, reason: 'ARG_MISMATCH' }
    return actual.value.length === right.value
      ? { permit: true }
      : { permit: false, reason: 'ARG_MISMATCH' }
  }

  // call_arg_field: value of a field in the map at element i of
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

  // Unknown leaf/op combination - structural fail-closed.
  return { permit: false, reason: 'UNSUPPORTED_NODE' }
}

/** Per-ScVal equality. Handles literal_vec as an EXACT ordered sequence:
 *  compare element-by-element in order; deny if length or any element differs.
 *  Opaque args (`type: 'other'`) fail closed. */
function evalArgEq(
  op: 'eq' | 'lte',
  actual: ScVal | undefined,
  right: PredicateLeaf,
  _ctx: EvalContext
): EvalResult {
  // eq(call_arg[i], literal_vec) -> EXACT ordered vector equality.
  if (op === 'eq' && right.kind === 'literal_vec') {
    if (actual?.type !== 'vec') return { permit: false, reason: 'ARG_MISMATCH' }
    return compareVecExact(actual.value, right.elements)
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

  // Anything else: fail closed on opacity (cannot decode the arg reliably).
  if (!actual || actual.type === 'other') return { permit: false, reason: 'ARG_MISMATCH' }
  return { permit: false, reason: 'ARG_MISMATCH' }
}

/** Ordered numeric comparison (lte) on a `call_arg`. The interpreter reads the
 *  arg as an integer (i128 on the recorder's ScVal surface) and compares it
 *  to a numeric literal via BigInt. A non-numeric arg or a non-numeric literal
 *  fails closed (ARG_MISMATCH) rather than permitting an undecidable bound. */
function evalArgOrderedCompare(
  op: 'eq' | 'lte',
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

/** BigInt value of a numeric-integer ScVal arg (i128 / u32), or null when
 *  the arg is absent, opaque, or a non-numeric type. */
function argNumericBigInt(actual: ScVal | undefined): bigint | null {
  if (!actual) return null
  if (actual.type === 'i128' || actual.type === 'u32') {
    try {
      return BigInt(actual.value)
    } catch {
      return null
    }
  }
  return null
}

/** BigInt value of a numeric-integer literal leaf (`literal_i128` / `literal_u32`),
 *  or null for a non-numeric literal. Callers fail closed on null. */
function literalNumericBigInt(leaf: PredicateLeaf): bigint | null {
  switch (leaf.kind) {
    case 'literal_i128':
      try {
        return BigInt(leaf.value)
      } catch {
        return null
      }
    case 'literal_u32':
      return BigInt(leaf.value)
    default:
      return null
  }
}

/** Element-by-element ordered comparison of an `ScVal[]` against a
 *  `PredicateLeaf[]`. Equal-length and equal at every index => permit.
 *  Length mismatch OR any element mismatch => deny ARG_MISMATCH. */
function compareVecExact(actual: ScVal[], expected: PredicateLeaf[]): boolean {
  if (actual.length !== expected.length) return false
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]
    const a = actual[i]
    if (!e || !a) return false
    const r = evalArgEq('eq', a, e, {} as EvalContext)
    if (!r.permit) return false
  }
  return true
}

/** `in` membership. Empty haystack ALWAYS denies. Opaque needle fails closed. */
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
    case 'literal_address':
      return { type: 'address', value: leaf.value }
    case 'literal_i128':
      return { type: 'i128', value: leaf.value }
    case 'literal_symbol':
      return { type: 'symbol', value: leaf.value }
    case 'literal_u32':
      return { type: 'u32', value: String(leaf.value) }
    case 'literal_vec':
      return undefined
  }
}

/** BigInt compare helper. */
function bigintCmp(op: 'eq' | 'lte', aStr: string, bStr: string): boolean {
  const a = BigInt(aStr)
  const b = BigInt(bStr)
  switch (op) {
    case 'eq':
      return a === b
    case 'lte':
      return a <= b
  }
}
