// src/run/synthesize-by-hash.test.ts - `synthesize_policy` accepts a transaction
// hash as an alternative to a full RecordedTransaction.
//
// Why this exists: an MCP client has no variable to pass by reference, so an
// agent handed a recording must retype it. Real recordings run to thousands of
// characters, a dozen levels deep, carrying exact i128 strings; agents lose
// fields doing that, and the synthesis then fails on a payload the server had
// already produced correctly. Passing a 64-character hash removes the copy.
//
// These tests cover the boundary only - that one of the two inputs is required,
// and that the hash form is shaped correctly. Whether re-recording returns the
// same recording is a property of `record_transaction` and is covered there.

import { describe, expect, it } from 'bun:test'
import { SynthesizePolicyInputSchema } from './schemas.ts'

const HASH = '7508e761a6b658c7f54930c75db2aa5878b20a45cdabc341ee03815a7383b4a4'

describe('SynthesizePolicyInputSchema', () => {
  it('accepts a hash instead of a recording', () => {
    const parsed = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'testnet',
      transactionHash: HASH,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a request naming neither, rather than synthesizing from nothing', () => {
    const parsed = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'testnet',
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(' ')).toContain('recordedTx')
    }
  })

  it('rejects a malformed hash at the boundary', () => {
    for (const bad of ['not-a-hash', HASH.toUpperCase(), HASH.slice(0, 63), `${HASH}00`]) {
      const parsed = SynthesizePolicyInputSchema.safeParse({
        source: 'recording',
        network: 'testnet',
        transactionHash: bad,
      })
      expect(parsed.success).toBe(false)
    }
  })

  it('still accepts a full recording, so programmatic callers are unaffected', () => {
    const parsed = SynthesizePolicyInputSchema.safeParse({
      source: 'recording',
      network: 'testnet',
      recordedTx: {
        network: 'testnet',
        signers: [],
        invocations: [],
        tokenMovements: [],
        events: [],
        authEntries: [],
        ledgerSequence: 1,
        fetchedAt: 1,
        parseConfidence: {
          overall: 1,
          knownContracts: [],
          unknownContracts: [],
          opaqueScVals: [],
          thresholdUsed: 1,
        },
        sourceAccount: 'GCM5SEV4U4YIR22PEMLHPR2MNFSB2SXCV2NYKHM7BHJEAYEMLCIPRWYN',
      },
    })
    expect(parsed.success).toBe(true)
  })
})
