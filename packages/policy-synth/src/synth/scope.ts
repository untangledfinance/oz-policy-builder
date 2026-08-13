// src/synth/scope.ts - decide the OZ context-rule scope from IntentFacts.
//
// Pure decision function. Three branches:
//   - single call target                   -> CallContract(target)
//   - multiple targets w/ sharedRouter     -> CallContract(sharedRouter)
//   - multiple unrelated targets           -> SCOPE_UNRESOLVED ToolError
//
// `decideScope` also surfaces the `DURATION_UNSPECIFIED` ambiguity when the
// caller has NOT supplied a validUntilLedger - the synth never fabricates a
// window. The orchestrator is responsible for assembling any
// `AmbiguityPrompt[]` from this and other decision points into the
// `ProposedPolicy.ambiguities` field.

import type { ToolError, ToolResponse } from '../errors.ts'
import type { AmbiguityPrompt, ContextRuleDraft, Network } from '../types.ts'
import type { IntentFacts } from './lower.ts'

export type ScopeDecision =
  | { kind: 'call_contract'; contract: string; ambiguities: AmbiguityPrompt[] }
  | { kind: 'default'; ambiguities: AmbiguityPrompt[] }

/** Options for the scope decision. `validUntilLedger` may be supplied via the
 *  synth opts; when absent the DURATION_UNSPECIFIED ambiguity is surfaced so
 *  the LLM can ask the user rather than the synth fabricating a window. */
export interface DecideScopeOptions {
  network: Network
  validUntilLedger?: number
}

/** Decide the OZ context-rule scope. Returns `ScopeDecision` on success or a
 *  `ToolError` with code `SCOPE_UNRESOLVED` when the recorded tx spans
 *  multiple unrelated call targets. */
export function decideScope(
  facts: IntentFacts,
  opts: DecideScopeOptions
): ToolResponse<ScopeDecision> {
  const ambiguities: AmbiguityPrompt[] = []
  if (opts.validUntilLedger === undefined) {
    ambiguities.push({
      code: 'DURATION_UNSPECIFIED',
      question:
        'No expiry supplied for this policy. What `validUntilLedger` should the policy carry?',
    })
  }

  // Single target -> scope directly.
  if (facts.callTargets.length === 1) {
    const contract = facts.callTargets[0]
    if (contract === undefined) {
      return {
        ok: false,
        error: scopeUnresolvedError(facts, 'no contract address resolvable from the recording'),
      }
    }
    return {
      ok: true,
      data: { kind: 'call_contract', contract, ambiguities },
    }
  }

  // Multiple targets with a shared router -> scope by the router.
  if (facts.sharedRouter) {
    return {
      ok: true,
      data: {
        kind: 'call_contract',
        contract: facts.sharedRouter,
        ambiguities,
      },
    }
  }

  // Multiple unrelated targets -> fail closed.
  return {
    ok: false,
    error: scopeUnresolvedError(
      facts,
      `multiple unrelated call targets: ${facts.callTargets.join(', ')}`
    ),
  }
}

/** Helper to project a `ScopeDecision` into the OZ `ContextRuleDraft`
 *  contextRuleType shape consumed by `composeFromRecording` and the OZ
 *  adapter. */
export function scopeToContextRuleType(scope: ScopeDecision): ContextRuleDraft['contextRuleType'] {
  return scope.kind === 'call_contract'
    ? { kind: 'call_contract', contract: scope.contract }
    : { kind: 'default' }
}

function scopeUnresolvedError(facts: IntentFacts, message: string): ToolError {
  return {
    code: 'SCOPE_UNRESOLVED',
    message,
    severity: 'error',
    retryable: false,
    details: { callTargets: facts.callTargets, sharedRouter: facts.sharedRouter ?? null },
    remediation: {
      userQuestion: {
        code: 'MULTIPLE_UNRELATED_TARGETS',
        question: `Recording spans ${facts.callTargets.length} call targets (${facts.callTargets.join(
          ', '
        )}). Which contract (or shared router) should this policy scope to?`,
      },
    },
  }
}
