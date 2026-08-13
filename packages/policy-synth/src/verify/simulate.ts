// src/verify/simulate.ts - the post-simulation verdict for `simulate_policy`.
//
// `simulatePolicy` replays a recorded transaction against a proposed
// `PredicateNode` and emits the `SimulationResult` envelope the review-card
// builder + the verification pipeline consume.
//
// Boundary (pinned, must not drift):
//   - `SIMULATION_ERROR`        = RUNTIME evaluation failed. Surfaced by
//     `simulatePolicy`. Reasons: malformed `permitTx` input (no top-level
//     invocation to build an EvalContext from), a referenced oracle asset
//     without a satisfying price fixture, or a non-runtime propagation (a
//     throw that is not an oracle error or a controlled deny). A
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
import type {
  ContractInvocation,
  PredicateLeaf,
  PredicateNode,
  RecordedTransaction,
  ScVal,
} from '../types.ts'
import { MAX_SCVAL_CLONE_DEPTH } from '../types.ts'
import type { SimulationResult } from './envelope.ts'

const SIMULATOR_VERSION = 'ts-model-1.0.0'

/** Options for `simulatePolicy`. `validUntilLedger` is propagated onto the
 *  permit EvalContext so the simulator exercises the expiry gate; absent ->
 *  no expiry check (mirrors the orchestrator's "no `validUntilLedger`
 *  supplied" path). `oraclePricesByAsset` is the test fixture the simulator
 *  uses to satisfy `oracle_price` leaves so the permit call evaluates under
 *  the bound; absent -> derive satisfying prices from the predicate itself
 *  (the orchestrator's oracle-satisfying-price logic). */
export interface SimulateOptions {
  validUntilLedger?: number
  /** Pre-populated oracle-price entries keyed by asset address. The fixture
   *  must satisfy every `oracle_price` leaf in the predicate; absent or
   *  unsatisfying entries cause `SIMULATION_ERROR`. */
  oraclePricesByAsset?: Record<
    string,
    | { price: string; timestampSeconds: number }
    | {
        error: 'stale' | 'missing' | 'deviation' | 'paused' | 'decimals' | 'fingerprint'
      }
  >
}

/** Replay a recorded transaction against a proposed predicate and emit the
 *  `SimulationResult` envelope. The simulator returns the SAME permit
 *  verdict `runHarness` expects: the intended recorded call must permit; every
 *  generated deny dimension must deny. A runtime evaluation failure
 *  (malformed input, missing oracle fixture, etc.) returns a `SIMULATION_ERROR`
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
    permitCtx = buildPermitContext(predicate, permitTx, topLevel, opts)
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
  predicate: PredicateNode | null,
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

  // Oracle prices: when the caller supplies a fixture, use it; otherwise
  // derive a satisfying entry per `oracle_price` leaf in the predicate so
  // the permit call permits. Negatives are clamped at 0 (Stellar oracle
  // prices are non-negative).
  const oraclePriceByAsset: EvalContext['oraclePriceByAsset'] = {}
  if (opts.oraclePricesByAsset) {
    for (const [asset, entry] of Object.entries(opts.oraclePricesByAsset)) {
      oraclePriceByAsset[asset] = entry
    }
  }
  if (predicate !== null) {
    visitOracleLeaves(predicate, (asset, op, bound) => {
      // A caller-supplied fixture entry always wins; we only fill gaps.
      if (oraclePriceByAsset[asset] !== undefined) return
      let price: bigint
      switch (op) {
        case 'lt':
        case 'gt':
          price = op === 'lt' ? bound - 1n : bound + 1n
          break
        case 'lte':
        case 'gte':
        case 'eq':
          price = bound
          break
      }
      if (price < 0n) price = 0n
      oraclePriceByAsset[asset] = {
        price: price.toString(),
        timestampSeconds: tx.fetchedAt,
      }
    })
  }

  const ctx: EvalContext = {
    contract: topLevel.contract,
    fn: topLevel.fn,
    args: topLevel.args.map(cloneScVal),
    atLedger: tx.ledgerSequence,
    nowSeconds: tx.fetchedAt,
    amountByToken,
    windowSpentByToken: {},
    invocationCountByWindow: {},
    oraclePriceByAsset,
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

function visitOracleLeaves(
  node: PredicateNode,
  visit: (asset: string, op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte', bound: bigint) => void
): void {
  switch (node.op) {
    case 'and':
    case 'or':
      for (const child of node.children) visitOracleLeaves(child, visit)
      return
    case 'not':
      visitOracleLeaves(node.child, visit)
      return
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const leftLeaf = node.left
      const rightLeaf = node.right
      let oracleAsset: string | undefined
      let literal: bigint | undefined
      if (leftLeaf.kind === 'oracle_price') {
        oracleAsset = leftLeaf.asset
        literal = oracleLiteralFromLeaf(rightLeaf)
      } else if (rightLeaf.kind === 'oracle_price') {
        oracleAsset = rightLeaf.asset
        literal = oracleLiteralFromLeaf(leftLeaf)
      }
      if (oracleAsset === undefined || literal === undefined) return
      visit(oracleAsset, node.op, literal)
      return
    }
    case 'in':
      return
  }
}

function oracleLiteralFromLeaf(leaf: PredicateLeaf): bigint | undefined {
  if (leaf.kind !== 'literal_i128') return undefined
  try {
    return BigInt(leaf.value)
  } catch {
    return undefined
  }
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
