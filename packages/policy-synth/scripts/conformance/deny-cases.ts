import type { PredicateLeaf, PredicateNode, ScVal } from '../../src/types.ts'
import { MAX_SCVAL_CLONE_DEPTH } from '../../src/types.ts'
import type { EvalContext } from './evaluate.ts'

export interface DenyCase {
  dimension: string
  ctx: EvalContext
  /** Canonical reason the Rust interpreter returns for this dimension.
   *  Optional: when set, `runHarness` asserts the TS evaluator emits this
   *  exact string, so a future TS/Rust reason divergence fails CI. When
   *  absent the case is only checked on the boolean decision. */
  expectedReason?: string
}

export interface GeneratedCases {
  permit: EvalContext
  denies: DenyCase[]
}

type ComparisonOperator = 'eq' | 'lte'

type ComparisonNode = {
  op: ComparisonOperator
  left: PredicateLeaf
  right: PredicateLeaf
}

type MembershipNode = {
  op: 'in'
  needle: PredicateLeaf
  haystack: PredicateLeaf[]
}

interface PredicateFacts {
  comparisons: ComparisonNode[]
  memberships: MembershipNode[]
}

// Deterministic XLM/USDC adjacency fixture; the shared registry can replace this boundary later.
const OVERPERMISSIVE_DIMENSIONS = ['argument_reorder'] as const

export { OVERPERMISSIVE_DIMENSIONS }

/** Build deterministic model-evaluated alternatives without mutating the intended call.
 *
 * @param predicate   - the synthesized predicate
 * @param permitCtx  - EvalContext for the intended (permitted) call
 * @param dimensions - optional whitelist of dimension names to emit; when omitted
 *                    all known dimensions (including over-permissiveness mutations)
 *                    are emitted. */
export function generateCases(
  predicate: PredicateNode,
  permitCtx: EvalContext,
  dimensions?: string[]
): GeneratedCases {
  const facts = inspectPredicate(predicate)
  const denies: DenyCase[] = []

  // arg_bound: set a constrained arg to an opaque ScVal.
  // The reason depends on the predicate shape:
  //   - an `eq(call_arg[i], literal)` denies with ARG_MISMATCH
  //   - an `in(call_arg[i], [literals])` denies with NOT_IN_ALLOWLIST
  // Both are correct in the TS evaluator; the reason is predicate-dependent
  // so we cannot pin a single canonical reason here.
  const argumentConstraints: Array<{ index: number }> = []
  for (const comparison of facts.comparisons) {
    if (
      comparison.op === 'eq' &&
      comparison.left.kind === 'call_arg' &&
      comparison.right.kind !== 'literal_vec'
    ) {
      argumentConstraints.push({ index: comparison.left.index })
    }
  }
  for (const membership of facts.memberships) {
    if (membership.needle.kind === 'call_arg') {
      argumentConstraints.push({ index: membership.needle.index })
    }
  }
  for (const constraint of argumentConstraints) {
    const ctx = cloneContext(permitCtx)
    ctx.args[constraint.index] = { type: 'other', value: 'deny-case-opaque-argument' }
    denies.push({ dimension: 'arg_bound', ctx })
  }

  // soroswap_allowed_path: replace a bound vec arg with a different vector.
  // Still valid for eq comparisons on literal_vec leaves.
  for (const comparison of facts.comparisons) {
    if (
      comparison.op !== 'eq' ||
      comparison.left.kind !== 'call_arg' ||
      comparison.right.kind !== 'literal_vec'
    ) {
      continue
    }
    const ctx = cloneContext(permitCtx)
    ctx.args[comparison.left.index] = differentVector(ctx.args[comparison.left.index])
    denies.push({ dimension: 'soroswap_allowed_path', ctx })
  }

  // argument_reorder: swap first two address args.
  // Skipped when dimensions filter is active so the synth pipeline can emit a policy;
  // the over-permissiveness harness then tests this mutation as a FINDING.
  const constrainedArgIndices = new Set<number>()
  for (const comparison of facts.comparisons) {
    if (comparison.left.kind === 'call_arg') constrainedArgIndices.add(comparison.left.index)
  }
  for (const membership of facts.memberships) {
    if (membership.needle.kind === 'call_arg') constrainedArgIndices.add(membership.needle.index)
  }
  const hasConstrainedArg = constrainedArgIndices.size > 0
  if (
    (!dimensions || dimensions.includes('argument_reorder')) &&
    hasConstrainedArg &&
    permitCtx.args.length >= 2 &&
    permitCtx.args[0]?.type === 'address' &&
    permitCtx.args[1]?.type === 'address' &&
    (permitCtx.args[0] as { type: 'address'; value: string }).value !==
      (permitCtx.args[1] as { type: 'address'; value: string }).value
  ) {
    const ctx = cloneContext(permitCtx)
    // Guard above guarantees args[0] and args[1] exist and are address-typed.
    const a0 = ctx.args[0] as ScVal
    const a1 = ctx.args[1] as ScVal
    ctx.args[0] = a1
    ctx.args[1] = a0
    denies.push({ dimension: 'argument_reorder', ctx })
  }

  // map_field_flip: flip a bound map field to a different valid value of
  // the same type. OPT-IN only, never ORIGINAL.
  // Targets each `call_arg_field` leaf and produces a ctx whose vec element
  // has a different value of the recorded field. ---
  if (!dimensions || dimensions.includes('map_field_flip')) {
    for (const comparison of facts.comparisons) {
      const sel = comparison.left
      if (sel.kind !== 'call_arg_field') continue
      const arg = permitCtx.args[sel.index]
      if (arg?.type !== 'vec') continue
      const element = arg.value[sel.element]
      if (element?.type !== 'map' || !Array.isArray(element.value)) continue
      const entry = element.value.find((e) => e.key === sel.field)
      if (!entry) continue
      const flipped = flipFieldValue(entry.val)
      if (flipped === null) continue
      const ctx = cloneContext(permitCtx)
      const clonedVec = arg.value.map(cloneScVal)
      const clonedElement = clonedVec[sel.element]
      if (clonedElement?.type !== 'map' || !Array.isArray(clonedElement.value)) continue
      clonedElement.value = clonedElement.value.map((e) =>
        e.key === sel.field ? { key: e.key, val: flipped } : e
      )
      clonedVec[sel.element] = clonedElement
      ctx.args[sel.index] = { type: 'vec', value: clonedVec }
      denies.push({ dimension: 'map_field_flip', ctx })
    }
  }

  // vec_append: append a new element to a bound vec. OPT-IN only, never ORIGINAL.
  // Targets every `call_arg_len` leaf; without the length pin a caller can
  // append an extra element to defeat per-element binds. ---
  if (!dimensions || dimensions.includes('vec_append')) {
    for (const comparison of facts.comparisons) {
      const sel = comparison.left
      if (sel.kind !== 'call_arg_len') continue
      const arg = permitCtx.args[sel.index]
      if (arg?.type !== 'vec') continue
      const ctx = cloneContext(permitCtx)
      ctx.args[sel.index] = {
        type: 'vec',
        value: [...arg.value, { type: 'other', value: 'deny-case-vec-append' }],
      }
      denies.push({ dimension: 'vec_append', ctx })
    }
  }

  return { permit: cloneContext(permitCtx), denies }
}

function inspectPredicate(predicate: PredicateNode): PredicateFacts {
  const facts: PredicateFacts = { comparisons: [], memberships: [] }
  visit(predicate, facts)
  return facts
}

function visit(node: PredicateNode, facts: PredicateFacts): void {
  switch (node.op) {
    case 'and':
      for (const child of node.children) visit(child, facts)
      return
    case 'in':
      facts.memberships.push(node)
      return
    case 'eq':
    case 'lte':
      facts.comparisons.push(node)
  }
}

function differentVector(actual: ScVal | undefined): ScVal {
  if (actual?.type !== 'vec') return { type: 'vec', value: [] }
  if (actual.value.length === 0) {
    return { type: 'vec', value: [{ type: 'other', value: 'deny-case-extra-hop' }] }
  }
  if (actual.value.length > 1) {
    const reversed = actual.value.map(cloneScVal).reverse()
    if (JSON.stringify(reversed) !== JSON.stringify(actual.value)) {
      return { type: 'vec', value: reversed }
    }
  }
  const value = actual.value.map(cloneScVal)
  value[0] = { type: 'other', value: 'deny-case-different-hop' }
  return { type: 'vec', value }
}

function cloneContext(ctx: EvalContext): EvalContext {
  return {
    contract: ctx.contract,
    fn: ctx.fn,
    args: ctx.args.map(cloneScVal),
  }
}

/** Deep-copy an ScVal so a mutation cannot alias the recorded call.
 *  Exported so the permit-context builder shares this one implementation. */
export function cloneScVal(value: ScVal, depth = 0): ScVal {
  if (value.type === 'vec') {
    if (depth >= MAX_SCVAL_CLONE_DEPTH) {
      throw cloneDepthError(value)
    }
    return { type: 'vec', value: value.value.map((v) => cloneScVal(v, depth + 1)) }
  }
  return { ...value }
}

function cloneDepthError(value: ScVal): never {
  const err = new Error(
    `ScVal clone depth exceeds MAX_SCVAL_CLONE_DEPTH (${MAX_SCVAL_CLONE_DEPTH})`
  ) as Error & { code: string; severity: string; retryable: boolean; depthContext: unknown }
  err.code = 'SYNTHESIS_ERROR'
  err.severity = 'error'
  err.retryable = false
  err.depthContext = value.type
  throw err
}

/** Build a value of the SAME ScVal type that differs from the recorded one,
 *  used by the `map_field_flip` mutation to defeat a per-element pin without
 *  changing the wire type. Returns null when the ScVal type has no obvious
 *  different value (e.g. opaque/other). */
function flipFieldValue(val: ScVal): ScVal | null {
  switch (val.type) {
    case 'address': {
      const a = 'GBFKRGJYZXLTDEI36ZCQEIM225NMOCR2VDBOIHJTXJ54FEFFVL2FKALE'
      const b = 'GD6XSMQJ47EHHJOWXQOND5YDVZC37JWZJHYHBKE6QJFSLLJ5KQXM5QS5'
      return { type: 'address', value: val.value === a ? b : a }
    }
    case 'i128':
    case 'u32':
      return { type: val.type, value: String(BigInt(val.value) + 1n) }
    case 'symbol':
      return { type: 'symbol', value: `${val.value}x` }
    default:
      return null
  }
}
