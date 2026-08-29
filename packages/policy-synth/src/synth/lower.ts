// src/synth/lower.ts - lower a RecordedTransaction to IntentFacts.
//
// Reads the top-level invocations only (the single authorized call that
// `Policy::enforce` receives; v1 grammar does not walk sub-invocations) and
// the recorded token movements. Produces the deterministic facts the synth
// reasons over: distinct call targets, functions per target, cumulative spend
// per token (outgoing movements from the recorded source account only),
// authorising signers, an optional shared-router marker when multiple top-level
// invocations hit the same contract, and the per-contract hop-path lists for
// router calls (SoroSwap `path`).

import type { ContractInvocation, RecordedTransaction, ScVal, TokenMovement } from '../types.ts'

/** Facts the recording-path synth reasons over. */
export interface IntentFacts {
  callTargets: string[]
  functionsByContract: Record<string, string[]>
  /** Aggregate outgoing spend per token (i128-safe decimal string). A single
   *  token entry is the prerequisite for `spending_limit`. Movements
   *  with from != sourceAccount are NOT counted as "spend" by this synth
   *  (incoming yield, refund, etc.). */
  spendByToken: Record<string, string>
  signers: string[]
  /** Set when more than one top-level invocation shares a target contract
   *  (a router); decideScope uses this to scope by the router instead of
   *  returning SCOPE_UNRESOLVED. */
  sharedRouter?: string
  /** Router hop paths, keyed by target contract. SoroSwap exposes its `path`
   *  arg directly on the top-level call; this is the input the compose step
   *  passes to a per-arg `in` condition (flagged as not covered by the OZ adapter). */
  allowedPaths?: Record<string, string[][]>
}

/** Lower a recorded transaction to the canonical IntentFacts. Pure (no
 *  randomness, no clock); same `RecordedTransaction` -> byte-identical facts.
 *
 *  `governedAccount` is the smart account the policy will be installed on, when
 *  one is known. It spends from itself while a wallet submits the transaction,
 *  so it counts as a spender alongside the source account. */
export function lower(tx: RecordedTransaction, governedAccount?: string): IntentFacts {
  const invocations = tx.invocations
  const callTargets = uniqueOrdered(invocations.map((i) => i.contract))
  const functionsByContract = groupFunctionsByContract(invocations)
  const spenders =
    governedAccount !== undefined && governedAccount !== tx.sourceAccount
      ? [tx.sourceAccount, governedAccount]
      : [tx.sourceAccount]
  const spendByToken = aggregateOutgoingSpend(tx.tokenMovements, spenders)
  const allowedPaths = extractPathsByContract(invocations)
  const sharedRouter = inferSharedRouter(invocations)

  const facts: IntentFacts = {
    callTargets,
    functionsByContract,
    spendByToken,
    signers: [...tx.signers],
  }
  if (sharedRouter) facts.sharedRouter = sharedRouter
  if (Object.keys(allowedPaths).length > 0) facts.allowedPaths = allowedPaths
  return facts
}

/** Preserve first-seen ordering, drop duplicates. */
function uniqueOrdered(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** Group the function names invoked per top-level contract. Order preserved
 *  per contract in first-seen order. */
function groupFunctionsByContract(invocations: ContractInvocation[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const inv of invocations) {
    const existing = out[inv.contract] ?? []
    if (!existing.includes(inv.fn)) existing.push(inv.fn)
    out[inv.contract] = existing
  }
  return out
}

/** Sum outgoing TokenMovement amounts per token, across every spender.
 *  BigInt throughout; never lossy. Movements whose `from` is none of the
 *  spenders are NOT counted (incoming yield, refund, etc.).
 *
 *  A smart account spends from ITSELF while a wallet submits the transaction,
 *  so matching the source account alone missed the entire treasury case: the
 *  flow read as incoming-only, no amount bound was required, and a rule that
 *  capped nothing installed with every check green. The account a policy
 *  governs is a spender in its own right. */
function aggregateOutgoingSpend(
  movements: TokenMovement[],
  spenders: readonly string[]
): Record<string, string> {
  const totals = new Map<string, bigint>()
  for (const m of movements) {
    if (!spenders.includes(m.from)) continue
    const current = totals.get(m.token) ?? 0n
    totals.set(m.token, current + BigInt(m.amount))
  }
  const out: Record<string, string> = {}
  for (const [token, total] of totals) {
    out[token] = total.toString()
  }
  return out
}

/** Walk the top-level invocations looking for a `vec` arg whose elements are
 *  addresses (the SoroSwap `path` shape). Only the FIRST arg in each
 *  invocation is examined in v1 - the recorder emits the top-level args
 *  in declaration order and the only contract-call convention we bind by is
 *  the router's first vec-arg path. */
function extractPathsByContract(invocations: ContractInvocation[]): Record<string, string[][]> {
  const out: Record<string, string[][]> = {}
  for (const inv of invocations) {
    const path = findAddressVec(inv.args)
    if (path) {
      const existing = out[inv.contract] ?? []
      existing.push(path)
      out[inv.contract] = existing
    }
  }
  return out
}

function findAddressVec(args: ScVal[]): string[] | null {
  for (const arg of args) {
    if (arg.type === 'vec') {
      const addresses = arg.value.filter(
        (v): v is Extract<ScVal, { type: 'address' }> => v.type === 'address'
      )
      if (addresses.length === arg.value.length && addresses.length > 0) {
        return addresses.map((a) => a.value)
      }
    }
  }
  return null
}

/** When multiple top-level invocations share the same target contract, that
 *  contract is the shared router. Single-call transactions return undefined
 *  (the default flow doesn't need the marker). */
function inferSharedRouter(invocations: ContractInvocation[]): string | undefined {
  if (invocations.length < 2) return undefined
  const counts = new Map<string, number>()
  for (const inv of invocations) {
    counts.set(inv.contract, (counts.get(inv.contract) ?? 0) + 1)
  }
  for (const [contract, count] of counts) {
    if (count >= 2) return contract
  }
  return undefined
}
