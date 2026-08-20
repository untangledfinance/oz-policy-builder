// src/synth/permit-context.ts - build the EvalContext that represents the
// recorded call being replayed.
//
// Extracted from the over-permissiveness harness so the same construction
// feeds both the in-process battery and the on-chain replay
// (scripts/verify-mutations-testnet.ts). Two callers building this
// separately would be two chances to disagree about what "the recorded
// call" means, which is the one thing both must share.

import type { PredicateLeaf, PredicateNode, RecordedTransaction } from '../types.ts'
import { cloneScVal } from './deny-cases.ts'
import type { EvalContext } from './evaluate.ts'

export interface PermitContextResponses {
  windowSeconds: number
  invocationLimit?: number
  limitAmount?: string
  validUntilLedger: number
}

export function buildPermitContext(
  tx: RecordedTransaction,
  responses: PermitContextResponses,
  predicate: PredicateNode
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

  const topLevel = tx.invocations[0]
  const scopeContract = topLevel?.contract ?? ''


  const ctx: EvalContext = {
    contract: scopeContract,
    fn: topLevel?.fn ?? '',
    args: (topLevel?.args ?? []).map(cloneScVal),
    atLedger: tx.ledgerSequence,
    nowSeconds: tx.fetchedAt,
    amountByToken,
    windowSpentByToken: {},
    invocationCountByWindow: {},
  }
  if (responses.validUntilLedger !== undefined) {
    ctx.validUntilLedger = responses.validUntilLedger
  }
  return ctx
}

