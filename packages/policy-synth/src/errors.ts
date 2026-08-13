// src/errors.ts

export type ErrorCode =
  // --- recorder ---
  | 'RECORDING_FAILED'
  | 'RECORDING_VALIDATION_FAILED'
  // --- synthesis ---
  | 'SCOPE_UNRESOLVED'
  | 'SYNTHESIS_ERROR'
  | 'MALFORMED_PREDICATE'
  // --- simulate / verify ---
  | 'SIMULATION_ERROR'
  | 'VERIFICATION_FAILED'
  | 'DENY_CASE_FAILURE'
  | 'PERMIT_CASE_FAILED'
  | 'SUMMARY_DRIFT'
  // --- install / revoke ---
  | 'INSTALL_BUILD_FAILED'
  | 'INSTALL_CONFIRM_MISSING'
  | 'INSTALL_CONFIRM_EXPIRED'
  | 'REVOKE_BUILD_FAILED'
  | 'REVOKE_CONFIRM_MISSING'
  | 'USER_REJECTED_SIGN'
  | 'WALLET_TIMEOUT'
  | 'WALLET_UNAVAILABLE'
  // --- predicate caps (fail-closed at install) ---
  | 'PREDICATE_TOO_LARGE'
  | 'PREDICATE_TOO_DEEP'
  | 'TOO_MANY_LEAVES'
  | 'IN_OPERAND_LIMIT'
  | 'PREDICATE_ORACLE_OVER_LIMIT'
  | 'POLICY_CAP_EXCEEDED'
  | 'WASM_TOO_LARGE'
  // --- interpreter-side denies (canonical names; matches Rust DenyCode) ---
  | 'MASTER_AUTH_REQUIRED'
  | 'NONCE_REPLAY'
  | 'VERSION_MISMATCH'
  | 'ARITHMETIC_OVERFLOW'
  | 'AMOUNT_OVERFLOW'
  | 'RULE_SIGNERS_CHANGED'
  | 'SCOPE_SELF_CALL'
  | 'ARG_MISMATCH'
  | 'CONTRACT_SCOPE'
  | 'UNSUPPORTED_NODE'
  | 'STATEFUL_BOUND'
  | 'NOT_IN_ALLOWLIST'
  | 'FREQUENCY'
  // A `call_arg >= call_arg_scaled(..)` slippage floor was not met. Distinct
  // from the generic ARG_MISMATCH/STATEFUL_BOUND so a violated swap floor
  // reads as itself on the review card.
  | 'SLIPPAGE_FLOOR'
  // --- oracle denies (fatal evaluator errors) ---
  | 'ORACLE_STALE'
  | 'ORACLE_MISSING'
  | 'ORACLE_NO_CONFIRMATION'
  | 'ORACLE_DEVIATION_EXCEEDED'
  | 'ORACLE_MALFORMED_HISTORY'
  | 'ORACLE_FINGERPRINT_DRIFT'
  | 'ORACLE_PAUSED'
  | 'ORACLE_LEAF_INVALID_POSITION'
  | 'ORACLE_PARAMS_OUT_OF_RANGE'
  | 'ORACLE_DECIMALS_MISMATCH'
  | 'ORACLE_THRESHOLD_DECIMALS_OUT_OF_RANGE'
  | 'ORACLE_THRESHOLD_BASIS_REQUIRED'
  // --- escape-hatch compile gate ---
  | 'COMPILE_OK'
  | 'COMPILE_GATE_FAILED'

export interface ToolError {
  code: ErrorCode
  message: string
  /** LLM-actionable hint for the agent skill. Per-code severity is pinned
   *  in CODE_SEVERITY below; this field is the resolved value at runtime. */
  severity: 'info' | 'warning' | 'error' | 'fatal'
  retryable: boolean
  remediation?: {
    toolCall?: { name: string; args: Record<string, unknown> }
    userQuestion?: { code: string; question: string }
    docsUrl?: string
  }
  /** Precedence rule for an LLM agent that sees BOTH toolCall AND userQuestion:
   *    - toolCall + userQuestion together = userQuestion wins (the human decides).
   *    - toolCall alone              = agent proceeds.
   *    - userQuestion alone          = agent stops and asks.
   *  No silent ambiguity. */
  details?: unknown
}

export type ToolResponse<T> = { ok: true; data: T } | { ok: false; error: ToolError }

/** Unsigned Soroban transaction envelope, base64-encoded XDR (Soroban SDK convention).
 *  Pinned for CLI + MCP + WalletAdapter compatibility. Hex / raw-bytes / TS objects
 *  are NOT accepted - the contract is base64 string, full stop. */
export type UnsignedXdrB64 = string
