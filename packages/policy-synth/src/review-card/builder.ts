// src/review-card/builder.ts - deterministic, pure review-card summary
// builder.
//
// `buildReviewCardSummary` renders the per-policy text the user-facing review
// card quotes. The whole DX win of non-engineer reviewability hinges on the
// summary being REPRODUCIBLE + TESTABLE + NON-HALLUCINABLE, so this module is
// pure: same inputs -> byte-identical output, no clock, no randomness, no I/O.
//
// The builder walks the interpreter `PredicateNode` and emits ONE constraint
// string per leaf, in a fixed deterministic order. Templates (Task 7b):
//   - call_arg[i] in [list]              -> Recipient/arg must be one of [list]
//   - eq(call_arg[i], literal_vec[...])  -> Path must be exactly [list]
//   - call_fn == x                       -> Function must be x
//   - call_contract == c                 -> Contract must be c
//   - amount <= v                        -> Amount <= v
//
// The content hash is a stable sha256 hex of a canonical JSON of
// { ruleName, plainEnglish, constraints, expiry, backend } - identical
// inputs (incl. the context-rule expiry and simulation backend) -> identical
// hash. There is no clock; the hash never includes a timestamp.

import { createHash } from 'node:crypto'
import type { ContextRuleDraft, PredicateLeaf, PredicateNode } from '../types.ts'
import { comparisonOpText, renderHaystackElement, renderVecElement } from './render-leaf.ts'

export interface ReviewCardSummary {
  ruleName: string
  plainEnglish: string
  constraints: string[]
  expiry: string
  /** Cross-layer L1: a human-readable note about the OZ any-of-N signer
   *  semantic for rules with N>=2 signers. `null` for single-signer rules
   *  (the note would be redundant). Purely additive to the review card
   *  text - does not change the policy semantics, only what the human
   *  reads when reviewing. */
  signerNote: string | null
  backend: 'interpreter-v1' | 'ts-model'
  /** Stable hash of the builder inputs - identical policy + summary = identical hash. */
  contentHash: string
}

/** Build a deterministic review-card summary from a policy + context rule +
 *  simulation result. Pure: same inputs -> byte-identical output. */
export function buildReviewCardSummary(
  predicate: PredicateNode | null,
  contextRule: ContextRuleDraft,
  /** Evaluator identity folded into the content hash. */
  backend: 'interpreter-v1' | 'ts-model'
): ReviewCardSummary {
  const constraints: string[] = []
  if (predicate !== null) {
    walkPredicate(predicate, (node) => {
      const line = renderConstraint(node)
      if (line !== null) constraints.push(line)
    })
  }

  const ruleName = contextRule.name
  const plainEnglish = renderPlainEnglish(ruleName, constraints)
  const expiry = renderExpiry(contextRule.validUntilLedger)
  // Cross-layer L1: a rule with N>=2 signers gets a one-line note about
  // the OZ any-of-N semantic so the human reviewing the install reads the
  // same wire-level behaviour the contract enforces. A single-signer rule
  // is trivially any-of-1, so the note would be noise.
  const signerNote =
    contextRule.signers.length >= 2
      ? 'any ONE signer may authorise a permitted op under this rule (OZ any-of-N semantic)'
      : null

  const contentHash = computeContentHash({
    ruleName,
    plainEnglish,
    constraints,
    expiry,
    signerNote,
    backend,
  })

  return { ruleName, plainEnglish, constraints, expiry, signerNote, backend, contentHash }
}

/** Walk every comparison / membership node of the predicate and invoke
 *  `visit` on each. The walk is depth-first, left-to-right, so the
 *  constraint list is stable across runs. Pure boolean nodes contribute no
 *  constraint lines themselves; their leaf children do, via the visitor. */
/** Every constraint sentence for one predicate, in walk order.
 *
 *  `buildReviewCardSummary` renders a policy the synthesiser just PRODUCED,
 *  and needs the refs / context rule / simulation to do it. This renders a
 *  predicate on its own, which is what a caller holding a policy already
 *  INSTALLED on chain has: it can read the document out of the interpreter's
 *  storage and decode it, but there is no proposal around it. Same renderers,
 *  so an installed rule reads exactly as it did on the review card. */
export function describePredicate(predicate: PredicateNode): string[] {
  const constraints: string[] = []
  walkPredicate(predicate, (node) => {
    const line = renderConstraint(node)
    if (line !== null) constraints.push(line)
  })
  return constraints
}

function walkPredicate(node: PredicateNode, visit: (node: PredicateNode) => void): void {
  switch (node.op) {
    case 'and':
      for (const child of node.children) walkPredicate(child, visit)
      return
    // NOT descended into. Every line the card emits reads as a requirement,
    // and `and` is what makes that true. Listing an `or`'s branches as
    // separate lines would state the opposite of what the policy means, so
    // the whole disjunction is rendered as ONE line instead.
    case 'or':
      visit(node)
      return
    case 'in':
      visit(node)
      return
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      visit(node)
      return
  }
}

/** Argument index of a `call_arg` leaf, for the scaled-comparison line. Any
 *  other leaf renders as its kind so the line stays readable rather than
 *  claiming an index that does not exist. */
function leftArgLabel(leaf: PredicateLeaf): string {
  return leaf.kind === 'call_arg' ? String(leaf.index) : `<${leaf.kind}>`
}

/** Render ONE constraint sentence for ONE interpreter predicate node. The
 *  shape of the output is pinned by Task 7b so the test suite can assert
 *  byte-for-byte equality. Returns `null` only when a node's shape cannot be
 *  rendered at all. */
function renderConstraint(node: PredicateNode): string | null {
  switch (node.op) {
    case 'and': {
      // Reached ONLY when an `and` sits BENEATH an `or`: `walkPredicate`
      // descends into a top-level `and` and never calls this on one.
      //
      // This used to return null, on the reasoning that `and` is structural
      // rather than a constraint leaf. That is true for the walk path and
      // false for this one, and the combination silently dropped real
      // policies: `or(and, and)` is the natural shape of a policy with
      // alternative permitted forms - one conjunction of pins per branch -
      // so the `or` case below always saw null children and withheld the
      // entire disjunction. `describePredicate` then returned an EMPTY list
      // for a restrictive policy, which any caller renders as "no
      // constraints".
      //
      // That inverts the very guard it was protecting: the `or` case
      // withholds to avoid reading STRICTER than reality, but withholding
      // the only line reads as UNRESTRICTED, which is far worse. Compose
      // instead, and keep the withhold for genuinely unrenderable children.
      const parts = node.children.map(renderConstraint)
      if (parts.some((p) => p === null)) return null
      return parts.join(' and ')
    }
    case 'or': {
      // One line for the whole disjunction. If any branch is a shape the
      // card cannot render, the entire line is withheld rather than shown
      // with a branch missing - a disjunction with a branch dropped reads
      // as STRICTER than it is, which is the dangerous direction.
      const parts = node.children.map(renderConstraint)
      if (parts.some((p) => p === null)) return null
      return `Either: ${parts.join(' OR ')}`
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return renderComparison(node)
    case 'in':
      return renderMembership(node)
  }
}

function renderComparison(
  node: Extract<PredicateNode, { op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' }>
): string | null {
  // The slippage floor: OP(call_arg[out], call_arg_scaled(in, num, den)).
  // Rendered explicitly because the human approving the signature has to see
  // that the bound is a RATIO of another argument, not a fixed amount.
  if (node.right.kind === 'call_arg_scaled') {
    const s = node.right
    return `arg[${leftArgLabel(node.left)}] ${comparisonOpText(node.op)} arg[${s.index}] * ${s.num}/${s.den}`
  }
  if (node.left.kind === 'call_arg_scaled') {
    const s = node.left
    return `arg[${s.index}] * ${s.num}/${s.den} ${comparisonOpText(node.op)} arg[${leftArgLabel(node.right)}]`
  }

  const left = node.left
  const right = node.right

  // eq(call_contract, literal_address) -> Contract must be <addr>
  if (left.kind === 'call_contract' && node.op === 'eq' && right.kind === 'literal_address') {
    return `Contract must be ${right.value}`
  }

  // eq(call_fn, literal_symbol) -> Function must be <sym>
  if (left.kind === 'call_fn' && node.op === 'eq' && right.kind === 'literal_symbol') {
    return `Function must be ${right.value}`
  }

  // eq(call_arg[i], literal_vec) -> Path must be exactly [list]
  if (left.kind === 'call_arg' && node.op === 'eq' && right.kind === 'literal_vec') {
    return `Path must be exactly [${right.elements.map(renderVecElement).join(', ')}]`
  }

  // eq(call_arg_len[i], literal_u32) -> Length of arg[i] is K
  // Binds the OUTER vec length so a caller cannot append an element to
  // defeat a per-element pin. Rendered as a single readable line so the
  // review card surfaces the implicit "no new elements" guarantee.
  if (left.kind === 'call_arg_len' && node.op === 'eq' && right.kind === 'literal_u32') {
    return `Length of arg[${left.index}] is ${right.value}`
  }

  // eq/lte(call_arg_field[i, el, field], <literal>) -> arg[i] element[el].field = <value>
  // The structured-argument bind pins a scalar field inside a vec element.
  // For lte the line reads "OP <value>" so the comparison kind is visible;
  // eq reads "= <value>".
  if (left.kind === 'call_arg_field') {
    const head = `arg[${left.index}] element[${left.element}].${left.field}`
    const sep = node.op === 'eq' ? '=' : comparisonOpText(node.op)
    if (right.kind === 'literal_address') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_symbol') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_i128') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_u32') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_vec') {
      return `${head} ${sep} [${right.elements.map(renderVecElement).join(', ')}]`
    }
  }

  // The per-call cap: OP(call_arg[i], <scalar literal>) -> arg[i] OP <value>.
  // The interpreter is passed one authorized call, not the transaction's token
  // movements, so a bound on the call's own amount ARGUMENT is how a cap is
  // written.
  //
  // Placed after the literal_vec case above so an exact-sequence `eq` still
  // reads as a path rather than as a comparison.
  if (left.kind === 'call_arg') {
    const head = `arg[${left.index}]`
    const sep = node.op === 'eq' ? '=' : comparisonOpText(node.op)
    if (right.kind === 'literal_i128') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_u32') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_address') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_symbol') return `${head} ${sep} ${right.value}`
  }

  // Any other comparison shape is a structural fail-closed: do not surface
  // a misleading line. Cross-check still requires every leaf produce a
  // constraint string; the only leaves we emit lines for are the ones we
  // recognise above, so the test fixtures cover exactly the supported
  // shapes.
  return null
}

function renderMembership(node: Extract<PredicateNode, { op: 'in' }>): string | null {
  // call_arg[i] in [list] -> Recipient/arg must be one of [list]
  if (node.needle.kind === 'call_arg') {
    const list = node.haystack.map(renderHaystackElement).join(', ')
    return `Recipient/arg must be one of [${list}]`
  }
  return null
}

/** Render the plain-English one-liner. Format: `<ruleName>: <constraints>`,
 *  joined by `; ` so the user reads one sentence per constraint. */
function renderPlainEnglish(ruleName: string, constraints: string[]): string {
  if (constraints.length === 0) return `${ruleName}: (no constraints)`
  return `${ruleName}: ${constraints.join('; ')}`
}

/** Render the expiry line. `null` -> "No expiry"; a ledger sequence -> the
 *  ledger number so the user reads it in the same units the OZ context rule
 *  applies it. */
function renderExpiry(validUntilLedger: number | null): string {
  if (validUntilLedger === null) return 'No expiry'
  return `Valid until ledger ${validUntilLedger}`
}

function computeContentHash(input: {
  ruleName: string
  plainEnglish: string
  constraints: string[]
  expiry: string
  signerNote: string | null
  backend: 'interpreter-v1' | 'ts-model'
}): string {
  return createHash('sha256').update(canonicalStringify(input)).digest('hex')
}

/** Canonical JSON with recursively sorted object keys (stable across runs). */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
