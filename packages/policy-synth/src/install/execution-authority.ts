import {
  effectiveSelectors,
  executionGovernedSelectors,
  intersectSelectors,
  signerKey,
  type ObservedRule,
  type Selector,
} from './authority-overlap.ts'
import type { SignerDraft } from '../types.ts'
import type { ExecutionDocument } from './scoped-execution.ts'

export interface ExecutionAuthorityConflict {
  /** null denotes a whole-scan failure, never a removable rule. */
  ruleId: number | null
  kind: 'direct-authority' | 'unknown-authority' | 'execution-overlap'
  reason: string
  sharedSigners: SignerDraft[]
  sharedSelectors: Selector[]
  executionDocumentHash?: string
}
export interface ExecutionAuthorityAnalysis {
  safe: boolean
  governedSelectors: Selector[]
  conflicts: ExecutionAuthorityConflict[]
}
/** Conservative account-wide guard. Supply all observed rules, only decode
 * documents from verified interpreter pins, and propagate incomplete reads.
 * Overlapping execution rules are NOT deemed safe merely for sharing an
 * executor: plans, amounts, recipients, auth trees and signer sets may differ.
 * This analysis never authorizes removing a default/owner rule. */
export function analyzeExecutionAuthority(args: {
  intended: { ruleId?: number; signers: SignerDraft[]; document: ExecutionDocument }
  existing: ObservedRule[]
  incomplete?: boolean
}): ExecutionAuthorityAnalysis {
  const governedSelectors = executionGovernedSelectors(args.intended.document)
  const conflicts: ExecutionAuthorityConflict[] = []
  if (args.incomplete)
    conflicts.push({
      ruleId: null,
      kind: 'unknown-authority',
      reason: 'The account authority scan is incomplete; execution safety cannot be established.',
      sharedSigners: [],
      sharedSelectors: governedSelectors,
    })
  const keys = new Set(args.intended.signers.map(signerKey))
  for (const rule of args.existing) {
    if (rule.id === args.intended.ruleId) continue
    const sharedSigners = rule.unreadableAuthority
      ? args.intended.signers
      : rule.signers.filter((s) => keys.has(signerKey(s)))
    if (!sharedSigners.length && !rule.unreadableAuthority) continue
    const sharedSelectors = intersectSelectors(governedSelectors, effectiveSelectors(rule))
    if (!sharedSelectors.length && !rule.unreadableAuthority) continue
    const kind: ExecutionAuthorityConflict['kind'] = rule.unreadableAuthority
      ? 'unknown-authority'
      : rule.executionDocument
        ? 'execution-overlap'
        : rule.policyAddresses.length && !rule.predicate
          ? 'unknown-authority'
          : 'direct-authority'
    const reason =
      kind === 'execution-overlap'
        ? `Rule ${rule.id} is an existing execution document. Its plans, limits and signer relationships may grant broader authority; sharing an executor does not prove equivalent restrictions.`
        : kind === 'unknown-authority'
          ? `Rule ${rule.id} has unreadable or unsupported authority; it must be reviewed before scoped execution can be claimed.`
          : `Rule ${rule.id} grants overlapping direct authority that can bypass this execution document's ordered plans and restrictions.`
    conflicts.push({
      ruleId: rule.id,
      kind,
      reason,
      sharedSigners,
      sharedSelectors,
      ...(rule.executionDocumentHash ? { executionDocumentHash: rule.executionDocumentHash } : {}),
    })
  }
  return { safe: conflicts.length === 0, governedSelectors, conflicts }
}
