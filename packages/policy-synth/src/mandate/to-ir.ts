// src/mandate/to-ir.ts - deterministic lowering of a MandateSpec to a PolicyIR.
//
// `mandateToPolicyIR` is pure and total: the same spec always lowers to a
// byte-identical PolicyIR. No decoding, no inference, no clock. Each mandate
// field maps to exactly one IR construct:
//   contract/method  -> rule.scope
//   spendingLimit    -> a `window_spent(token,window) <= limit` compare
//   approvalThreshold-> rule.approval.threshold
//   recipients       -> an `in` condition on the recipient arg (flagged as not
//                       covered by the OZ adapter; that is expected)
//   expiry           -> rule.expiry
// The top-level default is `deny_all` (OZ context rules are deny-by-default).

import type { IRCondition, IRPolicyRule, IRSelector, PolicyIR } from '../ir/types.ts'
import type { MandateSpec } from './types.ts'

/** Arg index the recipient allowlist constrains. Pinned to the SEP-41
 *  `transfer(from, to, amount)` convention where `to` is arg 1. This condition
 *  is flagged as not covered by the OZ adapter (no built-in primitive expresses
 *  an arg allowlist), so the index only needs to be deterministic in week-1. */
const RECIPIENT_ARG_INDEX = 1

export function mandateToPolicyIR(spec: MandateSpec): PolicyIR {
  const scope: IRPolicyRule['scope'] = { contract: spec.contract }
  if (spec.method !== undefined) scope.method = spec.method

  const constraints: IRCondition[] = []

  if (spec.spendingLimit) {
    constraints.push({
      op: 'compare',
      compare: {
        selector: {
          kind: 'window_spent',
          token: spec.spendingLimit.token,
          windowSeconds: spec.spendingLimit.windowSeconds,
        },
        operator: 'lte',
        value: spec.spendingLimit.limit,
      },
    })
  }

  if (spec.recipients && spec.recipients.length > 0) {
    const selector: IRSelector = {
      kind: 'arg',
      argIndex: RECIPIENT_ARG_INDEX,
      scalarType: 'address',
    }
    constraints.push({ op: 'in', selector, values: [...spec.recipients] })
  }

  const rule: IRPolicyRule = { roles: [], scope, constraints }

  if (spec.approvalThreshold !== undefined) {
    rule.approval = { kind: 'threshold', threshold: spec.approvalThreshold }
  }

  if (spec.expiry) {
    const expiry: NonNullable<IRPolicyRule['expiry']> = {}
    if (spec.expiry.validUntilLedger !== undefined) {
      expiry.validUntilLedger = spec.expiry.validUntilLedger
    }
    if (spec.expiry.validUntilUnixSeconds !== undefined) {
      expiry.validUntilUnixSeconds = spec.expiry.validUntilUnixSeconds
    }
    rule.expiry = expiry
  }

  return { chain: spec.chain, defaultBehavior: 'deny_all', rules: [rule] }
}
