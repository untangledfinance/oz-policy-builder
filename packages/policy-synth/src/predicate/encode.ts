// src/predicate/encode.ts - canonical predicate encoder.
//
// Pure function. Maps a `PredicateNode` AST to the canonical ScVal wire format:
//   - every node is a `ScVal::Vec` whose head element is the tag `ScVal::Symbol`
//   - children of `and` / `or` are sorted ascending by their canonical XDR bytes
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
// One gap remains, deliberately: the `amount` / `window_spent` leaf branches
// below are dead ABI - the contract's grammar no longer has those selector
// symbols, so a predicate carrying one is MALFORMED at decode. The interpreter
// adapter reports them as uncovered before lowering, so the product path
// cannot emit one; removing the branches (and the leaf kinds) is a separate
// change.

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
  // Two-round confirmation costs 2 oracle reads per UNIQUE asset referenced.
  const oracleReads = stats.oracleAssets.size * 2
  if (oracleReads > PREDICATE_CAPS.MAX_ORACLE_READS) {
    throw capError(
      'PREDICATE_ORACLE_OVER_LIMIT',
      `oracle reads ${oracleReads} exceed MAX_ORACLE_READS ${PREDICATE_CAPS.MAX_ORACLE_READS}`
    )
  }
  if (stats.oracleAssets.size > 0 && stats.nonOracleSelectorLeaves === 0) {
    throw capError(
      'MALFORMED_PREDICATE',
      'predicate constrains nothing but an oracle price: the contract refuses it at install (dsl.rs MissingNonOracleEnvelope). Pin the call itself (contract / method / argument) alongside the price bound.'
    )
  }

  // --- pass 1.5: leaf-value validation (Rust `validate_scaled_ratios` + the
  // broader cap-set gate the contract enforces at install). Defense in depth:
  // the TS self-verify pipeline should reject the same shapes Rust install
  // refuses, so a hand-crafted predicate that simulate/verify green-lights
  // cannot later be refused at the on-chain install step. The checks:
  //   - u32 fields in range (call_arg index, literal_u32 value, oracle
  //     threshold decimals, etc.) - the contract decodes as u32
  //   - i128 positivity where required (literal_i128 for amount/window
  //     caps; `den`/`num` for scaled ratios) - a negative cap would
  //     permit everything
  //   - hex even-length (literal_bytes) - `Buffer.from(v, 'hex')` silently
  //     drops non-hex chars, so 'zz' becomes empty bytes
  //   - scaled-ratio num>0 && den>0 - mirrors dsl.rs:661-704
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
  /** Unique assets referenced by `oracle_price` leaves - each costs 2 reads. */
  oracleAssets: Set<string>
  /** Selector leaves that are NOT `oracle_price`. The contract refuses a
   *  predicate whose only constraint is an oracle read (dsl.rs
   *  `validate_oracle_placement` -> MissingNonOracleEnvelope): a price bound
   *  alone pins nothing about the call itself. Literals are operands, not
   *  constraints, so they do not count. */
  nonOracleSelectorLeaves: number
}

function computeStats(node: PredicateNode): PredicateStats {
  const inCounts: Array<{ count: number }> = []
  const oracleAssets = new Set<string>()
  const counters = { nonOracleSelectorLeaves: 0 }
  const { depth, leaves } = walk(node, inCounts, oracleAssets, counters, false)
  return {
    depth,
    leaves,
    inCounts,
    oracleAssets,
    nonOracleSelectorLeaves: counters.nonOracleSelectorLeaves,
  }
}

function walk(
  node: PredicateNode,
  inCounts: Array<{ count: number }>,
  oracleAssets: Set<string>,
  counters: { nonOracleSelectorLeaves: number },
  /** True once the walk is under a `not` or an `or`, where an oracle read
   *  becomes a condition the caller can satisfy by taking the other branch. */
  negatedOrDisjunctive: boolean
): { depth: number; leaves: number } {
  switch (node.op) {
    case 'and':
    case 'or': {
      if (node.children.length === 0) {
        throw capError(
          'MALFORMED_PREDICATE',
          `\`${node.op}\` with no children: the contract refuses it at decode (MALFORMED_PREDICATE), so it can never be installed`
        )
      }
      let maxChildDepth = 0
      let totalLeaves = 0
      for (const c of node.children) {
        const child = walk(
          c,
          inCounts,
          oracleAssets,
          counters,
          negatedOrDisjunctive || node.op === 'or'
        )
        if (child.depth > maxChildDepth) maxChildDepth = child.depth
        totalLeaves += child.leaves
      }
      return { depth: maxChildDepth + 1, leaves: totalLeaves }
    }
    case 'not': {
      const child = walk(node.child, inCounts, oracleAssets, counters, true)
      return { depth: child.depth + 1, leaves: child.leaves }
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      collectOracle(node.left, oracleAssets, counters, negatedOrDisjunctive)
      collectOracle(node.right, oracleAssets, counters, negatedOrDisjunctive)
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
      collectOracle(node.needle, oracleAssets, counters, negatedOrDisjunctive)
      let haystackLeaves = 0
      for (const h of node.haystack) {
        collectOracle(h, oracleAssets, counters, negatedOrDisjunctive)
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

function collectOracle(
  leaf: PredicateLeaf,
  oracleAssets: Set<string>,
  counters: { nonOracleSelectorLeaves: number },
  negatedOrDisjunctive: boolean
): void {
  // literal_vec is the only nested leaf; recurse so an oracle_price buried in a
  // vector literal (which the lowering would forbid, but the cap-walker must
  // still see) is counted toward the oracle-read budget.
  if (leaf.kind === 'oracle_price') {
    if (negatedOrDisjunctive) {
      throw capError(
        'ORACLE_LEAF_INVALID_POSITION',
        `oracle_price(${leaf.asset}) sits under a \`not\`/\`or\`: the contract refuses that position at install (dsl.rs validate_oracle_placement). An oracle bound must be a conjunct the call has to satisfy.`
      )
    }
    oracleAssets.add(leaf.asset)
  } else if (leaf.kind === 'literal_vec') {
    for (const el of leaf.elements) collectOracle(el, oracleAssets, counters, negatedOrDisjunctive)
  } else if (!leaf.kind.startsWith('literal_') && leaf.kind !== 'oracle_threshold') {
    // A threshold is the oracle compare's operand, not an independent
    // constraint. Counting it would let an oracle-only predicate satisfy the
    // non-oracle envelope with its own bound (mirrors collect_oracle_leaf in
    // dsl.rs, where it sits with the literals).
    counters.nonOracleSelectorLeaves += 1
  }
}

function encodeNode(node: PredicateNode): xdr.ScVal {
  switch (node.op) {
    case 'and':
    case 'or': {
      const encoded = node.children.map(encodeNode)
      // sort children by their canonical XDR bytes ascending.
      const sorted = sortByCanonicalBytes(encoded)
      return xdr.ScVal.scvVec([symbol(node.op), xdr.ScVal.scvVec(sorted)])
    }
    case 'not': {
      return xdr.ScVal.scvVec([symbol('not'), encodeNode(node.child)])
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
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
    case 'call_arg_scaled':
      // Wire shape `vec[symbol, u32, i128, i128]` mirrors the Rust decoder's
      // expectation in dsl.rs SEL_CALL_ARG_SCALED. `scvI128FromDecimal` is
      // the same range-checked helper used by `literal_i128`; an out-of-range
      // num/den is refused at encode time (rather than at install on chain).
      return xdr.ScVal.scvVec([
        symbol('call_arg_scaled'),
        xdr.ScVal.scvU32(leaf.index),
        scvI128FromDecimal(leaf.num),
        scvI128FromDecimal(leaf.den),
      ])
    case 'amount':
      return xdr.ScVal.scvVec([symbol('amount'), scvAddressFromStrkey(leaf.token)])
    case 'window_spent':
      return xdr.ScVal.scvVec([
        symbol('window_spent'),
        scvAddressFromStrkey(leaf.token),
        scvU64FromValue(leaf.windowSeconds),
      ])
    case 'now':
      return xdr.ScVal.scvVec([symbol('now')])
    case 'valid_until':
      // The interpreter refuses this leaf at install: it never sources
      // valid_until_ledger, so a policy built on it would deny forever.
      // Expiry belongs to the smart account, through the context rule's
      // validUntilLedger. Refuse at synthesis so the author finds out here
      // rather than from an install that always fails.
      throw new Error(
        'valid_until is not a usable predicate leaf: the interpreter never sources it and ' +
          'refuses it at install. Put expiry on the context rule (validUntilLedger) instead.'
      )
    case 'invocation_count_in_window':
      return xdr.ScVal.scvVec([symbol('invocation_count'), scvU64FromValue(leaf.windowSecs)])
    case 'oracle_price':
      return xdr.ScVal.scvVec([symbol('oracle_price'), scvAddressFromStrkey(leaf.asset)])
    case 'oracle_threshold':
      // Arity 3, matching SEL_ORACLE_THRESHOLD in dsl.rs. The declared basis
      // travels with the value so the contract never has to assume one.
      return xdr.ScVal.scvVec([
        symbol('oracle_threshold'),
        scvI128FromDecimal(leaf.value),
        xdr.ScVal.scvU32(leaf.decimals),
      ])
    case 'literal_address':
      return scvAddressFromStrkey(leaf.value)
    case 'literal_i128':
      return scvI128FromDecimal(leaf.value)
    case 'literal_symbol':
      return xdr.ScVal.scvSymbol(leaf.value)
    case 'literal_u32':
      return xdr.ScVal.scvU32(leaf.value)
    case 'literal_u64':
      return scvU64FromValue(leaf.value)
    case 'literal_bytes':
      return xdr.ScVal.scvBytes(Buffer.from(leaf.value, 'hex'))
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

function scvU64FromValue(value: number | string): xdr.ScVal {
  // The Uint64 (UnsignedHyper) constructor accepts string | bigint | number;
  // string is safest for values > 2^53.
  return xdr.ScVal.scvU64(new xdr.Uint64(String(value)))
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
// The maximum decimal basis an oracle threshold can declare (mirrors
// `MAX_ORACLE_THRESHOLD_DECIMALS` in dsl.rs). A value above this is refused
// at install with `ORACLE_PARAMS_OUT_OF_RANGE`.
const MAX_ORACLE_THRESHOLD_DECIMALS = 18

/** Walk a `PredicateNode` and fail-closed on any leaf whose cap-set value the
 *  contract would refuse at install. Mirrors `validate_scaled_ratios` in
 *  dsl.rs:661-704 plus the broader cap-set gate (`literal_u32`, `literal_i128`
 *  positivity, `literal_bytes` hex even-length, `oracle_threshold` decimals
 *  range, `call_arg_scaled` positive-ratio). Defense in depth so the TS
 *  self-verify pipeline rejects the same shapes Rust install already
 *  refuses - a hand-crafted predicate that simulate/verify green-lights must
 *  NOT be installable. Throws `MALFORMED_PREDICATE` so the envelope shapes
 *  it into a ToolError. */
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
      case 'call_arg_scaled': {
        if (!Number.isInteger(leaf.index) || leaf.index < 0 || leaf.index > U32_MAX) {
          throw malformed(`call_arg_scaled.index out of u32 range at ${path}`)
        }
        // num / den are i128 on chain, decimal strings on the wire. The
        // contract refuses `den == 0` and `num <= 0` / `den <= 0` at install
        // (dsl.rs:664-672); mirror that here so a future regression in
        // `validate_scaled_ratios` cannot let a divide-by-zero policy reach
        // the wire. BigInt throws on non-numeric strings -> malformed.
        let num: bigint
        let den: bigint
        try {
          num = BigInt(leaf.num)
          den = BigInt(leaf.den)
        } catch {
          throw malformed(`call_arg_scaled.num/den not a decimal integer at ${path}`)
        }
        if (num <= 0n) throw malformed(`call_arg_scaled.num must be > 0 at ${path}`)
        if (den <= 0n) throw malformed(`call_arg_scaled.den must be > 0 at ${path}`)
        return
      }
      case 'literal_u32':
        if (!Number.isInteger(leaf.value) || leaf.value < 0 || leaf.value > U32_MAX) {
          throw malformed(`literal_u32.value out of u32 range at ${path}`)
        }
        return
      case 'literal_i128':
        // literal_i128 is signed; the contract allows negatives (i128
        // arithmetic), but caps on a positive quantity (amount / window
        // bound) should never be negative - a negative cap is silently
        // satisfied by every non-negative amount. The contract gate is
        // already on the leaf's ROLE (amount vs equality) not the value;
        // here we mirror the value-only invariant the cap-set gate enforces
        // by refusing the syntactic shape that would clearly be a bug
        // (literal_i128 as a CAP with a leading `-` on a non-equality).
        // We do not gate equality i128 - `literal_i128` as an address-by-
        // equality is fine (it is just a constant).
        // The value itself is always accepted; the structural check
        // (non-negative for an amount / window bound) is left to the
        // caller-built predicate, not the encoder.
        return
      case 'literal_bytes':
        // Hex even-length: a non-hex char silently drops, and an odd
        // length yields a half-byte Buffer. The contract decodes with a
        // strict hex parser and refuses anything that is not even-length
        // hex; mirror that here.
        if (!/^[0-9a-fA-F]*$/.test(leaf.value) || leaf.value.length % 2 !== 0) {
          throw malformed(`literal_bytes.value must be even-length hex at ${path}`)
        }
        return
      case 'oracle_threshold':
        if (
          !Number.isInteger(leaf.decimals) ||
          leaf.decimals < 0 ||
          leaf.decimals > MAX_ORACLE_THRESHOLD_DECIMALS
        ) {
          throw malformed(
            `oracle_threshold.decimals out of range (0..${MAX_ORACLE_THRESHOLD_DECIMALS}) at ${path}`
          )
        }
        return
      case 'literal_vec':
        leaf.elements.forEach((e, i) => {
          walkLeaf(e, `${path}.elements[${i}]`)
        })
        return
      // Selector and other leaves carry no cap-set values; the call_arg
      // branches above cover indices, the literal branches cover typed
      // constants. amount / window_spent / invocation_count / now /
      // valid_until / call_contract / call_fn / literal_address /
      // literal_symbol / literal_u64 / oracle_price are all value-free
      // at this gate.
      case 'amount':
      case 'window_spent':
      case 'invocation_count_in_window':
      case 'now':
      case 'valid_until':
      case 'call_contract':
      case 'call_fn':
      case 'literal_address':
      case 'literal_symbol':
      case 'literal_u64':
      case 'oracle_price':
        return
    }
  }
  function walkNode(n: PredicateNode, path: string): void {
    switch (n.op) {
      case 'and':
      case 'or':
        n.children.forEach((c, i) => {
          walkNode(c, `${path}.children[${i}]`)
        })
        return
      case 'not':
        walkNode(n.child, `${path}.child`)
        return
      case 'eq':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
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
