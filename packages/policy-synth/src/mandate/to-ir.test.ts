import { describe, expect, it } from 'bun:test'
import type { PolicyIR } from '../ir/types.ts'
import { mandateToPolicyIR } from './to-ir.ts'
import type { MandateSpec } from './types.ts'

describe('mandateToPolicyIR', () => {
  it('lowers a subscription mandate (spendingLimit) to the exact PolicyIR', () => {
    const spec: MandateSpec = {
      chain: 'stellar',
      contract: 'CTOKEN',
      method: 'transfer',
      spendingLimit: { token: 'CTOKEN', limit: '5000000', windowSeconds: 2592000 },
      expiry: { validUntilLedger: 1000000 },
    }

    const expected: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 2592000 },
                operator: 'lte',
                value: '5000000',
              },
            },
          ],
          expiry: { validUntilLedger: 1000000 },
        },
      ],
    }

    expect(mandateToPolicyIR(spec)).toEqual(expected)
  })

  it('is deterministic: same spec -> deep-equal IR across runs', () => {
    const spec: MandateSpec = {
      chain: 'stellar',
      contract: 'CTOKEN',
      method: 'transfer',
      spendingLimit: { token: 'CTOKEN', limit: '1', windowSeconds: 86400 },
      approvalThreshold: 2,
    }
    const a = mandateToPolicyIR(spec)
    const b = mandateToPolicyIR(spec)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('lowers approvalThreshold to rule.approval.threshold', () => {
    const ir = mandateToPolicyIR({ chain: 'stellar', contract: 'CX', approvalThreshold: 3 })
    expect(ir.rules[0]?.approval).toEqual({ kind: 'threshold', threshold: 3 })
  })

  it('lowers recipients to an `in` condition on an arg selector', () => {
    const ir = mandateToPolicyIR({
      chain: 'stellar',
      contract: 'CTOKEN',
      method: 'transfer',
      recipients: ['GRECIP_A', 'GRECIP_B'],
    })
    const cond = ir.rules[0]?.constraints[0]
    expect(cond?.op).toBe('in')
    if (cond?.op === 'in') {
      expect(cond.selector.kind).toBe('arg')
      expect(cond.values).toEqual(['GRECIP_A', 'GRECIP_B'])
    }
  })

  it('omits method / expiry / approval when the spec does not set them', () => {
    const ir = mandateToPolicyIR({ chain: 'stellar', contract: 'CX' })
    const rule = ir.rules[0]
    expect(rule?.scope).toEqual({ contract: 'CX' })
    expect(rule?.constraints).toEqual([])
    expect(rule && 'expiry' in rule).toBe(false)
    expect(rule && 'approval' in rule).toBe(false)
  })
})
