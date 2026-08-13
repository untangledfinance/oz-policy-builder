import { describe, expect, it } from 'bun:test'
import { placeholderOzConfig } from '../adapters/oz/adapter.ts'
import type { MandateSpec } from '../mandate/types.ts'
import { synthesizeFromMandate } from './synthesize-from-mandate.ts'

const ozConfig = placeholderOzConfig('testnet')

describe('synthesizeFromMandate', () => {
  it('lowers a SEP-41 subscription mandate to a ProposedPolicy carrying spending_limit', () => {
    const spec: MandateSpec = {
      chain: 'stellar',
      contract: 'CTOKEN',
      method: 'transfer',
      spendingLimit: { token: 'CTOKEN', limit: '5000000', windowSeconds: 2592000 },
      expiry: { validUntilLedger: 1000000 },
    }
    const res = synthesizeFromMandate(spec, ozConfig)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const p = res.data
    expect(p.contextRule.contextRuleType).toEqual({ kind: 'call_contract', contract: 'CTOKEN' })
    const ref = p.policyRefs[0]
    expect(ref?.kind).toBe('oz_builtin')
    if (ref?.kind === 'oz_builtin') {
      expect(ref.primitive).toEqual({
        primitive: 'spending_limit',
        // OZ params: no token (bound via the CallContract scope), window in ledgers.
        params: { spending_limit: '5000000', period_ledgers: 518400 },
      })
    }
    expect(p.parseConfidence.overall).toBe(1)
    expect(p.parseConfidence.thresholdUsed).toBe(1)
    expect(p.warnings.some((w) => w.includes('per-method scoping'))).toBe(true)
  })

  it('is deterministic: byte-identical ProposedPolicy across runs', () => {
    const spec: MandateSpec = {
      chain: 'stellar',
      contract: 'CTOKEN',
      method: 'transfer',
      spendingLimit: { token: 'CTOKEN', limit: '5000000', windowSeconds: 2592000 },
    }
    const a = synthesizeFromMandate(spec, ozConfig)
    const b = synthesizeFromMandate(spec, ozConfig)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('warns that a recipient allowlist and per-method scoping are Path-B while still carrying the covered spending_limit', () => {
    const spec: MandateSpec = {
      chain: 'stellar',
      contract: 'CTOKEN',
      method: 'transfer',
      spendingLimit: { token: 'CTOKEN', limit: '5000000', windowSeconds: 2592000 },
      recipients: ['GRECIP_A', 'GRECIP_B'],
    }
    const res = synthesizeFromMandate(spec, ozConfig)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(
      res.data.policyRefs.some(
        (r) => r.kind === 'oz_builtin' && r.primitive.primitive === 'spending_limit'
      )
    ).toBe(true)
    expect(res.data.warnings.some((w) => w.includes('allowlist'))).toBe(true)
    expect(
      res.data.warnings.some((w) => w.startsWith('Not covered by OZ built-in primitives'))
    ).toBe(true)
    expect(res.data.warnings.some((w) => w.includes('per-method scoping'))).toBe(true)
  })
})
