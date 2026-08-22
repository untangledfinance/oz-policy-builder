// src/predicate/grammar-v4.test.ts - the operators and leaf added in grammar 4.
//
// Covers `or`, the ordering operators `lt`/`gt`/`gte`, and the
// `call_arg_scaled` slippage-floor leaf across all three layers this package
// owns: encode (wire bytes + the install-gate mirror), decode (round-trip),
// and the reference evaluator. The Rust side has its own suite; these tests
// exist so a divergence shows up here rather than at install.

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import { evaluate } from '../simulate/evaluate.ts'
import type { PredicateNode, ScVal } from '../types.ts'
import { decodePredicate } from './decode.ts'
import { encodePredicate } from './encode.ts'

const TOKEN_A = Address.contract(Buffer.alloc(32, 0x01)).toString()
const TOKEN_B = Address.contract(Buffer.alloc(32, 0x02)).toString()

/** `args = [in, out]`, the shape a swap policy bounds. */
function swapCtx(input: string, output: string) {
  return {
    contract: TOKEN_A,
    fn: 'swap',
    args: [
      { type: 'i128', value: input },
      { type: 'i128', value: output },
    ] as ScVal[],
  }
}

/** The canonical floor: `call_arg(1) >= call_arg_scaled(0, num, den)`. */
function floorNode(num: string, den: string): PredicateNode {
  return {
    op: 'gte',
    left: { kind: 'call_arg', index: 1 },
    right: { kind: 'call_arg_scaled', index: 0, num, den },
  }
}

describe('grammar v4 - or', () => {
  const orNode: PredicateNode = {
    op: 'or',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: TOKEN_A },
      },
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: TOKEN_B },
      },
    ],
  }

  it('permits when either branch holds', () => {
    for (const contract of [TOKEN_A, TOKEN_B]) {
      expect(evaluate(orNode, { contract, fn: 'transfer', args: [] })).toEqual({ permit: true })
    }
  })

  it('denies when no branch holds', () => {
    const other = Address.contract(Buffer.alloc(32, 0x09)).toString()
    expect(evaluate(orNode, { contract: other, fn: 'transfer', args: [] })).toEqual({
      permit: false,
      reason: 'CONTRACT_SCOPE',
    })
  })

  it('round-trips through the wire format', () => {
    const { encodedPredicate } = encodePredicate(orNode)
    const decoded = decodePredicate(encodedPredicate)
    expect(decoded.op).toBe('or')
    expect(evaluate(decoded, { contract: TOKEN_B, fn: 'transfer', args: [] })).toEqual({
      permit: true,
    })
  })

  it('refuses an empty disjunction at encode', () => {
    // An empty `or` denies regardless of the call, and the contract refuses it
    // at decode, so it must never reach a transaction.
    expect(() => encodePredicate({ op: 'or', children: [] })).toThrow()
  })

  it('denies an empty disjunction when evaluated directly', () => {
    // Unreachable through encode or decode, but `evaluate` is exported, so a
    // consumer can hand it an AST that never passed either gate. The fallback
    // has to be a DENY: returning permit would tell a caller simulating a
    // malformed predicate that the call was allowed.
    expect(evaluate({ op: 'or', children: [] }, { contract: TOKEN_A, fn: 'f', args: [] })).toEqual({
      permit: false,
      reason: 'UNSUPPORTED_NODE',
    })
  })
})

describe('grammar v4 - ordering operators', () => {
  const bound = (op: 'lt' | 'lte' | 'gt' | 'gte'): PredicateNode => ({
    op,
    left: { kind: 'call_arg', index: 0 },
    right: { kind: 'literal_i128', value: '100' },
  })
  const at = (v: string) => ({
    contract: TOKEN_A,
    fn: 'f',
    args: [{ type: 'i128', value: v }] as ScVal[],
  })

  it('keeps strictness at the bound', () => {
    // The pair that would collapse if lt/lte or gt/gte were confused.
    expect(evaluate(bound('lt'), at('100')).permit).toBe(false)
    expect(evaluate(bound('lte'), at('100')).permit).toBe(true)
    expect(evaluate(bound('gt'), at('100')).permit).toBe(false)
    expect(evaluate(bound('gte'), at('100')).permit).toBe(true)
  })

  it('orders correctly away from the bound', () => {
    expect(evaluate(bound('lt'), at('99')).permit).toBe(true)
    expect(evaluate(bound('gt'), at('101')).permit).toBe(true)
    expect(evaluate(bound('lt'), at('101')).permit).toBe(false)
    expect(evaluate(bound('gt'), at('99')).permit).toBe(false)
  })

  it('round-trips every ordering operator through the wire format', () => {
    for (const op of ['lt', 'lte', 'gt', 'gte'] as const) {
      const decoded = decodePredicate(encodePredicate(bound(op)).encodedPredicate)
      expect(decoded.op).toBe(op)
    }
  })
})

describe('grammar v4 - call_arg_scaled slippage floor', () => {
  it('permits an output at or above the ratio and denies below it', () => {
    // 1000 * 99/100 = 990.
    expect(evaluate(floorNode('99', '100'), swapCtx('1000', '995'))).toEqual({ permit: true })
    expect(evaluate(floorNode('99', '100'), swapCtx('1000', '990'))).toEqual({ permit: true })
    expect(evaluate(floorNode('99', '100'), swapCtx('1000', '989'))).toEqual({
      permit: false,
      reason: 'SLIPPAGE_FLOOR',
    })
  })

  it('truncates toward zero', () => {
    // 1000 * 1/3 = 333.33 -> 333. An output of exactly 333 must clear the
    // floor; rounding up to 334 would deny it.
    expect(evaluate(floorNode('1', '3'), swapCtx('1000', '333'))).toEqual({ permit: true })
  })

  it('keeps strictness at the bound for every ordering operator', () => {
    const ctx = swapCtx('1000', '990')
    const withOp = (op: 'lt' | 'lte' | 'gt' | 'gte'): PredicateNode => ({
      op,
      left: { kind: 'call_arg', index: 1 },
      right: { kind: 'call_arg_scaled', index: 0, num: '99', den: '100' },
    })
    expect(evaluate(withOp('gte'), ctx).permit).toBe(true)
    expect(evaluate(withOp('lte'), ctx).permit).toBe(true)
    expect(evaluate(withOp('gt'), ctx).permit).toBe(false)
    expect(evaluate(withOp('lt'), ctx).permit).toBe(false)
  })

  it('denies on i128 overflow rather than wrapping', () => {
    const huge = (2n ** 127n - 1n).toString()
    expect(evaluate(floorNode('2', '1'), swapCtx(huge, '1'))).toEqual({
      permit: false,
      reason: 'ARITHMETIC_OVERFLOW',
    })
  })

  it('reports a missing operand as ARG_MISMATCH, not a floor miss', () => {
    // Could not READ the operand is a different failure from read-and-missed.
    const n: PredicateNode = {
      op: 'gte',
      left: { kind: 'call_arg', index: 1 },
      right: { kind: 'call_arg_scaled', index: 9, num: '1', den: '1' },
    }
    expect(evaluate(n, swapCtx('10', '10'))).toEqual({ permit: false, reason: 'ARG_MISMATCH' })
  })

  it('refuses to chain two scaled operands', () => {
    const n: PredicateNode = {
      op: 'gte',
      left: { kind: 'call_arg_scaled', index: 0, num: '1', den: '1' },
      right: { kind: 'call_arg_scaled', index: 1, num: '1', den: '1' },
    }
    expect(evaluate(n, swapCtx('10', '10'))).toEqual({ permit: false, reason: 'UNSUPPORTED_NODE' })
  })

  it('round-trips through the wire format', () => {
    const decoded = decodePredicate(encodePredicate(floorNode('99', '100')).encodedPredicate)
    expect(decoded).toEqual(floorNode('99', '100'))
    expect(evaluate(decoded, swapCtx('1000', '995'))).toEqual({ permit: true })
  })

  it('counts as a selector leaf, so a floor alone is installable', () => {
    // It reads the call, so a predicate made only of it constrains something.
    // If it did not count, encode would refuse it as SELECTOR_LEAF_REQUIRED.
    expect(() => encodePredicate(floorNode('99', '100'))).not.toThrow()
  })
})

describe('grammar v4 - encode mirrors the install ratio gate', () => {
  // The contract refuses these at install with INVALID_SCALED_RATIO (214).
  // Encode has to refuse them too, or the TS self-verify would green-light a
  // predicate the chain rejects.
  it('refuses a zero denominator', () => {
    expect(() => encodePredicate(floorNode('99', '0'))).toThrow(/zero|INVALID_SCALED_RATIO/i)
  })

  it('refuses a ratio that would invert the comparison', () => {
    for (const [num, den] of [
      ['-1', '100'],
      ['1', '-100'],
      ['0', '100'],
    ]) {
      expect(() => encodePredicate(floorNode(num as string, den as string))).toThrow()
    }
  })

  it('accepts a real floor', () => {
    expect(() => encodePredicate(floorNode('99', '100'))).not.toThrow()
  })
})
