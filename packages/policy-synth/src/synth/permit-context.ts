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
  oraclePriceBound?: Array<{ asset: string; operator: string; value: string; decimals: number }>
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

  const oraclePriceByAsset: EvalContext['oraclePriceByAsset'] = {}
  visitOracleLeaves(predicate, (asset, op, bound) => {
    let price: bigint
    switch (op) {
      case 'lt':
        price = bound - 1n
        break
      case 'gt':
        price = bound + 1n
        break
      default:
        price = bound
    }
    if (price < 0n) price = 0n
    oraclePriceByAsset[asset] = { price: price.toString(), timestampSeconds: tx.fetchedAt }
  })

  const ctx: EvalContext = {
    contract: scopeContract,
    fn: topLevel?.fn ?? '',
    args: (topLevel?.args ?? []).map(cloneScVal),
    atLedger: tx.ledgerSequence,
    nowSeconds: tx.fetchedAt,
    amountByToken,
    windowSpentByToken: {},
    invocationCountByWindow: {},
    oraclePriceByAsset,
  }
  if (responses.validUntilLedger !== undefined) {
    ctx.validUntilLedger = responses.validUntilLedger
  }
  return ctx
}

function visitOracleLeaves(
  node: PredicateNode,
  visit: (asset: string, op: string, bound: bigint) => void
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
      const leftIsOracle = node.left.kind === 'oracle_price'
      const rightIsOracle = node.right.kind === 'oracle_price'
      let asset: string | undefined
      let literal: bigint | undefined
      if (leftIsOracle) {
        asset = node.left.kind === 'oracle_price' ? node.left.asset : undefined
        literal = oracleThresholdNormalised(node.right)
      } else if (rightIsOracle) {
        asset = node.right.kind === 'oracle_price' ? node.right.asset : undefined
        literal = oracleThresholdNormalised(node.left)
      }
      if (asset !== undefined && literal !== undefined) {
        visit(asset, node.op, literal)
      }
      return
    }
    case 'in':
      return
  }
}

/** Oracle prices normalise to 9 decimals; mirrors NORMALISED_DECIMALS in
 *  oracle.rs. */
const NORMALISED_DECIMALS = 9n

/** A threshold restated on the normalised basis, so a derived permit price is
 *  comparable to it. Thresholds carry their own basis, so the conversion has
 *  to happen here - reading the digits raw would build a context off by a
 *  factor of 10^(decimals-9). Returns undefined for any other leaf. */
function oracleThresholdNormalised(leaf: PredicateLeaf): bigint | undefined {
  if (leaf.kind !== 'oracle_threshold') return undefined
  let value: bigint
  try {
    value = BigInt(leaf.value)
  } catch {
    return undefined
  }
  const decimals = BigInt(leaf.decimals)
  if (decimals <= NORMALISED_DECIMALS) {
    return value * 10n ** (NORMALISED_DECIMALS - decimals)
  }
  // Floor: a finer-grained threshold has no exact 9-dp representation. The
  // caller only needs a price that lands on the right side of the bound, and
  // it offsets by one from here.
  return value / 10n ** (decimals - NORMALISED_DECIMALS)
}
