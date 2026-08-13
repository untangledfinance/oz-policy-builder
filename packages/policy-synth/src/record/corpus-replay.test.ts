/**
 * corpus-replay.test.ts
 *
 * Offline replay of the real mainnet Soroban corpus through `recordTransaction`
 * in BOTH hash-injected and XDR modes.
 *
 * Every entry in `corpus-fixtures.json` is verified against the recorder.
 * The envelope XDR is what makes this deterministic — no network in the
 * default `bun test` path.
 *
 * Expected outcomes by category:
 *   sep41:transfer|mint|burn|approve  -> CLEARS (parseConfidence 1.0, known ABI match)
 *   blend:submit|claim                 -> CLEARS (parseConfidence 1.0, known ABI match)
 *   soroswap:*                        -> CLEARS or LOW_CONF (parseConfidence < 1 if args don't match ABI)
 *   unrecognised:*                    -> REFUSES (RECORDING_VALIDATION_FAILED, unknown contract+fn)
 *   createContract                    -> ACCEPTED with invocations:[] (zero-invocation case)
 *   uploadContractWasm                -> ACCEPTED with invocations:[] (zero-invocation case)
 *
 * The Blend claim `_control: true` entry is the regression guard from the brief.
 */

import { describe, expect, it } from 'bun:test'
import { xdr } from '@stellar/stellar-sdk'
import corpusEntries from './corpus-fixtures.json'
import { recordTransaction } from './index.ts'
import type { RpcFetcher, SorobanTxResponse } from './rpc.ts'

// Rehydrate the JSON entries (envelopeXdr is base64 string)
type CorpusEntry = {
  hash: string
  contract: string
  protocol: string
  hostFnType: string
  opCount: number
  success: boolean
  envelopeXdr: string
  category: string
  ledger: number
  createdAt: number
  _control?: boolean
}

const CORPUS = corpusEntries as CorpusEntry[]

// ── Build hash-mode injectors (one per unique hash) ─────────────────────────
function buildFetcher(hashToEntry: Map<string, CorpusEntry>): RpcFetcher {
  return async (hash: string): Promise<SorobanTxResponse | null> => {
    const entry = hashToEntry.get(hash)
    if (!entry) return null
    const envelopeXdr = xdr.TransactionEnvelope.fromXDR(entry.envelopeXdr, 'base64')
    return {
      status: entry.success ? 'SUCCESS' : 'FAILED',
      ledger: entry.ledger,
      createdAt: entry.createdAt,
      txHash: hash,
      envelopeXdr,
      events: { transactionEventsXdr: [], contractEventsXdr: [] },
    }
  }
}

// ── Expected outcome per category ────────────────────────────────────────────
type ExpectedOutcome =
  | { type: 'clears'; minInvocations?: number; parseConfidence?: number }
  | { type: 'refuses' }
  | { type: 'accepts_zero_invocations' } // createContract / uploadContractWasm

function expectedOutcome(entry: CorpusEntry): ExpectedOutcome {
  // Zero-invocation cases (the host-fn is NOT invokeContract)
  if (entry.hostFnType !== 'hostFunctionTypeInvokeContract') {
    return { type: 'accepts_zero_invocations' }
  }
  // Known protocol -> should clear
  if (['sep41', 'blend', 'soroswap'].includes(entry.protocol)) {
    return { type: 'clears', minInvocations: 1 }
  }
  // Unrecognised -> fail-closed
  return { type: 'refuses' }
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('corpus replay: real mainnet Soroban transactions', () => {
  // Build hash -> entry map for fetcher
  const hashToEntry = new Map<string, CorpusEntry>()
  for (const entry of CORPUS) hashToEntry.set(entry.hash, entry)
  const fetcher = buildFetcher(hashToEntry)

  for (const entry of CORPUS) {
    const outcome = expectedOutcome(entry)
    const testLabel = `${entry.category} (${entry.hash.slice(0, 8)}…)`

    // ── XDR mode ──────────────────────────────────────────────────────────
    it(`XDR: ${testLabel}`, async () => {
      const r = await recordTransaction({
        network: 'mainnet',
        xdr: entry.envelopeXdr,
      })

      if (outcome.type === 'accepts_zero_invocations') {
        expect(r.ok).toBe(true)
        if (r.ok) {
          expect(Array.isArray(r.data.invocations)).toBe(true)
          expect(r.data.invocations).toEqual([])
          expect(r.data.parseConfidence.overall).toBe(1.0)
        }
        return
      }

      if (outcome.type === 'clears') {
        expect(r.ok).toBe(true)
        if (!r.ok) {
          const msg = `${testLabel}: expected to clear but got error: ${r.error?.code}`
          throw new Error(msg)
        }
        if (outcome.minInvocations !== undefined) {
          expect(r.data.invocations.length).toBeGreaterThanOrEqual(outcome.minInvocations)
        }
        if (outcome.parseConfidence !== undefined) {
          expect(r.data.parseConfidence.overall).toBeGreaterThanOrEqual(outcome.parseConfidence)
        }
        return
      }

      // refuses
      expect(r.ok).toBe(false)
      if (r.ok) {
        const msg = `${testLabel}: expected to refuse but got ok`
        throw new Error(msg)
      }
    })

    // ── Hash mode (injector) ───────────────────────────────────────────────
    it(`HASH: ${testLabel}`, async () => {
      const r = await recordTransaction({
        network: 'mainnet',
        hash: entry.hash,
        fetcher,
      })

      if (outcome.type === 'accepts_zero_invocations') {
        expect(r.ok).toBe(true)
        if (r.ok) {
          expect(Array.isArray(r.data.invocations)).toBe(true)
          expect(r.data.invocations).toEqual([])
        }
        return
      }

      if (outcome.type === 'clears') {
        expect(r.ok).toBe(true)
        if (r.ok && outcome.minInvocations !== undefined) {
          expect(r.data.invocations.length).toBeGreaterThanOrEqual(outcome.minInvocations)
        }
        return
      }

      // refuses
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe('RECORDING_VALIDATION_FAILED')
      }
    })
  }

  // ── Regression guard: Blend submit control ──────────────────────────────
  it('REGRESSION: Blend submit -> ok:true, invocations=1, parseConfidence=1.0', async () => {
    const blendSubmit = CORPUS.find((e) => e._control === true && e.category === 'blend:submit')
    expect(blendSubmit).toBeDefined()

    const r = await recordTransaction({ network: 'mainnet', xdr: blendSubmit?.envelopeXdr ?? '' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations.length).toBe(1)
      expect(r.data.invocations[0]?.fn).toBe('submit')
      expect(r.data.parseConfidence.overall).toBe(1.0)
      expect(r.data.parseConfidence.unknownContracts).toEqual([])
    }
  })

  // ── Regression guard: SEP-41 transfer control ─────────────────────────────
  it('REGRESSION: SEP-41 transfer -> ok:true, movements>=0', async () => {
    const sep41Tx = CORPUS.find((e) => e.category === 'sep41:transfer')
    expect(sep41Tx).toBeDefined()

    const r = await recordTransaction({ network: 'mainnet', xdr: sep41Tx?.envelopeXdr ?? '' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations.length).toBeGreaterThanOrEqual(1)
      expect(r.data.invocations[0]?.fn).toBe('transfer')
    }
  })

  // ── Shape invariant: every ok result has well-typed invocations ──────────
  it('shape invariant: ok results always have well-typed invocations arrays', async () => {
    for (const entry of CORPUS) {
      const r = await recordTransaction({ network: 'mainnet', xdr: entry.envelopeXdr })
      if (r.ok) {
        expect(Array.isArray(r.data.invocations)).toBe(true)
        for (const inv of r.data.invocations) {
          expect(typeof inv.contract).toBe('string')
          expect(typeof inv.fn).toBe('string')
          expect(Array.isArray(inv.args)).toBe(true)
          expect(Array.isArray(inv.subInvocations)).toBe(true)
        }
        expect(typeof r.data.parseConfidence.overall).toBe('number')
      }
    }
  })
})
