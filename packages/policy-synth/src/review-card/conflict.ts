// src/review-card/conflict.ts - the ConflictAnnotation 4-kind enum + the
// `classifyConflict` classifier.
//
// When a user installs a new policy alongside an existing rule set, the
// review card surfaces the relationship between the new rule and each
// existing rule as a structured annotation. A boolean (conflict / no
// conflict) is wrong: four qualitatively different shapes are possible, and
// each one tells the user something different about what would happen if
// both rules installed together.
//
//   - subsume            new rule's scope is a SUPERSET of an existing
//                        rule's. The new rule is broader; installing it on
//                        top of the existing rule weakens the existing
//                        restriction. The existing rule becomes a no-op.
//   - disjoint           new rule and existing rule are unrelated: their
//                        scopes do not overlap. Safe to install both.
//   - counter_permissive new rule and existing rule allow CONFLICTING
//                        things at the same scope (one caps lower than the
//                        other on the same axis). The stricter one wins
//                        at evaluate; the looser is dead weight.
//   - window_divergent   new rule and existing rule have the same scope
//                        and the same per-window limit but DIFFERENT
//                        rolling windows. Effective union = sum (the user
//                        can spend `limit` per each window, independently).
//
// The classifier consumes a minimal `RuleRef` shape: the rule id, scope
// (contract + method), and an optional spending limit + window. Shapes
// without a limit fall back to scope-only classification.

/** Minimal rule reference the classifier needs to compute the conflict kind.
 *  Carries the rule id (used in the annotation), the scope (contract +
 *  method), and an optional spending cap. The cap captures both the
 *  amount and the window so the classifier can compare apples to apples. */
export interface RuleRef {
  id: string
  scope: { contract?: string; method?: string }
  /** When set, the rule enforces this per-window spend cap (token +
   *  decimal-string amount + seconds window). */
  spendingLimit?: { token: string; amount: string; windowSeconds: number }
}

/** Structured annotation a single new-vs-existing rule comparison yields.
 *  Four mutually exclusive kinds; the union is exhaustive (the classifier
 *  never throws). */
export type ConflictAnnotation =
  | { kind: 'subsume'; existingRuleId: string; detail: string }
  | { kind: 'disjoint' }
  | { kind: 'counter_permissive'; existingRuleId: string; newLimit: string; existingLimit: string }
  | { kind: 'window_divergent'; existingRuleId: string; effectiveUnion: string }

/** Classify the relationship between a new rule and one existing rule.
 *  Pure: same pair -> same annotation. */
export function classifyConflict(newRule: RuleRef, existingRule: RuleRef): ConflictAnnotation {
  // --- step 1: subsume? (new.scope ⊋ existing.scope) ---
  //
  // Subsume requires existing to be fully scoped (both contract AND method
  // pinned) AND new to be at least partially broader than existing. A new
  // rule with identical scope to existing is NOT a superset - it is the
  // same rule and falls through to the same-scope branch below. If existing
  // is "any contract" / "any method" then it is the wildest rule in the
  // rule set; a new rule covering it is just a duplicate, not a subsume -
  // fall through to disjoint.
  const existingHasContract = existingRule.scope.contract !== undefined
  const existingHasMethod = existingRule.scope.method !== undefined
  const newIsBroaderOnContract = newRule.scope.contract === undefined && existingHasContract
  const newIsBroaderOnMethod = newRule.scope.method === undefined && existingHasMethod
  const newMatchesOnContract =
    newRule.scope.contract === undefined ||
    (existingHasContract && newRule.scope.contract === existingRule.scope.contract)
  const newMatchesOnMethod =
    newRule.scope.method === undefined ||
    (existingHasMethod && newRule.scope.method === existingRule.scope.method)
  if (
    existingHasContract &&
    existingHasMethod &&
    newMatchesOnContract &&
    newMatchesOnMethod &&
    (newIsBroaderOnContract || newIsBroaderOnMethod)
  ) {
    return {
      kind: 'subsume',
      existingRuleId: existingRule.id,
      detail: `new rule scope (${describeScope(newRule)}) is a superset of existing rule (${describeScope(existingRule)})`,
    }
  }

  // --- step 2: disjoint by scope? ---
  if (existingHasContract && newRule.scope.contract !== undefined) {
    if (newRule.scope.contract !== existingRule.scope.contract) {
      return { kind: 'disjoint' }
    }
  }
  if (
    existingHasMethod &&
    newRule.scope.method !== undefined &&
    newRule.scope.method !== existingRule.scope.method
  ) {
    return { kind: 'disjoint' }
  }

  // --- step 3: same scope -> compare spend caps (when both sides carry them) ---
  if (newRule.spendingLimit && existingRule.spendingLimit) {
    const a = newRule.spendingLimit
    const b = existingRule.spendingLimit
    if (a.token !== b.token) {
      // Same scope, different tokens: each binds a different axis. They
      // do not counter each other; treat as disjoint.
      return { kind: 'disjoint' }
    }
    if (a.windowSeconds === b.windowSeconds) {
      // Same scope, same token, same window: counter-permissive when the
      // amounts disagree (the stricter wins at evaluate; the looser is
      // dead weight). Equal amounts -> duplicate rule, treat as disjoint.
      if (a.amount === b.amount) {
        return { kind: 'disjoint' }
      }
      return {
        kind: 'counter_permissive',
        existingRuleId: existingRule.id,
        newLimit: `${a.amount} ${a.token} / ${a.windowSeconds}s`,
        existingLimit: `${b.amount} ${b.token} / ${b.windowSeconds}s`,
      }
    }
    // Same scope + token, different windows: effective union is the sum
    // of the two per-window caps (each window ticks independently).
    const union = (BigInt(a.amount) + BigInt(b.amount)).toString()
    return {
      kind: 'window_divergent',
      existingRuleId: existingRule.id,
      effectiveUnion: `${union} ${a.token} per ${a.windowSeconds}s (new) + ${b.windowSeconds}s (existing)`,
    }
  }

  // Same scope without comparable spend caps on both sides -> disjoint.
  return { kind: 'disjoint' }
}

function describeScope(rule: RuleRef): string {
  const parts: string[] = []
  parts.push(rule.scope.contract ? `contract=${rule.scope.contract}` : 'contract=*')
  parts.push(rule.scope.method ? `method=${rule.scope.method}` : 'method=*')
  return parts.join(', ')
}
