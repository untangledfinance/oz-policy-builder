// Legacy ExecutionPolicy prototype only. For the stateless adapter + v5 use
// buildExecutionBatchPolicy from execution-batch.ts; do not install this config there.
// Batch-aware venue execution mandate (M3).
//
// Compiles a venue action into the ExecutionPolicy config a Prime installs on
// its execution-mandate rule: the `call_predicate` bounding every top-level
// call the agent may batch, and the `auth_predicate` bounding every nested
// executor authorization. No protocol-specific ON-CHAIN adapter - the venue
// knowledge lives here, in the compiled predicates, exactly the shape proven on
// testnet (spike scripts/execution-adapter-testnet.ts `configSc`).
//
// Pins that make the mandate safe: the position owner / token source / receiver
// are fixed to the Prime and the custody wallet (recipient semantics), the
// reserve asset and pool are fixed (venue), amounts are strictly bounded
// (0 < x < cap), and the executor's only nested authorization is the exact
// token.transfer executor->pool. Signer set and expiry are NOT here - they live
// on the ContextRule the installer wraps this config in.
import { encodePredicate } from '../predicate/encode.js'
import type { PredicateLeaf, PredicateNode } from '../types.js'

export interface BlendExecutionMandateParams {
  /** The Prime account: position owner, token source (spender), submit `from`. */
  prime: string
  /** The custody wallet: allowance source (`from` of the pull) and withdraw receiver. */
  custody: string
  /** The Prime's execution adapter (executor) - the transient in-tx holder. */
  executor: string
  /** The reserve asset SAC pinned across the pull, the submit request and the nested transfer. */
  token: string
  /** The Blend pool pinned as the venue. */
  pool: string
  /** Strict per-call upper bound in the asset's base units (calls need `0 < amount < cap`). */
  maxAmountBaseUnits: string
  /** Batch cap; the executor also hard-caps at 8. Default 3 (pull + submit + slack). */
  maxCalls?: number
}

export interface CompiledExecutionMandate {
  executor: string
  maxCalls: number
  callPredicate: PredicateNode
  authPredicate: PredicateNode
  /** base64 canonical ScVal-XDR, ready for the ExecutionPolicy `Config`. */
  encoded: { callPredicate: string; authPredicate: string }
}

const eq = (left: PredicateLeaf, right: PredicateLeaf): PredicateNode => ({ op: 'eq', left, right })
const litA = (value: string): PredicateLeaf => ({ kind: 'literal_address', value })
const litS = (value: string): PredicateLeaf => ({ kind: 'literal_symbol', value })
const litI = (value: string): PredicateLeaf => ({ kind: 'literal_i128', value })
const litU = (value: number): PredicateLeaf => ({ kind: 'literal_u32', value })
const arg = (index: number): PredicateLeaf => ({ kind: 'call_arg', index })

/** `0 < leaf < cap`: positive AND strictly below the cap (a cap-exact call denies). */
function bounded(leaf: PredicateLeaf, cap: string): PredicateNode[] {
  return [
    { op: 'gt', left: leaf, right: litI('0') },
    { op: 'lt', left: leaf, right: litI(cap) },
  ]
}

/**
 * Compile a Blend supply/withdraw execution mandate. Supply pulls
 * custody->executor then submits with the position bound to the Prime; withdraw
 * sends the pool's tokens straight to custody. Request types 0 (supply) and 1
 * (withdraw) are both permitted; the amount is strictly bounded on every leg.
 */
export function buildBlendExecutionMandate(
  p: BlendExecutionMandateParams
): CompiledExecutionMandate {
  const cap = p.maxAmountBaseUnits
  const field = (key: string): PredicateLeaf => ({
    kind: 'call_arg_field',
    index: 3,
    element: 0,
    field: key,
  })

  const pull: PredicateNode = {
    op: 'and',
    children: [
      eq({ kind: 'call_contract' }, litA(p.token)),
      eq({ kind: 'call_fn' }, litS('transfer_from')),
      eq(arg(0), litA(p.prime)),
      eq(arg(1), litA(p.custody)),
      eq(arg(2), litA(p.executor)),
      ...bounded(arg(3), cap),
    ],
  }
  const submit: PredicateNode = {
    op: 'and',
    children: [
      eq({ kind: 'call_contract' }, litA(p.pool)),
      eq({ kind: 'call_fn' }, litS('submit')),
      eq(arg(0), litA(p.prime)),
      eq(arg(1), litA(p.executor)),
      eq(arg(2), litA(p.custody)),
      eq({ kind: 'call_arg_len', index: 3 }, litU(1)),
      eq(field('address'), litA(p.token)),
      { op: 'in', needle: field('request_type'), haystack: [litU(0), litU(1)] },
      ...bounded(field('amount'), cap),
    ],
  }
  const callPredicate: PredicateNode = { op: 'or', children: [pull, submit] }
  const authPredicate: PredicateNode = {
    op: 'and',
    children: [
      eq({ kind: 'call_contract' }, litA(p.token)),
      eq({ kind: 'call_fn' }, litS('transfer')),
      eq(arg(0), litA(p.executor)),
      eq(arg(1), litA(p.pool)),
      ...bounded(arg(2), cap),
    ],
  }
  return {
    executor: p.executor,
    maxCalls: p.maxCalls ?? 3,
    callPredicate,
    authPredicate,
    encoded: {
      callPredicate: encodePredicate(callPredicate).encodedPredicate,
      authPredicate: encodePredicate(authPredicate).encodedPredicate,
    },
  }
}
