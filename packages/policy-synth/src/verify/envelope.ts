// src/verify/envelope.ts - the post-simulation result envelope used by
// review-card rendering and verification.
//
// `SimulationResult` is the structured verdict a `simulate_policy` run
// produces; the review-card builder reads it as one of its inputs (so the
// rendered card can quote the backend that evaluated the policy) and the
// verification pipeline reads `permit` + `evaluatedCases` to confirm every
// generated deny case really did deny.
//
// This envelope is intentionally separate from the CustodyAdapter
// `SimulationResult` in `src/seams/types.ts` (which is the dry-run stub
// returned by `adapter.simulate(ir, permitTx)`); the seam result is the
// adapter contract, this envelope is the post-simulation record consumed by
// downstream rendering + verification.
//
// Fields:
//   - `permit` is the single verdict for the candidate recorded tx.
//   - `evaluatedCases` is the deny-case battery outcome (every dimension
//     must report `deny` when the policy is minimal).
//   - `backend` is the actual evaluator that produced the verdict.
//   - `simulatorVersion` lets the reviewer / audit log distinguish runs.

export type SimulationResult = {
  permit: { tx: 'permit' } | { tx: 'deny'; reason: string }
  evaluatedCases: Array<{ dimension: string; outcome: 'permit' | 'deny'; reason: string }>
  backend: 'interpreter-v1' | 'ts-model'
  simulatorVersion: string
}
