import { describe, expect, it } from 'bun:test'
import {
  buildLowConfidenceQuestion,
  computeParseConfidence,
  isBelowThreshold,
} from './freshness.ts'

describe('computeParseConfidence', () => {
  it('returns overall = 1.0 with zero unknowns and zero opaque', () => {
    const c = computeParseConfidence({
      knownContracts: ['CABC'],
      unknownContracts: [],
      opaqueScVals: [],
    })
    expect(c.overall).toBe(1.0)
    expect(c.thresholdUsed).toBe(1.0)
    expect(c.knownContracts).toEqual(['CABC'])
  })

  it('scores a fully-unknown transaction 0 (pinned formula, no inflation)', () => {
    const c = computeParseConfidence({
      knownContracts: [],
      unknownContracts: [{ contract: 'CABC', reason: 'no-abi' }],
      opaqueScVals: [],
    })
    // 1 unknown / (0 known + 1 unknown + 0 opaque) = 1 -> overall 0.
    expect(c.overall).toBe(0)
    expect(c.unknownContracts.length).toBe(1)
  })

  it('reduces overall when opaque ScVals appear', () => {
    const c = computeParseConfidence({
      knownContracts: ['CABC'],
      unknownContracts: [],
      opaqueScVals: [{ path: 'args[0]', type: 'scvMap' }],
    })
    expect(c.overall).toBeLessThan(1.0)
    expect(c.opaqueScVals.length).toBe(1)
  })

  it('clamps overall into [0, 1]', () => {
    const c = computeParseConfidence({
      knownContracts: [],
      unknownContracts: [
        { contract: 'C1', reason: 'no-abi' },
        { contract: 'C2', reason: 'no-abi' },
        { contract: 'C3', reason: 'no-abi' },
      ],
      opaqueScVals: [
        { path: 'p1', type: 'scvMap' },
        { path: 'p2', type: 'scvMap' },
      ],
    })
    expect(c.overall).toBeGreaterThanOrEqual(0)
    expect(c.overall).toBeLessThanOrEqual(1)
  })
})

describe('OZ smart-account recognition feeds parseConfidence (regression for the demo gate)', () => {
  // The previous gate failed closed on every recorded `batch_add_signer`
  // tx because the OZ account was treated as an unknown third party. The
  // recogniser now pins OZ accounts by interface (see registry/identify.ts
  // OZ_ACCOUNT_ABI). A recording that drives `batch_add_signer(u32, vec)`
  // on any contract must:
  //   - register the contract as known (the recogniser is called by
  //     decode.ts / recordInvocation);
  //   - score confidence 1.0 against the default threshold of 1.0;
  //   - pass isBelowThreshold (refused != true).

  it('scores a recorded OZ batch_add_signer tx at confidence 1.0', () => {
    // Simulate the output of decode.ts after a successful recognition -
    // the contract is in knownContracts, the unknown bucket is empty, and
    // there are no opaque ScVals (the args normalized into the supported
    // vocabulary).
    const c = computeParseConfidence({
      knownContracts: ['CB35MK6WUSDDGU46WZXIHVOQNJA2QFKMKDLH6C2WDOXNJ4YMNYJR2'],
      unknownContracts: [],
      opaqueScVals: [],
    })
    expect(c.overall).toBe(1.0)
    expect(c.knownContracts).toEqual(['CB35MK6WUSDDGU46WZXIHVOQNJA2QFKMKDLH6C2WDOXNJ4YMNYJR2'])
    // Regression: the refusal gate must NOT fire for a recording the
    // recogniser marked as known.
    expect(isBelowThreshold(c)).toBe(false)
  })

  it('still scores 1.0 across multiple known OZ smart-account instances in the same recording', () => {
    const c = computeParseConfidence({
      knownContracts: [
        'CB35MK6WUSDDGU46WZXIHVOQNJA2QFKMKDLH6C2WDOXNJ4YMNYJR2',
        'CAY2JYOXP7VS56YVGN2R5JP762VG7CFHTCD3QDK72OXQXVWRJIONOYME',
      ],
      unknownContracts: [],
      opaqueScVals: [],
    })
    expect(c.overall).toBe(1.0)
    expect(isBelowThreshold(c)).toBe(false)
  })
})

describe('isBelowThreshold', () => {
  it('returns true when overall < thresholdUsed', () => {
    expect(
      isBelowThreshold({
        overall: 0.5,
        thresholdUsed: 1.0,
        knownContracts: [],
        unknownContracts: [],
        opaqueScVals: [],
      })
    ).toBe(true)
  })
  it('returns false when overall >= thresholdUsed', () => {
    expect(
      isBelowThreshold({
        overall: 1.0,
        thresholdUsed: 1.0,
        knownContracts: [],
        unknownContracts: [],
        opaqueScVals: [],
      })
    ).toBe(false)
  })
})

describe('buildLowConfidenceQuestion', () => {
  it('lists unknown contracts and opaque ScVals', () => {
    const q = buildLowConfidenceQuestion({
      overall: 0.5,
      thresholdUsed: 1.0,
      knownContracts: [],
      unknownContracts: [{ contract: 'CABC', reason: 'no-abi' }],
      opaqueScVals: [{ path: 'args[0]', type: 'scvMap' }],
    })
    expect(q).toContain('unknown contract CABC')
    expect(q).toContain('opaque ScVal at args[0]')
  })
  // Regression: pre-fix text always said "Supply an ABI for the unknown
  // contract(s) or re-capture the transaction against a known protocol
  // version" regardless of which diagnostic bucket was actually populated.
  // When the sole diagnostic is an opaqueScVals entry from OUR decoder
  // (e.g. a SAC transfer event whose data shape we do not yet support),
  // that guidance is wrong and unactionable - the user cannot supply an
  // ABI to fix a decoder bug. The fix branches the remediation text on
  // which bucket is non-empty.
  it('points the agent at a decoder limitation when only opaqueScVals is non-empty', () => {
    const q = buildLowConfidenceQuestion({
      overall: 0,
      thresholdUsed: 1.0,
      knownContracts: [],
      unknownContracts: [],
      opaqueScVals: [{ path: 'events[1]', type: 'undecodable-token-movement' }],
    })
    expect(q).toContain('opaque ScVal at events[1]')
    expect(q).toContain('undecodable-token-movement')
    // The misdirected "Supply an ABI" guidance must NOT appear when there
    // are no unknown contracts.
    expect(q.toLowerCase()).not.toContain('supply an abi')
    // The decoder-limitation guidance should appear instead.
    expect(q.toLowerCase()).toMatch(/decoder|tool limitation|re-run after/)
  })
  it('never tells the caller to supply an ABI for an unknown contract', () => {
    // `no-abi` names a REGISTRY MISS, not a contract without an interface -
    // most Soroban contracts publish a typed spec on chain and this package
    // never reads one. There is also no input that accepts an ABI, so the
    // old guidance named an action nobody could take and sent users after a
    // file they do not have and would not need. The remediation has to point
    // somewhere the caller can actually go.
    const q = buildLowConfidenceQuestion({
      overall: 0,
      thresholdUsed: 1.0,
      knownContracts: [],
      unknownContracts: [{ contract: 'CABC', reason: 'no-abi' }],
      opaqueScVals: [],
    })
    expect(q).toContain('unknown contract CABC')
    expect(q.toLowerCase()).not.toContain('supply an abi')
    expect(q).toContain("not in this package's built-in registry")
    expect(q).toContain('confidenceOverride')
  })
  it('lists both buckets distinctly when both are non-empty', () => {
    const q = buildLowConfidenceQuestion({
      overall: 0,
      thresholdUsed: 1.0,
      knownContracts: [],
      unknownContracts: [{ contract: 'CABC', reason: 'no-abi' }],
      opaqueScVals: [{ path: 'events[1]', type: 'undecodable-token-movement' }],
    })
    expect(q).toContain('unknown contract CABC')
    expect(q).toContain('opaque ScVal at events[1]')
  })
})
