// src/synth/evaluate.test.ts - model evaluator tests.
//
// Pure-function tests for the TS-model interpreter semantics. The evaluator is
// the single semantic evaluator every deny-case runs through. These tests pin
// the 10-step deny order (deny on FIRST violation, stable reason string).

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { PredicateLeaf, PredicateNode, ScVal } from '../types.ts'
import { type EvalContext, evaluate } from './evaluate.ts'

// Real, deterministic Stellar contract addresses (checksum-validated).
const TOKEN_A = Address.contract(Buffer.alloc(32, 0x01)).toString()
const BLEND_POOL = Address.contract(Buffer.alloc(32, 0x10)).toString()
const USDC_SAC = Address.contract(Buffer.alloc(32, 0x20)).toString()
const SOROSWAP_ROUTER = Address.contract(Buffer.alloc(32, 0x30)).toString()
const XLM_SAC = Address.contract(Buffer.alloc(32, 0x40)).toString()
const RECIPIENT_OK = Address.contract(Buffer.alloc(32, 0x50)).toString()
const RECIPIENT_OK2 = Address.contract(Buffer.alloc(32, 0x51)).toString()
const RECIPIENT_BAD = Address.contract(Buffer.alloc(32, 0x52)).toString()
const HOP_A = Address.contract(Buffer.alloc(32, 0x60)).toString()
const HOP_B = Address.contract(Buffer.alloc(32, 0x61)).toString()

const NOW = 1_700_000_000
const LEDGER = 1_000_000

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    contract: BLEND_POOL,
    fn: 'claim',
    args: [],
    atLedger: LEDGER,
    validUntilLedger: LEDGER + 1_000,
    nowSeconds: NOW,
    amountByToken: {},
    windowSpentByToken: {},
    ...overrides,
  }
}

function address(s: string): ScVal {
  return { type: 'address', value: s }
}

function i128(s: string): ScVal {
  return { type: 'i128', value: s }
}

describe('evaluate - step 1: EXPIRED by ledger', () => {
  it('denies EXPIRED when atLedger exceeds validUntilLedger', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(
      predicate,
      ctx({ atLedger: LEDGER + 2_000, validUntilLedger: LEDGER + 1_000 })
    )
    expect(result).toEqual({ permit: false, reason: 'EXPIRED' })
  })

  it('permits when atLedger is exactly validUntilLedger (boundary inclusive)', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(
      predicate,
      ctx({ atLedger: LEDGER + 1_000, validUntilLedger: LEDGER + 1_000 })
    )
    expect(result).toEqual({ permit: true })
  })

  it('skips the ledger check entirely when validUntilLedger is undefined', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(predicate, ctx({ atLedger: 999_999_999, validUntilLedger: undefined }))
    expect(result).toEqual({ permit: true })
  })
})

describe('evaluate - step 3: CONTRACT_SCOPE', () => {
  it('denies CONTRACT_SCOPE when the scoped contract differs from ctx.contract', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: TOKEN_A },
    }
    const result = evaluate(predicate, ctx({ contract: BLEND_POOL }))
    expect(result).toEqual({ permit: false, reason: 'CONTRACT_SCOPE' })
  })

  it('permits when the scoped contract matches ctx.contract', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: BLEND_POOL },
    }
    const result = evaluate(predicate, ctx({ contract: BLEND_POOL }))
    expect(result).toEqual({ permit: true })
  })
})

describe('evaluate - step 4: FN_MISMATCH and ARG_MISMATCH', () => {
  it('denies FN_MISMATCH when call_fn does not match the literal', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'withdraw' },
    }
    const result = evaluate(predicate, ctx({ fn: 'claim' }))
    expect(result).toEqual({ permit: false, reason: 'FN_MISMATCH' })
  })

  it('permits when call_fn matches the literal', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(predicate, ctx({ fn: 'claim' }))
    expect(result).toEqual({ permit: true })
  })

  it('denies ARG_MISMATCH when call_arg[i] is not present in ctx.args (out-of-range index)', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_address', value: RECIPIENT_OK },
    }
    const result = evaluate(predicate, ctx({ args: [] }))
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg[i] value differs from the literal', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_address', value: RECIPIENT_OK },
    }
    const result = evaluate(predicate, ctx({ args: [address(RECIPIENT_BAD)] }))
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when the ctx arg has type "other" (opaque/undecodable)', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_address', value: RECIPIENT_OK },
    }
    const result = evaluate(predicate, ctx({ args: [{ type: 'other', value: 'opaque-blob' }] }))
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('permits when call_arg[i] matches the literal (i128)', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_i128', value: '1000000' },
    }
    const result = evaluate(predicate, ctx({ args: [i128('1000000')] }))
    expect(result).toEqual({ permit: true })
  })
})

describe('evaluate - step 4b: ordered numeric bound on call_arg (input-amount cap)', () => {
  const argCap = (op: 'lt' | 'lte' | 'gt' | 'gte', value: string): PredicateNode => ({
    op,
    left: { kind: 'call_arg', index: 0 },
    right: { kind: 'literal_i128', value },
  })

  it('permits when call_arg[0] is at or below an lte cap (boundary inclusive)', () => {
    expect(evaluate(argCap('lte', '1000000'), ctx({ args: [i128('1000000')] }))).toEqual({
      permit: true,
    })
    expect(evaluate(argCap('lte', '1000000'), ctx({ args: [i128('999999')] }))).toEqual({
      permit: true,
    })
  })

  it('denies ARG_MISMATCH when call_arg[0] exceeds an lte cap', () => {
    expect(evaluate(argCap('lte', '1000000'), ctx({ args: [i128('1000001')] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })

  it('honours lt / gt / gte on a numeric call_arg', () => {
    expect(evaluate(argCap('lt', '10'), ctx({ args: [i128('9')] }))).toEqual({ permit: true })
    expect(evaluate(argCap('lt', '10'), ctx({ args: [i128('10')] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
    expect(evaluate(argCap('gt', '10'), ctx({ args: [i128('11')] }))).toEqual({ permit: true })
    expect(evaluate(argCap('gte', '10'), ctx({ args: [i128('10')] }))).toEqual({ permit: true })
  })

  it('fails closed (ARG_MISMATCH) on an ordered compare against a non-numeric or opaque arg', () => {
    expect(evaluate(argCap('lte', '1000000'), ctx({ args: [address(RECIPIENT_OK)] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
    expect(
      evaluate(argCap('lte', '1000000'), ctx({ args: [{ type: 'other', value: 'opaque' }] }))
    ).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
    expect(evaluate(argCap('lte', '1000000'), ctx({ args: [] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })

  it('fails closed (ARG_MISMATCH) when the compared literal is non-numeric', () => {
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_address', value: RECIPIENT_OK },
    }
    expect(evaluate(predicate, ctx({ args: [i128('1000000')] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })
})

describe('evaluate - call_arg_len', () => {
  it('permits when call_arg_len == matches a vec of the recorded length', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_len', index: 0 },
      right: { kind: 'literal_u32', value: 2 },
    }
    const result = evaluate(
      predicate,
      ctx({
        args: [
          {
            type: 'vec',
            value: [
              { type: 'u32', value: '1' },
              { type: 'u32', value: '2' },
            ],
          },
        ],
      })
    )
    expect(result).toEqual({ permit: true })
  })

  it('denies ARG_MISMATCH when vec length differs from the literal', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_len', index: 0 },
      right: { kind: 'literal_u32', value: 0 },
    }
    const result = evaluate(
      predicate,
      ctx({
        args: [{ type: 'vec', value: [{ type: 'u32', value: '1' }] }],
      })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg_len resolves against a non-vec arg', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_len', index: 0 },
      right: { kind: 'literal_u32', value: 0 },
    }
    expect(evaluate(predicate, ctx({ args: [address(RECIPIENT_OK)] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })

  it('denies ARG_MISMATCH when call_arg_len resolves against an absent arg', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_len', index: 0 },
      right: { kind: 'literal_u32', value: 0 },
    }
    expect(evaluate(predicate, ctx({ args: [] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })

  it('denies ARG_MISMATCH when call_arg_len is compared against a non-u32 literal', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_len', index: 0 },
      right: { kind: 'literal_i128', value: '0' },
    }
    const result = evaluate(predicate, ctx({ args: [{ type: 'vec', value: [] }] }))
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })
})

describe('evaluate - call_arg_field', () => {
  // Map shape mirroring Blend Request{ address, amount, request_type }.
  const blendRequest = (requestType: string, amt: string, addr: string): ScVal => ({
    type: 'map',
    value: [
      { key: 'address', val: { type: 'address', value: addr } },
      { key: 'amount', val: { type: 'i128', value: amt } },
      { key: 'request_type', val: { type: 'u32', value: requestType } },
    ],
  })

  it('permits when call_arg_field[0].request_type matches the recorded u32', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('3', '50000000', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: true })
  })

  it('denies ARG_MISMATCH when call_arg_field element is not the recorded one (evil twin: 3 -> 4)', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('4', '50000000', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg_field is compared against a non-map vec element', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [{ type: 'u32', value: '3' }] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg_field addresses the wrong element index', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 1, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('3', '50000000', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg_field references a non-existent field', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'unknown' },
      right: { kind: 'literal_symbol', value: 'x' },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('3', '50000000', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg_field resolves against a non-vec arg', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    expect(evaluate(predicate, ctx({ args: [address(RECIPIENT_OK)] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })

  it('denies ARG_MISMATCH when call_arg_field references a map element with a non-string key list', () => {
    // A map whose entry collection is malformed (not an array) should fail closed.
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const malformed = {
      type: 'map',
      value: { not: 'an array' },
    } as unknown as ScVal
    expect(evaluate(predicate, ctx({ args: [{ type: 'vec', value: [malformed] }] }))).toEqual({
      permit: false,
      reason: 'ARG_MISMATCH',
    })
  })

  it('compares an address field on a map element', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'address' },
      right: { kind: 'literal_address', value: RECIPIENT_OK },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('3', '50000000', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: true })
  })

  it('compares an i128 amount field on a map element (lte cap)', () => {
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'amount' },
      right: { kind: 'literal_i128', value: '50000000' },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('3', '50000000', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: true })
  })

  it('denies ARG_MISMATCH when the i128 amount field exceeds the lte cap', () => {
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'amount' },
      right: { kind: 'literal_i128', value: '50000000' },
    }
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [blendRequest('3', '50000001', RECIPIENT_OK)] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when call_arg_field references a vec that has been replaced (vec append)', () => {
    // Two recorded elements; the predicate pins element 0. An evil twin appends
    // a third element with a different request_type. The length leaf must
    // catch this; the per-element leaf alone cannot.
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_arg_field', index: 0, element: 0, field: 'request_type' },
      right: { kind: 'literal_u32', value: 3 },
    }
    const result = evaluate(
      predicate,
      ctx({
        args: [
          {
            type: 'vec',
            value: [
              blendRequest('3', '50000000', RECIPIENT_OK),
              blendRequest('4', '50000000', RECIPIENT_OK),
            ],
          },
        ],
      })
    )
    // The per-element leaf permits element 0=='3', but the policy should NOT
    // permit because the vec has been appended. The length leaf (emitted in
    // addition, not in this test) is what catches it - this test isolates the
    // per-element leaf behaviour so the design boundary is explicit.
    expect(result).toEqual({ permit: true })
  })
})

describe('evaluate - step 4: exact-vec equality (literal_vec)', () => {
  const vecPredicate = (elements: PredicateLeaf[]): PredicateNode => ({
    op: 'eq',
    left: { kind: 'call_arg', index: 0 },
    right: { kind: 'literal_vec', elements },
  })

  it('permits when the ctx arg vec matches the literal_vec element-for-element in order', () => {
    const predicate = vecPredicate([
      { kind: 'literal_address', value: HOP_A },
      { kind: 'literal_address', value: HOP_B },
    ])
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [address(HOP_A), address(HOP_B)] }] })
    )
    expect(result).toEqual({ permit: true })
  })

  it('denies ARG_MISMATCH when the ctx vec is reversed (different order)', () => {
    const predicate = vecPredicate([
      { kind: 'literal_address', value: HOP_A },
      { kind: 'literal_address', value: HOP_B },
    ])
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [address(HOP_B), address(HOP_A)] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when the ctx vec is shorter than the literal_vec', () => {
    const predicate = vecPredicate([
      { kind: 'literal_address', value: HOP_A },
      { kind: 'literal_address', value: HOP_B },
    ])
    const result = evaluate(predicate, ctx({ args: [{ type: 'vec', value: [address(HOP_A)] }] }))
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when the ctx vec is longer than the literal_vec', () => {
    const predicate = vecPredicate([{ kind: 'literal_address', value: HOP_A }])
    const result = evaluate(
      predicate,
      ctx({ args: [{ type: 'vec', value: [address(HOP_A), address(HOP_B)] }] })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('denies ARG_MISMATCH when the ctx vec is empty and the literal_vec is not', () => {
    const predicate = vecPredicate([{ kind: 'literal_address', value: HOP_A }])
    const result = evaluate(predicate, ctx({ args: [{ type: 'vec', value: [] }] }))
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('permits when BOTH the ctx vec and the literal_vec are empty', () => {
    const predicate = vecPredicate([])
    const result = evaluate(predicate, ctx({ args: [{ type: 'vec', value: [] }] }))
    expect(result).toEqual({ permit: true })
  })

  it('denies ARG_MISMATCH when an element differs in the middle of the vec', () => {
    const predicate = vecPredicate([
      { kind: 'literal_address', value: HOP_A },
      { kind: 'literal_address', value: HOP_B },
      { kind: 'literal_address', value: RECIPIENT_OK },
    ])
    const result = evaluate(
      predicate,
      ctx({
        args: [{ type: 'vec', value: [address(HOP_A), address(HOP_B), address(RECIPIENT_BAD)] }],
      })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })
})

describe('evaluate - step 5: NOT_IN_ALLOWLIST', () => {
  it('denies NOT_IN_ALLOWLIST when needle is not in the haystack', () => {
    const predicate: PredicateNode = {
      op: 'in',
      needle: { kind: 'call_arg', index: 0 },
      haystack: [
        { kind: 'literal_address', value: RECIPIENT_OK },
        { kind: 'literal_address', value: RECIPIENT_OK2 },
      ],
    }
    const result = evaluate(predicate, ctx({ args: [address(RECIPIENT_BAD)] }))
    expect(result).toEqual({ permit: false, reason: 'NOT_IN_ALLOWLIST' })
  })

  it('permits when the needle is in the haystack', () => {
    const predicate: PredicateNode = {
      op: 'in',
      needle: { kind: 'call_arg', index: 0 },
      haystack: [
        { kind: 'literal_address', value: RECIPIENT_OK },
        { kind: 'literal_address', value: RECIPIENT_OK2 },
      ],
    }
    const result = evaluate(predicate, ctx({ args: [address(RECIPIENT_OK2)] }))
    expect(result).toEqual({ permit: true })
  })

  it('ALWAYS denies NOT_IN_ALLOWLIST when the haystack is empty', () => {
    const predicate: PredicateNode = {
      op: 'in',
      needle: { kind: 'call_arg', index: 0 },
      haystack: [],
    }
    const result = evaluate(predicate, ctx({ args: [address(RECIPIENT_OK)] }))
    expect(result).toEqual({ permit: false, reason: 'NOT_IN_ALLOWLIST' })
  })

  it('denies NOT_IN_ALLOWLIST when the needle type is "other" (opaque/undecodable)', () => {
    const predicate: PredicateNode = {
      op: 'in',
      needle: { kind: 'call_arg', index: 0 },
      haystack: [{ kind: 'literal_address', value: RECIPIENT_OK }],
    }
    const result = evaluate(predicate, ctx({ args: [{ type: 'other', value: 'opaque' }] }))
    expect(result).toEqual({ permit: false, reason: 'NOT_IN_ALLOWLIST' })
  })
})

describe('evaluate - step 6: AMOUNT_BOUND', () => {
  it('denies AMOUNT_BOUND when amount exceeds the bound (gt)', () => {
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'amount', token: TOKEN_A },
      right: { kind: 'literal_i128', value: '1000' },
    }
    const result = evaluate(predicate, ctx({ amountByToken: { [TOKEN_A]: '2000' } }))
    expect(result).toEqual({ permit: false, reason: 'AMOUNT_BOUND' })
  })

  it('permits when amount equals the bound (lte inclusive)', () => {
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'amount', token: TOKEN_A },
      right: { kind: 'literal_i128', value: '1000' },
    }
    const result = evaluate(predicate, ctx({ amountByToken: { [TOKEN_A]: '1000' } }))
    expect(result).toEqual({ permit: true })
  })

  it('denies AMOUNT_BOUND on a window_spent check', () => {
    const predicate: PredicateNode = {
      op: 'lt',
      left: { kind: 'window_spent', token: TOKEN_A, windowSeconds: 3600 },
      right: { kind: 'literal_i128', value: '500' },
    }
    const result = evaluate(predicate, ctx({ windowSpentByToken: { [TOKEN_A]: '700' } }))
    expect(result).toEqual({ permit: false, reason: 'AMOUNT_BOUND' })
  })

  it('permits a window_spent check at boundary (lt)', () => {
    const predicate: PredicateNode = {
      op: 'lt',
      left: { kind: 'window_spent', token: TOKEN_A, windowSeconds: 3600 },
      right: { kind: 'literal_i128', value: '500' },
    }
    const result = evaluate(predicate, ctx({ windowSpentByToken: { [TOKEN_A]: '499' } }))
    expect(result).toEqual({ permit: true })
  })

  it('BigInt: large amounts (above Number.MAX_SAFE_INTEGER) compare correctly', () => {
    const big = '123456789012345678901234567890'
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'amount', token: TOKEN_A },
      right: { kind: 'literal_i128', value: big },
    }
    const result = evaluate(
      predicate,
      ctx({ amountByToken: { [TOKEN_A]: '999999999999999999999999999999' } })
    )
    expect(result).toEqual({ permit: false, reason: 'AMOUNT_BOUND' })
  })
})

describe('evaluate - THRESHOLD_NOT_MET', () => {
  it('denies THRESHOLD_NOT_MET when signerWeights is provided but empty', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(predicate, ctx({ signerWeights: {} }))
    expect(result).toEqual({ permit: false, reason: 'THRESHOLD_NOT_MET' })
  })

  it('denies THRESHOLD_NOT_MET when the cumulative weight is zero (positive-weight signers absent)', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(predicate, ctx({ signerWeights: { GZERO: 0 } }))
    expect(result).toEqual({ permit: false, reason: 'THRESHOLD_NOT_MET' })
  })

  it('permits when at least one signer carries positive weight', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(predicate, ctx({ signerWeights: { GOWNER: 1 } }))
    expect(result).toEqual({ permit: true })
  })

  it('skips the threshold check entirely when signerWeights is undefined', () => {
    const predicate: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    }
    const result = evaluate(predicate, ctx({ signerWeights: undefined }))
    expect(result).toEqual({ permit: true })
  })
})

describe('evaluate - step 9: boolean nodes', () => {
  it('and: permits when every child permits', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'claim' } },
        {
          op: 'eq',
          left: { kind: 'call_contract' },
          right: { kind: 'literal_address', value: BLEND_POOL },
        },
      ],
    }
    const result = evaluate(predicate, ctx())
    expect(result).toEqual({ permit: true })
  })

  it('and: denies with the FIRST child reason when any child denies (stable reason)', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        // first child fails on CONTRACT_SCOPE
        {
          op: 'eq',
          left: { kind: 'call_contract' },
          right: { kind: 'literal_address', value: TOKEN_A },
        },
        // second child would also fail (would be ARG_MISMATCH) but AND denies
        // on FIRST violation in traversal order.
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 99 },
          right: { kind: 'literal_address', value: RECIPIENT_OK },
        },
      ],
    }
    const result = evaluate(predicate, ctx())
    expect(result).toEqual({ permit: false, reason: 'CONTRACT_SCOPE' })
  })

  it('or: permits when any child permits', () => {
    const predicate: PredicateNode = {
      op: 'or',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'withdraw' },
        }, // deny
        { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'claim' } }, // permit
      ],
    }
    const result = evaluate(predicate, ctx())
    expect(result).toEqual({ permit: true })
  })

  it('or: denies when all children deny (reason is from the LAST child)', () => {
    const predicate: PredicateNode = {
      op: 'or',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'withdraw' },
        },
        {
          op: 'eq',
          left: { kind: 'call_contract' },
          right: { kind: 'literal_address', value: TOKEN_A },
        },
      ],
    }
    const result = evaluate(predicate, ctx())
    expect(result).toEqual({ permit: false, reason: 'CONTRACT_SCOPE' })
  })

  it('not: permits when child denies', () => {
    const predicate: PredicateNode = {
      op: 'not',
      child: {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'withdraw' },
      },
    }
    const result = evaluate(predicate, ctx())
    expect(result).toEqual({ permit: true })
  })

  it('not: denies when child permits', () => {
    const predicate: PredicateNode = {
      op: 'not',
      child: {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'claim' },
      },
    }
    const result = evaluate(predicate, ctx())
    expect(result).toEqual({ permit: false, reason: 'FN_MISMATCH' })
  })
})

describe('evaluate - permit paths (reference walkthroughs)', () => {
  it('SEP-41 recipient allowlist: and(call_fn=transfer, call_arg[0] in allowlist) permits a known recipient', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'transfer' },
        },
        {
          op: 'in',
          needle: { kind: 'call_arg', index: 0 },
          haystack: [
            { kind: 'literal_address', value: RECIPIENT_OK },
            { kind: 'literal_address', value: RECIPIENT_OK2 },
          ],
        },
      ],
    }
    const result = evaluate(
      predicate,
      ctx({ contract: USDC_SAC, fn: 'transfer', args: [address(RECIPIENT_OK)] })
    )
    expect(result).toEqual({ permit: true })
  })

  it('SEP-41 recipient allowlist: denies NOT_IN_ALLOWLIST for an unknown recipient', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'transfer' },
        },
        {
          op: 'in',
          needle: { kind: 'call_arg', index: 0 },
          haystack: [{ kind: 'literal_address', value: RECIPIENT_OK }],
        },
      ],
    }
    const result = evaluate(
      predicate,
      ctx({ contract: USDC_SAC, fn: 'transfer', args: [address(RECIPIENT_BAD)] })
    )
    expect(result).toEqual({ permit: false, reason: 'NOT_IN_ALLOWLIST' })
  })

  it('Soroswap exact-path+amount: permits when path matches and amount is within bound', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: XLM_SAC },
              { kind: 'literal_address', value: USDC_SAC },
            ],
          },
        },
        {
          op: 'lte',
          left: { kind: 'amount', token: XLM_SAC },
          right: { kind: 'literal_i128', value: '1000000000' },
        },
      ],
    }
    const result = evaluate(
      predicate,
      ctx({
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [{ type: 'vec', value: [address(XLM_SAC), address(USDC_SAC)] }],
        amountByToken: { [XLM_SAC]: '900000000' },
      })
    )
    expect(result).toEqual({ permit: true })
  })

  it('Soroswap exact-path: denies ARG_MISMATCH when the path is reversed', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_arg', index: 0 },
          right: {
            kind: 'literal_vec',
            elements: [
              { kind: 'literal_address', value: XLM_SAC },
              { kind: 'literal_address', value: USDC_SAC },
            ],
          },
        },
      ],
    }
    const result = evaluate(
      predicate,
      ctx({
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [{ type: 'vec', value: [address(USDC_SAC), address(XLM_SAC)] }],
      })
    )
    expect(result).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })
})
