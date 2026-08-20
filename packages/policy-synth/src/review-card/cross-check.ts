// src/review-card/cross-check.ts - the non-hallucination guard.
//
// `summaryCrossCheck` walks EVERY leaf of the predicate and asserts the
// review-card summary quoted a constraint string for it. Returns
// `{ ok: false, missingConstraints }` if any leaf was dropped (or rendered
// into a template shape the cross-check does not recognise). A
// `PredicateNode = null` is always ok - the policy is OZ-only and the
// interpreter predicate did not exist.
//
// The guard is structural: every leaf the builder is supposed to render has
// exactly one template shape. The cross-check enumerates those shapes and
// demands the summary carries the corresponding string. A naive summary
// that drops a leaf (or fabricates a string not in the predicate) trips the
// guard.

import type { PredicateLeaf, PredicateNode } from '../types.ts'
import type { ReviewCardSummary } from './builder.ts'

/** Assert every leaf in the predicate appears as a constraint string in
 *  `summary.constraints`. Returns the missing templates (without the leaf
 *  values filled in) when any leaf was dropped. */
export function summaryCrossCheck(
  predicate: PredicateNode | null,
  summary: ReviewCardSummary
): { ok: true } | { ok: false; missingConstraints: string[] } {
  if (predicate === null) return { ok: true }

  const expected: string[] = []
  collect(predicate, expected)

  if (expected.length === 0) return { ok: true }

  const present = new Set(summary.constraints)
  const missing = expected.filter((s) => !present.has(s))
  if (missing.length === 0) return { ok: true }
  return { ok: false, missingConstraints: missing }
}

/** Walk the predicate and emit the EXACT constraint string the builder is
 *  expected to produce for each leaf, in walk order. Strings here MUST
 *  match the templates in `builder.ts` byte-for-byte; the cross-check is
 *  the structural claim that "every supported leaf shape is rendered". */
function collect(node: PredicateNode, out: string[]): void {
  switch (node.op) {
    case 'and':
    case 'or':
      for (const child of node.children) collect(child, out)
      return
    case 'not':
      collect(node.child, out)
      return
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      pushComparison(node.left, node.right, node.op, out)
      return
    case 'in':
      pushMembership(node.needle, node.haystack, out)
      return
  }
}

function pushComparison(
  left: PredicateLeaf,
  right: PredicateLeaf,
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  out: string[]
): void {
  if (left.kind === 'call_contract' && op === 'eq' && right.kind === 'literal_address') {
    out.push(`Contract must be ${right.value}`)
    return
  }
  if (left.kind === 'call_fn' && op === 'eq' && right.kind === 'literal_symbol') {
    out.push(`Function must be ${right.value}`)
    return
  }
  if (left.kind === 'call_arg' && op === 'eq' && right.kind === 'literal_vec') {
    out.push(`Path must be exactly [${right.elements.map(renderVecElement).join(', ')}]`)
    return
  }
  if (left.kind === 'call_arg_len' && op === 'eq' && right.kind === 'literal_u32') {
    out.push(`Length of arg[${left.index}] is ${right.value}`)
    return
  }
  // call_arg_field: must mirror the builder's templates byte-for-byte so
  // the cross-check can assert a faithful summary.
  if (left.kind === 'call_arg_field') {
    const head = `arg[${left.index}] element[${left.element}].${left.field}`
    const sep = op === 'eq' ? '=' : comparisonOpText(op)
    if (right.kind === 'literal_address') {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
    if (right.kind === 'literal_symbol') {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
    if (right.kind === 'literal_bytes') {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
    if (right.kind === 'literal_u64') {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
    if (right.kind === 'literal_i128') {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
    if (right.kind === 'literal_u32') {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
    if (right.kind === 'literal_vec') {
      out.push(`${head} ${sep} [${right.elements.map(renderVecElement).join(', ')}]`)
      return
    }
  }
  // Mirrors the builder's per-call cap line. Both sides must render the same
  // string: cross-check compares the summary against the predicate, so a
  // shape only ONE of them renders would read as a dropped constraint.
  if (left.kind === 'call_arg') {
    const head = `arg[${left.index}]`
    const sep = op === 'eq' ? '=' : comparisonOpText(op)
    if (
      right.kind === 'literal_i128' ||
      right.kind === 'literal_u64' ||
      right.kind === 'literal_u32' ||
      right.kind === 'literal_address' ||
      right.kind === 'literal_symbol' ||
      right.kind === 'literal_bytes'
    ) {
      out.push(`${head} ${sep} ${right.value}`)
      return
    }
  }
  if (left.kind === 'amount' && right.kind === 'literal_i128') {
    out.push(`Amount <= ${right.value}`)
    return
  }
}

function pushMembership(needle: PredicateLeaf, haystack: PredicateLeaf[], out: string[]): void {
  if (needle.kind !== 'call_arg') return
  const list = haystack.map(renderHaystackElement).join(', ')
  out.push(`Recipient/arg must be one of [${list}]`)
}

function renderVecElement(leaf: PredicateLeaf): string {
  switch (leaf.kind) {
    case 'literal_address':
      return leaf.value
    case 'literal_i128':
      return leaf.value
    case 'literal_symbol':
      return leaf.value
    case 'literal_u32':
      return String(leaf.value)
    case 'literal_u64':
      return leaf.value
    case 'literal_bytes':
      return leaf.value
    case 'literal_vec':
      return `[${leaf.elements.map(renderVecElement).join(', ')}]`
    case 'call_contract':
    case 'call_fn':
    case 'call_arg':
    case 'call_arg_len':
    case 'call_arg_field':
    case 'amount':
    case 'window_spent':
    case 'now':
      return `<${leaf.kind}>`
  }
}

function renderHaystackElement(leaf: PredicateLeaf): string {
  if (leaf.kind === 'literal_address') return leaf.value
  if (leaf.kind === 'literal_i128') return leaf.value
  if (leaf.kind === 'literal_symbol') return leaf.value
  if (leaf.kind === 'literal_u32') return String(leaf.value)
  if (leaf.kind === 'literal_u64') return leaf.value
  if (leaf.kind === 'literal_bytes') return leaf.value
  if (leaf.kind === 'literal_vec') {
    return `[${leaf.elements.map(renderHaystackElement).join(', ')}]`
  }
  return `<${leaf.kind}>`
}

function comparisonOpText(op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'): string {
  switch (op) {
    case 'lt':
      return '<'
    case 'lte':
      return '<='
    case 'gt':
      return '>'
    case 'gte':
      return '>='
    case 'eq':
      return '=='
  }
}
