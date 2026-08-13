import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { ContextRuleDraft, PredicateNode } from '../types.ts'
import type { SimulationResult } from '../verify/envelope.ts'
import { buildReviewCardSummary } from './builder.ts'
import { summaryCrossCheck } from './cross-check.ts'

function cAddress(byte: number): string {
  return Address.contract(Buffer.alloc(32, byte)).toString()
}

const BLEND_POOL = cAddress(1)
const XLM_SAC = cAddress(2)
const USDC_SAC = cAddress(3)
const ROUTER = cAddress(4)

const simulation: SimulationResult = {
  permit: { tx: 'permit' },
  evaluatedCases: [{ dimension: 'permit', outcome: 'permit', reason: 'ok' }],
  backend: 'ts-model',
  simulatorVersion: 'ts-model-1.0.0',
}

const baseContextRule: ContextRuleDraft = {
  contextRuleType: { kind: 'call_contract', contract: USDC_SAC },
  name: 'cross-check-rule',
  validUntilLedger: 1000,
  signers: [],
  policies: [],
}

function blendClaimPredicate(): PredicateNode {
  return {
    op: 'and',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: BLEND_POOL },
      },
      {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'claim' },
      },
      {
        op: 'lte',
        left: { kind: 'invocation_count_in_window', windowSecs: 86400 },
        right: { kind: 'literal_u32', value: 1 },
      },
    ],
  }
}

function soroswapPredicate(): PredicateNode {
  return {
    op: 'and',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: ROUTER },
      },
      {
        op: 'eq',
        left: { kind: 'call_arg', index: 2 },
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
        right: { kind: 'literal_i128', value: '100000000' },
      },
      {
        op: 'lt',
        left: { kind: 'oracle_price', asset: XLM_SAC },
        right: { kind: 'oracle_threshold', value: '10000000', decimals: 9 },
      },
    ],
  }
}

function recipientAllowlistPredicate(): PredicateNode {
  return {
    op: 'and',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: USDC_SAC },
      },
      {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'transfer' },
      },
      {
        op: 'in',
        needle: { kind: 'call_arg', index: 1 },
        haystack: [
          { kind: 'literal_address', value: cAddress(10) },
          { kind: 'literal_address', value: cAddress(11) },
        ],
      },
    ],
  }
}

describe('summaryCrossCheck', () => {
  it('returns ok for a faithful summary of the Blend yield-claim predicate', () => {
    const summary = buildReviewCardSummary(blendClaimPredicate(), [], baseContextRule, simulation)
    expect(summaryCrossCheck(blendClaimPredicate(), summary)).toEqual({ ok: true })
  })

  it('returns ok for a faithful summary of the SEP-41 recipient allowlist predicate', () => {
    const predicate = recipientAllowlistPredicate()
    const summary = buildReviewCardSummary(predicate, [], baseContextRule, simulation)
    expect(summaryCrossCheck(predicate, summary)).toEqual({ ok: true })
  })

  it('returns ok for a faithful summary of the SoroSwap exact-path+amount+oracle predicate', () => {
    const predicate = soroswapPredicate()
    const summary = buildReviewCardSummary(predicate, [], baseContextRule, simulation)
    expect(summaryCrossCheck(predicate, summary)).toEqual({ ok: true })
  })

  it('returns missingConstraints when a leaf is dropped from the summary constraints', () => {
    const predicate = blendClaimPredicate()
    const summary = buildReviewCardSummary(predicate, [], baseContextRule, simulation)
    // Drop the third (invocation_count) constraint line. The cross-check
    // must flag it - this is the non-hallucination guard.
    const tampered = {
      ...summary,
      constraints: summary.constraints.slice(0, 2),
    }
    const result = summaryCrossCheck(predicate, tampered)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.missingConstraints).toEqual(['At most 2 calls per 86400 seconds'])
    }
  })

  it('flags every dropped leaf in a multi-leaf predicate', () => {
    const predicate = soroswapPredicate()
    const summary = buildReviewCardSummary(predicate, [], baseContextRule, simulation)
    // Drop the amount + oracle constraints; keep contract + path.
    const kept = summary.constraints.filter(
      (s) => s.startsWith('Contract must be') || s.startsWith('Path must be exactly')
    )
    const tampered = { ...summary, constraints: kept }
    const result = summaryCrossCheck(predicate, tampered)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.missingConstraints).toContain(`Amount <= 100000000`)
      expect(result.missingConstraints).toContain(
        `Only when oracle_price(${XLM_SAC}) < 10000000 (9 dp)`
      )
    }
  })

  it('returns ok when the predicate is null (OZ-only policies)', () => {
    const summary = buildReviewCardSummary(null, [], baseContextRule, simulation)
    expect(summaryCrossCheck(null, summary)).toEqual({ ok: true })
  })

  it('returns ok when the predicate has no recognized constraint leaves', () => {
    // A predicate of just `and` with no children renders no constraint
    // lines; the cross-check has nothing to demand, so it returns ok.
    const empty: PredicateNode = { op: 'and', children: [] }
    const summary = buildReviewCardSummary(empty, [], baseContextRule, simulation)
    expect(summaryCrossCheck(empty, summary)).toEqual({ ok: true })
  })
})

/** A predicate exercising the new structured-argument leaves (call_arg_len
 *  + three call_arg_field binds). Mirrors the Blend `submit` shape that the
 *  synthesiser emits after the bind-fields-in-vec change. */
function blendSubmitPredicate(): PredicateNode {
  return {
    op: 'and',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: BLEND_POOL },
      },
      {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'submit' },
      },
      {
        op: 'eq',
        left: { kind: 'call_arg_len', index: 3 },
        right: { kind: 'literal_u32', value: 1 },
      },
      {
        op: 'eq',
        left: { kind: 'call_arg_field', index: 3, element: 0, field: 'address' },
        right: { kind: 'literal_address', value: BLEND_POOL },
      },
      {
        op: 'eq',
        left: { kind: 'call_arg_field', index: 3, element: 0, field: 'request_type' },
        right: { kind: 'literal_u32', value: 4 },
      },
      {
        op: 'lte',
        left: { kind: 'call_arg_field', index: 3, element: 0, field: 'amount' },
        right: { kind: 'literal_i128', value: '1000000' },
      },
    ],
  }
}

describe('summaryCrossCheck - structured-argument leaves', () => {
  it('returns ok for a faithful summary of the Blend submit predicate', () => {
    const predicate = blendSubmitPredicate()
    const summary = buildReviewCardSummary(predicate, [], baseContextRule, simulation)
    const result = summaryCrossCheck(predicate, summary)
    expect(result).toEqual({ ok: true })
  })

  it('flags every dropped call_arg_field leaf explicitly', () => {
    const predicate = blendSubmitPredicate()
    const summary = buildReviewCardSummary(predicate, [], baseContextRule, simulation)
    // Tamper: drop the call_arg_field address line. The cross-check must
    // surface it as a missing constraint (the renderer is the source of
    // truth; the cross-check is the non-hallucination guard).
    const tampered = {
      ...summary,
      constraints: summary.constraints.filter((s) => !s.startsWith('arg[3] element[0].address')),
    }
    const result = summaryCrossCheck(predicate, tampered)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.missingConstraints).toContain(`arg[3] element[0].address = ${BLEND_POOL}`)
    }
  })
})
