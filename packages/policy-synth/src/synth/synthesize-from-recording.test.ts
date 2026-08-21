import { describe, expect, it } from 'bun:test'
import { Address, xdr } from '@stellar/stellar-sdk'
import {
  GRAMMAR_VERSION,
  type ParseConfidence,
  type PredicateLeaf,
  type PredicateNode,
  type RecordedTransaction,
} from '../types.ts'
// `__TestInterpreterAdapterOptions` is the PRIVATE test-only extension of
// `InterpreterAdapterOptions`. It carries the `__testPredicateNode` seam that
// production callers MUST NOT be able to set; the test file uses a local cast
// to set it (the same pattern Rust's `#[cfg(test)]` modules use).
import type { __TestInterpreterAdapterOptions } from './synthesize-from-recording.ts'
import { synthesizeFromRecording } from './synthesize-from-recording.ts'

const FULL: ParseConfidence = {
  overall: 1,
  knownContracts: [],
  unknownContracts: [],
  opaqueScVals: [],
  thresholdUsed: 1,
}

const LOW: ParseConfidence = {
  overall: 0.5,
  knownContracts: [],
  unknownContracts: [{ contract: 'CUNKNOWN', reason: 'no-abi' }],
  opaqueScVals: [],
  thresholdUsed: 1,
}

const SEP41_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
const BLEND_POOL = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
const SOROSWAP_ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'
const XLM_TOKEN = 'CAS3J7GYLGXMF6TDJ5WQ2PEN4GRVNXJUIQ2TZU3ZB3OQ2V4DRCWI7WPF'
const USDC_TOKEN = 'CCWCLTASNDT57N3BCHOSVB5QWMV5URK4BXLDDF6ZZQYMBQ4OKZA3ZB2N'
const G_OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD'

function sep41Tx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER],
    invocations: [
      {
        contract: SEP41_TOKEN,
        fn: 'transfer',
        args: [
          { type: 'address', value: G_OWNER },
          { type: 'address', value: 'GBILLER' },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: SEP41_TOKEN, from: G_OWNER, to: 'GBILLER', amount: '1000000000' }],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_OWNER,
  }
}

function blendTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER],
    invocations: [
      {
        contract: BLEND_POOL,
        fn: 'claim',
        args: [
          { type: 'address', value: G_OWNER },
          { type: 'vec', value: [{ type: 'u32', value: '0' }] },
          { type: 'address', value: G_OWNER },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: XLM_TOKEN, from: BLEND_POOL, to: G_OWNER, amount: '1500000' }],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_OWNER,
  }
}

function _soroswapTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER],
    invocations: [
      {
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [
          { type: 'i128', value: '50000000' },
          { type: 'i128', value: '45000000' },
          {
            type: 'vec',
            value: [
              { type: 'address', value: XLM_TOKEN },
              { type: 'address', value: USDC_TOKEN },
            ],
          },
          { type: 'address', value: G_OWNER },
          { type: 'u64', value: '1700000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: XLM_TOKEN, from: G_OWNER, to: SOROSWAP_ROUTER, amount: '50000000' },
      { token: USDC_TOKEN, from: SOROSWAP_ROUTER, to: G_OWNER, amount: '45000000' },
    ],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_OWNER,
  }
}

describe('synthesizeFromRecording - input validation (I3)', () => {
  it('rejects a recording with no interpreter options: nothing can be installed', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    // Pin the reason: without this the test passes on any synthesis failure.
    expect(res.error.message).toContain('no installable policy was synthesised')
  })

  it('rejects a non-integer validUntilLedger with SYNTHESIS_ERROR', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { validUntilLedger: 1.5 },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })

  it('rejects a non-numeric / negative limitAmount with SYNTHESIS_ERROR', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '-5' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })

  it('rejects a limitAmount above the i128 max (2**127-1) with SYNTHESIS_ERROR (F2)', () => {
    // 2**127 is one past the signed-i128 ceiling; a value that cannot be
    // represented on-chain must be rejected fail-closed, not passed through as
    // an unbounded spending_limit.
    const overMax = (2n ** 127n).toString()
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: overMax },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('i128')
  })

  it('accepts a limitAmount exactly at the i128 max (2**127-1) boundary (F2)', () => {
    // The boundary value IS a representable i128, so it must pass the range
    // guard (it may still fail later for unrelated reasons, but never on range).
    const atMax = (2n ** 127n - 1n).toString()
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: atMax },
    })
    if (!res.ok) {
      expect(res.error.message.includes('i128')).toBe(false)
    }
  })

  it('rejects an unknown network with SYNTHESIS_ERROR', () => {
    const res = synthesizeFromRecording(sep41Tx(), { network: 'devnet' as unknown as 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })
})

describe('synthesizeFromRecording - parseConfidence gate', () => {
  it('refuses with RECORDING_VALIDATION_FAILED when overall < threshold', () => {
    const tx: RecordedTransaction = { ...validSep41Tx(), parseConfidence: { ...LOW } }
    const res = synthesizeFromRecording(tx, { network: 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('RECORDING_VALIDATION_FAILED')
    expect(res.error.severity).toBe('error')
    expect(res.error.retryable).toBe(false)
    expect(res.error.details).toBeDefined()
  })

  it('lets the recording through when confidenceOverride.threshold <= overall', () => {
    const tx: RecordedTransaction = { ...validSep41Tx(), parseConfidence: { ...LOW } }
    const res = synthesizeFromRecording(tx, {
      network: 'mainnet',
      userResponses: {},
      confidenceOverride: { threshold: 0.4 },
      interpreter: { smartAccountAddress: SMART_ACCOUNT },
    })
    expect(res.ok).toBe(true)
  })
})

describe('synthesizeFromRecording - SCOPE_UNRESOLVED', () => {
  it('returns SCOPE_UNRESOLVED ToolError for multiple unrelated targets', () => {
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      invocations: [
        {
          contract: 'CA',
          fn: 'transfer',
          args: [
            { type: 'address', value: G_OWNER },
            { type: 'address', value: 'GB' },
            { type: 'i128', value: '1' },
          ],
          subInvocations: [],
        },
        {
          contract: 'CB',
          fn: 'submit',
          args: [
            { type: 'address', value: G_OWNER },
            { type: 'address', value: G_OWNER },
            { type: 'address', value: G_OWNER },
            { type: 'vec', value: [] },
          ],
          subInvocations: [],
        },
      ],
      tokenMovements: [],
    }
    const res = synthesizeFromRecording(tx, { network: 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SCOPE_UNRESOLVED')
    expect(res.error.remediation?.userQuestion?.code).toBe('MULTIPLE_UNRELATED_TARGETS')
  })
})

describe('synthesizeFromRecording - input bounds (fail-closed)', () => {
  it('rejects a negative confidenceOverride.threshold (would disable the gate)', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      confidenceOverride: { threshold: -0.5 },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('confidenceOverride')
  })

  it('rejects a validUntilLedger above the u32 max (uninstallable on-chain)', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1', validUntilLedger: 4294967296 },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('u32')
  })

  it('rejects a NaN confidenceOverride.threshold (would not be caught by a plain < / > check)', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      confidenceOverride: { threshold: Number.NaN },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('finite')
  })

  it('accepts a validUntilLedger exactly at the u32 max (boundary)', () => {
    const res = synthesizeFromRecording(validSep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1', validUntilLedger: 4294967295 },
      interpreter: { smartAccountAddress: SMART_ACCOUNT },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.contextRule.validUntilLedger).toBe(4294967295)
  })

  it('refuses a recording whose invocation count exceeds the cap', () => {
    const inv = sep41Tx().invocations[0]
    const tx = { ...sep41Tx(), invocations: Array.from({ length: 513 }, () => ({ ...inv })) }
    const res = synthesizeFromRecording(tx, {
      network: 'mainnet',
      userResponses: { limitAmount: '1' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('RECORDING_VALIDATION_FAILED')
    expect(res.error.message).toContain('exceeding the cap')
  })
})

describe('synthesizeFromRecording - determinism', () => {
  it('same tx + opts -> byte-identical ProposedPolicy across runs', () => {
    const opts = {
      network: 'mainnet' as const,
      userResponses: {},
    }
    const a = synthesizeFromRecording(sep41Tx(), opts)
    const b = synthesizeFromRecording(sep41Tx(), opts)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('synthesizeFromRecording - parseConfidence mirror', () => {
  it('mirrors the tx parseConfidence onto the ProposedPolicy', () => {
    const res = synthesizeFromRecording(validSep41Tx(), {
      network: 'mainnet',
      userResponses: {},
      interpreter: { smartAccountAddress: SMART_ACCOUNT },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.parseConfidence.overall).toBe(1)
    expect(res.data.parseConfidence.thresholdUsed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// P3: interpreter adapter wiring (fail-closed)
// ---------------------------------------------------------------------------

const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0xee)).toString()
const XLM_TOKEN_C = Address.contract(Buffer.alloc(32, 0x01)).toString()
const USDC_TOKEN_C = Address.contract(Buffer.alloc(32, 0x02)).toString()
const SEP41_TOKEN_C = Address.contract(Buffer.alloc(32, 0x41)).toString()
const G_OWNER_C = Address.account(Buffer.alloc(32, 0x01)).toString()
const G_RECIPIENT = Address.account(Buffer.alloc(32, 0xa1)).toString()
const G_FEE_PAYER = Address.account(Buffer.alloc(32, 0x0f)).toString()

function interpreterOpts(extra?: __TestInterpreterAdapterOptions): {
  network: 'mainnet'
  userResponses?: Record<string, unknown>
  interpreter?: __TestInterpreterAdapterOptions
} {
  return {
    network: 'mainnet',
    userResponses: { limitAmount: '1000000000' },
    interpreter: {
      smartAccountAddress: extra?.smartAccountAddress ?? SMART_ACCOUNT,
      ...(extra?.installNonce !== undefined ? { installNonce: extra.installNonce } : {}),
      ...(extra?.__testPredicateNode !== undefined
        ? { __testPredicateNode: extra.__testPredicateNode }
        : {}),
    },
  }
}

/** Blend claim with real strkeys, so the pinned beneficiary can be encoded. */
function blendClaimTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER_C],
    invocations: [
      {
        contract: BLEND_POOL,
        fn: 'claim',
        args: [
          { type: 'address', value: G_OWNER_C },
          { type: 'vec', value: [{ type: 'u32', value: '0' }] },
          { type: 'address', value: G_OWNER_C },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: XLM_TOKEN_C, from: BLEND_POOL, to: G_OWNER_C, amount: '1500000' }],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_OWNER_C,
  }
}

function validSep41Tx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER_C],
    invocations: [
      {
        contract: SEP41_TOKEN_C,
        fn: 'transfer',
        args: [
          { type: 'address', value: G_OWNER_C },
          { type: 'address', value: G_RECIPIENT },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: SEP41_TOKEN_C, from: G_OWNER_C, to: G_RECIPIENT, amount: '1000000000' },
    ],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_OWNER_C,
  }
}

function validSoroswapTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER_C],
    invocations: [
      {
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [
          { type: 'i128', value: '50000000' },
          { type: 'i128', value: '45000000' },
          {
            type: 'vec',
            value: [
              { type: 'address', value: XLM_TOKEN_C },
              { type: 'address', value: USDC_TOKEN_C },
            ],
          },
          { type: 'address', value: G_OWNER_C },
          { type: 'u64', value: '1700000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: XLM_TOKEN_C, from: G_OWNER_C, to: SOROSWAP_ROUTER, amount: '50000000' },
      { token: USDC_TOKEN_C, from: SOROSWAP_ROUTER, to: G_OWNER_C, amount: '45000000' },
    ],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_OWNER_C,
  }
}

/** Fee-sponsored SoroSwap swap: the fee-payer (sourceAccount) is NOT the swap
 *  holder. The input token moves FROM the holder (G_OWNER_C = arg[3] `to`),
 *  never from the source account, so lower() attributes no outgoing spend -
 *  the limit must bind call_arg[0] (the exact amount_in) instead of a
 *  window_spent. Mirrors the real recording /tmp/demo-rec-h11.json. */
function feeSponsoredSoroswapTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [G_OWNER_C],
    invocations: [
      {
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [
          { type: 'i128', value: '50000000' },
          { type: 'i128', value: '45000000' },
          {
            type: 'vec',
            value: [
              { type: 'address', value: XLM_TOKEN_C },
              { type: 'address', value: USDC_TOKEN_C },
            ],
          },
          { type: 'address', value: G_OWNER_C },
          { type: 'u64', value: '1700000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: XLM_TOKEN_C, from: G_OWNER_C, to: SOROSWAP_ROUTER, amount: '50000000' },
      { token: USDC_TOKEN_C, from: SOROSWAP_ROUTER, to: G_OWNER_C, amount: '45000000' },
    ],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL },
    sourceAccount: G_FEE_PAYER,
  }
}

describe('synthesizeFromRecording - interpreter adapter wiring (P3)', () => {
  it('absent `interpreter` option is a fail-closed error, not an empty policy', () => {
    // The interpreter is the only backend, so without a smart account there is
    // nothing to lower to. Returning an empty-but-successful ProposedPolicy
    // would read as "no restrictions" rather than "nothing was synthesised".
    const res = synthesizeFromRecording(validSep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('interpreter')
  })

  it('SEP-41 transfer: routes the recipient allowlist + per-method into a predicate doc', () => {
    const res = synthesizeFromRecording(validSep41Tx(), interpreterOpts())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.policyDocuments).toHaveLength(1)
    const doc = res.data.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    expect(doc.grammarVersion).toBe(GRAMMAR_VERSION)
    expect(typeof doc.encodedPredicate).toBe('string')
    expect(doc.predicateHash).toMatch(/^[0-9a-f]{64}$/)
    // The interpreter ref + the OZ spending_limit ref both install against the
    // same context rule; the merge order is [interpreter, ...oz].
    expect(res.data.policyRefs[0]?.kind).toBe('interpreter')
    // The allowlist + per-method scoping warnings are GONE because the
    // interpreter lowered them into the predicate doc.
    expect(res.data.warnings.some((w) => w.includes('allowlist'))).toBe(false)
    expect(res.data.warnings.some((w) => w.includes('per-method scoping'))).toBe(false)
  })

  it('SoroSwap swap: routes the exact path (eq_seq) into a predicate doc; OZ does not emit spending_limit', () => {
    const res = synthesizeFromRecording(validSoroswapTx(), {
      ...interpreterOpts(),
      userResponses: {
        limitAmount: '50000000',
      },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The doc carries the path; OZ emits no spending_limit because the token
    // != scope.contract; per-method is in the predicate.
    expect(res.data.policyDocuments).toHaveLength(1)
    expect(res.data.policyRefs.some((r) => r.kind === 'interpreter')).toBe(true)
    expect(
      res.data.policyRefs.some(
        (r) => r.kind === 'oz_builtin' && r.primitive.primitive === 'spending_limit'
      )
    ).toBe(false)
    // The per-method warning is GONE.
    expect(res.data.warnings.some((w) => w.includes('per-method scoping'))).toBe(false)
  })

  it('SoroSwap swap without swapRecipientAllowlist pins call_arg[3] to the recorded recipient + surfaces RECIPIENT_ALLOWLIST_EMPTY as informational (F1)', () => {
    // The swap recipient (arg[3]) is G_OWNER_C in the fixture. Without an
    // explicit allowlist the synth PINS it (mirroring SEP-41) so the emitted
    // predicate permits exactly the recorded flow; the ambiguity is surfaced as
    // informational (pinned, here is how to widen), never a silent free pass.
    const res = synthesizeFromRecording(validSoroswapTx(), {
      ...interpreterOpts(),
      userResponses: { limitAmount: '50000000' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.ambiguities.some((a) => a.code === 'RECIPIENT_ALLOWLIST_EMPTY')).toBe(true)
    // The emitted IR contains the recipient `in` constraint on call_arg[3].
    const doc = res.data.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const decoded = decodeTopLevelAnd(doc.encodedPredicate)
    expect(decoded).not.toBeNull()
    if (!decoded) return
    const recipientIn = decoded.children.find(
      (c) => c.op === 'in' && c.needle.kind === 'call_arg' && c.needle.index === 3
    )
    expect(recipientIn).toBeDefined()
    if (recipientIn && recipientIn.op === 'in') {
      const pinned = recipientIn.haystack.filter((h) => h.kind === 'literal_address')
      expect(pinned.map((h) => (h.kind === 'literal_address' ? h.value : ''))).toEqual([G_OWNER_C])
    }
  })

  it('pins the Blend beneficiary to the recorded address', () => {
    // Blend `claim(from, reserve_token_ids, to)` sends the claimed tokens to
    // `to` (call_arg[2]). Scoping to the pool and the method still leaves the
    // proceeds free to go anywhere, so the beneficiary is pinned from the
    // recording exactly as the SEP-41 and SoroSwap recipients are.
    const res = synthesizeFromRecording(blendClaimTx(), {
      network: 'mainnet',
      interpreter: { smartAccountAddress: SMART_ACCOUNT, installNonce: 1 },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const doc = res.data.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const decoded = decodeTopLevelAnd(doc.encodedPredicate)
    expect(decoded).not.toBeNull()
    if (!decoded) return
    const beneficiaryIn = decoded.children.find(
      (c) => c.op === 'in' && c.needle.kind === 'call_arg' && c.needle.index === 2
    )
    expect(beneficiaryIn).toBeDefined()
    if (beneficiaryIn && beneficiaryIn.op === 'in') {
      const haystack = beneficiaryIn.haystack
        .filter((h) => h.kind === 'literal_address')
        .map((h) => (h.kind === 'literal_address' ? h.value : ''))
      expect(haystack).toEqual([G_OWNER_C])
    }
  })

  it('EVIL TWIN: a different Blend beneficiary is not permitted by the emitted IR', () => {
    // Same pool and method as the recorded claim, but call_arg[2] redirected to
    // an attacker wallet. The pinned single-element `in` denies it.
    const ATTACKER_TO = Address.account(Buffer.alloc(32, 0xcc)).toString()
    const res = synthesizeFromRecording(blendClaimTx(), {
      network: 'mainnet',
      interpreter: { smartAccountAddress: SMART_ACCOUNT, installNonce: 1 },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const doc = res.data.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const decoded = decodeTopLevelAnd(doc.encodedPredicate)
    expect(decoded).not.toBeNull()
    if (!decoded) return
    const beneficiaryIn = decoded.children.find(
      (c) => c.op === 'in' && c.needle.kind === 'call_arg' && c.needle.index === 2
    )
    expect(beneficiaryIn).toBeDefined()
    if (beneficiaryIn && beneficiaryIn.op === 'in') {
      const haystack = beneficiaryIn.haystack
        .filter((h) => h.kind === 'literal_address')
        .map((h) => (h.kind === 'literal_address' ? h.value : ''))
      // The recorded beneficiary is permitted; the attacker is not.
      expect(haystack).toContain(G_OWNER_C)
      expect(haystack).not.toContain(ATTACKER_TO)
    }
  })

  it('EVIL TWIN: a different swap recipient is no longer permitted by the emitted IR (F1)', () => {
    // Same contract / fn / hop-path as the recorded swap, but call_arg[3] set to
    // an attacker wallet. The pinned `in(call_arg[3], [recorded])` leaf denies
    // it: `in` is pure membership, so an address absent from the single-element
    // haystack fails the leaf and the top-level `and` denies the call.
    const ATTACKER = Address.account(Buffer.alloc(32, 0xbb)).toString()
    const res = synthesizeFromRecording(validSoroswapTx(), {
      ...interpreterOpts(),
      userResponses: { limitAmount: '50000000' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const doc = res.data.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const decoded = decodeTopLevelAnd(doc.encodedPredicate)
    expect(decoded).not.toBeNull()
    if (!decoded) return
    const recipientIn = decoded.children.find(
      (c) => c.op === 'in' && c.needle.kind === 'call_arg' && c.needle.index === 3
    )
    expect(recipientIn).toBeDefined()
    if (recipientIn && recipientIn.op === 'in') {
      const haystack = recipientIn.haystack
        .filter((h) => h.kind === 'literal_address')
        .map((h) => (h.kind === 'literal_address' ? h.value : ''))
      // The recorded recipient is permitted; the attacker is not.
      expect(haystack).toContain(G_OWNER_C)
      expect(haystack).not.toContain(ATTACKER)
    }
  })

  it('fee-sponsored SoroSwap swap: binds the input-amount cap to call_arg[0] in the predicate doc', () => {
    // The fee-payer != holder, so no outgoing spend is detected; the caller's
    // limitAmount must bind the exact amount_in (call_arg[0]) as `<= cap`. The
    // self-verify pipeline (permit + deny battery) keeps the leaf.
    const res = synthesizeFromRecording(feeSponsoredSoroswapTx(), {
      ...interpreterOpts(),
      userResponses: { limitAmount: '50000000' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const doc = res.data.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return
    const decoded = decodeTopLevelAnd(doc.encodedPredicate)
    expect(decoded).not.toBeNull()
    if (!decoded) return
    // The input-amount cap conjunct: lte(call_arg[0], i128 cap).
    const argCap = decoded.children.find(
      (c) => c.op === 'lte' && c.left.kind === 'call_arg' && c.left.index === 0
    )
    expect(argCap).toBeDefined()
    if (argCap && argCap.op === 'lte' && argCap.right.kind === 'literal_i128') {
      expect(argCap.right.value).toBe('50000000')
    }
    // No OZ spending_limit is emitted (there is no detected spend to lower).
    expect(
      res.data.policyRefs.some(
        (r) => r.kind === 'oz_builtin' && r.primitive.primitive === 'spending_limit'
      )
    ).toBe(false)
  })

  it('SCOPE_SELF_CALL fails closed: interpreter adapter throw -> SYNTHESIS_ERROR carrying SCOPE_SELF_CALL', () => {
    // Recipient equals the smart account -> the interpreter adapter throws
    // SCOPE_SELF_CALL. The orchestrator must NOT install an OZ-only partial
    // policy; it must refuse with the underlying gate code surfaced.
    const tx: RecordedTransaction = {
      ...validSep41Tx(),
      invocations: [
        {
          contract: SEP41_TOKEN_C,
          fn: 'transfer',
          args: [
            { type: 'address', value: G_OWNER_C },
            { type: 'address', value: SMART_ACCOUNT }, // self-call target
            { type: 'i128', value: '1000000000' },
          ],
          subInvocations: [],
        },
      ],
      tokenMovements: [
        { token: SEP41_TOKEN_C, from: G_OWNER_C, to: SMART_ACCOUNT, amount: '1000000000' },
      ],
    }
    const res = synthesizeFromRecording(tx, {
      ...interpreterOpts(),
      userResponses: { limitAmount: '1000000000' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SCOPE_SELF_CALL')
    expect(res.error.severity).toBe('error')
    expect(res.error.retryable).toBe(false)
  })

  it('smartAccountAddress missing -> SYNTHESIS_ERROR (fail-closed at options boundary)', () => {
    const res = synthesizeFromRecording(validSep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
      interpreter: { smartAccountAddress: '' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('smartAccountAddress')
  })

  it('smartAccountAddress must be a C... contract address, not the G... source account', () => {
    const res = synthesizeFromRecording(validSep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
      interpreter: { smartAccountAddress: G_OWNER_C }, // G... is the user, not the smart account
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('contract')
  })

  it('merged output is deterministic: identical (tx, opts) -> byte-identical ProposedPolicy across runs', () => {
    const opts = interpreterOpts()
    const a = synthesizeFromRecording(validSep41Tx(), opts)
    const b = synthesizeFromRecording(validSep41Tx(), opts)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('unknown protocol still emits a scope-only interpreter predicate (no OZ primitive)', () => {
    // The unknown-protocol branch in compose leaves `ir` empty, so OZ emits
    // nothing. The interpreter still lowers the scope (call_contract + call_fn)
    // into a real predicate doc.
    const UNKNOWN = Address.contract(Buffer.alloc(32, 0xfa)).toString()
    const tx: RecordedTransaction = {
      ...validSep41Tx(),
      invocations: [
        {
          contract: UNKNOWN,
          fn: 'do_something',
          args: [{ type: 'address', value: G_OWNER_C }],
          subInvocations: [],
        },
      ],
      tokenMovements: [
        { token: SEP41_TOKEN_C, from: G_OWNER_C, to: UNKNOWN, amount: '1000000000' },
      ],
    }
    const res = synthesizeFromRecording(tx, {
      ...interpreterOpts(),
      userResponses: { limitAmount: '1000000000' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.policyDocuments).toHaveLength(1)
    expect(res.data.policyRefs).toHaveLength(1)
    expect(res.data.policyRefs[0]?.kind).toBe('interpreter')
  })
})

// ---------------------------------------------------------------------------
// P5b: self-verify wired into the recording path
// ---------------------------------------------------------------------------

function _isCallFnEqTransfer(node: PredicateNode): boolean {
  return (
    node.op === 'eq' &&
    node.left.kind === 'call_fn' &&
    node.right.kind === 'literal_symbol' &&
    node.right.value === 'transfer'
  )
}

function _childHasEqContract(contract: string): (node: PredicateNode) => boolean {
  return (node: PredicateNode): boolean =>
    node.op === 'eq' &&
    node.left.kind === 'call_contract' &&
    node.right.kind === 'literal_address' &&
    node.right.value === contract
}

function _childHasEqFn(fn: string): (node: PredicateNode) => boolean {
  return (node: PredicateNode): boolean =>
    node.op === 'eq' &&
    node.left.kind === 'call_fn' &&
    node.right.kind === 'literal_symbol' &&
    node.right.value === fn
}

/** Re-decode a base64 XDR predicate blob to its top-level `and` shape so the
 *  tests can assert structural properties (child count, presence of a
 *  specific conjunct) without parsing the full canonical ScVal tree. The
 *  interpreter encodes `and` as `ScVal::Vec([symbol("and"), ScVal::Vec(children)])`
 *  with children sorted by their canonical XDR bytes - we rely on the
 *  sort key being stable but assert only on presence + count, not order. */
function decodeTopLevelAnd(encodedPredicate: string): PredicateNode | null {
  const scval = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
  if (scval.switch().name !== 'scvVec') return null
  const vec = scval.vec()
  if (!vec || vec.length < 2) return null
  const head = vec[0]
  if (head?.switch().name !== 'scvSymbol') return null
  const tag = head.sym().toString()
  if (tag !== 'and') return null
  const inner = vec[1]
  if (inner?.switch().name !== 'scvVec') return null
  const childVec = inner.vec()
  if (!childVec) return null
  // Recursively decode. We only care about the structural shape for tests;
  // the canonical hash remains the contract. Using the SDK ensures the same
  // encoding round-trips through the model's evaluator.
  const children: PredicateNode[] = []
  for (const c of childVec) {
    const decoded = decodeScValToPredicate(c)
    if (decoded) children.push(decoded)
  }
  return { op: 'and', children }
}

function decodeScValToPredicate(scval: xdr.ScVal): PredicateNode | null {
  if (scval.switch().name !== 'scvVec') return null
  const vec = scval.vec()
  if (!vec || vec.length < 2) return null
  const head = vec[0]
  if (head?.switch().name !== 'scvSymbol') return null
  const tag = head.sym().toString()
  switch (tag) {
    case 'and':
    case 'or': {
      const inner = vec[1]
      if (inner?.switch().name !== 'scvVec') return null
      const innerVec = inner.vec()
      if (!innerVec) return null
      const children: PredicateNode[] = []
      for (const c of innerVec) {
        const d = decodeScValToPredicate(c)
        if (d) children.push(d)
      }
      return { op: tag, children }
    }
    case 'not': {
      const child = vec[1]
      if (!child) return null
      const d = decodeScValToPredicate(child)
      if (!d) return null
      return { op: 'not', child: d }
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const left = vec[1]
      const right = vec[2]
      if (!left || !right) return null
      const leftLeaf = decodeScValToLeaf(left)
      const rightLeaf = decodeScValToLeaf(right)
      if (!leftLeaf || !rightLeaf) return null
      return { op: tag, left: leftLeaf, right: rightLeaf }
    }
    case 'in': {
      const needle = vec[1]
      const haystack = vec[2]
      if (!needle || !haystack) return null
      const needleLeaf = decodeScValToLeaf(needle)
      if (!needleLeaf) return null
      if (haystack.switch().name !== 'scvVec') return null
      const haystackVec = haystack.vec()
      if (!haystackVec) return null
      const haystackLeaves: PredicateLeaf[] = []
      for (const h of haystackVec) {
        const l = decodeScValToLeaf(h)
        if (l) haystackLeaves.push(l)
      }
      return { op: 'in', needle: needleLeaf, haystack: haystackLeaves }
    }
    default:
      return null
  }
}

function decodeScValToLeaf(scval: xdr.ScVal): PredicateLeaf | null {
  switch (scval.switch().name) {
    case 'scvSymbol': {
      const s = scval.sym().toString()
      switch (s) {
        case 'call_contract':
          return { kind: 'call_contract' }
        case 'call_fn':
          return { kind: 'call_fn' }
        case 'now':
          return { kind: 'now' }
      }
      // Symbols that aren't a tag are literal_symbols at the top level.
      return { kind: 'literal_symbol', value: s }
    }
    case 'scvVec': {
      const vec = scval.vec()
      if (!vec || vec.length === 0) return null
      const head = vec[0]
      if (head?.switch().name !== 'scvSymbol') {
        // bare vec with no head tag = literal_vec of elements
        const elements: PredicateLeaf[] = []
        for (const el of vec) {
          const e = decodeScValToLeaf(el)
          if (e) elements.push(e)
        }
        return { kind: 'literal_vec', elements }
      }
      const tag = head.sym().toString()
      switch (tag) {
        case 'call_contract':
          return { kind: 'call_contract' }
        case 'call_fn':
          return { kind: 'call_fn' }
        case 'call_arg': {
          const idx = vec[1]
          if (idx?.switch().name !== 'scvU32') return null
          return { kind: 'call_arg', index: idx.u32() }
        }
        default:
          return null
      }
    }
    case 'scvAddress':
      return { kind: 'literal_address', value: Address.fromScAddress(scval.address()).toString() }
    case 'scvU32': {
      return { kind: 'literal_u32', value: scval.u32() }
    }
    case 'scvI128': {
      // Int128Parts {hi, lo}: value = hi*2^64 + lo
      const parts = scval.i128()
      const hi = BigInt(parts.hi().toString()) << 64n
      const lo = BigInt(parts.lo().toString())
      return { kind: 'literal_i128', value: (hi + lo).toString() }
    }
    case 'scvU64':
      return { kind: 'literal_u64', value: scval.u64().toString() }
    case 'scvBytes':
      return { kind: 'literal_bytes', value: scval.bytes().toString('hex') }
    default:
      return null
  }
}

// === item 2: amount validation at the synthesizeFromRecording boundary ===

describe('synthesizeFromRecording - amount validation (item 2)', () => {
  it('rejects a non-numeric tokenMovements[].amount with RECORDING_VALIDATION_FAILED (NOT a thrown SyntaxError)', () => {
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      tokenMovements: [{ token: SEP41_TOKEN, from: G_OWNER, to: 'GBILLER', amount: 'not-an-int' }],
    }
    const res = synthesizeFromRecording(tx, { network: 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('RECORDING_VALIDATION_FAILED')
    expect(res.error.severity).toBe('error')
  })

  it('rejects a negative amount with RECORDING_VALIDATION_FAILED', () => {
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      tokenMovements: [{ token: SEP41_TOKEN, from: G_OWNER, to: 'GBILLER', amount: '-1' }],
    }
    const res = synthesizeFromRecording(tx, { network: 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('RECORDING_VALIDATION_FAILED')
  })

  it('rejects a hex/float-shaped amount with RECORDING_VALIDATION_FAILED', () => {
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      tokenMovements: [{ token: SEP41_TOKEN, from: G_OWNER, to: 'GBILLER', amount: '1.5' }],
    }
    const res = synthesizeFromRecording(tx, { network: 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('RECORDING_VALIDATION_FAILED')
  })
})

// === item 3: try/catch envelope on synthesizeFromRecording body ===

describe('synthesizeFromRecording - try/catch envelope (item 3)', () => {
  it('does not throw when the interpreter predicate exceeds encodePredicate caps; returns a structured ToolError', () => {
    // An over-cap predicate must NOT throw past the envelope. We force the
    // fail-closed path by:
    //   1. building a recorded tx that the interpreter adapter accepts as covered
    //   2. threading a `__testPredicateNode` that is too large to encode
    //      (a deeply nested `and` chain that exceeds PREDICATE_CAPS.MAX_DEPTH)
    // The `synthesizeFromRecording` envelope must catch the ToolError-shaped
    // throw from `encodePredicate` and return `{ok:false, error}`.
    const smartAccount = Address.contract(Buffer.alloc(32, 0xee)).toString()
    const overDepthPredicate: PredicateNode = (() => {
      // and -> and -> and -> ... depth 6 (PREDICATE_CAPS.MAX_DEPTH = 5).
      let n: PredicateNode = {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'transfer' },
      }
      for (let i = 0; i < 6; i++) {
        n = { op: 'and', children: [n] }
      }
      return n
    })()
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
      interpreter: {
        smartAccountAddress: smartAccount,
        __testPredicateNode: overDepthPredicate,
      },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('PREDICATE_TOO_DEEP')
    expect(res.error.severity).toBe('error')
  })
})

// === item 4: installNonce u32 bound ===

describe('synthesizeFromRecording - installNonce bound (item 4)', () => {
  it('rejects installNonce > 2**32-1 with SYNTHESIS_ERROR', () => {
    const smartAccount = Address.contract(Buffer.alloc(32, 0xee)).toString()
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      interpreter: { smartAccountAddress: smartAccount, installNonce: 2 ** 32 },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('installNonce')
  })

  it('accepts installNonce === 2**32-1 (the u32 max boundary) - validation passes', () => {
    // We use the Blend-claim fixture (the same shape the CLI test exercises)
    // so the interpreter adapter has a real IR to compile. The test asserts
    // the synthesis does NOT fail on a `SYNTHESIS_ERROR` mentioning
    // `installNonce` - the value must pass the u32 bound in `validateOptions`.
    const smartAccount = Address.contract(Buffer.alloc(32, 0xee)).toString()
    const res = synthesizeFromRecording(blendTx(), {
      network: 'mainnet',
      userResponses: { invocationLimit: 1, validUntilLedger: 200000000 },
      interpreter: { smartAccountAddress: smartAccount, installNonce: 2 ** 32 - 1 },
    })
    if (!res.ok) {
      // A failure is acceptable (the test fixture may not lower cleanly),
      // but it must NOT be a `SYNTHESIS_ERROR` driven by the installNonce
      // bound - that would mean validateOptions rejected a valid u32 value.
      expect(
        res.error.code === 'SYNTHESIS_ERROR' && res.error.message.includes('installNonce')
      ).toBe(false)
    }
  })
})

// === item 5: placeholder-address blocklist ===

describe('synthesizeFromRecording - placeholder smartAccountAddress blocklist (item 5)', () => {
  it('rejects a VERIFY- prefixed smart account address with SYNTHESIS_ERROR', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      interpreter: { smartAccountAddress: 'VERIFY-fake-account' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.message).toContain('placeholder')
  })

  it('rejects a PLACEHOLDER- prefixed smart account address with SYNTHESIS_ERROR', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      interpreter: { smartAccountAddress: 'PLACEHOLDER-account' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })

  it('rejects a TODO- prefixed smart account address (case-insensitive) with SYNTHESIS_ERROR', () => {
    const res = synthesizeFromRecording(sep41Tx(), {
      network: 'mainnet',
      interpreter: { smartAccountAddress: 'todo-account' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })
})

// ---------------------------------------------------------------------------
// Item 1: zero-invocation recording refusal (recorder remains faithful at
// parseConfidence 1.0; the synth refuses because a policy must scope to an
// authorized contract call).
// ---------------------------------------------------------------------------

describe('synthesizeFromRecording - zero-invocation recording (item 1)', () => {
  it('REFUSES a zero-invocation recording with SYNTHESIS_ERROR + an actionable message (no ABI guidance)', () => {
    // Mirror the shape produced by the recorder for an `invokeHostFunction` that
    // uploads wasm or creates a contract: invocations=[], parseConfidence 1.0,
    // and the recorder-side noInvocations marker set. The synth must refuse
    // because a policy is scoped to an authorized contract call and the
    // recording has no contract invocation to scope to.
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      invocations: [],
      tokenMovements: [],
      parseConfidence: { ...FULL, noInvocations: true },
    }
    const res = synthesizeFromRecording(tx, { network: 'mainnet' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
    expect(res.error.severity).toBe('error')
    expect(res.error.retryable).toBe(false)
    // Must plainly state the recording has no contract invocation.
    expect(res.error.message.toLowerCase()).toContain('no contract invocation')
    // Must NOT tell the user to supply an ABI - the failure mode here is
    // about the recording shape, not about decoding coverage.
    expect(res.error.message.toLowerCase()).not.toContain('supply an abi')
  })

  it('REFUSES a zero-invocation recording even when the user supplied limit + window responses', () => {
    // The refusal must happen regardless of userResponses - the recording has
    // nothing to scope to, so additional user inputs cannot rescue it.
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      invocations: [],
      tokenMovements: [],
      parseConfidence: { ...FULL, noInvocations: true },
    }
    const res = synthesizeFromRecording(tx, {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })

  it('REFUSES a zero-invocation recording on the interpreter path too', () => {
    // The interpreter path needs a top-level invocation to build the permit
    // context; refusing zero-invocation recordings here too means the gate
    // is upstream of the interpreter wiring (single decision point).
    const tx: RecordedTransaction = {
      ...sep41Tx(),
      invocations: [],
      tokenMovements: [],
      parseConfidence: { ...FULL, noInvocations: true },
    }
    const res = synthesizeFromRecording(tx, interpreterOpts())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SYNTHESIS_ERROR')
  })
})

// ---------------------------------------------------------------------------
// TS-F1: __testPredicateNode is a test-only seam.
// Not in the public `InterpreterAdapterOptions` type; the body reads it via a
// private cast and refuses any use outside NODE_ENV=test so a production
// caller that smuggles it in (any-cast, JSON-driven opt) cannot bypass the
// recording -> interpreter adapter compile path.
// ---------------------------------------------------------------------------

describe('synthesizeFromRecording - __testPredicateNode test seam (TS-F1)', () => {
  it('refuses __testPredicateNode when NODE_ENV is not "test"', () => {
    // The seam is a defense-in-depth escape hatch - production callers
    // (e.g. a future serverless function) must NOT be able to substitute a
    // hand-crafted predicate for the compiled one. The body throws a plain
    // Error (NOT a ToolError), so it surfaces past the envelope as a genuine
    // bug rather than a structured failure.
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      const opts = {
        network: 'mainnet' as const,
        interpreter: {
          smartAccountAddress: SMART_ACCOUNT,
          installNonce: 1,
          __testPredicateNode: {
            op: 'eq' as const,
            left: { kind: 'call_fn' as const },
            right: { kind: 'literal_symbol' as const, value: 'claim' },
          },
        },
      } as unknown as Parameters<typeof synthesizeFromRecording>[1]
      expect(() => synthesizeFromRecording(validSep41Tx(), opts)).toThrow(
        /__testPredicateNode is a test-only seam/
      )
    } finally {
      process.env.NODE_ENV = original
    }
  })
})
