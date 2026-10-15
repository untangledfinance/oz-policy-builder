// The response envelope every tool returns, and the one error type that
// produces its failure half.

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'RECORDING_FAILED'
  | 'SYNTHESIS_ERROR'
  | 'MALFORMED_PREDICATE'
  | 'SIMULATION_ERROR'
  | 'VERIFICATION_FAILED'
  | 'INSTALL_BUILD_FAILED'
  | 'REVOKE_BUILD_FAILED'
  | 'INTERPRETER_MISMATCH'

export interface ToolError {
  code: ErrorCode
  message: string
  severity: 'info' | 'warning' | 'error' | 'fatal'
  retryable: boolean
  remediation?: { toolCall?: { name: string; args: Record<string, unknown> } }
  details?: unknown
}

export type ToolResponse<T> = { ok: true; data: T } | { ok: false; error: ToolError }

/** Thrown anywhere below a tool; the tool wrapper turns it into the envelope. */
export class Refusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { retryable?: boolean; details?: unknown } = {}
  ) {
    super(message)
  }
}

const MAX_MESSAGE = 512

/** Any thrown value as a bounded, stack-free message. */
export function describe(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)
  return (m ?? String(e)).slice(0, MAX_MESSAGE)
}
