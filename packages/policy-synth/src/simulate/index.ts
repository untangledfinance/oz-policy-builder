// src/simulate/index.ts - the off-chain evaluation engine.
//
// `evaluate` is a second implementation of the on-chain predicate semantics.
// The conformance harness runs it and the Rust interpreter against the same
// predicate and asserts the verdicts match, so a divergence between the two
// fails CI rather than reaching a user as a wrong simulation.

export type { DenyCase, GeneratedCases } from './deny-cases.ts'
export { generateCases } from './deny-cases.ts'
export type { EvalContext, EvalResult } from './evaluate.ts'
export { evaluate } from './evaluate.ts'
