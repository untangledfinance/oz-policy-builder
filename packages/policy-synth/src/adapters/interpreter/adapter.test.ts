// src/adapters/interpreter/adapter.test.ts - interpreter compile adapter tests.
//
// These tests pin the ComposedRule -> PredicateNode lowering for the three reference
// walkthroughs plus the three fail-closed enforcement gates. Any change is a
// behavioural break: the predicate bytes are the wire format the future Rust
// interpreter parses, and the lowering must reproduce the same shape across
// runs (the encoder sorts / canonicalises internally).

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { Address } from '@stellar/stellar-sdk'
import { decodePredicate } from '../../predicate/decode.ts'
import { encodePredicate } from '../../predicate/encode.ts'
import type { ComposedRule } from '../../synth/compose-from-recording.ts'
import { GRAMMAR_VERSION, type PredicateLeaf, type PredicateNode } from '../../types.ts'
import { compileInterpreterPolicy } from './adapter.ts'

// Deterministic Stellar strkeys (checksum-validated by the SDK).
const BLEND_POOL = Address.contract(Buffer.alloc(32, 0x10)).toString()
const XLM = Address.contract(Buffer.alloc(32, 0x01)).toString()
const USDC = Address.contract(Buffer.alloc(32, 0x02)).toString()
const RECIPIENT_A = Address.contract(Buffer.alloc(32, 0xa1)).toString()
const RECIPIENT_B = Address.contract(Buffer.alloc(32, 0xa2)).toString()
const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0xee)).toString()

const CONFIG = {
  installNonce: 1,
  smartAccountAddress: SMART_ACCOUNT,
}

function leafCallFn(): PredicateLeaf {
  return { kind: 'call_fn' }
}

function leafCallContract(): PredicateLeaf {
  return { kind: 'call_contract' }
}

describe('interpreter adapter - Blend claim walkthrough', () => {
  it('lowers (claim, scope only) to and(call_contract, call_fn==claim)', () => {
    const rule: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'claim' },
      constraints: [],
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    expect(res.covered).toBe(true)
    expect(res.uncovered).toEqual([])
    const proposed = res.proposed
    expect(proposed).toBeDefined()
    if (!proposed) return
    // Scoped to the contract, matching what the context rule must route: a
    // `default` rule would send every call through this policy.
    expect(proposed.contextRule.contextRuleType).toEqual({
      kind: 'call_contract',
      contract: BLEND_POOL,
    })
    expect(proposed.policyDocuments).toHaveLength(1)
    expect(proposed.policyRefs).toHaveLength(1)
    const doc = proposed.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    expect(doc.grammarVersion).toBe(GRAMMAR_VERSION)
    expect(doc.installNonce).toBe(1)
    expect(typeof doc.encodedPredicate).toBe('string')
    expect(doc.predicateHash).toMatch(/^[0-9a-f]{64}$/)
    // hash must equal sha256 of the raw XDR bytes
    const raw = Buffer.from(doc.encodedPredicate, 'base64')
    expect(doc.predicateHash).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(proposed.policyRefs[0]).toEqual({
      kind: 'interpreter',
      interpreterAddress: 'VERIFY-interpreter-address',
      predicateBlobBase64: doc.encodedPredicate,
    })
  })

  it('emits the exact canonical predicate bytes for the Blend claim fixture', () => {
    const rule: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'claim' },
      constraints: [],
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    const doc = res.proposed?.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    // Build the expected predicate by hand and assert the encoder produces the
    // same bytes. The ComposedRule->predicate lowering must match the hand-built tree.
    const expectedNode: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: leafCallContract(),
          right: { kind: 'literal_address', value: BLEND_POOL },
        },
        { op: 'eq', left: leafCallFn(), right: { kind: 'literal_symbol', value: 'claim' } },
      ],
    }
    const expected = encodePredicate(expectedNode)
    expect(doc.encodedPredicate).toBe(expected.encodedPredicate)
    expect(doc.predicateHash).toBe(expected.predicateHash)
    // The canonical bytes must round-trip. Compare bytes, not trees: the
    // encoder sorts children, so decoding returns the same predicate with the
    // two `eq` conjuncts in canonical rather than hand-written order.
    const decoded = decodePredicate(doc.encodedPredicate)
    expect(encodePredicate(decoded).encodedPredicate).toBe(doc.encodedPredicate)
  })
})

describe('interpreter adapter - SEP-41 recipient allowlist walkthrough', () => {
  it('lowers (transfer + allowlist[recipients]) to and(call_contract, call_fn==transfer, call_arg[0] in [...])', () => {
    const rule: ComposedRule = {
      scope: { contract: XLM, method: 'transfer' },
      constraints: [
        {
          op: 'in',
          needle: { kind: 'call_arg', index: 0 },
          haystack: [
            { kind: 'literal_address', value: RECIPIENT_A },
            { kind: 'literal_address', value: RECIPIENT_B },
          ],
        },
      ],
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    expect(res.covered).toBe(true)
    expect(res.uncovered).toEqual([])
    const doc = res.proposed?.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const expectedNode: PredicateNode = {
      op: 'and',
      children: [
        { op: 'eq', left: leafCallContract(), right: { kind: 'literal_address', value: XLM } },
        { op: 'eq', left: leafCallFn(), right: { kind: 'literal_symbol', value: 'transfer' } },
        {
          op: 'in',
          needle: { kind: 'call_arg', index: 0 },
          haystack: [
            { kind: 'literal_address', value: RECIPIENT_A },
            { kind: 'literal_address', value: RECIPIENT_B },
          ],
        },
      ],
    }
    const expected = encodePredicate(expectedNode)
    expect(doc.encodedPredicate).toBe(expected.encodedPredicate)
    expect(doc.predicateHash).toBe(expected.predicateHash)
    // The interpreter address is the clearly-marked placeholder.
    expect(res.proposed?.policyRefs[0]?.kind).toBe('interpreter')
    if (res.proposed?.policyRefs[0]?.kind === 'interpreter') {
      expect(res.proposed.policyRefs[0].interpreterAddress).toBe('VERIFY-interpreter-address')
    }
  })

  it('emits call_contract as a sibling eq when scope.contract is set', () => {
    const rule: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'claim' },
      constraints: [],
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    expect(res.covered).toBe(true)
    const doc = res.proposed?.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const expectedNode: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: leafCallContract(),
          right: { kind: 'literal_address', value: BLEND_POOL },
        },
        { op: 'eq', left: leafCallFn(), right: { kind: 'literal_symbol', value: 'claim' } },
      ],
    }
    const expected = encodePredicate(expectedNode)
    expect(doc.encodedPredicate).toBe(expected.encodedPredicate)
  })
})

describe('interpreter adapter - Soroswap bounded-swap walkthrough', () => {
  it('lowers (path ordered [XLM,USDC] + per-call arg cap) to one and', () => {
    const rule: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'swap' },
      constraints: [
        {
          // Exact ordered sequence equality: the swap hop path MUST equal
          // [XLM, USDC] in that order. This is expressed as
          // eq(call_arg[0], literal_vec([XLM, USDC])) - element order preserved.
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: XLM },
              { kind: 'literal_address', value: USDC },
            ],
          },
        },
        {
          // Per-call input cap. The value bound is expressed against the
          // call's own argument, not an `amount` selector: the on-chain
          // interpreter cannot observe token movements, so `amount` is
          // reported as uncovered rather than lowered.
          op: 'lte',
          left: { kind: 'call_arg', index: 1 },
          right: { kind: 'literal_i128', value: '1000000000' },
        },
      ],
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    expect(res.covered).toBe(true)
    const doc = res.proposed?.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    // Hand-built expected predicate: path eq lowers to
    // eq(call_arg[0], literal_vec([XLM, USDC])) - element order preserved.
    const expectedNode: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: leafCallContract(),
          right: { kind: 'literal_address', value: BLEND_POOL },
        },
        { op: 'eq', left: leafCallFn(), right: { kind: 'literal_symbol', value: 'swap' } },
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: XLM },
              { kind: 'literal_address', value: USDC },
            ],
          },
        },
        {
          op: 'lte',
          left: { kind: 'call_arg', index: 1 },
          right: { kind: 'literal_i128', value: '1000000000' },
        },
      ],
    }
    const expected = encodePredicate(expectedNode)
    expect(doc.encodedPredicate).toBe(expected.encodedPredicate)
    expect(doc.predicateHash).toBe(expected.predicateHash)
  })

  it('eq_seq of [USDC,XLM] (reversed) yields DIFFERENT predicate bytes than [XLM,USDC]', () => {
    // This pins the exact-ordered-sequence semantic: reversing the sequence
    // produces a different predicate (the order is the semantic), which is
    // impossible to express with a sorted `in` allowlist.
    const ruleForward: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'swap' },
      constraints: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: XLM },
              { kind: 'literal_address', value: USDC },
            ],
          },
        },
      ],
    }
    const ruleReversed: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'swap' },
      constraints: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: USDC },
              { kind: 'literal_address', value: XLM },
            ],
          },
        },
      ],
    }
    const fwd = compileInterpreterPolicy(ruleForward, CONFIG)
    const rev = compileInterpreterPolicy(ruleReversed, CONFIG)
    expect(fwd.covered).toBe(true)
    expect(rev.covered).toBe(true)
    const fwdDoc = fwd.proposed?.policyDocuments[0]
    const revDoc = rev.proposed?.policyDocuments[0]
    expect(fwdDoc).toBeDefined()
    expect(revDoc).toBeDefined()
    if (!fwdDoc || !revDoc) return
    expect(fwdDoc.encodedPredicate).not.toBe(revDoc.encodedPredicate)
    expect(fwdDoc.predicateHash).not.toBe(revDoc.predicateHash)
  })

  it('eq_seq containing the smart account address throws SCOPE_SELF_CALL (same gate as in)', () => {
    const rule: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'swap' },
      constraints: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: XLM },
              { kind: 'literal_address', value: SMART_ACCOUNT },
            ],
          },
        },
      ],
    }
    try {
      compileInterpreterPolicy(rule, CONFIG)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string }
      expect(err.code).toBe('SCOPE_SELF_CALL')
    }
  })
})

describe('interpreter adapter - self-call rejection', () => {
  it('throws SCOPE_SELF_CALL when an `in` allowlist contains the smart account address', () => {
    const rule: ComposedRule = {
      scope: { contract: XLM, method: 'transfer' },
      constraints: [
        {
          op: 'in',
          needle: { kind: 'call_arg', index: 0 },
          haystack: [
            { kind: 'literal_address', value: RECIPIENT_A },
            { kind: 'literal_address', value: SMART_ACCOUNT },
          ],
        },
      ],
    }
    try {
      compileInterpreterPolicy(rule, CONFIG)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string }
      expect(err.code).toBe('SCOPE_SELF_CALL')
    }
  })

  it('accepts an `in` allowlist that does NOT contain the smart account address', () => {
    const rule: ComposedRule = {
      scope: { contract: XLM, method: 'transfer' },
      constraints: [
        {
          op: 'in',
          needle: { kind: 'call_arg', index: 0 },
          haystack: [
            { kind: 'literal_address', value: RECIPIENT_A },
            { kind: 'literal_address', value: RECIPIENT_B },
          ],
        },
      ],
    }
    expect(compileInterpreterPolicy(rule, CONFIG).covered).toBe(true)
  })

  it('throws SCOPE_SELF_CALL when a compare eq targets the smart account address', () => {
    const rule: ComposedRule = {
      scope: { contract: XLM, method: 'transfer' },
      constraints: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: { kind: 'literal_address', value: SMART_ACCOUNT },
        },
      ],
    }
    try {
      compileInterpreterPolicy(rule, CONFIG)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as { code?: string }
      expect(err.code).toBe('SCOPE_SELF_CALL')
    }
  })
})

describe('interpreter adapter - unsupported IR constructs', () => {
  it('maps validUntilLedger onto the context rule (Stellar-native expiry)', () => {
    const rule: ComposedRule = {
      scope: { contract: XLM, method: 'transfer' },
      constraints: [],
      expiry: { validUntilLedger: 1234567 },
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    expect(res.covered).toBe(true)
    expect(res.proposed?.contextRule.validUntilLedger).toBe(1234567)
  })

  it('produces an interpreter PolicyRef alongside a zero-arity policy doc', () => {
    const rule: ComposedRule = {
      scope: { contract: BLEND_POOL, method: 'claim' },
      constraints: [],
    }
    const res = compileInterpreterPolicy(rule, CONFIG)
    expect(res.proposed?.policyRefs[0]?.kind).toBe('interpreter')
  })
})
