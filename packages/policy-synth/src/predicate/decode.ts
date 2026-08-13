// src/predicate/decode.ts - the inverse of `encode.ts`.
//
// Turns the canonical wire encoding back into a `PredicateNode`, so a policy
// already installed on chain can be read and explained. The interpreter has no
// getter for the document, but its persistent storage IS readable over RPC, so
// the bytes are available to any caller that can reconstruct the storage key -
// this module takes it from there.
//
// Mirrors `decode_leaf` / `decode_node` in
// `contracts/policy-interpreter/src/dsl.rs`. Two rules carry most of the
// weight, and both come from the Rust decoder verbatim:
//
//   1. A `Vec` whose FIRST element is a Symbol is a selector tuple. A `Vec`
//      whose first element is anything else is a `literal_vec`, decoded
//      element-wise with order preserved (the order IS the semantic for exact
//      sequence equality).
//   2. An unknown symbol at a selector position is MALFORMED, never a
//      literal_vec fallback. Guessing there would let an unsupported selector
//      decode as data and read as permitted.
//
// The round-trip `decode(encode(node)) === node` is pinned in decode.test.ts
// for every leaf and node shape; that test is what keeps this file honest as
// the grammar grows.

import { Address, scValToBigInt, xdr } from '@stellar/stellar-sdk'
import type { ToolError } from '../errors.ts'
import type { PredicateLeaf, PredicateNode } from '../types.ts'

/** Same shape the encoder raises, so both directions surface one error type.
 *  Returns `never` - it always throws; callers `throw malformed(...)` purely
 *  so the control flow reads at the call site. */
function malformed(detail: string): never {
  const err = new Error(`cannot decode predicate: ${detail}`) as Error & {
    code: ToolError['code']
    severity: string
    retryable: boolean
  }
  err.code = 'MALFORMED_PREDICATE'
  err.severity = 'error'
  err.retryable = false
  throw err
}

/** The symbol at a leaf's selector position, or null when the value is not a
 *  symbol-headed vec (i.e. it is a literal or a literal vector). */
function selectorSymbol(items: xdr.ScVal[]): string | null {
  const head = items[0]
  if (!head) return null
  return head.switch() === xdr.ScValType.scvSymbol() ? head.sym().toString() : null
}

function expectVec(v: xdr.ScVal, what: string): xdr.ScVal[] {
  if (v.switch() !== xdr.ScValType.scvVec()) throw malformed(`${what} is not a vec`)
  return v.vec() ?? []
}

function expectU32(v: xdr.ScVal | undefined, what: string): number {
  if (!v || v.switch() !== xdr.ScValType.scvU32()) throw malformed(`${what} is not a u32`)
  return v.u32()
}

function expectSymbol(v: xdr.ScVal | undefined, what: string): string {
  if (!v || v.switch() !== xdr.ScValType.scvSymbol()) throw malformed(`${what} is not a symbol`)
  return v.sym().toString()
}

function expectAddress(v: xdr.ScVal | undefined, what: string): string {
  if (!v || v.switch() !== xdr.ScValType.scvAddress()) throw malformed(`${what} is not an address`)
  return Address.fromScAddress(v.address()).toString()
}

function expectU64(v: xdr.ScVal | undefined, what: string): string {
  if (!v || v.switch() !== xdr.ScValType.scvU64()) throw malformed(`${what} is not a u64`)
  return v.u64().toString()
}

function expectI128(v: xdr.ScVal | undefined, what: string): string {
  if (!v || v.switch() !== xdr.ScValType.scvI128()) throw malformed(`${what} is not an i128`)
  return scValToBigInt(v).toString()
}

/** Arity check with the same intent as the Rust `check_arity`: a selector with
 *  the wrong element count is malformed, not silently truncated. */
function arity(items: xdr.ScVal[], n: number, selector: string): void {
  if (items.length !== n) {
    throw malformed(`${selector} expects ${n} elements, got ${items.length}`)
  }
}

function decodeSelectorLeaf(items: xdr.ScVal[], sym: string): PredicateLeaf {
  switch (sym) {
    case 'call_contract':
      arity(items, 1, sym)
      return { kind: 'call_contract' }
    case 'call_fn':
      arity(items, 1, sym)
      return { kind: 'call_fn' }
    case 'call_arg':
      arity(items, 2, sym)
      return { kind: 'call_arg', index: expectU32(items[1], 'call_arg index') }
    case 'call_arg_len':
      arity(items, 2, sym)
      return { kind: 'call_arg_len', index: expectU32(items[1], 'call_arg_len index') }
    case 'call_arg_field':
      arity(items, 4, sym)
      return {
        kind: 'call_arg_field',
        index: expectU32(items[1], 'call_arg_field index'),
        element: expectU32(items[2], 'call_arg_field element'),
        field: expectSymbol(items[3], 'call_arg_field field'),
      }
    case 'call_arg_scaled':
      arity(items, 4, sym)
      return {
        kind: 'call_arg_scaled',
        index: expectU32(items[1], 'call_arg_scaled index'),
        num: expectI128(items[2], 'call_arg_scaled num'),
        den: expectI128(items[3], 'call_arg_scaled den'),
      }
    case 'amount':
      arity(items, 2, sym)
      return { kind: 'amount', token: expectAddress(items[1], 'amount token') }
    case 'window_spent':
      arity(items, 3, sym)
      return {
        kind: 'window_spent',
        token: expectAddress(items[1], 'window_spent token'),
        windowSeconds: Number(expectU64(items[2], 'window_spent windowSeconds')),
      }
    case 'now':
      arity(items, 1, sym)
      return { kind: 'now' }
    case 'valid_until':
      // The encoder refuses to emit this and the interpreter refuses it at
      // install, so it cannot appear in a document that installed. Decoding it
      // anyway would present a rule the chain would never have accepted.
      throw malformed('valid_until is not a usable predicate leaf')
    case 'invocation_count':
      arity(items, 2, sym)
      return {
        kind: 'invocation_count_in_window',
        windowSecs: Number(expectU64(items[1], 'invocation_count windowSecs')),
      }
    case 'oracle_price':
      arity(items, 2, sym)
      return { kind: 'oracle_price', asset: expectAddress(items[1], 'oracle_price asset') }
    case 'oracle_threshold':
      arity(items, 3, sym)
      return {
        kind: 'oracle_threshold',
        value: expectI128(items[1], 'oracle_threshold value'),
        decimals: expectU32(items[2], 'oracle_threshold decimals'),
      }
    default:
      // Deliberately NOT a literal_vec fallback - see the header note.
      throw malformed(`unknown selector symbol '${sym}'`)
  }
}

/** One leaf. Order of the bare-literal checks mirrors `decode_leaf` in dsl.rs. */
export function decodeLeaf(v: xdr.ScVal): PredicateLeaf {
  if (v.switch() === xdr.ScValType.scvVec()) {
    const items = v.vec() ?? []
    if (items.length === 0) throw malformed('empty vec is neither a selector nor a literal vector')
    const sym = selectorSymbol(items)
    if (sym !== null) return decodeSelectorLeaf(items, sym)
    return { kind: 'literal_vec', elements: items.map(decodeLeaf) }
  }
  switch (v.switch()) {
    case xdr.ScValType.scvAddress():
      return { kind: 'literal_address', value: Address.fromScAddress(v.address()).toString() }
    case xdr.ScValType.scvSymbol():
      return { kind: 'literal_symbol', value: v.sym().toString() }
    case xdr.ScValType.scvU32():
      return { kind: 'literal_u32', value: v.u32() }
    case xdr.ScValType.scvU64():
      return { kind: 'literal_u64', value: v.u64().toString() }
    case xdr.ScValType.scvI128():
      return { kind: 'literal_i128', value: scValToBigInt(v).toString() }
    case xdr.ScValType.scvBytes():
      return { kind: 'literal_bytes', value: Buffer.from(v.bytes()).toString('hex') }
    default:
      throw malformed(`unsupported leaf value type ${v.switch().name}`)
  }
}

/** One node. `not` wraps a NODE; the comparison ops wrap two LEAVES. */
export function decodeNode(v: xdr.ScVal): PredicateNode {
  const items = expectVec(v, 'node')
  const op = selectorSymbol(items)
  if (op === null) throw malformed('node does not start with an operator symbol')
  switch (op) {
    case 'and':
    case 'or': {
      arity(items, 2, op)
      const children = expectVec(items[1] as xdr.ScVal, `${op} children`).map(decodeNode)
      if (children.length === 0) throw malformed(`${op} has no children`)
      return { op, children }
    }
    case 'not':
      arity(items, 2, op)
      return { op: 'not', child: decodeNode(items[1] as xdr.ScVal) }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      arity(items, 3, op)
      return {
        op,
        left: decodeLeaf(items[1] as xdr.ScVal),
        right: decodeLeaf(items[2] as xdr.ScVal),
      }
    case 'in': {
      arity(items, 3, op)
      return {
        op: 'in',
        needle: decodeLeaf(items[1] as xdr.ScVal),
        haystack: expectVec(items[2] as xdr.ScVal, 'in haystack').map(decodeLeaf),
      }
    }
    default:
      throw malformed(`unknown node operator '${op}'`)
  }
}

/** Decode a predicate from the wire bytes the interpreter stores.
 *
 *  Accepts the base64 the encoder emits (`encodePredicate().encodedPredicate`)
 *  or the raw XDR bytes read straight out of `StoredDoc.predicate_bytes`. */
export function decodePredicate(encoded: string | Uint8Array): PredicateNode {
  let scv: xdr.ScVal
  try {
    scv =
      typeof encoded === 'string'
        ? xdr.ScVal.fromXDR(Buffer.from(encoded, 'base64'))
        : xdr.ScVal.fromXDR(Buffer.from(encoded))
  } catch (e) {
    throw malformed(`not valid ScVal XDR (${e instanceof Error ? e.message : String(e)})`)
  }
  return decodeNode(scv)
}
