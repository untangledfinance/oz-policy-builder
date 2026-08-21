import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { ContextRuleDraft, PredicateNode } from '../types.ts'
import { buildReviewCardSummary, describePredicate } from './builder.ts'

/** Build a C... Stellar contract address from a 32-byte buffer of bytes. */
function cAddress(byte: number): string {
  return Address.contract(Buffer.alloc(32, byte)).toString()
}

const BLEND_POOL = cAddress(1)
const USDC_SAC = cAddress(2)
const SOROSWAP_ROUTER = cAddress(3)
const USDC_RECIPIENT_A = cAddress(4)
const USDC_RECIPIENT_B = cAddress(5)
const XLM_SAC = cAddress(6)

/** Evaluator identities the builder folds into the content hash. */
const tsModelSimulation = 'ts-model' as const
const interpreterSimulation = 'interpreter-v1' as const

/** Build the predicate for the Blend yield-claim walkthrough:
 *  and(
 *    eq(call_contract, blend_pool),
 *    eq(call_fn, 'claim')
 *  )
 */
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
    ],
  }
}

/** Build the predicate for the SEP-41 recipient-allowlist walkthrough:
 *  and(
 *    eq(call_contract, usdc_sac),
 *    eq(call_fn, 'transfer'),
 *    in(call_arg[1], [USDC_RECIPIENT_A, USDC_RECIPIENT_B])
 *  )
 */
function sep41Predicate(): PredicateNode {
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
          { kind: 'literal_address', value: USDC_RECIPIENT_A },
          { kind: 'literal_address', value: USDC_RECIPIENT_B },
        ],
      },
    ],
  }
}

/** Build the predicate for the SoroSwap bounded walkthrough:
 *  and(
 *    eq(call_contract, soroswap_router),
 *    eq(call_arg[2], literal_vec([XLM, USDC])),
 *    lte(amount(swap_input_token), max_input)
 *  )
 */
function soroswapPredicate(): PredicateNode {
  return {
    op: 'and',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: SOROSWAP_ROUTER },
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
        left: { kind: 'call_arg', index: 1 },
        right: { kind: 'literal_i128', value: '100000000' },
      },
    ],
  }
}

const baseContextRule: ContextRuleDraft = {
  contextRuleType: { kind: 'call_contract', contract: USDC_SAC },
  name: 'review-card-rule',
  validUntilLedger: 12345,
  signers: [],
  policies: [],
}

describe('buildReviewCardSummary - Blend yield-claim walkthrough', () => {
  const summary = buildReviewCardSummary(blendClaimPredicate(), baseContextRule, tsModelSimulation)

  it('emits one constraint line per leaf (contract / function)', () => {
    expect(summary.constraints).toEqual([
      `Contract must be ${BLEND_POOL}`,
      `Function must be claim`,
    ])
  })

  it('expiry line reflects the context-rule validUntilLedger', () => {
    expect(summary.expiry).toBe('Valid until ledger 12345')
  })

  it('backend field carries the simulation backend', () => {
    expect(summary.backend).toBe('ts-model')
  })

  it('plainEnglish concatenates ruleName + the constraint sentences', () => {
    expect(summary.plainEnglish).toBe(
      `review-card-rule: Contract must be ${BLEND_POOL}; Function must be claim`
    )
  })
})

describe('buildReviewCardSummary - SEP-41 recipient allowlist walkthrough', () => {
  const summary = buildReviewCardSummary(sep41Predicate(), baseContextRule, tsModelSimulation)

  it('emits the recipient-allowlist line with the concrete addresses', () => {
    expect(summary.constraints).toContain(
      `Recipient/arg must be one of [${USDC_RECIPIENT_A}, ${USDC_RECIPIENT_B}]`
    )
  })

  it('emits the contract + function lines for the call target', () => {
    expect(summary.constraints).toContain(`Contract must be ${USDC_SAC}`)
    expect(summary.constraints).toContain('Function must be transfer')
  })
})

describe('buildReviewCardSummary - SoroSwap exact-path+amount walkthrough', () => {
  const summary = buildReviewCardSummary(
    soroswapPredicate(),
    baseContextRule,
    interpreterSimulation
  )

  it('emits the exact-path line for the literal_vec equality', () => {
    expect(summary.constraints).toContain(`Path must be exactly [${XLM_SAC}, ${USDC_SAC}]`)
  })

  it('emits the amount-bound line', () => {
    expect(summary.constraints).toContain(`arg[1] <= 100000000`)
  })

  it('emits the contract line for the router target', () => {
    expect(summary.constraints).toContain(`Contract must be ${SOROSWAP_ROUTER}`)
  })

  it('backend reflects the interpreter evaluation', () => {
    expect(summary.backend).toBe('interpreter-v1')
  })
})

describe('contentHash', () => {
  it('is stable across runs for identical inputs (byte-identical)', () => {
    const a = buildReviewCardSummary(blendClaimPredicate(), baseContextRule, tsModelSimulation)
    const b = buildReviewCardSummary(blendClaimPredicate(), baseContextRule, tsModelSimulation)
    expect(a.contentHash).toBe(b.contentHash)
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when a constraint changes', () => {
    const baseline = buildReviewCardSummary(
      blendClaimPredicate(),
      baseContextRule,
      tsModelSimulation
    )
    const tweaked: PredicateNode = {
      ...blendClaimPredicate(),
      children: [
        ...blendClaimPredicate().children.slice(0, 1),
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'withdraw' },
        },
      ],
    }
    const tweakedSummary = buildReviewCardSummary(tweaked, baseContextRule, tsModelSimulation)
    expect(tweakedSummary.contentHash).not.toBe(baseline.contentHash)
  })

  it('changes when the ruleName changes', () => {
    const baseline = buildReviewCardSummary(
      blendClaimPredicate(),
      baseContextRule,
      tsModelSimulation
    )
    const renamed: ContextRuleDraft = { ...baseContextRule, name: 'renamed-rule' }
    const renamedSummary = buildReviewCardSummary(blendClaimPredicate(), renamed, tsModelSimulation)
    expect(renamedSummary.contentHash).not.toBe(baseline.contentHash)
  })

  it('changes when the backend changes (different simulator)', () => {
    const a = buildReviewCardSummary(blendClaimPredicate(), baseContextRule, tsModelSimulation)
    const b = buildReviewCardSummary(blendClaimPredicate(), baseContextRule, interpreterSimulation)
    expect(a.contentHash).not.toBe(b.contentHash)
  })

  it('changes when validUntilLedger changes', () => {
    const a = buildReviewCardSummary(blendClaimPredicate(), baseContextRule, tsModelSimulation)
    const laterExpiry: ContextRuleDraft = { ...baseContextRule, validUntilLedger: 99999 }
    const b = buildReviewCardSummary(blendClaimPredicate(), laterExpiry, tsModelSimulation)
    expect(a.contentHash).not.toBe(b.contentHash)
  })

  it('renders "No expiry" when validUntilLedger is null', () => {
    const noExpiry: ContextRuleDraft = { ...baseContextRule, validUntilLedger: null }
    const a = buildReviewCardSummary(blendClaimPredicate(), noExpiry, tsModelSimulation)
    expect(a.expiry).toBe('No expiry')
  })
})

/** Build a predicate that uses the new structured-argument leaves:
 *  and(
 *    eq(call_contract, BLEND_POOL),
 *    eq(call_fn, 'submit'),
 *    eq(call_arg_len(3), 1),
 *    eq(call_arg_field(3, 0, 'address'), LENDER),
 *    eq(call_arg_field(3, 0, 'request_type'), 4),
 *    lte(call_arg_field(3, 0, 'amount'), 1000000)
 *  )
 */
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

describe('buildReviewCardSummary - signerNote (cross-layer L1: OZ any-of-N)', () => {
  const DELEGATED_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJF'
  const DELEGATED_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE5KQ'

  it('returns null when the rule has a single signer (any-of-1 is implicit)', () => {
    const summary = buildReviewCardSummary(
      blendClaimPredicate(),
      {
        ...baseContextRule,
        signers: [{ kind: 'delegated', address: DELEGATED_A }],
      },
      tsModelSimulation
    )
    expect(summary.signerNote).toBeNull()
  })

  it('returns null when the rule has no signers (a degenerate, already-rejected shape)', () => {
    const summary = buildReviewCardSummary(
      blendClaimPredicate(),
      baseContextRule,
      tsModelSimulation
    )
    expect(summary.signerNote).toBeNull()
  })

  it('carries the OZ any-of-N note for a rule with N>=2 signers', () => {
    // The note mirrors the wire-level semantic: a context rule with
    // multiple attached signers accepts any ONE of them as authoriser
    // for a permitted op. A human reviewing the install reads the same
    // shape the contract enforces.
    const summary = buildReviewCardSummary(
      blendClaimPredicate(),
      {
        ...baseContextRule,
        signers: [
          { kind: 'delegated', address: DELEGATED_A },
          { kind: 'delegated', address: DELEGATED_B },
        ],
      },
      tsModelSimulation
    )
    expect(summary.signerNote).toBe(
      'any ONE signer may authorise a permitted op under this rule (OZ any-of-N semantic)'
    )
  })

  it('signerNote participates in the content hash (changing N changes the hash)', () => {
    const oneSigner = buildReviewCardSummary(
      blendClaimPredicate(),
      {
        ...baseContextRule,
        signers: [{ kind: 'delegated', address: DELEGATED_A }],
      },
      tsModelSimulation
    )
    const twoSigners = buildReviewCardSummary(
      blendClaimPredicate(),
      {
        ...baseContextRule,
        signers: [
          { kind: 'delegated', address: DELEGATED_A },
          { kind: 'delegated', address: DELEGATED_B },
        ],
      },
      tsModelSimulation
    )
    expect(oneSigner.contentHash).not.toBe(twoSigners.contentHash)
  })
})

describe('buildReviewCardSummary - structured-argument leaves (Blend submit)', () => {
  const summary = buildReviewCardSummary(blendSubmitPredicate(), baseContextRule, tsModelSimulation)

  it('renders the call_arg_len leaf as a readable "Length of arg[N] is K" line', () => {
    // The arg-length binding must surface readably - NOT as "blank",
    // "[object Object]", or "<call_arg_len>".
    const lenLine = summary.constraints.find((s) => s.startsWith('Length of arg['))
    expect(lenLine).toBeDefined()
    expect(lenLine).toBe('Length of arg[3] is 1')
  })

  it('renders call_arg_field leaves as "arg[N] element[M].field = <value>" lines', () => {
    // Three call_arg_field leaves - one per bound field. Each must be
    // readable and name the index, element, and field literally.
    const fieldLines = summary.constraints.filter((s) => s.startsWith('arg[3] element['))
    expect(fieldLines.length).toBe(3)
    expect(fieldLines).toContain(`arg[3] element[0].address = ${BLEND_POOL}`)
    expect(fieldLines).toContain('arg[3] element[0].request_type = 4')
    expect(fieldLines).toContain('arg[3] element[0].amount <= 1000000')
  })

  it('never emits blank lines or "[object Object]" for any leaf', () => {
    for (const s of summary.constraints) {
      expect(s.length).toBeGreaterThan(0)
      expect(s).not.toContain('[object Object]')
      expect(s).not.toContain('undefined')
      expect(s).not.toMatch(/<call_arg_len>|<call_arg_field>/)
    }
  })

  it('emits the same constraint list twice for the same predicate (deterministic)', () => {
    const a = buildReviewCardSummary(blendSubmitPredicate(), baseContextRule, tsModelSimulation)
    const b = buildReviewCardSummary(blendSubmitPredicate(), baseContextRule, tsModelSimulation)
    expect(a.constraints).toEqual(b.constraints)
    expect(a.contentHash).toBe(b.contentHash)
  })
})

describe('buildReviewCardSummary - per-call caps on a bare call_arg', () => {
  it('renders a cap on the call amount argument', () => {
    // This shape rendered NOTHING: `call_arg` was only handled for an exact
    // `eq` against a vec, so a cap silently vanished from the card while
    // still being enforced on chain.
    expect(
      describePredicate({
        op: 'lte',
        left: { kind: 'call_arg', index: 2 },
        right: { kind: 'literal_i128', value: '1000000000' },
      })
    ).toEqual(['arg[2] <= 1000000000'])
  })

  it('reads eq as = and keeps the comparison kind otherwise', () => {
    expect(
      describePredicate({
        op: 'eq',
        left: { kind: 'call_arg', index: 0 },
        right: {
          kind: 'literal_address',
          value: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        },
      })[0]
    ).toContain('arg[0] = CDLZFC3')
  })

  it('does not steal the exact-sequence line from eq against a vec', () => {
    // literal_vec must still read as a path, not as a comparison.
    const line = describePredicate({
      op: 'eq',
      left: { kind: 'call_arg', index: 1 },
      right: {
        kind: 'literal_vec',
        elements: [{ kind: 'literal_symbol', value: 'a' }],
      },
    })[0]
    expect(line).toContain('Path must be exactly')
  })
})
