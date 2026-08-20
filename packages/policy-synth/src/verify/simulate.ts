// src/verify/simulate.ts - the post-simulation verdict for `simulate_policy`.
//
// `simulatePolicy` replays a recorded transaction against a proposed
// `PredicateNode` and emits the `SimulationResult` envelope the review-card
// builder + the verification pipeline consume.
//
// Boundary (pinned, must not drift):
//   - `SIMULATION_ERROR`        = RUNTIME evaluation failed. Surfaced by
//     `simulatePolicy`. Reasons: malformed `permitTx` input (no top-level
//     without a satisfying price fixture, or a non-runtime propagation (a
//     runtime evaluation failure is NOT a policy-minimality problem; the
//     policy may still be minimal. Re-running with a complete fixture MAY
//     succeed.
//   - `VERIFICATION_FAILED`     = STATIC minimality check failed. Surfaced
//     by `verifyPolicy`. The minimiser identified a load-bearing-free
//     constraint; the policy is structurally over-broad regardless of how
//     any concrete call evaluates. Re-running with a different fixture
//     will NOT fix it; the policy must be trimmed.
//
// Determinism: same `(predicate, permitTx, opts)` -> byte-identical
// envelope, no clock, no randomness.
//
// The permit EvalContext is built locally (mirror of the helper used in
// `synthesize-from-recording.ts`) so this module does not couple to the
// orchestrator's private build helpers. The shape is pinned by the test
// suite to stay in lockstep.

import type { ToolError, ToolResponse } from '../errors.ts'
import { generateCases } from '../synth/deny-cases.ts'
import { type EvalContext, evaluate } from '../synth/evaluate.ts'
import type { ContractInvocation, PredicateNode, RecordedTransaction, ScVal } from '../types.ts'
import { MAX_SCVAL_CLONE_DEPTH } from '../types.ts'
import type { SimulationResult } from './envelope.ts'

const SIMULATOR_VERSION = 'ts-model-1.0.0'

/** Options for `simulatePolicy`. `validUntilLedger` is propagated onto the
 *  permit EvalContext so the simulator exercises the expiry gate; absent ->
 *  no expiry check (mirrors the orchestrator's "no `validUntilLedger`
 *  supplied" path). */
export interface SimulateOptions {
  validUntilLedger?: number
}

/** Replay a recorded transaction against a proposed predicate and emit the
 *  `SimulationResult` envelope. The simulator returns the SAME permit
 *  verdict `runHarness` expects: the intended recorded call must permit; every
 *  generated deny dimension must deny. A runtime evaluation failure
 *  `ToolError` - NOT a deny verdict, NOT `VERIFICATION_FAILED`. The boundary
 *  is pinned: minimality is a verify-time concern, runtime evaluation is a
 *  simulate-time concern. */
export function simulatePolicy(
  predicate: PredicateNode | null,
  permitTx: RecordedTransaction,
  opts: SimulateOptions = {}
): ToolResponse<SimulationResult> {
  // The permit EvalContext requires a top-level invocation. A recorded tx
  // with no invocations is structurally malformed input - we surface a
  // runtime `SIMULATION_ERROR` rather than fabricating a permit verdict.
  const topLevel = permitTx.invocations[0]
  if (!topLevel) {
    return {
      ok: false,
      error: simulationError('recorded transaction has no top-level invocation to simulate'),
    }
  }

  let permitCtx: EvalContext
  try {
    permitCtx = buildPermitContext(permitTx, topLevel, opts)
  } catch (e) {
    return {
      ok: false,
      error: simulationError(`could not build permit evaluation context: ${(e as Error).message}`),
    }
  }

  // `predicate === null` means the policy is OZ-only (no interpreter
  // predicate). We still emit the envelope so the review card + verifier
  // can consume it: the permit verdict evaluates an always-permit empty
  // tree, and the deny battery is empty (nothing to verify at the
  // interpreter layer).
  const evaluatePredicate: PredicateNode = predicate ?? { op: 'and', children: [] }

  const evaluatedCases: SimulationResult['evaluatedCases'] = []

  let permitVerdict: { permit: true } | { permit: false; reason: string }
  try {
    permitVerdict = evaluate(evaluatePredicate, permitCtx)
  } catch (e) {
    return {
      ok: false,
      error: simulationError(`permit evaluation threw at runtime: ${(e as Error).message}`, e),
    }
  }
  evaluatedCases.push({
    dimension: 'permit',
    outcome: permitVerdict.permit ? 'permit' : 'deny',
    reason: permitVerdict.permit ? 'matches recorded call' : permitVerdict.reason,
  })

  // The deny battery is generated against the SAME permit context. A
  // runtime evaluation failure on ANY deny case is a `SIMULATION_ERROR` -
  // not a deny verdict (an evaluate-throws is not a deny) and not a
  // minimality problem.
  const cases = generateCases(evaluatePredicate, permitCtx)
  for (const deny of cases.denies) {
    let result: { permit: true } | { permit: false; reason: string }
    try {
      result = evaluate(evaluatePredicate, deny.ctx)
    } catch (e) {
      return {
        ok: false,
        error: simulationError(
          `deny case "${deny.dimension}" threw at runtime: ${(e as Error).message}`,
          e
        ),
      }
    }
    evaluatedCases.push({
      dimension: deny.dimension,
      outcome: result.permit ? 'permit' : 'deny',
      reason: result.permit ? 'no matching deny' : result.reason,
    })
  }

  const envelope: SimulationResult = {
    permit: permitVerdict.permit ? { tx: 'permit' } : { tx: 'deny', reason: permitVerdict.reason },
    evaluatedCases,
    backend: 'ts-model',
    simulatorVersion: SIMULATOR_VERSION,
  }
  return { ok: true, data: envelope }
}

/** Build the permit `EvalContext` the simulator drives. Mirrors the
 *  helper in `synthesize-from-recording.ts` so the simulator sees the same
 *  shape the orchestrator's self-verify pipeline sees; we mirror here
 *  rather than import to keep `src/verify/` decoupled from the
 *  orchestrator's private helpers. The shape is pinned by tests so the
 *  two implementations stay in lockstep. */
function buildPermitContext(
  tx: RecordedTransaction,
  topLevel: ContractInvocation,
  opts: SimulateOptions
): EvalContext {
  const amountByToken: Record<string, string> = {}
  const totals = new Map<string, bigint>()
  for (const m of tx.tokenMovements) {
    const current = totals.get(m.token) ?? 0n
    totals.set(m.token, current + BigInt(m.amount))
  }
  for (const [token, total] of totals) {
    amountByToken[token] = total.toString()
  }

  const ctx: EvalContext = {
    contract: topLevel.contract,
    fn: topLevel.fn,
    args: topLevel.args.map(cloneScVal),
    atLedger: tx.ledgerSequence,
    nowSeconds: tx.fetchedAt,
    amountByToken,
    windowSpentByToken: {},
  }
  if (opts.validUntilLedger !== undefined) {
    ctx.validUntilLedger = opts.validUntilLedger
  }
  return ctx
}

function cloneScVal(value: ScVal, depth = 0): ScVal {
  // Recursion is bounded by MAX_SCVAL_CLONE_DEPTH so a hand-crafted nested-vec
  // payload cannot RangeError the JS stack during context building. Over-depth
  // throws a ToolError-shaped error that the simulator's existing try/catch
  // converts to a structured `{ok:false, error}` (not a thrown RangeError).
  if (value.type === 'vec') {
    if (depth >= MAX_SCVAL_CLONE_DEPTH) {
      throw cloneDepthError(value)
    }
    return { type: 'vec', value: value.value.map((v) => cloneScVal(v, depth + 1)) }
  }
  return { ...value }
}

function cloneDepthError(value: ScVal): never {
  const err = new Error(
    `ScVal clone depth exceeds MAX_SCVAL_CLONE_DEPTH (${MAX_SCVAL_CLONE_DEPTH})`
  ) as Error & { code: string; severity: string; retryable: boolean; depthContext: unknown }
  err.code = 'SIMULATION_ERROR'
  err.severity = 'error'
  err.retryable = false
  err.depthContext = value.type
  throw err
}

function simulationError(message: string, cause?: unknown): ToolError {
  const error: ToolError = {
    code: 'SIMULATION_ERROR',
    message,
    severity: 'error',
    retryable: false,
  }
  if (cause !== undefined) error.details = { cause: String(cause) }
  return error
}
