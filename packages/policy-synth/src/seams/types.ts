// src/seams/types.ts - the three custody seams (contracts, not implementations).
//
// The synthesizer is decoupled from its edges by three seams:
//   - PolicySource  (INPUT):  produces a normalized RecordedTransaction. The
//                             recorder is the reference source; a MandateSpec
//                             lowering is a second, deterministic source.
//   - ChainDecoder  (DECODE): chain-specific call data -> normalized facts.
//   - CustodyAdapter (OUTPUT): compile a PolicyIR to a backend-native policy +
//                             verify/export it (OZ is the first adapter).
// These are INTERFACES only. Implementations live in their own modules.

import type { ToolResponse } from '../errors.ts'
import type { PolicyIR } from '../ir/types.ts'
import type { Network, ProposedPolicy, RecordedTransaction, ScVal } from '../types.ts'

/** INPUT: something that produces a normalized RecordedTransaction. */
export interface PolicySource {
  readonly name: string
  capture(input: {
    hash?: string
    xdr?: string
    network: Network
  }): Promise<ToolResponse<RecordedTransaction>>
}

/** DECODE: chain-specific call data -> the normalized facts the synth reasons
 *  over. */
export interface ChainDecoder {
  readonly chain: 'stellar' | 'evm'
  decodeInvocation(tx: RecordedTransaction): { contract: string; method: string; args: ScVal[] }
}

/** OZ = enforce; `log_only` is reserved for shadow mode (out of scope). */
export type CustodyMode = 'enforce' | 'log_only'

/** What a backend can express. A construct needing a false flag is flagged
 *  `uncovered` by the adapter, never silently dropped. */
export interface CustodyCapabilities {
  supportsSpendWindow: boolean
  supportsTimeExpiry: boolean
  supportsThreshold: boolean
  supportsGeneralPredicate: boolean
}

/** The result of compiling a PolicyIR for one backend. */
export interface CompileResult {
  /** false => some IR construct this backend cannot express (see `uncovered`). */
  covered: boolean
  /** Human-readable list of unsupported constructs. */
  uncovered: string[]
  /** The backend-native installable policy, assembled when a rule lowered. */
  proposed?: ProposedPolicy
}

/** Result of a simulate() dry-run. `ts-model` is the off-chain TS evaluator.
 *  Real permit/deny semantics wiring is a later phase; week-1 returns a
 *  clearly-marked stub (empty `evaluations`, `permitted: null`). */
export interface SimulationResult {
  backend: 'ts-model'
  /** Whether the permit tx would be allowed; null until real semantics land. */
  permitted: boolean | null
  /** Per-construct evaluation trace; empty placeholder in this slice. */
  evaluations: unknown[]
  /** Diagnostics; marks the stub explicitly. */
  notes: string[]
}

/** OUTPUT: compile a PolicyIR to a backend-specific installable policy. */
export interface CustodyAdapter {
  readonly name: string
  readonly mode: CustodyMode
  capabilities(): CustodyCapabilities
  compile(ir: PolicyIR): CompileResult
  /** Phase-03 wiring; a clearly-marked stub in week-1. */
  simulate(ir: PolicyIR, permitTx: RecordedTransaction): SimulationResult
  /** Canonical JSON of the IR (portability / audit). */
  export(ir: PolicyIR): string
  // install(...) lands with a later phase; not part of this slice.
}
