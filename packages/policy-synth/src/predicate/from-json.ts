// src/predicate/from-json.ts - parse untrusted JSON into a `PredicateNode`.
//
// The counterpart to `encodePredicate`: that turns a typed node into the
// canonical wire bytes, this turns arbitrary parsed JSON into a typed node,
// or throws. Anything accepting a hand-written policy needs both, so both
// belong in this package rather than in whichever app happened to grow the
// paste box first.
//
// Deliberately shape-only. Structural caps (depth, node count, argument
// count) stay in the encoder, which is the gate the contract's decoder
// mirrors; duplicating them here would give two places to drift.

import type { PredicateLeaf, PredicateNode } from '../types.ts'

/** Parse a JSON object back into a `PredicateNode`. Throws on shape
 *  mismatches. The encoder's structural caps are the real gate. */
export function jsonToAst(value: unknown): PredicateNode {
  if (value === null || typeof value !== 'object') throw new Error('predicate must be an object')
  const v = value as {
    op?: unknown
    children?: unknown
    child?: unknown
    left?: unknown
    right?: unknown
    needle?: unknown
    haystack?: unknown
  }
  switch (v.op) {
    case 'and':
    case 'or':
      return { op: v.op, children: arrayOf(v.children, jsonToAst) }
    case 'not':
      return { op: 'not', child: jsonToAst(v.child) }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { op: v.op, left: jsonToLeaf(v.left), right: jsonToLeaf(v.right) }
    case 'in':
      return { op: 'in', needle: jsonToLeaf(v.needle), haystack: arrayOf(v.haystack, jsonToLeaf) }
    default:
      throw new Error(`unknown predicate op: ${String(v.op)}`)
  }
}

function arrayOf<T>(v: unknown, f: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Error('expected array')
  return v.map(f)
}

function jsonToLeaf(value: unknown): PredicateLeaf {
  if (value === null || typeof value !== 'object') throw new Error('leaf must be an object')
  const v = value as { kind?: unknown; [k: string]: unknown }
  switch (v.kind) {
    case 'call_contract':
    case 'call_fn':
    case 'now':
    case 'valid_until':
      return { kind: v.kind }
    case 'call_arg':
      return { kind: 'call_arg', index: numberField(v, 'index') }
    case 'call_arg_len':
      return { kind: 'call_arg_len', index: numberField(v, 'index') }
    // num/den are strings, not numbers: they are i128 on chain, and a JSON
    // number would silently lose precision past 2^53 before the encoder
    // ever saw the value.
    case 'call_arg_scaled':
      return {
        kind: 'call_arg_scaled',
        index: numberField(v, 'index'),
        num: stringField(v, 'num'),
        den: stringField(v, 'den'),
      }
    case 'call_arg_field':
      return {
        kind: 'call_arg_field',
        index: numberField(v, 'index'),
        element: numberField(v, 'element'),
        field: stringField(v, 'field'),
      }
    case 'amount':
      return { kind: 'amount', token: stringField(v, 'token') }
    case 'window_spent':
      return {
        kind: 'window_spent',
        token: stringField(v, 'token'),
        windowSeconds: numberField(v, 'windowSeconds'),
      }
    case 'invocation_count_in_window':
      return { kind: 'invocation_count_in_window', windowSecs: numberField(v, 'windowSecs') }
    case 'literal_address':
      return { kind: 'literal_address', value: stringField(v, 'value') }
    case 'literal_i128':
      return { kind: 'literal_i128', value: stringField(v, 'value') }
    case 'literal_symbol':
      return { kind: 'literal_symbol', value: stringField(v, 'value') }
    case 'literal_u32':
      return { kind: 'literal_u32', value: numberField(v, 'value') }
    case 'literal_u64':
      return { kind: 'literal_u64', value: stringField(v, 'value') }
    case 'literal_bytes':
      return { kind: 'literal_bytes', value: stringField(v, 'value') }
    case 'literal_vec':
      return { kind: 'literal_vec', elements: arrayOf(v.elements, jsonToLeaf) }
    default:
      throw new Error(`unknown leaf kind: ${String(v.kind)}`)
  }
}

function numberField(v: { [k: string]: unknown }, key: string): number {
  const x = v[key]
  if (typeof x !== 'number' || !Number.isInteger(x))
    throw new Error(`field ${key} must be an integer`)
  return x
}

function stringField(v: { [k: string]: unknown }, key: string): string {
  const x = v[key]
  if (typeof x !== 'string') throw new Error(`field ${key} must be a string`)
  return x
}
