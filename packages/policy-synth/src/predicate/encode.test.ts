// src/predicate/encode.test.ts - canonical predicate encoder tests.
//
// These tests pin the frozen ABI v1 wire format. Every test asserts a behaviour
// the future Rust interpreter MUST reproduce exactly. Any change to a test is
// a breaking change to the canonical encoding.

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { Address, Keypair, xdr } from '@stellar/stellar-sdk'
import type { PredicateLeaf, PredicateNode } from '../types.ts'
import { encodePredicate } from './encode.ts'

// Real, valid Stellar strkeys (checksum-validated by the SDK).
const TOKEN_A = Address.contract(Buffer.alloc(32, 0x01)).toString()
const TOKEN_B = Address.contract(Buffer.alloc(32, 0x02)).toString()
const ACCOUNT_A = Keypair.random().publicKey()

function leafAmount(token: string): PredicateLeaf {
  return { kind: 'amount', token }
}

function leafNow(): PredicateLeaf {
  return { kind: 'now' }
}

describe('encodePredicate - determinism', () => {
  it('produces byte-identical encodedPredicate + predicateHash across repeated runs', () => {
    const node: PredicateNode = {
      op: 'and',
      children: [
        { op: 'eq', left: leafAmount(TOKEN_A), right: { kind: 'literal_i128', value: '1000000' } },
        {
          op: 'or',
          children: [{ op: 'not', child: { op: 'eq', left: leafNow(), right: leafNow() } }],
        },
      ],
    }
    const r1 = encodePredicate(node)
    const r2 = encodePredicate(node)
    const r3 = encodePredicate(node)
    expect(r1.encodedPredicate).toBe(r2.encodedPredicate)
    expect(r2.encodedPredicate).toBe(r3.encodedPredicate)
    expect(r1.predicateHash).toBe(r2.predicateHash)
    expect(r2.predicateHash).toBe(r3.predicateHash)
  })

  it('predicateHash equals sha256 of the raw XDR bytes (base64-decoded)', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '42' },
    }
    const { encodedPredicate, predicateHash } = encodePredicate(node)
    const rawBytes = Buffer.from(encodedPredicate, 'base64')
    const expectedHash = createHash('sha256').update(rawBytes).digest('hex')
    expect(predicateHash).toBe(expectedHash)
    expect(rawBytes.length).toBeGreaterThan(0)
    // also confirm round-trip: parsing the bytes back into an ScVal succeeds
    expect(() => xdr.ScVal.fromXDR(rawBytes)).not.toThrow()
  })

  it('hashes the decoded (post-canonicalisation) bytes - encoded bytes are non-empty', () => {
    const node: PredicateNode = {
      op: 'not',
      child: { op: 'eq', left: leafNow(), right: leafNow() },
    }
    const { encodedPredicate, predicateHash } = encodePredicate(node)
    expect(Buffer.from(encodedPredicate, 'base64').length).toBeGreaterThan(5)
    expect(predicateHash).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(predicateHash)).toBe(true)
  })
})

describe('encodePredicate - signed-magnitude i128', () => {
  // Helper: walk the eq(root, left, right) shape to the right-hand i128.
  function rightI128(encodedPredicate: string): { hi: bigint; lo: bigint } {
    const scv = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = scv.vec() ?? []
    const right = rootVec[2]
    if (!right) throw new Error('missing right element')
    const parts = right.i128()
    return { hi: BigInt(parts.hi().toString()), lo: BigInt(parts.lo().toString()) }
  }

  it('encodes a positive i128 deterministically', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '1000000000' },
    }
    const a = encodePredicate(node)
    const b = encodePredicate(node)
    expect(a.encodedPredicate).toBe(b.encodedPredicate)
    expect(a.predicateHash).toBe(b.predicateHash)
    const parts = rightI128(a.encodedPredicate)
    expect((parts.hi << 64n) + parts.lo).toBe(1000000000n)
  })

  it('encodes a NEGATIVE i128 correctly (signed-magnitude Int128Parts)', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '-1' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const parts = rightI128(encodedPredicate)
    // Int128Parts split: hi = -1 (signed), lo = 2^64-1 (unsigned). Decoding
    // uses the same (hi << 64) + lo arithmetic as the decoder in record/decode.ts.
    expect((parts.hi << 64n) + parts.lo).toBe(-1n)
  })

  it('encodes a larger negative i128 correctly', () => {
    const node: PredicateNode = {
      op: 'lt',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '-1000000000' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const parts = rightI128(encodedPredicate)
    expect((parts.hi << 64n) + parts.lo).toBe(-1000000000n)
  })

  it('encodes i128::MAX (170141183460469231731687303715884105727) correctly at the boundary', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '170141183460469231731687303715884105727' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const parts = rightI128(encodedPredicate)
    expect((parts.hi << 64n) + parts.lo).toBe(170141183460469231731687303715884105727n)
    // hi is the maximum positive int64, lo is max u64
    expect(parts.hi.toString()).toBe('9223372036854775807')
    expect(parts.lo.toString()).toBe('18446744073709551615')
  })

  it('encodes i128::MIN (-170141183460469231731687303715884105728) correctly at the boundary', () => {
    const node: PredicateNode = {
      op: 'gt',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '-170141183460469231731687303715884105728' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const parts = rightI128(encodedPredicate)
    expect((parts.hi << 64n) + parts.lo).toBe(-170141183460469231731687303715884105728n)
  })
})

describe('encodePredicate - and/or child sort stability', () => {
  it('and: child reordering produces the same predicateHash', () => {
    const a: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '1' },
    }
    const b: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '2' },
    }
    const c: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '3' },
    }
    const left = encodePredicate({ op: 'and', children: [a, b, c] })
    const right = encodePredicate({ op: 'and', children: [c, a, b] })
    expect(left.encodedPredicate).toBe(right.encodedPredicate)
    expect(left.predicateHash).toBe(right.predicateHash)
  })

  it('or: child reordering produces the same predicateHash', () => {
    const a: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '7' },
    }
    const b: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '8' },
    }
    const c: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_i128', value: '9' },
    }
    const left = encodePredicate({ op: 'or', children: [a, b, c] })
    const right = encodePredicate({ op: 'or', children: [c, b, a] })
    expect(left.encodedPredicate).toBe(right.encodedPredicate)
    expect(left.predicateHash).toBe(right.predicateHash)
  })

  it('not: single child is NOT reordered (preserved verbatim)', () => {
    // The single child of `not` MUST keep its own canonical form regardless
    // of which side of the comparison sits where - but flipping the eq
    // sides would change the semantic. We assert only that a `not(eq)` of a
    // given (left,right) hashes the same across runs.
    const node: PredicateNode = {
      op: 'not',
      child: {
        op: 'eq',
        left: leafAmount(TOKEN_A),
        right: { kind: 'literal_i128', value: '11' },
      },
    }
    const r1 = encodePredicate(node)
    const r2 = encodePredicate(node)
    expect(r1.predicateHash).toBe(r2.predicateHash)
  })
})

describe('encodePredicate - in haystack ordering', () => {
  it('default `in` (set-valued) sorts the haystack ascending by XDR bytes', () => {
    const needle: PredicateLeaf = { kind: 'call_fn' }
    const a: PredicateNode = {
      op: 'in',
      needle,
      haystack: [
        { kind: 'literal_symbol', value: 'swap' },
        { kind: 'literal_symbol', value: 'transfer' },
        { kind: 'literal_symbol', value: 'approve' },
      ],
    }
    const b: PredicateNode = {
      op: 'in',
      needle,
      haystack: [
        { kind: 'literal_symbol', value: 'approve' },
        { kind: 'literal_symbol', value: 'swap' },
        { kind: 'literal_symbol', value: 'transfer' },
      ],
    }
    const ra = encodePredicate(a)
    const rb = encodePredicate(b)
    expect(ra.encodedPredicate).toBe(rb.encodedPredicate)
    expect(ra.predicateHash).toBe(rb.predicateHash)
  })

  it('`in` ALWAYS sorts the haystack - a haystack in REVERSE canonical order produces the same bytes as the sorted one', () => {
    // Build the same set twice: once in the order that the encoder would
    // produce (sorted ascending), once deliberately in the reverse order that
    // is also reverse-canonical. The encoder is responsible for re-sorting,
    // so the two predicates must be byte-identical. This pins `in` as PURE
    // set membership - there is no `ordered` flag, no sequence case.
    const needle: PredicateLeaf = { kind: 'call_arg', index: 0 }
    const sorted: PredicateNode = {
      op: 'in',
      needle,
      haystack: [
        { kind: 'literal_address', value: TOKEN_A },
        { kind: 'literal_address', value: TOKEN_B },
        { kind: 'literal_address', value: ACCOUNT_A },
      ],
    }
    const reversedCanonical: PredicateNode = {
      op: 'in',
      needle,
      haystack: [
        { kind: 'literal_address', value: ACCOUNT_A },
        { kind: 'literal_address', value: TOKEN_B },
        { kind: 'literal_address', value: TOKEN_A },
      ],
    }
    const rSorted = encodePredicate(sorted)
    const rReversed = encodePredicate(reversedCanonical)
    expect(rReversed.encodedPredicate).toBe(rSorted.encodedPredicate)
    expect(rReversed.predicateHash).toBe(rSorted.predicateHash)
  })

  it('two single-element `in` haystacks differing only by ordering still produce the same bytes (sort is a no-op)', () => {
    const needle: PredicateLeaf = { kind: 'call_fn' }
    const one: PredicateNode = {
      op: 'in',
      needle,
      haystack: [{ kind: 'literal_symbol', value: 'alpha' }],
    }
    const two: PredicateNode = {
      op: 'in',
      needle,
      haystack: [{ kind: 'literal_symbol', value: 'alpha' }],
    }
    const r1 = encodePredicate(one)
    const r2 = encodePredicate(two)
    expect(r1.encodedPredicate).toBe(r2.encodedPredicate)
  })
})

describe('encodePredicate - literal_vec order preservation', () => {
  it('literal_vec preserves element order verbatim: [A,B] vs [B,A] produce DIFFERENT bytes', () => {
    // The order IS the semantic. Two literal_vecs that differ only by element
    // permutation MUST encode to distinct bytes; this is the property that
    // makes `eq(selector, literal_vec)` an exact-ordered-sequence equality.
    const ab: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: {
        kind: 'literal_vec',
        elements: [
          { kind: 'literal_address', value: TOKEN_A },
          { kind: 'literal_address', value: TOKEN_B },
        ],
      },
    }
    const ba: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: {
        kind: 'literal_vec',
        elements: [
          { kind: 'literal_address', value: TOKEN_B },
          { kind: 'literal_address', value: TOKEN_A },
        ],
      },
    }
    const rAb = encodePredicate(ab)
    const rBa = encodePredicate(ba)
    expect(rAb.encodedPredicate).not.toBe(rBa.encodedPredicate)
    expect(rAb.predicateHash).not.toBe(rBa.predicateHash)
  })

  it('literal_vec encodes to a bare ScVal::Vec at the right-hand side of an eq (no selector tuple wrapper)', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: {
        kind: 'literal_vec',
        elements: [
          { kind: 'literal_symbol', value: 'swap' },
          { kind: 'literal_symbol', value: 'transfer' },
        ],
      },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    // root is [sym"eq", selector, literal_vec]; the literal_vec is the third
    // element and must itself be a Vec (not a symbol/tuple) holding the
    // element encodings in the caller's order.
    expect(rootVec).toHaveLength(3)
    expect(rootVec[0]?.sym().toString()).toBe('eq')
    const vec = rootVec[2]?.vec()
    expect(vec).toBeDefined()
    expect(vec).toHaveLength(2)
    expect(vec?.[0]?.sym().toString()).toBe('swap')
    expect(vec?.[1]?.sym().toString()).toBe('transfer')
  })

  it('literal_vec inside an eq contributes its element leaf count toward MAX_LEAVES', () => {
    // MAX_LEAVES = 200; build an eq whose right-hand literal_vec alone has
    // 201 elements (1 for the vec + 200 elements) so the total is 201 + 1
    // (left = call_arg) = 202 > 200. Confirms the cap walker recurses into
    // literal_vec elements.
    const elements: PredicateLeaf[] = []
    for (let i = 0; i < 200; i++) {
      elements.push({ kind: 'literal_u32', value: i })
    }
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_vec', elements },
    }
    try {
      encodePredicate(node)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('TOO_MANY_LEAVES')
    }
  })
})

describe('encodePredicate - selector leaf wire shapes', () => {
  it('window_spent serialises (token, windowSeconds) in that order', () => {
    const node: PredicateNode = {
      op: 'lt',
      left: { kind: 'window_spent', token: TOKEN_A, windowSeconds: 3600 },
      right: { kind: 'literal_i128', value: '100' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const scv = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    // The root is a Vec of [sym"lt", selectorVec, literalI128]. The selector
    // Vec is [sym"window_spent", scvAddress(token), scvU64(windowSeconds)].
    const rootVec = scv.vec() ?? []
    expect(rootVec).toHaveLength(3)
    expect(rootVec[0]?.sym().toString()).toBe('lt')
    const selector = rootVec[1]?.vec() ?? []
    expect(selector).toHaveLength(3)
    expect(selector[0]?.sym().toString()).toBe('window_spent')
    expect(selector[1]?.switch().name).toBe('scvAddress')
    expect(selector[2]?.switch().name).toBe('scvU64')
    expect(selector[2]?.u64().toString()).toBe('3600')
  })

  it('amount serialises with scvAddress(token)', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: leafAmount(TOKEN_A),
      right: { kind: 'literal_u64', value: '1' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    const selector = rootVec[1]?.vec() ?? []
    expect(selector[0]?.sym().toString()).toBe('amount')
    expect(selector[1]?.switch().name).toBe('scvAddress')
  })

  it('call_arg uses scvU32(index)', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 2 },
      right: { kind: 'literal_symbol', value: 'swap' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    const sel = rootVec[1]?.vec() ?? []
    expect(sel[0]?.sym().toString()).toBe('call_arg')
    expect(sel[1]?.u32()).toBe(2)
  })

  it('now serialises as a zero-arity selector vec', () => {
    const node: PredicateNode = {
      op: 'lt',
      left: leafNow(),
      right: { kind: 'literal_u64', value: 100 },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    expect(rootVec[1]?.vec() ?? []).toHaveLength(1)
    expect(rootVec[1]?.vec()?.[0]?.sym().toString()).toBe('now')
  })
})

describe('encodePredicate - literal leaf wire shapes', () => {
  it('literal_address serialises as bare scvAddress', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_address', value: ACCOUNT_A },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    // right-hand literal is the third Vec element, a bare ScVal (NOT a Vec).
    expect(rootVec[2]?.switch().name).toBe('scvAddress')
  })

  it('literal_symbol serialises as bare scvSymbol', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'swap' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    expect(rootVec[2]?.switch().name).toBe('scvSymbol')
    expect(rootVec[2]?.sym().toString()).toBe('swap')
  })

  it('literal_u32 serialises as bare scvU32', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_u32', value: 42 },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    expect(rootVec[2]?.switch().name).toBe('scvU32')
    expect(rootVec[2]?.u32()).toBe(42)
  })

  it('literal_u64 serialises as bare scvU64', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_u64', value: '999999999999' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    expect(rootVec[2]?.switch().name).toBe('scvU64')
    expect(rootVec[2]?.u64().toString()).toBe('999999999999')
  })

  it('literal_bytes serialises as bare scvBytes (hex-decoded)', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_bytes', value: 'deadbeef' },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    expect(rootVec[2]?.switch().name).toBe('scvBytes')
    expect(Buffer.from(rootVec[2]?.bytes() as Uint8Array).toString('hex')).toBe('deadbeef')
  })
})

describe('encodePredicate - cap enforcement', () => {
  function depthChain(depth: number): PredicateNode {
    let n: PredicateNode = { op: 'eq', left: leafNow(), right: leafNow() }
    for (let i = 0; i < depth; i++) {
      n = { op: 'not', child: n }
    }
    return n
  }

  it('throws PREDICATE_TOO_DEEP when depth exceeds MAX_DEPTH', () => {
    // MAX_DEPTH = 5; depth 6 is one past.
    try {
      encodePredicate(depthChain(5))
      throw new Error('expected throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('PREDICATE_TOO_DEEP')
    }
  })

  it('accepts exactly MAX_DEPTH (5) without throwing', () => {
    // 4 nots wrapping an eq -> depth = 1 (eq) + 4 (nots) = 5
    expect(() => encodePredicate(depthChain(4))).not.toThrow()
  })

  it('throws TOO_MANY_LEAVES when leaf count exceeds MAX_LEAVES', () => {
    // Build an `and` of MAX_LEAVES + 1 selector leaves.
    const leaves: PredicateLeaf[] = []
    for (let i = 0; i <= 200; i++) leaves.push({ kind: 'call_arg', index: i % 4 })
    const node: PredicateNode = {
      op: 'and',
      children: leaves.map((leaf) => ({ op: 'eq', left: leaf, right: leafNow() })),
    }
    try {
      encodePredicate(node)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('TOO_MANY_LEAVES')
    }
  })

  it('throws IN_OPERAND_LIMIT when an `in` haystack exceeds MAX_IN_OPERAND_COUNT', () => {
    const haystack: PredicateLeaf[] = []
    for (let i = 0; i < 33; i++) haystack.push({ kind: 'literal_symbol', value: `fn_${i}` })
    const node: PredicateNode = { op: 'in', needle: { kind: 'call_fn' }, haystack }
    try {
      encodePredicate(node)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('IN_OPERAND_LIMIT')
    }
  })

  it('throws PREDICATE_TOO_LARGE when encoded bytes exceed MAX_PREDICATE_BYTES', () => {
    // Force oversize: one huge `in` haystack (set-valued) of the maximum
    // allowed operand count, with long bytes literals. XDR symbol length is
    // capped at 32 bytes, so we use bytes (1500 raw bytes each) to grow past
    // the 32 KB wire cap. 32 * ~1504 encoded bytes = ~48 KB, well past the
    // 32 KB limit.
    const haystack: PredicateLeaf[] = []
    for (let i = 0; i < 32; i++) {
      haystack.push({ kind: 'literal_bytes', value: 'ab'.repeat(1500) })
    }
    const node: PredicateNode = { op: 'in', needle: { kind: 'call_fn' }, haystack }
    try {
      encodePredicate(node)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('PREDICATE_TOO_LARGE')
    }
  })
})

describe('encodePredicate - call_arg_len / call_arg_field wire shapes', () => {
  it('call_arg_len serialises as [sym"call_arg_len", scvU32(index)]', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_len', index: 3 },
      right: { kind: 'literal_u32', value: 1 },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    const sel = rootVec[1]?.vec() ?? []
    expect(sel[0]?.sym().toString()).toBe('call_arg_len')
    expect(sel[1]?.switch().name).toBe('scvU32')
    expect(sel[1]?.u32()).toBe(3)
  })

  it('call_arg_field serialises as [sym"call_arg_field", scvU32(index), scvU32(element), scvSymbol(field)]', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 3, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const { encodedPredicate } = encodePredicate(node)
    const root = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
    const rootVec = root.vec() ?? []
    const sel = rootVec[1]?.vec() ?? []
    expect(sel[0]?.sym().toString()).toBe('call_arg_field')
    expect(sel[1]?.switch().name).toBe('scvU32')
    expect(sel[1]?.u32()).toBe(3)
    expect(sel[2]?.switch().name).toBe('scvU32')
    expect(sel[2]?.u32()).toBe(0)
    expect(sel[3]?.switch().name).toBe('scvSymbol')
    expect(sel[3]?.sym().toString()).toBe('request_type')
  })

  it('call_arg_len produces byte-identical encoding across repeated runs (deterministic)', () => {
    const node: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_arg_len', index: 3 },
          right: { kind: 'literal_u32', value: 2 },
        },
        {
          op: 'eq',
          left: { kind: 'call_arg_field', index: 3, element: 0, field: 'request_type' },
          right: { kind: 'literal_u32', value: 3 },
        },
      ],
    }
    const r1 = encodePredicate(node)
    const r2 = encodePredicate(node)
    expect(r1.encodedPredicate).toBe(r2.encodedPredicate)
    expect(r1.predicateHash).toBe(r2.predicateHash)
  })
})

describe('encodePredicate - cap-breach error shape', () => {
  it('throws a ToolError with severity=error and retryable=false', () => {
    const node: PredicateNode = {
      op: 'eq',
      left: leafNow(),
      right: leafNow(),
    }
    // wrap in nots past the depth cap
    const deep: PredicateNode = Array.from({ length: 6 }).reduce(
      (acc) => ({ op: 'not', child: acc }) as PredicateNode,
      node
    )
    try {
      encodePredicate(deep)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code: string; severity: string; retryable: boolean }
      expect(err.code).toBe('PREDICATE_TOO_DEEP')
      expect(err.severity).toBe('error')
      expect(err.retryable).toBe(false)
    }
  })
})

// The contract refuses an empty `and`/`or` child list and an empty `in`
// haystack at decode (dsl.rs `decode_and_or` / `decode_in` ->
// MALFORMED_PREDICATE). Encoding one produces a policy that cannot be
// installed, so the encoder is the gate that catches it locally.
describe('encodePredicate - structures the contract refuses at decode', () => {
  it('rejects an empty `and`', () => {
    expect(() => encodePredicate({ op: 'and', children: [] })).toThrow()
  })

  it('rejects an empty `or`', () => {
    expect(() => encodePredicate({ op: 'or', children: [] })).toThrow()
  })

  it('rejects an empty `and` nested under a valid parent', () => {
    expect(() =>
      encodePredicate({
        op: 'and',
        children: [
          { op: 'eq', left: leafNow(), right: leafNow() },
          { op: 'or', children: [] },
        ],
      })
    ).toThrow()
  })

  it('rejects an empty `in` haystack', () => {
    expect(() =>
      encodePredicate({
        op: 'in',
        needle: { kind: 'call_contract' },
        haystack: [],
      })
    ).toThrow()
  })

  it('reports the malformed structure as a non-retryable error', () => {
    try {
      encodePredicate({ op: 'and', children: [] })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code: string; severity: string; retryable: boolean }
      expect(err.code).toBe('MALFORMED_PREDICATE')
      expect(err.severity).toBe('error')
      expect(err.retryable).toBe(false)
    }
  })
})
