import { describe, expect, it } from 'bun:test'
import type { IRCondition, IRPolicyRule, PolicyIR } from './types.ts'

describe('PolicyIR reference shapes', () => {
  it('constructs a spending-limit rule (window_spent <= L)', () => {
    const spendConstraint: IRCondition = {
      op: 'compare',
      compare: {
        selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
        operator: 'lte',
        value: '1000000',
      },
    }
    const rule: IRPolicyRule = {
      roles: [],
      scope: { contract: 'CCONTRACT', method: 'transfer' },
      constraints: [spendConstraint],
      expiry: { validUntilLedger: 123456 },
    }
    const ir: PolicyIR = { chain: 'stellar', defaultBehavior: 'deny_all', rules: [rule] }

    const first = ir.rules[0]?.constraints[0]
    expect(first?.op).toBe('compare')
    if (first?.op === 'compare') {
      expect(first.compare.selector.kind).toBe('window_spent')
      expect(first.compare.operator).toBe('lte')
      expect(first.compare.value).toBe('1000000')
    }
    expect(ir.rules[0]?.expiry?.validUntilLedger).toBe(123456)
  })

  it('constructs a threshold rule (M-of-N approval)', () => {
    const rule: IRPolicyRule = {
      roles: ['agent'],
      scope: { contract: 'CCONTRACT' },
      constraints: [],
      approval: { kind: 'threshold', threshold: 2, weights: { GSIGNER_A: 1, GSIGNER_B: 1 } },
    }
    const ir: PolicyIR = { chain: 'stellar', defaultBehavior: 'deny_all', rules: [rule] }

    expect(ir.rules[0]?.approval?.threshold).toBe(2)
    expect(ir.rules[0]?.approval?.weights?.GSIGNER_A).toBe(1)
  })

  it('constructs an `in` allowlist condition on an arg selector', () => {
    const cond: IRCondition = {
      op: 'in',
      selector: { kind: 'arg', argIndex: 1, scalarType: 'address' },
      values: ['GRECIP_A', 'GRECIP_B'],
    }
    expect(cond.op).toBe('in')
    if (cond.op === 'in') {
      expect(cond.selector.kind).toBe('arg')
      expect(cond.values.length).toBe(2)
    }
  })
})
