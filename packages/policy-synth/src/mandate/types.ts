// src/mandate/types.ts - the deterministic Mandate source.
//
// A MandateSpec is a declarative policy statement: "this account may call this
// contract, spending at most L per window, requiring M approvals, to these
// recipients, until this expiry". It carries NO transaction to decode, NO
// parseConfidence, and NO inference - it lowers deterministically to a
// PolicyIR. It is the clean end-to-end demo path, co-equal with the recorder.

export interface MandateSpec {
  chain: 'stellar'
  contract: string
  method?: string
  /** -> OZ `spending_limit` primitive. `limit` is an i128 decimal string. */
  spendingLimit?: { token: string; limit: string; windowSeconds: number }
  /** -> OZ `simple_threshold` / `weighted_threshold` primitive. */
  approvalThreshold?: number
  /** Recipient allowlist -> an `in` arg condition (not covered by an OZ built-in). */
  recipients?: string[]
  /** -> OZ context-rule expiry. */
  expiry?: { validUntilLedger?: number; validUntilUnixSeconds?: number }
}
