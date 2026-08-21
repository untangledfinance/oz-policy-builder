// src/predicate/encode.ts - canonical predicate encoder.
//
// Pure function. Maps a `PredicateNode` AST to the canonical ScVal wire format:
//   - every node is a `ScVal::Vec` whose head element is the tag `ScVal::Symbol`
//   - children of `and` are sorted ascending by their canonical XDR bytes
//   - `in` haystacks are ALWAYS sorted by canonical XDR bytes (pure set
//     membership); an EXACT ordered sequence is expressed as
//     `eq(selector, literal_vec)` where the `literal_vec` element order is
//     preserved verbatim (the order IS the semantic)
//   - `literal_vec` encodes to a bare `ScVal::Vec` of its element encodings
//   - i128 uses `Int128Parts{hi: Int64 (signed), lo: Uint64 (unsigned)}`,
//     value = hi*2^64 + lo (NOT signed-magnitude)
//   - no `ScMap` anywhere in the predicate
//   - `encodedPredicate = base64(root.toXDR())`,
//     `predicateHash = sha256(raw XDR bytes)` as hex
//
// Caps from `PREDICATE_CAPS` are enforced BEFORE returning; a cap breach throws
// a `ToolError` with the matching error code and `severity: 'error'`.
//

import { createHash } from 'node:crypto'
import { Address, xdr } from '@stellar/stellar-sdk'
import type { ToolError } from '../errors.ts'
import { PREDICATE_CAPS, type PredicateLeaf, type PredicateNode } from '../types.ts'

export interface EncodedPredicate {
  /** base64 of the canonical ScVal XDR of the predicate root. */
  encodedPredicate: string
  /** sha256 hex digest of the raw XDR bytes (post-canonicalisation). */
  predicateHash: string
}

const INT64_MAX = (1n << 63n) - 1n
const INT64_MIN = -(1n << 63n)
const UINT64_MAX = (1n << 64n) - 1n

/** Encode a `PredicateNode` to the canonical ScVal wire format and hash it.
 *  Pure function: same input -> byte-identical output every run. */
export function encodePredicate(node: PredicateNode): EncodedPredicate {
  // --- pass 1: structural cap checks (no encoding needed) ---
  const stats = computeStats(node)
  if (stats.depth > PREDICATE_CAPS.MAX_DEPTH) {
    throw capError(
      'PREDICATE_TOO_DEEP',
      `predicate depth ${stats.depth} exceeds MAX_DEPTH ${PREDICATE_CAPS.MAX_DEPTH}`
    )
  }
  if (stats.leaves > PREDICATE_CAPS.MAX_LEAVES) {
    throw capError(
      'TOO_MANY_LEAVES',
      `predicate leaf count ${stats.leaves} exceeds MAX_LEAVES ${PREDICATE_CAPS.MAX_LEAVES}`
    )
  }
  for (const c of stats.inCounts) {
    if (c.count > PREDICATE_CAPS.MAX_IN_OPERAND_COUNT) {
      throw capError(
        'IN_OPERAND_LIMIT',
        `\`in\` operand count ${c.count} exceeds MAX_IN_OPERAND_COUNT ${PREDICATE_CAPS.MAX_IN_OPERAND_COUNT}`
      )
    }
  }
  // Minimum constraint. A predicate with no selector leaf compares literals
  // to literals, so it is trivially true or false and would permit everything
  // or nothing forever. The contract refuses it at install with
  // SELECTOR_LEAF_REQUIRED (216); refuse it here too so the failure is caught
  // before a transaction is built.
  if (stats.selectorLeaves === 0) {
    throw capError(
      'MALFORMED_PREDICATE',
      'predicate constrains nothing: every comparison has literals on both sides. The contract refuses it at install (SELECTOR_LEAF_REQUIRED). Pin the call itself - contract, method or argument.'
    )
  }

  // --- pass 1.5: leaf-value validation against the cap-set gate the contract
  // enforces at install. Defense in depth: the TS self-verify pipeline should
  // reject the same shapes Rust install refuses, so a hand-crafted predicate
  // that simulate/verify green-lights cannot later be refused at the on-chain
  // install step. The checks are the u32 ranges on the argument selectors
  // (`call_arg.index`, `call_arg_len.index`, `call_arg_field.index` and
  // `.element`) - the contract decodes each as u32, so an out-of-range value
  // would fail there instead.
  // Throws `MALFORMED_PREDICATE` so the error stays a ToolError shape.
  validateLeafValues(node)

  // --- pass 2: build + canonicalise the ScVal ---
  const root = encodeNode(node)
  const rawBytes = root.toXDR()
  if (rawBytes.length > PREDICATE_CAPS.MAX_PREDICATE_BYTES) {
    throw capError(
      'PREDICATE_TOO_LARGE',
      `predicate bytes ${rawBytes.length} exceed MAX_PREDICATE_BYTES ${PREDICATE_CAPS.MAX_PREDICATE_BYTES}`
    )
  }
  const encodedPredicate = rawBytes.toString('base64')
  const predicateHash = createHash('sha256').update(rawBytes).digest('hex')
  return { encodedPredicate, predicateHash }
}

interface PredicateStats {
  depth: number
  leaves: number
  inCounts: Array<{ count: number }>
  /** Leaves that read something from the call under evaluation. Literals are
   *  operands, not constraints, so they do not count. Zero means the
   *  predicate constrains nothing and the contract refuses it at install. */
  selectorLeaves: number
}

function computeStats(node: PredicateNode): PredicateStats {
  const inCounts: Array<{ count: number }> = []
  const counters = { selectorLeaves: 0 }
  const { depth, leaves } = walk(node, inCounts, counters)
  return {
    depth,
    leaves,
    inCounts,
    selectorLeaves: counters.selectorLeaves,
  }
}

function walk(
  node: PredicateNode,
  inCounts: Array<{ count: number }>,
  counters: { selectorLeaves: number }
): { depth: number; leaves: number } {
  switch (node.op) {
    case 'and': {
      if (node.children.length === 0) {
        throw capError(
          'MALFORMED_PREDICATE',
          `\`${node.op}\` with no children: the contract refuses it at decode (MALFORMED_PREDICATE), so it can never be installed`
        )
      }
      let maxChildDepth = 0
      let totalLeaves = 0
      for (const c of node.children) {
        const child = walk(c, inCounts, counters)
        if (child.depth > maxChildDepth) maxChildDepth = child.depth
        totalLeaves += child.leaves
      }
      return { depth: maxChildDepth + 1, leaves: totalLeaves }
    }
    case 'eq':
    case 'lte': {
      collectSelector(node.left, counters)
      collectSelector(node.right, counters)
      return { depth: 1, leaves: leafCount(node.left) + leafCount(node.right) }
    }
    case 'in': {
      if (node.haystack.length === 0) {
        throw capError(
          'MALFORMED_PREDICATE',
          '`in` with an empty haystack: the contract refuses it at decode (MALFORMED_PREDICATE), so it can never be installed'
        )
      }
      inCounts.push({ count: node.haystack.length })
      collectSelector(node.needle, counters)
      let haystackLeaves = 0
      for (const h of node.haystack) {
        collectSelector(h, counters)
        haystackLeaves += leafCount(h)
      }
      return {
        depth: 1,
        leaves: leafCount(node.needle) + haystackLeaves,
      }
    }
  }
}

/** Leaf-count contribution of one PredicateLeaf: 1 for any flat leaf, and the
 *  sum of element leaf counts for `literal_vec` so MAX_LEAVES caps see nested
 *  vector elements. */
function leafCount(leaf: PredicateLeaf): number {
  if (leaf.kind === 'literal_vec') {
    let total = 1 // the literal_vec itself counts as one leaf node
    for (const el of leaf.elements) total += leafCount(el)
    return total
  }
  return 1
}

function collectSelector(leaf: PredicateLeaf, counters: { selectorLeaves: number }): void {
  // literal_vec is the only nested leaf; recurse so a selector buried in a
  // vector literal is still counted. Mirrors `dsl::has_selector_leaf`.
  if (leaf.kind === 'literal_vec') {
    for (const el of leaf.elements) collectSelector(el, counters)
  } else if (!leaf.kind.startsWith('literal_')) {
    counters.selectorLeaves += 1
  }
}

function encodeNode(node: PredicateNode): xdr.ScVal {
  switch (node.op) {
    case 'and': {
      const encoded = node.children.map(encodeNode)
      // sort children by their canonical XDR bytes ascending.
      const sorted = sortByCanonicalBytes(encoded)
      return xdr.ScVal.scvVec([symbol(node.op), xdr.ScVal.scvVec(sorted)])
    }
    case 'eq':
    case 'lte': {
      return xdr.ScVal.scvVec([symbol(node.op), encodeLeaf(node.left), encodeLeaf(node.right)])
    }
    case 'in': {
      const needle = encodeLeaf(node.needle)
      // `in` is PURE set membership: the haystack is ALWAYS sorted by canonical
      // XDR bytes ascending. An exact ordered sequence (e.g. a swap hop path)
      // is expressed as `eq(selector, literal_vec)` where the vec's element
      // order is preserved verbatim (handled in `encodeLeaf(literal_vec)`).
      const haystack = sortByCanonicalBytes(node.haystack.map(encodeLeaf))
      return xdr.ScVal.scvVec([symbol('in'), needle, xdr.ScVal.scvVec(haystack)])
    }
  }
}

function encodeLeaf(leaf: PredicateLeaf): xdr.ScVal {
  switch (leaf.kind) {
    case 'call_contract':
      return xdr.ScVal.scvVec([symbol('call_contract')])
    case 'call_fn':
      return xdr.ScVal.scvVec([symbol('call_fn')])
    case 'call_arg':
      return xdr.ScVal.scvVec([symbol('call_arg'), xdr.ScVal.scvU32(leaf.index)])
    case 'call_arg_len':
      return xdr.ScVal.scvVec([symbol('call_arg_len'), xdr.ScVal.scvU32(leaf.index)])
    case 'call_arg_field':
      return xdr.ScVal.scvVec([
        symbol('call_arg_field'),
        xdr.ScVal.scvU32(leaf.index),
        xdr.ScVal.scvU32(leaf.element),
        xdr.ScVal.scvSymbol(leaf.field),
      ])
    case 'literal_address':
      return scvAddressFromStrkey(leaf.value)
    case 'literal_i128':
      return scvI128FromDecimal(leaf.value)
    case 'literal_symbol':
      return xdr.ScVal.scvSymbol(leaf.value)
    case 'literal_u32':
      return xdr.ScVal.scvU32(leaf.value)
    case 'literal_vec':
      // Bare ScVal::Vec of element encodings - order is preserved verbatim
      // because the order IS the semantic (exact ordered sequence equality).
      return xdr.ScVal.scvVec(leaf.elements.map(encodeLeaf))
  }
}

function symbol(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s)
}

function sortByCanonicalBytes(values: xdr.ScVal[]): xdr.ScVal[] {
  const pairs = values.map((v) => ({ v, bytes: v.toXDR() }))
  pairs.sort((a, b) => Buffer.compare(a.bytes, b.bytes))
  return pairs.map((p) => p.v)
}

function scvAddressFromStrkey(strkey: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(Address.fromString(strkey).toScAddress())
}

/** Build `ScVal::I128(Int128Parts{hi, lo})` from a signed decimal string.
 *  `Int128Parts` encodes the value as `(hi << 64) + lo` with `hi` a SIGNED
 *  64-bit int and `lo` an UNSIGNED 64-bit int (this is NOT signed-magnitude).
 *  The inverse split is `hi = v >> 64n` (arithmetic right shift) and
 *  `lo = v & 0xFFFF...`. The SDK's `Int64` constructor takes a signed
 *  bigint/string/number. */
function scvI128FromDecimal(decimal: string): xdr.ScVal {
  const v = BigInt(decimal)
  const hi = v >> 64n
  const lo = v & UINT64_MAX
  // Guard against accidental over-range. Int128Parts.hi must be a valid Int64
  // (-2^63 .. 2^63-1); values outside this range are invalid i128 entirely.
  if (hi < INT64_MIN || hi > INT64_MAX) {
    throw capError(
      'MALFORMED_PREDICATE',
      `literal_i128 value ${decimal} is outside the Int128 range`
    )
  }
  if (lo < 0n || lo > UINT64_MAX) {
    throw capError(
      'MALFORMED_PREDICATE',
      `literal_i128 value ${decimal} has an invalid Int128Parts.lo`
    )
  }
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: new xdr.Int64(hi),
      lo: new xdr.Uint64(lo),
    })
  )
}

function capError(code: ToolError['code'], message: string): ToolError {
  const err = new Error(message) as Error & {
    code: ToolError['code']
    severity: string
    retryable: boolean
  }
  err.code = code
  err.severity = 'error'
  err.retryable = false
  throw err
}

// u32 boundary - the same constant the contract decodes with. A value above
// this either overflows during encode or is refused at install.
const U32_MAX = 4294967295

/** Walk a `PredicateNode` and fail-closed on any leaf whose value the contract
 *  would refuse at install: the argument selectors carry u32 indices, so a
 *  value outside that range is refused here rather than on chain. Defense in
 *  depth so the TS self-verify pipeline rejects the same shapes Rust install
 *  already refuses - a hand-crafted predicate that simulate/verify
 *  green-lights must NOT be installable. Throws `MALFORMED_PREDICATE` so the
 *  envelope shapes it into a ToolError. */
function validateLeafValues(node: PredicateNode): void {
  function walkLeaf(leaf: PredicateLeaf, path: string): void {
    switch (leaf.kind) {
      case 'call_arg':
        if (!Number.isInteger(leaf.index) || leaf.index < 0 || leaf.index > U32_MAX) {
          throw malformed(`call_arg.index out of u32 range at ${path}`)
        }
        return
      case 'call_arg_len':
        if (!Number.isInteger(leaf.index) || leaf.index < 0 || leaf.index > U32_MAX) {
          throw malformed(`call_arg_len.index out of u32 range at ${path}`)
        }
        return
      case 'call_arg_field':
        if (!Number.isInteger(leaf.index) || leaf.index < 0 || leaf.index > U32_MAX) {
          throw malformed(`call_arg_field.index out of u32 range at ${path}`)
        }
        if (!Number.isInteger(leaf.element) || leaf.element < 0 || leaf.element > U32_MAX) {
          throw malformed(`call_arg_field.element out of u32 range at ${path}`)
        }
        return
      case 'call_contract':
      case 'call_fn':
      case 'literal_address':
      case 'literal_symbol':
        return
    }
  }
  function walkNode(n: PredicateNode, path: string): void {
    switch (n.op) {
      case 'and':
        n.children.forEach((c, i) => {
          walkNode(c, `${path}.children[${i}]`)
        })
        return
      case 'eq':
      case 'lte':
        walkLeaf(n.left, `${path}.left`)
        walkLeaf(n.right, `${path}.right`)
        return
      case 'in':
        walkLeaf(n.needle, `${path}.needle`)
        n.haystack.forEach((h, i) => {
          walkLeaf(h, `${path}.haystack[${i}]`)
        })
        return
    }
  }
  walkNode(node, '<root>')
}

function malformed(message: string): ToolError {
  return capError('MALFORMED_PREDICATE', message)
}
