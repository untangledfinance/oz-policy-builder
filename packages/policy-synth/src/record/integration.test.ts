// Integration test against the LIVE public Soroban testnet RPC.
//
// GATED: this test only runs when the env flag `RUN_LIVE_TESTS=1` is set.
// Default `bun test` and every `prepublishOnly` publish gate SKIP it
// deterministically - the live RPC is non-deterministic (RPC outages,
// rate limits, time-varying event stream), so it must NOT be a publish
// gate. The deterministic offline coverage lives in
// `decoder.fixtures.test.ts` (next to this file) and is the actual
// contract for the decode path.
//
// When opted in, the test samples a real Soroban tx whose envelope
// contains at least one `invokeHostFunction` operation, then exercises
// both recorder modes (on-chain hash + XDR) and asserts the result
// shape (whichever verdict the network returned). The decoder does NOT
// guarantee that an `invokeHostFunction` op produces an `invocation` -
// `uploadContractWasm` and `createContract` are valid host functions
// that the recorder correctly surfaces as `invocations: []` (see
// `decodeV1Envelope` in decode.ts: the `hostFunctionTypeInvokeContract`
// branch is the only one that pushes an invocation). The assertion is
// therefore a shape/type invariant, not a count.

import { describe, expect, it } from 'bun:test'
import { rpc, xdr } from '@stellar/stellar-sdk'
import { recordTransaction } from './index.ts'
import { probeNetwork } from './rpc.ts'

const TESTNET_RPC = 'https://soroban-testnet.stellar.org'
const RUN_LIVE = process.env.RUN_LIVE_TESTS === '1'

describe('recordTransaction integration (live testnet RPC, opt-in via RUN_LIVE_TESTS=1)', () => {
  if (!RUN_LIVE) {
    it.skip('skipped: set RUN_LIVE_TESTS=1 to exercise the live Soroban testnet RPC', () => {})
    return
  }

  it('runs end-to-end against a recent testnet Soroban transaction (skips if unreachable)', async () => {
    const reachable = await probeNetwork('testnet', 10000)
    if (!reachable) {
      console.warn(`[integration.test] testnet RPC ${TESTNET_RPC} unreachable; self-skipping`)
      return
    }
    const server = new rpc.Server(TESTNET_RPC, { allowHttp: false })
    const latest = await server.getLatestLedger()
    // Discover via contract events - high signal for Soroban activity.
    let sorobanTx: { txHash: string; envelopeXdr: string } | null = null
    const events = await server.getEvents({
      startLedger: Math.max(1, latest.sequence - 1000),
      endLedger: latest.sequence,
      filters: [{ type: 'contract' }],
      pagination: { limit: 20 },
    })
    for (const evt of events.events ?? []) {
      try {
        const fetched = await server.getTransaction(evt.txHash)
        if (
          fetched.status !== rpc.Api.GetTransactionStatus.SUCCESS &&
          fetched.status !== rpc.Api.GetTransactionStatus.FAILED
        )
          continue
        const env = xdr.TransactionEnvelope.fromXDR(
          fetched.envelopeXdr.toXDR().toString('base64'),
          'base64'
        )
        if (env.switch().name !== 'envelopeTypeTx') continue
        const ops = env.v1().tx().operations()
        if (!ops.some((op) => op.body().switch().name === 'invokeHostFunction')) continue
        sorobanTx = {
          txHash: fetched.txHash,
          envelopeXdr: env.toXDR().toString('base64'),
        }
        break
      } catch {}
    }
    if (!sorobanTx) {
      console.warn(
        `[integration.test] no Soroban invoke-host-function tx found via contract events within window endLedger=${latest.sequence}`
      )
      return
    }
    const sampledHash = sorobanTx.txHash

    const onChain = await recordTransaction({
      network: 'testnet',
      hash: sampledHash,
    })
    const xdrMode = await recordTransaction({
      network: 'testnet',
      xdr: sorobanTx.envelopeXdr,
    })

    // Diagnostic so the harness records what was sampled + which assertions fired.
    console.info(
      `[integration.test] sampledHash=${sampledHash} onChain.ok=${onChain.ok} xdr.ok=${xdrMode.ok}`
    )
    if (onChain.ok) {
      console.info(
        `  onChain invocations=${onChain.data.invocations.length} movements=${onChain.data.tokenMovements.length}`
      )
    } else {
      console.info(`  onChain error=${onChain.error.code}: ${onChain.error.message.slice(0, 100)}`)
    }
    if (xdrMode.ok) {
      console.info(
        `  xdr invocations=${xdrMode.data.invocations.length} movements=${xdrMode.data.tokenMovements.length}`
      )
    } else {
      console.info(`  xdr error=${xdrMode.error.code}: ${xdrMode.error.message.slice(0, 100)}`)
    }

    // 1. The recorder path ran end-to-end (no RECORDING_FAILED from network errors).
    if (!onChain.ok) {
      expect(onChain.error.code).not.toBe('RECORDING_FAILED')
    }

    // 2. XDR mode shape invariants. The decoder does NOT guarantee >=1
    //    invocation on every `ok` decode: `uploadContractWasm` and
    //    `createContract` host functions are valid and yield ZERO
    //    invocations (decode.ts only pushes for `hostFunctionTypeInvokeContract`).
    //    So we assert TYPE invariants, not counts.
    if (xdrMode.ok) {
      expect(Array.isArray(xdrMode.data.invocations)).toBe(true)
      for (const inv of xdrMode.data.invocations) {
        expect(typeof inv.contract).toBe('string')
        expect(typeof inv.fn).toBe('string')
        expect(Array.isArray(inv.args)).toBe(true)
        expect(Array.isArray(inv.subInvocations)).toBe(true)
      }
      expect(xdrMode.data.network).toBe('testnet')
    } else {
      expect(xdrMode.error.code).toBe('RECORDING_VALIDATION_FAILED')
      expect(xdrMode.error.severity).toBe('error')
      expect(xdrMode.error.retryable).toBe(false)
      expect(xdrMode.error.remediation?.userQuestion).toBeDefined()
    }

    // 3. The on-chain path either succeeds OR refuses on one of two gates:
    //    - freshness (parseConfidence < 1) - details carries a ParseConfidence payload.
    //    - events validation (parsed movement/event mismatch) - details carries the offender.
    //    We accept either; the only thing we forbid is RECORDING_FAILED (network error).
    if (onChain.ok) {
      expect(Array.isArray(onChain.data.invocations)).toBe(true)
      for (const inv of onChain.data.invocations) {
        expect(typeof inv.contract).toBe('string')
        expect(typeof inv.fn).toBe('string')
        expect(Array.isArray(inv.args)).toBe(true)
        expect(Array.isArray(inv.subInvocations)).toBe(true)
      }
      expect(onChain.data.network).toBe('testnet')
      expect(typeof onChain.data.sourceAccount).toBe('string')
    } else if (onChain.error.code === 'RECORDING_VALIDATION_FAILED') {
      // Either gate is acceptable - just assert details is non-null + a remediation is set.
      expect(onChain.error.details).toBeDefined()
      expect(onChain.error.severity).toBe('error')
      expect(onChain.error.retryable).toBe(false)
      expect(onChain.error.remediation?.userQuestion).toBeDefined()
    } else {
      throw new Error(`unexpected on-chain error code: ${onChain.error.code}`)
    }
  }, 30000)
})
