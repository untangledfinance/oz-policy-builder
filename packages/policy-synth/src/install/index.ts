// Public entry for the install-argument builders.
//
// `buildAddContextRuleArgs` is the encoder `runInstallPolicy` uses to turn a
// ContextRuleDraft into the `add_context_rule` arguments. It was reachable
// only from inside this package, so a browser client that wants to build the
// same call had the choice of re-implementing the encoding or going without.
// Re-implementing it is not a real option: the interpreter compares
// sha256(context_rule.signers) at enforce time, so an encoding that differs in
// any field yields a rule that denies every call, and an omitted policy yields
// one that permits every call. Both failure modes have happened.
//
// Exported here rather than from the package root to keep the root surface
// about synthesis, and because these are transaction-building primitives whose
// callers should know they are reaching for them.
export {
  ADD_CONTEXT_RULE_SYMBOL,
  type AddContextRuleArgs,
  type BuildAddContextRuleArgs,
  buildAddContextRuleArgs,
  DEFAULT_GRAMMAR_VERSION,
} from './build-add-context-rule.ts'
