// src/record/freshness.ts - compute parseConfidence for a DecodedTransaction.
//
// The pinned rule (see ParseConfidence in src/types.ts):
//   overall = 1 - (unknownContracts + opaqueScVals) / total
// where total = unique contracts referenced + opaque ScVal count.
// In v1 every contract is "unknown" by default (no adjacency ABI hint is
// bundled with the recorder); the freshness module still computes the value
// honestly so callers can see why the gate fires.
//
// thresholdUsed defaults to 1.0 - a stricter gate. Callers can opt to lower
// it via confidence_override but v1 ships only the default.

import type { ParseConfidence } from '../types.ts'

/** Inputs to the freshness computation. The decode module produces the raw
 *  counters; this module applies the rule. */
export interface FreshnessInput {
  knownContracts: string[]
  unknownContracts: ParseConfidence['unknownContracts']
  opaqueScVals: ParseConfidence['opaqueScVals']
}

/** Compute parseConfidence per the pinned rule. Pure: no IO. */
export function computeParseConfidence(input: FreshnessInput): ParseConfidence {
  const unknown = input.unknownContracts.length
  const opaque = input.opaqueScVals.length
  const known = input.knownContracts.length
  // Pinned rule: overall = 1 - (unknown + opaque) / (known + unknown + opaque).
  // Only the empty-decode case (nothing referenced) is guarded to avoid 0/0; it
  // means "nothing to decode", so full confidence. A fully-unknown tx therefore
  // scores 0, not an inflated value.
  const denom = known + unknown + opaque
  const total = denom === 0 ? 1 : denom
  const overall = Math.max(0, Math.min(1, 1 - (unknown + opaque) / total))
  return {
    overall,
    knownContracts: [...input.knownContracts],
    unknownContracts: [...input.unknownContracts],
    opaqueScVals: [...input.opaqueScVals],
    thresholdUsed: 1.0,
  }
}

/** Refuse-on-low-confidence gate. Returns true when the recording must be
 *  refused (overall < thresholdUsed). The orchestrator wraps this in a
 *  ToolError with the ParseConfidence payload attached as `details`. */
export function isBelowThreshold(c: ParseConfidence): boolean {
  return c.overall < c.thresholdUsed
}

/** Convenience: build the user-facing remediation question for an
 *  under-confidence recording.
 *
 *  The remediation text branches on which diagnostic bucket is non-empty:
 *    - unknownContracts only -> user MUST supply an ABI (or re-capture
 *      against a known protocol version). The contract is real, the
 *      recorder just cannot decode it.
 *    - opaqueScVals only -> the recorder encountered a value shape it
 *      should support but did not decode. The user cannot supply an ABI
 *      to fix a decoder bug; the guidance explicitly says so and points at
 *      re-running after a tool upgrade / reporting the path.
 *    - both -> list both diagnostics AND chain the right remediation for
 *      each (the user supplies an ABI AND reports the decoder gap).
 *    - neither (the "denom === 0" path) -> unchanged from the pre-fix
 *      text; the user did not actually hit a code-level barrier. */
export function buildLowConfidenceQuestion(c: ParseConfidence): string {
  const hasUnknown = c.unknownContracts.length > 0
  const hasOpaque = c.opaqueScVals.length > 0
  const reasons: string[] = []
  for (const u of c.unknownContracts) {
    reasons.push(`unknown contract ${u.contract} (${u.reason})`)
  }
  for (const o of c.opaqueScVals) {
    reasons.push(`opaque ScVal at ${o.path} (${o.type})`)
  }
  const why = reasons.length === 0 ? 'no diagnostic reason available' : reasons.join('; ')
  const header = `Recording refused: parseConfidence ${c.overall.toFixed(3)} is below the threshold ${c.thresholdUsed.toFixed(3)}. Diagnostic: ${why}.`
  // The two remediation branches are explicit so the user (or the agent)
  // can dispatch on the verb. The "unknown contract" branch is the only
  // one that asks for an ABI; the "opaque ScVal" branch asks the user to
  // report the path and re-run after a tool upgrade.
  if (hasUnknown && hasOpaque) {
    return (
      `${header} Supply an ABI for the unknown contract(s) or re-capture the transaction against a known protocol version; ` +
      `also file the opaque ScVal path against the recorder (decoder limitation) and re-run record_transaction after a tool upgrade.`
    )
  }
  if (hasUnknown) {
    return `${header} Supply an ABI for the unknown contract(s) or re-capture the transaction against a known protocol version, then re-run record_transaction.`
  }
  if (hasOpaque) {
    return `${header} This is a recorder decoder limitation (the value shape is supported in principle but not yet decoded) - the agent cannot fix it by supplying an ABI. Report the opaque ScVal path above against the recorder and re-run record_transaction after a tool upgrade.`
  }
  return `${header} No actionable diagnostic was recorded; re-run record_transaction against a fresh fetch and inspect the events.`
}
