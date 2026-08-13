// src/record/index.ts - the recorder orchestrator.
//
// `recordTransaction(input)` is the single public entry point for the
// synthesizer (the next phase) to consume. Two modes:
//   - on-chain (hash set): fetch via the injected RPC fetcher (default:
//     public Soroban RPC for the requested network).
//   - simulation/XDR (xdr set): decode the provided envelope XDR directly.
//
// In both modes the recorder:
//   1. Decodes the envelope to sourceAccount, signers, invocations (+ diagnostic
//      subInvocations), args -> ScVal subset.
//   2. Extracts token movements from raw events (or skips in XDR mode).
//   3. Validates the parsed movements/invocations against the raw events.
//   4. Computes parseConfidence.
//   5. Refuses with ToolError RECORDING_VALIDATION_FAILED when overall < threshold.
//
// Returns ToolResponse<RecordedTransaction> per the canonical envelope
// defined in src/errors.ts.

import type { xdr } from '@stellar/stellar-sdk'
import type { ToolError, ToolResponse } from '../errors.ts'
import type { Network, ParseConfidence, RecordedTransaction } from '../types.ts'
import type { DecodedTransaction } from './decode.ts'
import {
  contractEventsToOnChainEvents,
  DecodeError,
  decodeEnvelope,
  decodeEnvelopeXdr,
  transactionEventsToOnChainEvents,
} from './decode.ts'
import {
  buildLowConfidenceQuestion,
  computeParseConfidence,
  isBelowThreshold,
} from './freshness.ts'
import { extractTokenMovements } from './movements.ts'
import { createRpcServer, type RpcFetcher } from './rpc.ts'
import { validateAgainstEvents } from './validate.ts'

/** Public input shape. The brief pins:
 *    - exactly one of `hash` / `xdr`
 *    - `network` for hash mode (selects the public RPC)
 *    - optional injected `fetcher` for tests + custom RPC endpoints
 *    - optional `crossNetworkFetcher` (item 2) for tests + offline use;
 *      production builds the cross-network probe from `createRpcServer` when
 *      this field is absent
 *    - optional `confidenceOverride` to relax the gate (default 1.0)
 *
 *  In xdr mode `network` is still required so the caller documents intent
 *  (the synthesis downstream consumes it).
 */
export interface RecordInput {
  hash?: string
  xdr?: string
  network: Network
  fetcher?: RpcFetcher
  /** Test-only seam + explicit production override for the cross-network
   *  probe (item 2). When the primary fetcher returns null on hash mode,
   *  the recorder also tries this fetcher against the OTHER network. If it
   *  finds the hash there, the recorder returns a specific actionable
   *  error mentioning the actual network. When unset, the recorder builds
   *  this fetcher from `createRpcServer(otherNetwork)` so the help fires
   *  automatically; tests can pass a deterministic stub. */
  crossNetworkFetcher?: RpcFetcher
  confidenceOverride?: number
}

export type RecordResult = ToolResponse<RecordedTransaction>

export async function recordTransaction(input: RecordInput): Promise<RecordResult> {
  if (!input.network) {
    return err('RECORDING_FAILED', 'network required', false)
  }
  // A confidenceOverride outside [0, 1] would disable the fail-closed gate (a
  // negative threshold can never be exceeded), so reject it up front.
  if (
    input.confidenceOverride !== undefined &&
    (!Number.isFinite(input.confidenceOverride) ||
      input.confidenceOverride < 0 ||
      input.confidenceOverride > 1)
  ) {
    return err(
      'RECORDING_FAILED',
      'confidenceOverride must be a finite number within [0, 1]',
      false
    )
  }
  const hasHash = typeof input.hash === 'string' && input.hash.length > 0
  const hasXdr = typeof input.xdr === 'string' && input.xdr.length > 0
  if (hasHash && hasXdr) {
    return err('RECORDING_FAILED', 'provide exactly one of `hash` or `xdr`, not both', false)
  }
  if (!hasHash && !hasXdr) {
    return err('RECORDING_FAILED', 'one of `hash` or `xdr` is required', false)
  }

  // === Phase 1: fetch + decode ===
  let decoded: DecodedTransaction

  if (hasHash) {
    const fetcher = input.fetcher ?? createRpcServer(input.network)
    const hash = input.hash
    if (!hash) return err('RECORDING_FAILED', 'hash required for on-chain mode', false)
    const fetched = await fetcher(hash)
    if (!fetched) {
      // Item 2: cross-network sanity check. The default NOT_FOUND message
      // ("transaction X not found on <network>") is not actionable when the
      // user just used the wrong --network. Probe the OTHER network's
      // fetcher before giving up: if the hash actually exists there, the
      // user almost certainly passed the wrong network flag. Trade-off:
      // one extra RPC round-trip ONLY on the NOT_FOUND path (the happy
      // path is unchanged; NOT_FOUND is rare). The probe is auto-built
      // from createRpcServer(otherNetwork) when the caller did not inject
      // one; tests pass an explicit stub for offline determinism.
      const otherNetwork: Network = input.network === 'mainnet' ? 'testnet' : 'mainnet'
      const crossFetcher = input.crossNetworkFetcher ?? createRpcServer(otherNetwork)
      const crossFetched = await crossFetcher(hash)
      if (crossFetched) {
        return err(
          'RECORDING_FAILED',
          `transaction ${hash} not found on ${input.network}; it exists on ${otherNetwork}. Re-run with --network ${otherNetwork} (or the corresponding MCP / API field).`,
          true
        )
      }
      return err('RECORDING_FAILED', `transaction ${hash} not found on ${input.network}`, true)
    }
    const events = combineEvents(fetched.events)
    try {
      decoded = decodeEnvelope(
        fetched.envelopeXdr,
        events,
        [],
        fetched.ledger,
        undefined,
        input.network
      )
    } catch (e) {
      if (e instanceof DecodeError) return err('RECORDING_FAILED', e.message, false)
      throw e
    }
    return finish(input.network, decoded, input.confidenceOverride)
  }

  // XDR mode has no raw on-chain events, so the events-based cross-check is
  // skipped. parseConfidence reaches 1.0 when every invocation matches a
  // known protocol interface or pinned address; a confidenceOverride is only
  // needed when the caller wants to lower the gate below the default 1.0.
  const xdrStr = input.xdr
  if (!xdrStr) return err('RECORDING_FAILED', 'xdr required for simulation mode', false)
  try {
    decoded = decodeEnvelopeXdr(xdrStr, [], [], 0, undefined, input.network)
  } catch (e) {
    if (e instanceof DecodeError) return err('RECORDING_FAILED', e.message, false)
    return err(
      'RECORDING_FAILED',
      `failed to decode base64 envelope XDR: ${(e as Error).message}`,
      false
    )
  }
  return finish(input.network, decoded, input.confidenceOverride)
}

function combineEvents(raw: {
  transactionEventsXdr: xdr.TransactionEvent[]
  contractEventsXdr: xdr.ContractEvent[][]
}): ReturnType<typeof contractEventsToOnChainEvents> {
  const a = transactionEventsToOnChainEvents(raw.transactionEventsXdr)
  const b = contractEventsToOnChainEvents(raw.contractEventsXdr)
  const seen = new Set<string>()
  const merged: typeof a = []
  for (const e of [...a, ...b]) {
    const k = `${e.contract}|${e.topics.join(',')}|${JSON.stringify(e.data)}`
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(e)
  }
  return merged
}

/** Apply freshness + validate + refuse gate, then build the RecordedTransaction
 *  on success. */
function finish(
  network: Network,
  decoded: DecodedTransaction,
  confidenceOverride: number | undefined
): RecordResult {
  // === Phase 2: extract token movements ===
  const tokenMovements = extractTokenMovements(decoded.events, decoded.opaqueScVals)

  // === Phase 3: validate against events (fail-closed) ===
  if (decoded.events.length > 0) {
    const failure = validateAgainstEvents(tokenMovements, decoded.events)
    if (failure) {
      const te: ToolError = {
        code: 'RECORDING_VALIDATION_FAILED',
        message: failure.message,
        severity: 'error',
        retryable: false,
        details: failure.details,
        remediation: {
          userQuestion: {
            code: failure.code,
            question: `Recording refused: ${failure.message}. Inspect details and re-run record_transaction against a re-fetched transaction.`,
          },
        },
      }
      return { ok: false, error: te }
    }
  }

  // === Phase 4: parseConfidence + refuse gate ===
  let confidence: ParseConfidence = computeParseConfidence({
    knownContracts: decoded.knownContracts,
    unknownContracts: decoded.unknownContracts,
    opaqueScVals: decoded.opaqueScVals,
  })
  // Item 1: surface the "zero contract invocations decoded" case explicitly.
  // The math already pins overall = 1.0 via the `denom === 0` guard; the
  // marker just makes the silence visible so a downstream synth can refuse
  // the recording (a policy must scope to an authorized contract call)
  // without inferring the situation from `invocations: []` next to a
  // confidence of 1.0. Only set when zero invocations were actually decoded
  // - the marker is a positive signal, not a default.
  if (decoded.invocations.length === 0) {
    confidence = { ...confidence, noInvocations: true }
  }
  if (typeof confidenceOverride === 'number') {
    confidence = { ...confidence, thresholdUsed: confidenceOverride }
  }
  if (isBelowThreshold(confidence)) {
    const te: ToolError = {
      code: 'RECORDING_VALIDATION_FAILED',
      message: `parseConfidence ${confidence.overall} < threshold ${confidence.thresholdUsed}`,
      severity: 'error',
      retryable: false,
      details: confidence,
      remediation: {
        userQuestion: {
          code: 'PARSE_CONFIDENCE_BELOW_THRESHOLD',
          question: buildLowConfidenceQuestion(confidence),
        },
      },
    }
    return { ok: false, error: te }
  }

  const recorded: RecordedTransaction = {
    network,
    signers: decoded.signers,
    invocations: decoded.invocations,
    tokenMovements,
    events: decoded.events,
    authEntries: decoded.authEntries,
    ledgerSequence: decoded.ledgerSequence,
    fetchedAt: Math.floor(Date.now() / 1000),
    parseConfidence: confidence,
    sourceAccount: decoded.sourceAccount,
  }
  return { ok: true, data: recorded }
}

function err(code: ToolError['code'], message: string, retryable: boolean): RecordResult {
  return { ok: false, error: { code, message, severity: 'error', retryable } }
}
