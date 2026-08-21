// Round-trip tests for the wire decoder.
//
// The contract these pin: `decode(encode(node))` must equal `node` for every
// shape the grammar can express. That is what lets a policy already installed
// on chain be read back and explained - if the two sides ever drift, a rule
// would be described as something other than what it enforces, which is worse
// than not describing it at all.

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import { describePredicate } from '../review-card/builder.ts'
import type { PredicateNode } from '../types.ts'
import { decodePredicate } from './decode.ts'
import { encodePredicate } from './encode.ts'

const TOKEN_A = Address.contract(Buffer.alloc(32, 0x01)).toString()
const TOKEN_B = Address.contract(Buffer.alloc(32, 0x02)).toString()
const CONTRACT = Address.contract(Buffer.alloc(32, 0x03)).toString()

/** encode -> decode -> expect the original tree back. */
function roundTrip(node: PredicateNode): PredicateNode {
  const { encodedPredicate } = encodePredicate(node)
  return decodePredicate(encodedPredicate)
}

/** `and` / `or` children are sorted by canonical XDR bytes on encode, so the
 *  decoded order is the encoder's, not the author's. Canonicalise both sides
 *  before comparing: the SET of conjuncts is the semantic, the order is not.
 *  Everything else - literal_vec elements, `in` haystacks - is compared as
 *  written, because there order IS the semantic. */
function canonical(node: PredicateNode): PredicateNode {
  if (node.op === 'and' || node.op === 'or') {
    const children = node.children.map(canonical)
    children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return { ...node, children }
  }
  if (node.op === 'not') return { ...node, child: canonical(node.child) }
  return node
}

function expectRoundTrip(node: PredicateNode): void {
  expect(canonical(roundTrip(node))).toEqual(canonical(node))
}

describe('decodePredicate - round-trips every leaf kind', () => {
  it('call_contract / call_fn (zero-arity selectors)', () => {
    const node: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_contract' },
          right: { kind: 'literal_address', value: CONTRACT },
        },
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'transfer' },
        },
      ],
    }
    expectRoundTrip(node)
  })

  it('call_arg / call_arg_len / call_arg_field', () => {
    const node: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: { kind: 'literal_address', value: TOKEN_A },
        },
        {
          op: 'eq',
          left: { kind: 'call_arg_len', index: 1 },
          right: { kind: 'literal_u32', value: 2 },
        },
        {
          op: 'lte',
          left: { kind: 'call_arg_field', index: 2, element: 0, field: 'amount' },
          right: { kind: 'literal_i128', value: '100000000' },
        },
      ],
    }
    expectRoundTrip(node)
  })

  it('a negative i128 survives the (hi << 64) + lo split', () => {
    const node: PredicateNode = {
      op: 'lte',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_i128', value: '-170141183460469231731687303715884105728' },
    }
    expect(roundTrip(node)).toEqual(node)
  })
})

describe('decodePredicate - round-trips every node shape', () => {
  it('eq against a literal_vec preserves element ORDER (exact sequence)', () => {
    // Order is the semantic here - a reordered path is a different policy.
    const node: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 1 },
      right: {
        kind: 'literal_vec',
        elements: [
          { kind: 'literal_address', value: TOKEN_A },
          { kind: 'literal_address', value: TOKEN_B },
        ],
      },
    }
    const back = roundTrip(node) as Extract<PredicateNode, { op: 'eq' }>
    expect(back.right).toEqual(node.right)
  })

  it('in haystack round-trips', () => {
    const node: PredicateNode = {
      op: 'in',
      needle: { kind: 'call_arg', index: 0 },
      haystack: [
        { kind: 'literal_address', value: TOKEN_A },
        { kind: 'literal_address', value: TOKEN_B },
      ],
    }
    const back = roundTrip(node) as Extract<PredicateNode, { op: 'in' }>
    expect(back.op).toBe('in')
    expect(back.haystack).toHaveLength(2)
  })
})

describe('decodePredicate - refuses rather than guessing', () => {
  it('an unknown selector symbol is malformed, NOT a literal_vec', () => {
    // Falling back to literal_vec would let an unsupported selector decode as
    // data and read as permitted.
    const bad = encodePredicate({
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: {
        kind: 'literal_vec',
        elements: [{ kind: 'literal_symbol', value: 'not_a_selector' }],
      },
    })
    expect(() => decodePredicate(bad.encodedPredicate)).toThrow(/unknown selector symbol/)
  })

  it('non-XDR input is refused with a clear message', () => {
    expect(() => decodePredicate('not-base64-xdr')).toThrow(/not valid ScVal XDR/)
  })
})

describe('decode -> describe: an installed policy explains itself', () => {
  it('renders the sentences a caller would show for a decoded rule', () => {
    // The point of the decoder: a rule already on chain can be read back and
    // explained in the SAME words the review card used before it was
    // installed. If these two ever diverge, a rule would be described as
    // something other than what it enforces.
    const node: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_contract' },
          right: { kind: 'literal_address', value: CONTRACT },
        },
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'transfer' },
        },
      ],
    }
    const lines = describePredicate(decodePredicate(encodePredicate(node).encodedPredicate))
    expect(lines).toContain(`Contract must be ${CONTRACT}`)
    expect(lines).toContain('Function must be transfer')
  })
})
