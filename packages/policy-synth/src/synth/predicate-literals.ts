// src/synth/predicate-literals.ts - read scalar values out of predicate literal leaves.
//
// Small shared helpers for interpreting a `PredicateLeaf` literal. Kept out of
// `evaluate.ts` so the evaluator stays focused on the deny-order semantics; the
// deny-case generator uses the same reader so both sides agree on what a numeric
// literal means.

import type { PredicateLeaf } from '../types.ts'

/** BigInt value of a numeric-integer literal leaf (`literal_i128` / `literal_u64`
 *  / `literal_u32`), or null for a non-numeric literal (address / symbol / bytes
 *  / vec). Callers fail closed on null. */
export function literalNumericBigInt(leaf: PredicateLeaf): bigint | null {
  switch (leaf.kind) {
    case 'literal_i128':
    case 'literal_u64':
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
