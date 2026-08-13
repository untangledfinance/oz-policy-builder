// src/verify/verify.ts - the static minimality check for `verify_policy`.
//
// `verifyPolicy` proves the policy is MINIMAL: no top-level conjunct is
// load-bearing-free. It is the static sibling of `simulatePolicy` and emits
// `VERIFICATION_FAILED` (not `SIMULATION_ERROR`) on failure. The boundary is
// pinned:
//
//   - `VERIFICATION_FAILED`  = STATIC minimality check failed. The policy is
//     structurally over-broad: a constraint could be dropped without losing
//     a deny-case. Surfaced by `verifyPolicy`. Runtime evaluation is not
//     part of this check; the policy may evaluate to a permit/deny just
//     fine, the failure is shape-only.
//
//   - `SIMULATION_ERROR`     = RUNTIME evaluation failed (see simulate.ts).
//     This module never emits SIMULATION_ERROR. A minimality failure is
//     never a simulation error and vice-versa.
//
// Algorithm:
//   1. Build the permit EvalContext from `permitTx` (mirror of the
//      orchestrator's helper so verify is self-contained).
//   2. Run `minimize(predicate, permitCtx)` to strip load-bearing-free
//      top-level conjuncts (only `and` predicates are minimisable; other
//      shapes are returned unchanged by `minimize`).
//   3. If the minimised tree has fewer top-level conjuncts than the input,
//      return `VERIFICATION_FAILED` listing the dropped conjuncts by their
//      structural fingerprint.
//   4. Otherwise `{ ok: true }`.
//
// Determinism: same `(predicate, permitTx)` -> byte-identical verdict.

import type { ToolError, ToolResponse } from '../errors.ts'
import type { EvalContext } from '../synth/evaluate.ts'
import { minimize } from '../synth/minimize.ts'
import type { ContractInvocation, PredicateNode, RecordedTransaction, ScVal } from '../types.ts'
import { MAX_SCVAL_CLONE_DEPTH } from '../types.ts'

/** Options for `verifyPolicy`. Mirrors the orchestrator's permit-context
 *  knobs (expiry; oracle fixture) so verify sees the same shape
 *  `simulatePolicy` sees. */
export interface VerifyOptions {
  validUntilLedger?: number
  oraclePricesByAsset?: Record<
    string,
    | { price: string; timestampSeconds: number }
    | {
        error: 'stale' | 'missing' | 'deviation' | 'paused' | 'decimals' | 'fingerprint'
      }
  >
}

/** Run the static minimality check on a proposed predicate + recorded tx.
 *  Returns `{ ok: true }` when the predicate is minimal (every top-level
 *  conjunct carries load) and `VERIFICATION_FAILED` when a conjunct could
 *  be dropped without losing a deny-case. The dropped conjuncts are
 *  reported in `details.droppedConstraints` so the caller can render a
 *  review-card warning. */
export function verifyPolicy(
  predicate: PredicateNode,
  permitTx: RecordedTransaction,
  opts: VerifyOptions = {}
): ToolResponse<true> {
  const topLevel = permitTx.invocations[0]
  if (!topLevel) {
    return {
      ok: false,
      error: verificationFailed(
        'recorded transaction has no top-level invocation to verify against',
        { droppedConstraints: [] }
      ),
    }
  }

  let permitCtx: EvalContext
  try {
    permitCtx = buildPermitContextForVerify(permitTx, topLevel, opts)
  } catch (e) {
    return {
      ok: false,
      error: verificationFailed(
        `could not build permit evaluation context: ${(e as Error).message}`,
        { droppedConstraints: [] }
      ),
    }
  }

  // `minimize` only reduces `and` predicates; other shapes are returned
  // unchanged. A non-`and` predicate therefore trivially passes the static
  // minimality check (its top-level structure carries no removable
  // conjuncts). The runtime harness in `simulatePolicy` covers the
  // OR / NOT / comparison shapes.
  const minimised = minimize(predicate, permitCtx)

  // Drop count: only meaningful for `and`. For other shapes we already
  // returned the input unchanged; report ok.
  if (predicate.op !== 'and' || minimised.op !== 'and') {
    if (!structuralEqual(predicate, minimised)) {
      return {
        ok: false,
        error: verificationFailed(
          'minimizer returned a structurally different tree for a non-and predicate',
          { droppedConstraints: [fingerprint(minimised)] }
        ),
      }
    }
    return { ok: true, data: true }
  }

  const inputChildren = predicate.children
  const minimisedChildren = minimised.children
  if (minimisedChildren.length >= inputChildren.length) {
    return { ok: true, data: true }
  }

  // Over-broad: identify the dropped conjuncts by structural fingerprint
  // (so the review card can quote exactly which constraint was redundant).
  // We use a multiset comparison because two structurally identical
  // conjuncts (e.g. a duplicate `call_fn == transfer`) collapse to the
  // same fingerprint - the dropped item is the one whose fingerprint
  // count drops between input and minimised.
  const inputCounts = fingerprintCounts(inputChildren)
  const minimisedCounts = fingerprintCounts(minimisedChildren)
  const dropped: string[] = []
  for (const [fp, count] of inputCounts) {
    const kept = minimisedCounts.get(fp) ?? 0
    for (let i = 0; i < count - kept; i++) dropped.push(fp)
  }
  return {
    ok: false,
    error: verificationFailed(
      `policy is structurally over-broad: ${dropped.length} redundant conjunct(s) can be dropped without losing a deny case`,
      { droppedConstraints: dropped }
    ),
  }
}

function buildPermitContextForVerify(
  tx: RecordedTransaction,
  topLevel: ContractInvocation,
  opts: VerifyOptions
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

  const oraclePriceByAsset: EvalContext['oraclePriceByAsset'] = {}
  if (opts.oraclePricesByAsset) {
    for (const [asset, entry] of Object.entries(opts.oraclePricesByAsset)) {
      oraclePriceByAsset[asset] = entry
    }
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
  // throws a ToolError-shaped error that the verifier's existing try/catch
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
  err.code = 'VERIFICATION_FAILED'
  err.severity = 'error'
  err.retryable = false
  err.depthContext = value.type
  throw err
}

function fingerprint(node: PredicateNode): string {
  return JSON.stringify(node, replacer)
}

/** Multiset fingerprint counts for a list of conjuncts. Two structurally
 *  identical conjuncts (e.g. a duplicate `call_fn == transfer`) each
 *  contribute their own count. The minimiser may drop one of them; we
 *  surface exactly the surplus via the count difference. */
function fingerprintCounts(children: PredicateNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const child of children) {
    const fp = fingerprint(child)
    counts.set(fp, (counts.get(fp) ?? 0) + 1)
  }
  return counts
}

/** Deterministic JSON key order for fingerprinting. Object keys are sorted
 *  recursively so the same shape produces the same string. */
function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k]
    }
    return sorted
  }
  return value
}

function structuralEqual(a: PredicateNode, b: PredicateNode): boolean {
  return fingerprint(a) === fingerprint(b)
}

function verificationFailed(message: string, details: unknown): ToolError {
  return {
    code: 'VERIFICATION_FAILED',
    message,
    severity: 'error',
    retryable: false,
    details,
  }
}
