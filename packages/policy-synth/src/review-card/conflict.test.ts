import { describe, expect, it } from 'bun:test'
import { classifyConflict, type RuleRef } from './conflict.ts'

function ref(overrides: Partial<RuleRef> & { id: string }): RuleRef {
  return {
    scope: {},
    ...overrides,
  }
}

describe('classifyConflict', () => {
  describe('subsume', () => {
    it('flags subsume when new rule covers an existing fully-scoped rule', () => {
      const newRule = ref({
        id: 'new-1',
        scope: {}, // any contract + any method
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '100', windowSeconds: 86400 },
      })
      const result = classifyConflict(newRule, existing)
      expect(result.kind).toBe('subsume')
      if (result.kind === 'subsume') {
        expect(result.existingRuleId).toBe('existing-1')
        expect(result.detail).toContain('superset')
      }
    })

    it('flags subsume when new rule covers existing on contract + matches on method', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { method: 'claim' }, // any contract, claim method
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
      })
      expect(classifyConflict(newRule, existing).kind).toBe('subsume')
    })
  })

  describe('disjoint', () => {
    it('flags disjoint when new rule targets a different contract', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CSOROSWAP', method: 'swap' },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
      })
      expect(classifyConflict(newRule, existing)).toEqual({ kind: 'disjoint' })
    })

    it('flags disjoint when new rule targets the same contract but a different method', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CBLEND', method: 'deposit' },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
      })
      expect(classifyConflict(newRule, existing)).toEqual({ kind: 'disjoint' })
    })

    it('flags disjoint when same contract + same method + identical caps (duplicate rule)', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '100', windowSeconds: 86400 },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '100', windowSeconds: 86400 },
      })
      expect(classifyConflict(newRule, existing)).toEqual({ kind: 'disjoint' })
    })

    it('flags disjoint when same scope + same window but different tokens', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CSOROSWAP', method: 'swap' },
        spendingLimit: { token: 'CXLM', amount: '100', windowSeconds: 3600 },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CSOROSWAP', method: 'swap' },
        spendingLimit: { token: 'CUSDC', amount: '50', windowSeconds: 3600 },
      })
      expect(classifyConflict(newRule, existing)).toEqual({ kind: 'disjoint' })
    })

    it('flags disjoint when neither rule carries a spend cap (scope-only comparison)', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CBLEND', method: 'claim' },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
      })
      expect(classifyConflict(newRule, existing)).toEqual({ kind: 'disjoint' })
    })
  })

  describe('counter_permissive', () => {
    it('flags counter_permissive when same scope + window but different amounts', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '200', windowSeconds: 86400 },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '100', windowSeconds: 86400 },
      })
      const result = classifyConflict(newRule, existing)
      expect(result.kind).toBe('counter_permissive')
      if (result.kind === 'counter_permissive') {
        expect(result.existingRuleId).toBe('existing-1')
        expect(result.newLimit).toBe('200 CBLEND / 86400s')
        expect(result.existingLimit).toBe('100 CBLEND / 86400s')
      }
    })
  })

  describe('window_divergent', () => {
    it('flags window_divergent when same scope + amount but different windows', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '100', windowSeconds: 3600 },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CBLEND', method: 'claim' },
        spendingLimit: { token: 'CBLEND', amount: '100', windowSeconds: 86400 },
      })
      const result = classifyConflict(newRule, existing)
      expect(result.kind).toBe('window_divergent')
      if (result.kind === 'window_divergent') {
        expect(result.existingRuleId).toBe('existing-1')
        expect(result.effectiveUnion).toBe('200 CBLEND per 3600s (new) + 86400s (existing)')
      }
    })

    it('window_divergent: the effectiveUnion is the sum of the two per-window caps', () => {
      const newRule = ref({
        id: 'new-1',
        scope: { contract: 'CSOROSWAP', method: 'swap' },
        spendingLimit: { token: 'CXLM', amount: '1000000', windowSeconds: 60 },
      })
      const existing = ref({
        id: 'existing-1',
        scope: { contract: 'CSOROSWAP', method: 'swap' },
        spendingLimit: { token: 'CXLM', amount: '2500000', windowSeconds: 600 },
      })
      const result = classifyConflict(newRule, existing)
      expect(result.kind).toBe('window_divergent')
      if (result.kind === 'window_divergent') {
        expect(result.effectiveUnion).toBe('3500000 CXLM per 60s (new) + 600s (existing)')
      }
    })
  })
})
