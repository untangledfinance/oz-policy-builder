// src/review-card/index.ts - re-export the deterministic review-card surface.

export {
  buildReviewCardSummary,
  describePredicate,
  type ReviewCardSummary,
} from './builder.ts'
export {
  type ConflictAnnotation,
  classifyConflict,
  type RuleRef,
} from './conflict.ts'
export { summaryCrossCheck } from './cross-check.ts'
