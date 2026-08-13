import { describe, expect, it } from 'bun:test'
import type { IntentFacts } from './lower.ts'
import { decideScope, scopeToContextRuleType } from './scope.ts'

function facts(opts: Partial<IntentFacts> = {}): IntentFacts {
  return {
    callTargets: opts.callTargets ?? ['CTOKEN'],
    functionsByContract: opts.functionsByContract ?? { CTOKEN: ['transfer'] },
    spendByToken: opts.spendByToken ?? {},
    signers: opts.signers ?? ['GOWNER'],
    ...(opts.sharedRouter !== undefined ? { sharedRouter: opts.sharedRouter } : {}),
    ...(opts.allowedPaths !== undefined ? { allowedPaths: opts.allowedPaths } : {}),
  }
}

describe('decideScope - single call target', () => {
  it('returns CallContract(target) when exactly one contract is recorded', () => {
    const r = decideScope(facts({ callTargets: ['CTOKEN'] }), { network: 'mainnet' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.kind).toBe('call_contract')
    if (r.data.kind === 'call_contract') expect(r.data.contract).toBe('CTOKEN')
  })

  it('surfaces a DURATION_UNSPECIFIED ambiguity when no validUntilLedger is supplied', () => {
    const r = decideScope(facts({ callTargets: ['CTOKEN'] }), { network: 'mainnet' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.ambiguities.some((a) => a.code === 'DURATION_UNSPECIFIED')).toBe(true)
  })

  it('does NOT surface DURATION_UNSPECIFIED when validUntilLedger is supplied', () => {
    const r = decideScope(facts({ callTargets: ['CTOKEN'] }), {
      network: 'mainnet',
      validUntilLedger: 12345,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.ambiguities).toEqual([])
  })
})

describe('decideScope - sharedRouter', () => {
  it('returns CallContract(sharedRouter) when multiple targets share a router', () => {
    const f = facts({
      callTargets: ['CROUTER', 'CROUTER'],
      sharedRouter: 'CROUTER',
      functionsByContract: { CROUTER: ['swap_exact_tokens_for_tokens'] },
    })
    const r = decideScope(f, { network: 'mainnet' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.kind).toBe('call_contract')
    if (r.data.kind === 'call_contract') expect(r.data.contract).toBe('CROUTER')
  })
})

describe('decideScope - SCOPE_UNRESOLVED', () => {
  it('returns ToolError when multiple targets have no shared router', () => {
    const f = facts({
      callTargets: ['CA', 'CB'],
      functionsByContract: { CA: ['fn'], CB: ['fn'] },
    })
    const r = decideScope(f, { network: 'mainnet' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('SCOPE_UNRESOLVED')
    expect(r.error.severity).toBe('error')
    expect(r.error.retryable).toBe(false)
    expect(r.error.remediation?.userQuestion?.code).toBe('MULTIPLE_UNRELATED_TARGETS')
  })
})

describe('scopeToContextRuleType', () => {
  it('projects a call_contract scope to CallContract(kind)', () => {
    expect(
      scopeToContextRuleType({ kind: 'call_contract', contract: 'CX', ambiguities: [] })
    ).toEqual({ kind: 'call_contract', contract: 'CX' })
  })

  it('projects a default scope to {kind:default}', () => {
    expect(scopeToContextRuleType({ kind: 'default', ambiguities: [] })).toEqual({
      kind: 'default',
    })
  })
})

describe('decideScope - determinism', () => {
  it('same facts+opts -> identical decision across runs', () => {
    const f = facts({ callTargets: ['CTOKEN'] })
    const opts = { network: 'mainnet' as const }
    const a = decideScope(f, opts)
    const b = decideScope(f, opts)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
