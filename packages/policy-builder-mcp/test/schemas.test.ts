// packages/policy-builder-mcp/test/schemas.test.ts
//
// Round-trip + reject tests for the Zod input schemas. Malformed inputs must
// surface a machine-readable ZodError (no throws in the tool path).

import { describe, expect, it } from 'bun:test'
import {
  RecordTransactionInputSchema,
  SynthesizePolicyInputSchema,
  ToolErrorSchema,
} from '../src/schemas.ts'

describe('RecordTransactionInputSchema', () => {
  it('accepts a valid hash + network input', () => {
    const r = RecordTransactionInputSchema.safeParse({
      hash: 'a'.repeat(64),
      network: 'testnet',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid xdr + network input', () => {
    const r = RecordTransactionInputSchema.safeParse({
      xdr: 'AAAA',
      network: 'mainnet',
    })
    expect(r.success).toBe(true)
  })

  it('rejects when both hash and xdr are provided (no throw, structured issue)', () => {
    const r = RecordTransactionInputSchema.safeParse({
      hash: 'a'.repeat(64),
      xdr: 'AAAA',
      network: 'testnet',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(' | ')
      expect(messages).toMatch(/not both/)
    }
  })

  it('rejects when neither hash nor xdr is provided', () => {
    const r = RecordTransactionInputSchema.safeParse({ network: 'testnet' })
    expect(r.success).toBe(false)
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(' | ')
      expect(messages).toMatch(/required/)
    }
  })

  it('rejects when network is missing', () => {
    const r = RecordTransactionInputSchema.safeParse({ hash: 'a'.repeat(64) })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown network value', () => {
    const r = RecordTransactionInputSchema.safeParse({
      hash: 'a'.repeat(64),
      network: 'devnet',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a confidenceOverride outside [0, 1]', () => {
    const r = RecordTransactionInputSchema.safeParse({
      hash: 'a'.repeat(64),
      network: 'testnet',
      confidenceOverride: 1.5,
    })
    expect(r.success).toBe(false)
  })
})

describe('SynthesizePolicyInputSchema (discriminated union)', () => {
  it('accepts a recording source with a recordedTx', () => {
    const r = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'mainnet',
      recordedTx: {
        network: 'mainnet',
        signers: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD'],
        invocations: [
          {
            contract: 'CCTOKEN',
            fn: 'transfer',
            args: [
              {
                type: 'address',
                value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD',
              },
              { type: 'address', value: 'GBILLER' },
              { type: 'i128', value: '100' },
            ],
            subInvocations: [],
          },
        ],
        tokenMovements: [],
        events: [],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD',
      },
    })
    expect(r.success).toBe(true)
  })

  it('accepts a recordedTx whose event carries a negative i128 (signed; e.g. a fee refund)', () => {
    // The recorder emits negative i128 event data for fee-adjustment/refund
    // events; its own output must round-trip through the synthesize input schema.
    const r = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'mainnet',
      recordedTx: {
        network: 'mainnet',
        signers: [],
        invocations: [],
        tokenMovements: [],
        events: [
          { contract: 'CFEE', topics: ['fee', 'GSRC'], data: { type: 'i128', value: '22248' } },
          { contract: 'CFEE', topics: ['fee', 'GSRC'], data: { type: 'i128', value: '-9741' } },
        ],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GSRC',
      },
    })
    expect(r.success).toBe(true)
  })

  it('accepts a recordedTx with a negative TokenMovement.amount (recorder passes the signed i128 through)', () => {
    const r = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'mainnet',
      recordedTx: {
        network: 'mainnet',
        signers: [],
        invocations: [],
        tokenMovements: [{ token: 'CTOK', from: 'GSRC', to: 'GDST', amount: '-42' }],
        events: [],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GSRC',
      },
    })
    expect(r.success).toBe(true)
  })

  it('rejects a negative u64/u32 (unsigned stay non-negative)', () => {
    const base = {
      source: 'recording' as const,
      network: 'mainnet' as const,
      recordedTx: {
        network: 'mainnet',
        signers: [],
        invocations: [
          { contract: 'C', fn: 'f', args: [{ type: 'u64', value: '-1' }], subInvocations: [] },
        ],
        tokenMovements: [],
        events: [],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GSRC',
      },
    }
    expect(SynthesizePolicyInputSchema.safeParse(base).success).toBe(false)
  })

  it('rejects a recording source missing network', () => {
    const r = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      recordedTx: {
        network: 'mainnet',
        signers: [],
        invocations: [],
        tokenMovements: [],
        events: [],
        authEntries: [],
        ledgerSequence: 0,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD',
      },
    })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown source discriminator', () => {
    const r = SynthesizePolicyInputSchema.safeParse({ source: 'codegen' })
    expect(r.success).toBe(false)
  })

  it('rejects a userResponses.validUntilLedger above the u32 max', () => {
    const r = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'mainnet',
      userResponses: { validUntilLedger: 4294967296 },
      recordedTx: {
        network: 'mainnet',
        signers: [],
        invocations: [],
        tokenMovements: [],
        events: [],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GSRC',
      },
    })
    expect(r.success).toBe(false)
  })

  it('rejects a recordedTx whose invocations array exceeds the cap', () => {
    const one = {
      contract: 'C',
      fn: 'f',
      args: [] as unknown[],
      subInvocations: [] as unknown[],
    }
    const r = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'mainnet',
      recordedTx: {
        network: 'mainnet',
        signers: [],
        invocations: Array.from({ length: 513 }, () => ({ ...one })),
        tokenMovements: [],
        events: [],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 0,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GSRC',
      },
    })
    expect(r.success).toBe(false)
  })
})

describe('ToolErrorSchema', () => {
  it('accepts a canonical ToolError envelope', () => {
    const r = ToolErrorSchema.safeParse({
      code: 'RECORDING_FAILED',
      message: 'fail',
      severity: 'error',
      retryable: false,
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown severity value', () => {
    const r = ToolErrorSchema.safeParse({
      code: 'X',
      message: 'm',
      severity: 'critical',
      retryable: false,
    })
    expect(r.success).toBe(false)
  })
})
