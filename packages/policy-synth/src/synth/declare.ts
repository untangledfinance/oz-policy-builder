// src/synth/declare.ts - build a predicate from a DECLARED constraint.
//
// The second synthesis front-end, beside `synthesizeFromRecording`. That one
// infers a predicate from a transaction that happened; this one takes the
// constraint the user states outright. No transaction, no decoding, no
// inference, no RPC: the same declaration always lowers to a byte-identical
// predicate.
//
// This is the surviving half of the removed `MandateSpec`. Two of that type's
// five fields lowered to things that do not exist - `spendingLimit` became a
// `window_spent` compare the interpreter cannot evaluate (it is handed one
// call and keeps no state), and `approvalThreshold` needed OZ built-in policy
// contracts that were never deployed. Both are deliberately absent here, and
// the per-call `maxAmount` bound below is the honest replacement for the
// first: it constrains the amount in THIS call rather than implying a rolling
// total nothing tracks.
//
// What a declaration can say maps one-to-one onto grammar 4:
//   fn            -> eq(call_fn, literal_symbol)
//   contract      -> eq(call_contract, literal_address)
//   maxAmount     -> lte(call_arg(i), literal_i128)
//   recipients    -> in(call_arg(j), [literal_address, ...])
//   minOutputRatio-> gte(call_arg(out), call_arg_scaled(in, num, den))

import type { ToolError } from '../errors.ts'
import type { PredicateLeaf, PredicateNode } from '../types.ts'
import { isStellarAddress } from './address.ts'

/** Argument positions of the SEP-41 `transfer(from, to, amount)` shape. A
 *  declaration that names a different method almost certainly has different
 *  positions, which is why using either default emits a warning naming the
 *  index it assumed - a bound on the wrong argument constrains something the
 *  user did not mean and fails silently. */
const SEP41_RECIPIENT_ARG = 1
const SEP41_AMOUNT_ARG = 2

export interface PolicyDeclaration {
  /** Method to pin. Required: a predicate with no selector leaf constrains
   *  nothing and the contract refuses it at install. */
  fn: string
  /** Contract to pin, already resolved to a `C...` address. */
  contract?: string
  /** Upper bound on the call's amount argument, in the token's SMALLEST
   *  unit as an unsigned decimal string (25 XLM = "250000000"). */
  maxAmount?: string
  /** Which argument carries the amount. Defaults to the SEP-41 position. */
  amountArgIndex?: number
  /** Recipient allowlist. */
  recipients?: string[]
  /** Which argument carries the recipient. Defaults to the SEP-41 position. */
  recipientArgIndex?: number
  /** A cap of "0" denies every call, so it is refused unless asked for
   *  explicitly. A rule that permits nothing is a plausible thing to want and
   *  an implausible thing to want by accident. */
  allowZeroCap?: boolean
  /** Minimum output as a ratio of the call's own input: the output argument
   *  must be at least `input * num / den`.
   *
   *  A swap's acceptable output depends on the size of the trade, so a fixed
   *  floor would pin the policy to one trade size. The ratio is DECLARED, never
   *  inferred from a recording: a recorded rate is a price at one moment, and
   *  freezing it as policy would deny ordinary trades later. */
  minOutputRatio?: { num: string; den: string; inputArgIndex: number; outputArgIndex: number }
}

export interface DeclaredPredicate {
  predicate: PredicateNode
  /** Assumptions the caller should check. Never empty when an argument index
   *  was defaulted rather than supplied. */
  warnings: string[]
}

/** Lower a declared constraint to a grammar-3 predicate. Pure and total:
 *  the same declaration always produces the same predicate. */
export function declarePredicate(d: PolicyDeclaration): DeclaredPredicate {
  if (!d.fn || d.fn.trim() === '') {
    throw declareError('SYNTHESIS_ERROR', 'a declaration needs `fn`: the method to pin')
  }
  const warnings: string[] = []
  const children: PredicateNode[] = [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: d.fn } },
  ]

  if (d.contract !== undefined) {
    if (!isStellarAddress(d.contract) || !d.contract.startsWith('C')) {
      throw declareError(
        'SYNTHESIS_ERROR',
        `contract must be a Stellar contract address (C...), got ${d.contract}`
      )
    }
    children.push({
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: d.contract },
    })
  }

  if (d.recipients !== undefined) {
    if (d.recipients.length === 0) {
      throw declareError(
        'SYNTHESIS_ERROR',
        'recipients was supplied but empty; an empty `in` haystack is refused at decode. Omit it to leave recipients unconstrained.'
      )
    }
    for (const r of d.recipients) {
      if (!isStellarAddress(r)) {
        throw declareError('SYNTHESIS_ERROR', `recipient is not a Stellar address: ${r}`)
      }
    }
    const idx = d.recipientArgIndex ?? SEP41_RECIPIENT_ARG
    if (d.recipientArgIndex === undefined) {
      warnings.push(
        `recipient allowlist bound to call_arg(${idx}), the SEP-41 \`transfer\` position. If \`${d.fn}\` carries the recipient elsewhere this constrains the wrong argument - pass recipientArgIndex.`
      )
    }
    children.push({
      op: 'in',
      needle: { kind: 'call_arg', index: idx },
      haystack: d.recipients.map((value): PredicateLeaf => ({ kind: 'literal_address', value })),
    })
  }

  if (d.maxAmount !== undefined) {
    if (!/^[0-9]+$/.test(d.maxAmount)) {
      throw declareError(
        'SYNTHESIS_ERROR',
        `maxAmount must be an unsigned integer in the token's smallest unit, got "${d.maxAmount}" (25 XLM = "250000000")`
      )
    }
    if (d.maxAmount === '0' && d.allowZeroCap !== true) {
      throw declareError(
        'SYNTHESIS_ERROR',
        'maxAmount "0" denies every call: no amount satisfies the bound. Set allowZeroCap to declare that deliberately.'
      )
    }
    const idx = d.amountArgIndex ?? SEP41_AMOUNT_ARG
    if (d.amountArgIndex === undefined) {
      warnings.push(
        `amount cap bound to call_arg(${idx}), the SEP-41 \`transfer\` position. If \`${d.fn}\` carries the amount elsewhere this caps the wrong argument - pass amountArgIndex.`
      )
    }
    children.push({
      op: 'lte',
      left: { kind: 'call_arg', index: idx },
      right: { kind: 'literal_i128', value: d.maxAmount },
    })
  }

  if (d.minOutputRatio !== undefined) {
    const { num, den, inputArgIndex, outputArgIndex } = d.minOutputRatio
    if (!/^[0-9]+$/.test(num) || !/^[0-9]+$/.test(den)) {
      throw declareError(
        'SYNTHESIS_ERROR',
        `minOutputRatio num/den must be unsigned integers, got "${num}"/"${den}" (a 1% slippage tolerance is num "99", den "100")`
      )
    }
    // Both are refused on chain at install (INVALID_SCALED_RATIO). Refusing
    // here too means the caller learns before a transaction is built.
    if (den === '0') {
      throw declareError('SYNTHESIS_ERROR', 'minOutputRatio.den is zero: the ratio has no value')
    }
    if (num === '0') {
      throw declareError(
        'SYNTHESIS_ERROR',
        'minOutputRatio.num is zero: the floor would be zero, which constrains nothing. Omit it instead.'
      )
    }
    if (inputArgIndex === outputArgIndex) {
      throw declareError(
        'SYNTHESIS_ERROR',
        `minOutputRatio bounds arg[${inputArgIndex}] against itself, which is true for any ratio at or below 1 and false above it - never a slippage floor. Pass the distinct input and output positions.`
      )
    }
    if (BigInt(num) > BigInt(den)) {
      // Demanding MORE out than went in is not slippage protection; it is a
      // rule that denies every honest trade. Loud beats a policy that never
      // permits.
      warnings.push(
        `minOutputRatio ${num}/${den} is above 1: it requires the output to EXCEED the input, which no ordinary swap satisfies. Check the ratio is not inverted.`
      )
    }
    children.push({
      op: 'gte',
      left: { kind: 'call_arg', index: outputArgIndex },
      right: { kind: 'call_arg_scaled', index: inputArgIndex, num, den },
    })
  }

  // A single conjunct is emitted bare. `and` with one child encodes to
  // different bytes than the child alone, and the extra node buys nothing.
  const predicate: PredicateNode =
    children.length === 1 ? (children[0] as PredicateNode) : { op: 'and', children }
  return { predicate, warnings }
}

function declareError(code: ToolError['code'], message: string): ToolError {
  const err = new Error(message) as Error & {
    code: ToolError['code']
    severity: string
    retryable: boolean
  }
  err.code = code
  err.severity = 'error'
  err.retryable = false
  throw err
}
