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
  type DeclaredPredicate,
  declarePredicate,
  type PolicyDeclaration,
} from './declare.ts'
export { type IntentFacts, lower } from './lower.ts'
export {
  type DecideScopeOptions,
  decideScope,
  type ScopeDecision,
  scopeToContextRuleType,
} from './scope.ts'
export {
  type __TestInterpreterAdapterOptions,
  type SynthesizeFromRecordingOptions,
  synthesizeFromRecording,
} from './synthesize-from-recording.ts'
