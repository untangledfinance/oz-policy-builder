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
 *    - unknownContracts only -> the contract is not in the compiled-in
 *      registry. NOT "the contract has no interface": most Soroban
 *      contracts publish a typed spec on chain, this package just never
 *      reads one. The reason code stays `no-abi` because it is a published
 *      enum value, so the TEXT has to carry the correction.
 *    - opaqueScVals only -> the recorder met a value shape it should
 *      support but did not decode. That is a decoder bug, and the guidance
 *      says so rather than implying the caller can fix it.
 *    - both -> list both diagnostics and chain the right remediation.
 *    - neither (the "denom === 0" path) -> the caller did not actually hit
 *      a code-level barrier.
 *
 *  Do NOT tell the caller to supply an ABI. There is no input for one:
 *  recognition runs off the compiled-in registry plus a known-contract set
 *  that no public tool boundary exposes. The old text named an action
 *  nobody could take and sent users looking for a file they do not have and
 *  would not need. */
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
  // The remediation branches are explicit so the user (or the agent) can
  // dispatch on the verb. Neither branch asks for an ABI: there is no input
  // that accepts one, and for the unknown-contract branch the contract's
  // own spec is usually on chain already - it is this package that does not
  // read it.
  const unknownAdvice =
    `The contract is not in this package's built-in registry - "no-abi" means unrecognised here, not that the contract lacks an interface. ` +
    `You cannot supply one: the registry is compiled in. Either build the policy without deriving it from this transaction, or re-capture against a protocol the registry covers. ` +
    `Passing confidenceOverride accepts the recording as it stands, including the arguments this tool could not attribute - do that only if you have checked them yourself.`
  if (hasUnknown && hasOpaque) {
    return (
      `${header} ${unknownAdvice} Separately, file the opaque ScVal path against the recorder (a decoder limitation) ` +
      `and re-run record_transaction after a tool upgrade.`
    )
  }
  if (hasUnknown) {
    return `${header} ${unknownAdvice}`
  }
  if (hasOpaque) {
    return `${header} This is a recorder decoder limitation (the value shape is supported in principle but not yet decoded) - the agent cannot fix it by supplying an ABI. Report the opaque ScVal path above against the recorder and re-run record_transaction after a tool upgrade.`
  }
  return `${header} No actionable diagnostic was recorded; re-run record_transaction against a fresh fetch and inspect the events.`
}
