// Leaf and operator rendering shared by the review-card builder and the
// summary cross-check. Both turn the SAME predicate into human-readable text -
// the cross-check exists to confirm the builder's summary matches the predicate
// - so rendering a leaf differently in the two would make the check compare a
// string against itself under a different spelling and pass on a real mismatch.

import type { PredicateLeaf } from '../types.ts'

export function renderVecElement(leaf: PredicateLeaf): string {
  switch (leaf.kind) {
    case 'literal_address':
      return leaf.value
    case 'literal_i128':
      return leaf.value
    case 'literal_symbol':
      return leaf.value
    case 'literal_u32':
      return String(leaf.value)
    case 'literal_vec':
      return `[${leaf.elements.map(renderVecElement).join(', ')}]`
    case 'call_contract':
    case 'call_fn':
    case 'call_arg':
    case 'call_arg_len':
    case 'call_arg_field':
    case 'call_arg_scaled':
      return `<${leaf.kind}>`
  }
}

export function renderHaystackElement(leaf: PredicateLeaf): string {
  if (leaf.kind === 'literal_address') return leaf.value
  if (leaf.kind === 'literal_i128') return leaf.value
  if (leaf.kind === 'literal_symbol') return leaf.value
  if (leaf.kind === 'literal_u32') return String(leaf.value)
  if (leaf.kind === 'literal_vec') {
    return `[${leaf.elements.map(renderHaystackElement).join(', ')}]`
  }
  return `<${leaf.kind}>`
}

export function comparisonOpText(op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'): string {
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
