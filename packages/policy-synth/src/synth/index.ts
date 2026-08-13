// src/synth/index.ts - re-export the synthesizer front-ends.

// Exported because `swapRecipientAllowlist` is part of the public synthesis
// input: a caller assembling one needs the same validator the schema applies,
// and re-deriving it elsewhere means a second address check that can drift.
export { isStellarAddress } from './address.ts'
export {
  type ComposeOptions,
  type ComposeResult,
  composeFromRecording,
} from './compose-from-recording.ts'
export {
  type DenyCase,
  type GeneratedCases,
  generateCases,
} from './deny-cases.ts'
export { type EvalContext, type EvalResult, evaluate } from './evaluate.ts'
export {
  type HarnessFailure,
  type HarnessResult,
  runHarness,
} from './harness.ts'
export { type IntentFacts, lower } from './lower.ts'
export { minimize } from './minimize.ts'
export {
  type DecideScopeOptions,
  decideScope,
  type ScopeDecision,
  scopeToContextRuleType,
} from './scope.ts'
export { synthesizeFromMandate } from './synthesize-from-mandate.ts'
export {
  type __TestInterpreterAdapterOptions,
  type SynthesizeFromRecordingOptions,
  synthesizeFromRecording,
} from './synthesize-from-recording.ts'
