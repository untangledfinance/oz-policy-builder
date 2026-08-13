// Offline corpus that exercises the recorder end-to-end against hand-built
// Soroban envelopes. The LIVE integration test (`integration.test.ts`) used
// to be the only place this path was exercised; the live RPC made that a
// hollow gate (sampled unrecognised contracts, never reached the decode
// assertions) AND a flaky publish gate (could spuriously fail on a zero-
// invocation Soroban tx). This file is the deterministic, offline, always-
// run answer.
//
// Every case below uses `Operation.*` SDK helpers (no fabrication) so the
// envelope XDR is a real, round-trippable Stellar transaction envelope. The
// differentiator is WHICH host function each envelope uses, and the
// corresponding recorder verdict.
//
// The four required cases are covered:
//   1. recognised-protocol tx (SEP-41 transfer) -> CLEARS (parseConfidence 1.0)
//   2. unrecognised-contract tx (unknown contract + fn) -> REFUSES
//   3. zero-invocation host-fn tx (createContract / uploadContractWasm) -> OK
//      with invocations:[] (this is the case the live test wrongly rejected;
//      the decoder correctly skips non-`invokeContract` host function types)
//   4. FAILED tx (faked via injected fetcher) -> recorder runs end-to-end
//      and surfaces the parsed data without throwing

import { describe, expect, it } from 'bun:test'
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import type { OnChainEvent } from '../types.ts'
import { recordTransaction } from './index.ts'
import type { RpcFetcher, SorobanTxResponse } from './rpc.ts'

function buildTransferEnvelopeXdr(opts: { token?: string } = {}): string {
  const sourceKp = Keypair.random()
  const acc = new Account(sourceKp.publicKey(), '0')
  const from = Address.fromString(Keypair.random().publicKey())
  const to = Address.fromString(Keypair.random().publicKey())
  const token = opts.token ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
  const op = Operation.invokeContractFunction({
    contract: token,
    function: 'transfer',
    args: [
      xdr.ScVal.scvAddress(from.toScAddress()),
      xdr.ScVal.scvAddress(to.toScAddress()),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString('0'),
          lo: xdr.Uint64.fromString('100'),
        })
      ),
    ],
    auth: [],
  })
  const tx = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  return tx.toEnvelope().toXDR().toString('base64')
}

function buildUnknownContractEnvelopeXdr(): string {
  const sourceKp = Keypair.random()
  const acc = new Account(sourceKp.publicKey(), '0')
  // Synthesise a valid, unpinned contract strkey from a fixed 32-byte hash.
  const unknownContract = Address.contract(Buffer.alloc(32, 0x99)).toString()
  const op = Operation.invokeContractFunction({
    contract: unknownContract,
    function: 'completely_unknown_fn',
    args: [],
    auth: [],
  })
  const tx = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  return tx.toEnvelope().toXDR().toString('base64')
}

function buildCreateContractEnvelopeXdr(): string {
  const sourceKp = Keypair.random()
  const acc = new Account(sourceKp.publicKey(), '0')
  // createContract uses hostFunctionTypeCreateContract, NOT
  // hostFunctionTypeInvokeContract. The decoder's
  // `decodeV1Envelope` only pushes an invocation for the invokeContract
  // branch - so a createContract op yields a valid decoded envelope
  // with `invocations: []`. This is the empty-invocation case the live
  // integration test wrongly rejected.
  const op = Operation.createCustomContract({
    wasmHash: Buffer.alloc(32, 0xab),
    address: Address.fromString(Keypair.random().publicKey()),
    salt: Buffer.alloc(32, 0xcd),
  })
  const tx = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  return tx.toEnvelope().toXDR().toString('base64')
}

function buildUploadWasmEnvelopeXdr(): string {
  const sourceKp = Keypair.random()
  const acc = new Account(sourceKp.publicKey(), '0')
  // uploadContractWasm is the third valid Soroban host function type.
  // Like createContract, it is NOT invokeContract and yields zero
  // invocations through the decoder.
  const op = Operation.uploadContractWasm({ wasm: Buffer.alloc(64, 0xef) })
  const tx = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  return tx.toEnvelope().toXDR().toString('base64')
}

function buildFetcher(opts: {
  envelopeXdr: string
  status?: 'SUCCESS' | 'FAILED'
  events?: OnChainEvent[]
}): RpcFetcher {
  const env = xdr.TransactionEnvelope.fromXDR(opts.envelopeXdr, 'base64')
  const txEventsXdr: xdr.TransactionEvent[] = (opts.events ?? []).map((e) => {
    const topicsScval: xdr.ScVal[] = e.topics.map((t) =>
      t.startsWith('G') || t.startsWith('C')
        ? xdr.ScVal.scvAddress(Address.fromString(t).toScAddress())
        : xdr.ScVal.scvSymbol(t)
    )
    const dataScval =
      e.data.type === 'i128'
        ? xdr.ScVal.scvI128(
            new xdr.Int128Parts({
              hi: xdr.Int64.fromString('0'),
              lo: xdr.Uint64.fromString(e.data.value),
            })
          )
        : xdr.ScVal.scvVoid()
    const v0 = new xdr.ContractEventV0({ topics: topicsScval, data: dataScval })
    const body = new xdr.ContractEventBody(0, v0)
    const contractEvent = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: Buffer.from(
        Address.fromString(e.contract).toScAddress().contractId() as Uint8Array
      ),
      type: new xdr.ContractEventType('contract'),
      body,
    })
    return new xdr.TransactionEvent({
      stage: new xdr.TransactionEventStage('soroban'),
      event: contractEvent,
    })
  })
  const fetcher: RpcFetcher = async (): Promise<SorobanTxResponse | null> => {
    return {
      status: opts.status ?? 'SUCCESS',
      ledger: 12345,
      createdAt: Math.floor(Date.now() / 1000),
      txHash: 'a'.repeat(64),
      envelopeXdr: env,
      events: {
        transactionEventsXdr: txEventsXdr,
        contractEventsXdr: [],
      },
    }
  }
  return fetcher
}

describe('recorder offline corpus (declare the contract of decode shapes)', () => {
  // ===== Case 1: recognised-protocol tx CLEARS =====
  it('CLEARS a recognised SEP-41 transfer (XDR mode, parseConfidence = 1.0)', async () => {
    const envXdr = buildTransferEnvelopeXdr()
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations.length).toBe(1)
      expect(r.data.invocations[0]?.fn).toBe('transfer')
      expect(r.data.parseConfidence.overall).toBe(1.0)
      expect(r.data.parseConfidence.unknownContracts.length).toBe(0)
    }
  })

  // ===== Case 2: unrecognised-contract tx REFUSES =====
  it('REFUSES an unrecognised contract + fn (XDR mode, RECORDING_VALIDATION_FAILED)', async () => {
    const envXdr = buildUnknownContractEnvelopeXdr()
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_VALIDATION_FAILED')
      expect(r.error.severity).toBe('error')
      expect(r.error.retryable).toBe(false)
      expect(r.error.remediation?.userQuestion?.code).toBe('PARSE_CONFIDENCE_BELOW_THRESHOLD')
      expect((r.error.details as { overall?: number })?.overall).toBeLessThan(1.0)
    }
  })

  // ===== Case 3a: zero-invocation host-fn (createContract) =====
  // This is the case the live test wrongly rejected. The decoder's
  // `decodeV1Envelope` only pushes an invocation for invokeContract; a
  // createContract op yields an empty `invocations` array, and the
  // freshness module treats the empty-decode case as full confidence
  // (denom === 0 -> overall = 1.0). The recording is valid.
  it('ACCEPTS a createContract host-fn tx with zero invocations (XDR mode)', async () => {
    const envXdr = buildCreateContractEnvelopeXdr()
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations).toEqual([])
      expect(r.data.parseConfidence.overall).toBe(1.0)
      expect(r.data.parseConfidence.knownContracts).toEqual([])
      expect(r.data.parseConfidence.unknownContracts).toEqual([])
      expect(r.data.parseConfidence.opaqueScVals).toEqual([])
    }
  })

  // ===== Case 3b: zero-invocation host-fn (uploadContractWasm) =====
  it('ACCEPTS an uploadContractWasm host-fn tx with zero invocations (XDR mode)', async () => {
    const envXdr = buildUploadWasmEnvelopeXdr()
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations).toEqual([])
      expect(r.data.parseConfidence.overall).toBe(1.0)
    }
  })

  // ===== Case 3c: on-chain mode with zero invocations =====
  // Same case as 3a but via the injected fetcher path; confirms the
  // shape holds end-to-end (decode + freshness + validate + record).
  it('ACCEPTS a createContract on-chain tx with zero invocations', async () => {
    const envXdr = buildCreateContractEnvelopeXdr()
    const fetcher = buildFetcher({ envelopeXdr: envXdr })
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'a'.repeat(64),
      fetcher,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations).toEqual([])
      expect(r.data.parseConfidence.overall).toBe(1.0)
    }
  })

  // ===== Case 4: FAILED tx end-to-end =====
  // The fetcher reports status='FAILED' (the on-chain transaction did
  // not succeed). The recorder still decodes the envelope and surfaces
  // the parsed data - the gate is on parseConfidence, not on success.
  it('RUNS end-to-end on a FAILED tx (on-chain mode, no RECORDING_FAILED)', async () => {
    const envXdr = buildTransferEnvelopeXdr()
    const fetcher = buildFetcher({ envelopeXdr: envXdr, status: 'FAILED' })
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'a'.repeat(64),
      fetcher,
    })
    // No events -> events-validation skipped; recognised SEP-41 transfer
    // -> parseConfidence = 1.0 -> recording clears.
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations.length).toBe(1)
      expect(r.data.invocations[0]?.fn).toBe('transfer')
    }
  })

  // ===== Shape invariant: every ok result has well-typed fields =====
  // Pins the shape constraint that the live test was attempting to
  // assert via a flaky count. Replaces `invocations.length > 0` with
  // type-and-array invariants that hold for every legitimate decode
  // result (including zero-invocation host-fn tx).
  it('returned invocations are always well-typed arrays of objects (shape invariant)', async () => {
    const envelopes = [
      buildTransferEnvelopeXdr(),
      buildUnknownContractEnvelopeXdr(),
      buildCreateContractEnvelopeXdr(),
      buildUploadWasmEnvelopeXdr(),
    ]
    for (const envXdr of envelopes) {
      const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
      if (r.ok) {
        expect(Array.isArray(r.data.invocations)).toBe(true)
        for (const inv of r.data.invocations) {
          expect(typeof inv.contract).toBe('string')
          expect(typeof inv.fn).toBe('string')
          expect(Array.isArray(inv.args)).toBe(true)
          expect(Array.isArray(inv.subInvocations)).toBe(true)
        }
      }
    }
  })

  // ===== Item 1: zero-invocation recordings carry the recorder-side marker.
  // The math is unchanged (overall = 1.0 via the denom === 0 guard), but the
  // marker makes the silence visible so the synth can refuse the recording
  // rather than infer it from `invocations: []` next to `overall: 1.0`.
  it('sets noInvocations=true on the parseConfidence when zero invocations were decoded', async () => {
    for (const envXdr of [buildCreateContractEnvelopeXdr(), buildUploadWasmEnvelopeXdr()]) {
      const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.data.invocations).toEqual([])
      // The pre-existing overall / known / unknown / opaque assertions stay
      // intact (no math change). Only the new marker is added.
      expect(r.data.parseConfidence.overall).toBe(1.0)
      expect(r.data.parseConfidence.noInvocations).toBe(true)
    }
  })

  it('does NOT set noInvocations=true when >= 1 invocation was decoded', async () => {
    const envXdr = buildTransferEnvelopeXdr()
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.invocations.length).toBeGreaterThan(0)
      expect(r.data.parseConfidence.noInvocations).toBeUndefined()
    }
  })
})
