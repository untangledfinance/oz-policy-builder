// src/synth/synthesize-from-mandate.ts - the deterministic Mandate front-end.
//
// synthesizeFromMandate is the clean end-to-end demo path: a declarative
// MandateSpec is lowered deterministically to a PolicyIR and compiled by the OZ
// adapter to a ProposedPolicy. No decoding, no inference, so parseConfidence is
// the full/not-applicable value. Constructs the OZ built-in primitives cannot
// express (compile's `uncovered`) are surfaced in `ProposedPolicy.warnings`
// rather than failing the call - the covered primitives still install; the
// uncovered ones are reported.

import type { OzAdapterConfig } from '../adapters/oz/adapter.ts'
import { createOzAdapter } from '../adapters/oz/adapter.ts'
import type { ToolResponse } from '../errors.ts'
import { mandateToPolicyIR } from '../mandate/to-ir.ts'
import type { MandateSpec } from '../mandate/types.ts'
import type { PredicateNode, ProposedPolicy } from '../types.ts'
import type { SimulationResult } from '../verify/envelope.ts'

const UNCOVERED_PREFIX = 'Not covered by OZ built-in primitives: '

export function synthesizeFromMandate(
  spec: MandateSpec,
  ozConfig: OzAdapterConfig,
  /** --explain opt-in. When true, the success envelope carries the
   *  in-memory predicate tree (always null for the mandate path - the
   *  declarative MandateSpec lowers to OZ built-ins, not to an
   *  interpreter predicate) + a minimal honest SimulationResult. The
   *  flag is ADDITIVE: the existing ProposedPolicy fields are never
   *  altered. */
  opts?: { explain?: true }
): ToolResponse<ProposedPolicy> & {
  explain?: {
    predicateTree: PredicateNode | null
    simulation: SimulationResult
  }
} {
  const ir = mandateToPolicyIR(spec)
  const adapter = createOzAdapter(ozConfig)
  const result = adapter.compile(ir)

  if (!result.proposed) {
    return {
      ok: false,
      error: {
        code: 'SYNTHESIS_ERROR',
        message: `mandate lowered to no installable OZ policy: ${result.uncovered.join('; ')}`,
        severity: 'error',
        retryable: false,
        details: { uncovered: result.uncovered },
      },
    }
  }

  const proposed: ProposedPolicy = {
    ...result.proposed,
    warnings: result.uncovered.map((u) => `${UNCOVERED_PREFIX}${u}`),
  }
  // Same --explain envelope pattern as the recording path. The mandate path
  // never produces an interpreter predicate, so predicateTree is null and
  // the simulation is a minimal honest deny (no self-verify was performed).
  const envelope: ToolResponse<ProposedPolicy> & {
    explain?: {
      predicateTree: PredicateNode | null
      simulation: SimulationResult
    }
  } = { ok: true, data: proposed }
  if (opts?.explain) {
    envelope.explain = {
      predicateTree: null,
      simulation: {
        permit: {
          tx: 'deny',
          reason: 'No self-verification was performed (mandate path is OZ-only)',
        },
        evaluatedCases: [],
        backend: 'ts-model',
        simulatorVersion: 'not-run',
      },
    }
  }
  return envelope
}
