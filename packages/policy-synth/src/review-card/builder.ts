// src/review-card/builder.ts - deterministic, pure review-card summary
// builder.
//
// `buildReviewCardSummary` renders the per-policy text the user-facing review
// card quotes. The whole DX win of non-engineer reviewability hinges on the
// summary being REPRODUCIBLE + TESTABLE + NON-HALLUCINABLE, so this module is
// pure: same inputs -> byte-identical output, no clock, no randomness, no I/O.
//
// The builder walks two inputs and emits ONE constraint string per leaf or
// primitive, in a fixed deterministic order:
//
//   1. The OZ built-in `PolicyRef`s. Each `spending_limit` primitive becomes a
//      `spending_limit(token, limitAmount, windowSecs)` line; other OZ
//      primitives (threshold) are skipped - the review card does not quote
//      them (they are signer-config concerns, not transactional bounds).
//
//   2. The interpreter `PredicateNode`. One string per constraint leaf,
//      rendered by enclosing-comparison kind. Templates (Task 7b):
//        - invocation_count_in_window < N     -> At most N calls per <window> seconds
//        - call_arg[i] in [list]              -> Recipient/arg must be one of [list]
//        - eq(call_arg[i], literal_vec[...])  -> Path must be exactly [list]
//        - oracle_price(asset) OP price       -> Only when oracle_price(asset) OP price
//        - call_fn == x                       -> Function must be x
//        - call_contract == c                 -> Contract must be c
//        - amount <= v                        -> Amount <= v
//
// The content hash is a stable sha256 hex of a canonical JSON of
// { ruleName, plainEnglish, constraints, expiry, backend } - identical
// inputs (incl. the context-rule expiry and simulation backend) -> identical
// hash. There is no clock; the hash never includes a timestamp.

import { createHash } from 'node:crypto'
import type {
  ContextRuleDraft,
  OZPrimitiveConfig,
  PolicyRef,
  PredicateLeaf,
  PredicateNode,
} from '../types.ts'
import type { SimulationResult } from '../verify/envelope.ts'

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
  policyRefs: PolicyRef[],
  contextRule: ContextRuleDraft,
  simulation: SimulationResult
): ReviewCardSummary {
  const constraints: string[] = []
  for (const ref of policyRefs) {
    const line = renderOzPrimitive(ref)
    if (line !== null) constraints.push(line)
  }
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
  const backend = simulation.backend

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

/** Render the OZ built-in primitive summary line. Only `spending_limit` is
 *  quoted by the review card (it is the only primitive that defines a
 *  transactional bound). Other primitives (threshold) are signer-config
 *  concerns handled by the OZ adapter's own `uncovered` machinery.
 *  Spending_limit takes `period_ledgers` on-chain (~5s/ledger); the card
 *  states the window in seconds so the user reads it consistently with the
 *  interpreter templates. */
function renderOzPrimitive(ref: PolicyRef): string | null {
  if (ref.kind !== 'oz_builtin') return null
  const primitive: OZPrimitiveConfig = ref.primitive
  if (primitive.primitive !== 'spending_limit') return null
  const params = primitive.params as { spending_limit?: string; period_ledgers?: number }
  const limit = params.spending_limit ?? '0'
  const periodLedgers = params.period_ledgers ?? 0
  const windowSecs = periodLedgers * 5
  return `spending_limit(${limit}, ${windowSecs})`
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
    case 'or':
      for (const child of node.children) walkPredicate(child, visit)
      return
    case 'not':
      walkPredicate(node.child, visit)
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

/** Render ONE constraint sentence for ONE interpreter predicate node. The
 *  shape of the output is pinned by Task 7b so the test suite can assert
 *  byte-for-byte equality. Returns `null` when the node is a structural
 *  boolean (`and` / `or` / `not`) - those are not constraint leaves. */
function renderConstraint(node: PredicateNode): string | null {
  switch (node.op) {
    case 'and':
    case 'or':
    case 'not':
      return null
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
  // For lt/gt/lte/gte the line reads "OP <value>" so the comparison kind
  // is visible; eq reads "= <value>".
  if (left.kind === 'call_arg_field') {
    const head = `arg[${left.index}] element[${left.element}].${left.field}`
    const sep = node.op === 'eq' ? '=' : comparisonOpText(node.op)
    if (right.kind === 'literal_address') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_symbol') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_bytes') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_u64') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_i128') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_u32') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_vec') {
      return `${head} ${sep} [${right.elements.map(renderVecElement).join(', ')}]`
    }
  }

  // The bound is compared against the calls ALREADY made in the window, so
  // `< N` permits N of them and `<= N` permits one more. Report how many
  // calls the rule allows rather than restating the comparison.
  if (left.kind === 'invocation_count_in_window' && right.kind === 'literal_u32') {
    const allowed = node.op === 'lt' ? right.value : right.value + 1
    return `At most ${allowed} calls per ${left.windowSecs} seconds`
  }

  // OP(call_arg[i], <scalar literal>) -> arg[i] OP <value>
  //
  // The per-call cap. It has to be here because the `amount` template below
  // is unreachable for an interpreter policy: `amount` is deliberately not in
  // the contract's grammar (dsl.rs - the interpreter sees one authorized
  // call, not the transaction's token movements), so a predicate using it is
  // refused at install. A bound on the call's own amount ARGUMENT is how a
  // cap is actually written, and it was rendering nothing at all - the card
  // silently understated the policy.
  //
  // Placed after the literal_vec case above so an exact-sequence `eq` still
  // reads as a path rather than as a comparison.
  if (left.kind === 'call_arg') {
    const head = `arg[${left.index}]`
    const sep = node.op === 'eq' ? '=' : comparisonOpText(node.op)
    if (right.kind === 'literal_i128') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_u64') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_u32') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_address') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_symbol') return `${head} ${sep} ${right.value}`
    if (right.kind === 'literal_bytes') return `${head} ${sep} ${right.value}`
    // call_arg_scaled is the slippage floor and reads as itself.
    if (right.kind === 'call_arg_scaled') {
      return `${head} >= arg[${right.index}] * ${right.num}/${right.den}`
    }
  }

  // amount <= v -> Amount <= v
  if (left.kind === 'amount' && right.kind === 'literal_i128') {
    return `Amount <= ${right.value}`
  }

  // oracle_price(asset) OP price -> Only when oracle_price(asset) OP price
  if (left.kind === 'oracle_price' && right.kind === 'oracle_threshold') {
    return `Only when oracle_price(${left.asset}) ${comparisonOpText(node.op)} ${right.value} (${right.decimals} dp)`
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

function renderVecElement(leaf: PredicateLeaf): string {
  switch (leaf.kind) {
    case 'literal_address':
      return leaf.value
    case 'literal_i128':
      return leaf.value
    case 'literal_symbol':
      return leaf.value
    case 'literal_u32':
      return String(leaf.value)
    case 'literal_u64':
      return leaf.value
    case 'literal_bytes':
      return leaf.value
    case 'literal_vec':
      return `[${leaf.elements.map(renderVecElement).join(', ')}]`
    case 'call_contract':
    case 'call_fn':
    case 'call_arg':
    case 'call_arg_len':
    case 'call_arg_field':
    case 'call_arg_scaled':
    case 'amount':
    case 'window_spent':
    case 'now':
    case 'valid_until':
    case 'invocation_count_in_window':
    case 'oracle_price':
      return `<${leaf.kind}>`
    // Show the declared basis, not just the digits. A threshold on the wrong
    // basis is the one policy error the contract cannot detect, so the review
    // card is where a human has to be able to see it.
    case 'oracle_threshold':
      return `${leaf.value} (${leaf.decimals} dp)`
  }
}

function renderHaystackElement(leaf: PredicateLeaf): string {
  if (leaf.kind === 'literal_address') return leaf.value
  if (leaf.kind === 'literal_i128') return leaf.value
  if (leaf.kind === 'literal_symbol') return leaf.value
  if (leaf.kind === 'literal_u32') return String(leaf.value)
  if (leaf.kind === 'literal_u64') return leaf.value
  if (leaf.kind === 'literal_bytes') return leaf.value
  if (leaf.kind === 'literal_vec') {
    return `[${leaf.elements.map(renderHaystackElement).join(', ')}]`
  }
  return `<${leaf.kind}>`
}

function comparisonOpText(op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'): string {
  switch (op) {
    case 'lt':
      return '<'
    case 'lte':
      return '<='
    case 'gt':
      return '>'
    case 'gte':
      return '>='
    case 'eq':
      return '=='
  }
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
