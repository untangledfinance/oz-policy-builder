import type { PredicateNode } from '../types.ts'
import type { GeneratedCases } from './deny-cases.ts'
import { evaluate } from './evaluate.ts'

export interface HarnessFailure {
  dimension: string
  expected: 'permit' | 'deny'
  got: 'permit' | 'deny'
  reason?: string
  /** When `expectedReason` is set on the deny case and the case actually
   *  denies, this carries the canonical reason the TS evaluator MUST emit
   *  to stay in lockstep with the Rust interpreter (the cross-layer
   *  reason-code contract). A future TS/Rust reason divergence surfaces
   *  here in CI. */
  expectedReason?: string
  actualReason?: string
}

export type HarnessResult = { ok: true } | { ok: false; failures: HarnessFailure[] }

/** Evaluate the intended call and every generated denial without side effects.
 *  Asserts both the boolean decision AND, for deny cases that carry an
 *  `expectedReason`, the concrete reason the TS evaluator emits. The reason
 *  is what the Rust interpreter returns; the cross-layer conformance test in
 *  `contracts/policy-interpreter/tests/conformance` mirrors the same contract
 *  for the verifyLive path. */
export function runHarness(predicate: PredicateNode, cases: GeneratedCases): HarnessResult {
  const failures: HarnessFailure[] = []
  const permitResult = evaluate(predicate, cases.permit)
  if (!permitResult.permit) {
    failures.push({
      dimension: 'PERMIT_CASE_FAILED',
      expected: 'permit',
      got: 'deny',
      reason: permitResult.reason,
    })
  }

  for (const deny of cases.denies) {
    const result = evaluate(predicate, deny.ctx)
    if (result.permit) {
      failures.push({
        dimension: deny.dimension,
        expected: 'deny',
        got: 'permit',
        reason: 'DENY_CASE_FAILURE',
      })
      continue
    }
    // Reason-code assertion (cross-layer contract). When a deny case carries
    // an expected reason, the TS evaluator MUST emit that exact string; a
    // divergence means the TS model and the Rust interpreter disagree on
    // what the user sees in CI - the harness fails so the diff is visible
    // here, not at runtime in production.
    if (deny.expectedReason !== undefined && result.reason !== deny.expectedReason) {
      failures.push({
        dimension: deny.dimension,
        expected: 'deny',
        got: 'deny',
        reason: 'REASON_MISMATCH',
        expectedReason: deny.expectedReason,
        actualReason: result.reason,
      })
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures }
}
