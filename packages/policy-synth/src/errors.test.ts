import { describe, expect, it } from 'bun:test'
import type { ErrorCode, ToolError, ToolResponse, UnsignedXdrB64 } from './errors.ts'

const REPRESENTATIVE_CODES: ErrorCode[] = [
  // recorder
  'RECORDING_FAILED',
  'RECORDING_VALIDATION_FAILED',
  // synthesis
  'SCOPE_UNRESOLVED',
  'SYNTHESIS_ERROR',
  'MALFORMED_PREDICATE',
  // simulate / verify
  'SIMULATION_ERROR',
  'VERIFICATION_FAILED',
  'DENY_CASE_FAILURE',
  'PERMIT_CASE_FAILED',
  'SUMMARY_DRIFT',
  // install / revoke
  'INSTALL_BUILD_FAILED',
  'INSTALL_CONFIRM_MISSING',
  'INSTALL_CONFIRM_EXPIRED',
  'REVOKE_BUILD_FAILED',
  'REVOKE_CONFIRM_MISSING',
  'USER_REJECTED_SIGN',
  'WALLET_TIMEOUT',
  'WALLET_UNAVAILABLE',
  // predicate caps
  'PREDICATE_TOO_LARGE',
  'PREDICATE_TOO_DEEP',
  'PREDICATE_ORACLE_OVER_LIMIT',
  'POLICY_CAP_EXCEEDED',
  'WASM_TOO_LARGE',
  // interpreter denies
  'MASTER_AUTH_REQUIRED',
  'NONCE_REPLAY',
  'VERSION_MISMATCH',
  'ARITHMETIC_OVERFLOW',
  'AMOUNT_OVERFLOW',
  'RULE_SIGNERS_CHANGED',
  'SCOPE_SELF_CALL',
  'ARG_MISMATCH',
  'CONTRACT_SCOPE',
  'UNSUPPORTED_NODE',
  'STATEFUL_BOUND',
  'NOT_IN_ALLOWLIST',
  'FREQUENCY',
  // oracle denies
  'ORACLE_STALE',
  'ORACLE_MISSING',
  'ORACLE_NO_CONFIRMATION',
  'ORACLE_DEVIATION_EXCEEDED',
  'ORACLE_MALFORMED_HISTORY',
  'ORACLE_FINGERPRINT_DRIFT',
  'ORACLE_PAUSED',
  'ORACLE_LEAF_INVALID_POSITION',
  'ORACLE_PARAMS_OUT_OF_RANGE',
  'ORACLE_DECIMALS_MISMATCH',
  // escape-hatch compile gate
  'COMPILE_OK',
  'COMPILE_GATE_FAILED',
]

describe('ErrorCode union', () => {
  it('has no duplicate string values in the representative list', () => {
    const set = new Set(REPRESENTATIVE_CODES)
    expect(set.size).toBe(REPRESENTATIVE_CODES.length)
  })

  it('every representative code is a non-empty string', () => {
    for (const code of REPRESENTATIVE_CODES) {
      expect(typeof code).toBe('string')
      expect(code.length).toBeGreaterThan(0)
    }
  })
})

describe('ToolResponse<T> discriminated union', () => {
  it('narrows on ok=true to the data branch', () => {
    const ok: ToolResponse<{ x: number }> = { ok: true, data: { x: 1 } }
    if (ok.ok) {
      expect(ok.data.x).toBe(1)
    } else {
      throw new Error('should not reach here')
    }
  })

  it('narrows on ok=false to the error branch', () => {
    const err: ToolError = {
      code: 'VERIFICATION_FAILED',
      message: 'deny case incorrectly permitted',
      severity: 'error',
      retryable: false,
    }
    const fail: ToolResponse<{ x: number }> = { ok: false, error: err }
    if (!fail.ok) {
      expect(fail.error.code).toBe('VERIFICATION_FAILED')
      expect(fail.error.retryable).toBe(false)
    } else {
      throw new Error('should not reach here')
    }
  })

  it('ToolError carries the required fields', () => {
    const e: ToolError = {
      code: 'ORACLE_STALE',
      message: 'pulse price older than 600s',
      severity: 'fatal',
      retryable: false,
      remediation: { docsUrl: 'https://example.com/oracle-stale' },
      details: { lastSeen: 1 },
    }
    expect(e.severity).toBe('fatal')
    expect(e.remediation?.docsUrl).toBe('https://example.com/oracle-stale')
    expect(e.details).toEqual({ lastSeen: 1 })
  })
})

describe('UnsignedXdrB64', () => {
  it('is a string alias', () => {
    const xdr: UnsignedXdrB64 = 'AAAA'
    expect(typeof xdr).toBe('string')
  })
})
