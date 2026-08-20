import type { PredicateLeaf, PredicateNode, ScVal } from '../types.ts'
import { MAX_SCVAL_CLONE_DEPTH } from '../types.ts'
import type { EvalContext } from './evaluate.ts'
import { literalNumericBigInt } from './predicate-literals.ts'

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

type ComparisonOperator = 'eq' | 'lt' | 'lte' | 'gt' | 'gte'

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
const ADJACENT_ASSETS = [
  'CAS3J7GYLGXMF6TDJ5WQ2PEN4GRVNXJUIQ2TZU3ZB3OQ2V4DRCWI7WPF',
  'CCWCLTASNDT57N3BCHOSVB5QWMV5URK4BXLDDF6ZZQYMBQ4OKZA3ZB2N',
] as const

// Property-harness mutation dimensions excluded from the synth pipeline's
// self-verify call so existing fixtures still emit policies. The harness tests
// them as FINDINGS against the already-emitted policy.
const OVERPERMISSIVE_DIMENSIONS = ['argument_reorder'] as const

// The dimensions the synth pipeline uses for self-verify and minimise. No count
// is written here on purpose: this comment said 15 while the array held 17, and
// anyone checking the number should read the array rather than the prose.
// Phase 1 grammar extension: `vec_append` and `map_field_flip` are listed below
// alongside the existing dimensions so the per-element binds emitted for
// Blend `submit` (call_arg_len + 3 call_arg_field per element) survive
// minimise. Without these, no deny case exercises the new leaves and the
// minimise pass drops them as "redundant" - reopening the element-append
// hole they were added to close. Both dimensions are no-ops for any fixture
// whose predicate has no `call_arg_len` / `call_arg_field` leaves (the
// generator short-circuits on leaf-kind), so they cannot make production
// synthesis refuse for fixtures that do not exercise the new grammar.
const ORIGINAL_DIMENSIONS: string[] = [
  'amount',
  'asset',
  'contract',
  'function',
  'timing',
  'time_window',
  'invocation_count',
  'arg_amount_bound',
  'arg_bound',
  'scope_contract_fn_arg',
  'soroswap_allowed_path',
  'vec_append',
  'map_field_flip',
]

export { ORIGINAL_DIMENSIONS, OVERPERMISSIVE_DIMENSIONS }

/** Build deterministic model-evaluated alternatives without mutating the intended call.
 *
 * @param predicate   - the synthesized predicate
 * @param permitCtx   - EvalContext for the intended (permitted) call
 * @param dimensions  - optional whitelist of dimension names to emit; when omitted
 *                     all known dimensions (including over-permissiveness mutations)
 *                     are emitted. The synth pipeline passes ORIGINAL_DIMENSIONS so
 *                     existing fixtures do not regress. */
export function generateCases(
  predicate: PredicateNode,
  permitCtx: EvalContext,
  dimensions?: string[]
): GeneratedCases {
  const facts = inspectPredicate(predicate)
  const denies: DenyCase[] = []

  for (const comparison of facts.comparisons) {
    if (comparison.left.kind !== 'amount') continue
    const mutated = mutateBigIntRecord(
      permitCtx,
      'amountByToken',
      comparison.left.token,
      comparison
    )
    if (mutated) denies.push({ dimension: 'amount', ctx: mutated, expectedReason: 'AMOUNT_BOUND' })
  }

  const movedTokens = new Set<string>()
  for (const comparison of facts.comparisons) {
    if (comparison.left.kind === 'amount' || comparison.left.kind === 'window_spent') {
      movedTokens.add(comparison.left.token)
    }
  }
  for (const token of movedTokens) {
    // The `asset` deny case mutates BOTH the amount record AND the contract
    // binding (token's value moved to an adjacent asset; the same swap applied
    // to any address-typed `call_arg` / `call_contract` literal). The actual
    // deny reason is therefore predicate-dependent - the order of evaluation
    // is CONTRACT_SCOPE (step 3) before AMOUNT_BOUND (step 6), so a policy
    // that has both bindings denies with CONTRACT_SCOPE, while a policy with
    // only an amount binding denies with AMOUNT_BOUND. The reason assertion
    // would be brittle here; the boolean decision is what we strictly need
    // to pin. Leave `expectedReason` unset for this dimension.
    denies.push({ dimension: 'asset', ctx: mutateAsset(predicate, permitCtx, token) })
  }

  const contractConstraints = [
    ...facts.comparisons.filter(
      (node) =>
        node.op === 'eq' &&
        node.left.kind === 'call_contract' &&
        node.right.kind === 'literal_address'
    ),
    ...facts.memberships.filter((node) => node.needle.kind === 'call_contract'),
  ]
  for (const _constraint of contractConstraints) {
    const ctx = cloneContext(permitCtx)
    ctx.contract = distinctText(permitCtx.contract, 'contract')
    denies.push({ dimension: 'contract', ctx, expectedReason: 'CONTRACT_SCOPE' })
  }

  const functionConstraints = [
    ...facts.comparisons.filter(
      (node) =>
        node.op === 'eq' && node.left.kind === 'call_fn' && node.right.kind === 'literal_symbol'
    ),
    ...facts.memberships.filter((node) => node.needle.kind === 'call_fn'),
  ]
  for (const _constraint of functionConstraints) {
    const ctx = cloneContext(permitCtx)
    ctx.fn = distinctText(permitCtx.fn, 'function')
    denies.push({ dimension: 'function', ctx, expectedReason: 'FN_MISMATCH' })
  }

  if (permitCtx.validUntilLedger !== undefined) {
    const ctx = cloneContext(permitCtx)
    ctx.atLedger = permitCtx.validUntilLedger + 1
    denies.push({ dimension: 'timing', ctx, expectedReason: 'EXPIRED' })
  }

  for (const comparison of facts.comparisons) {
    if (comparison.left.kind !== 'window_spent') continue
    const mutated = mutateBigIntRecord(
      permitCtx,
      'windowSpentByToken',
      comparison.left.token,
      comparison,
      false
    )
    if (mutated)
      denies.push({ dimension: 'time_window', ctx: mutated, expectedReason: 'AMOUNT_BOUND' })
  }

  for (const comparison of facts.comparisons) {
    if (comparison.left.kind !== 'invocation_count_in_window') continue
    if (comparison.right.kind !== 'literal_u32') continue
    const ctx = cloneContext(permitCtx)
    ctx.invocationCountByWindow[comparison.left.windowSecs] = violatingNumber(
      comparison.op,
      comparison.right.value
    )
    denies.push({ dimension: 'invocation_count', ctx, expectedReason: 'FREQUENCY' })
  }

  // Ordered numeric bound on a call_arg (e.g. a SoroSwap input-amount cap
  // `call_arg[0] <= limit`). A violating deny case pushes the arg past the
  // bound so the leaf is exercised - and, critically, so `minimize` keeps it:
  // a conjunct that no deny case needs is pruned as redundant, which would
  // silently drop a caller-requested restriction.
  for (const comparison of facts.comparisons) {
    if (comparison.op === 'eq' || comparison.left.kind !== 'call_arg') continue
    const violating = violatingArgScVal(comparison.op, comparison.right)
    if (!violating) continue
    const ctx = cloneContext(permitCtx)
    ctx.args[comparison.left.index] = violating
    denies.push({ dimension: 'arg_amount_bound', ctx, expectedReason: 'ARG_MISMATCH' })
  }

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
    // The `arg_bound` case sets the arg to an opaque ScVal. The deny reason
    // depends on the predicate shape:
    //   - an `eq(call_arg[i], literal)` denies with ARG_MISMATCH
    //   - an `in(call_arg[i], [literals])` denies with NOT_IN_ALLOWLIST
    //     (opaque needles fail-closed at the `in` membership gate, step 5)
    // Both are correct in the TS evaluator; the reason is predicate-dependent
    // so we cannot pin a single canonical reason here. The boolean decision
    // is what we strictly need to assert; the reason is recorded (not asserted)
    // when the harness runs this case.
    denies.push({ dimension: 'arg_bound', ctx })
  }

  const scopedArgumentIndices = new Set<number>(argumentConstraints.map(({ index }) => index))
  for (const comparison of facts.comparisons) {
    if (
      comparison.op === 'eq' &&
      comparison.left.kind === 'call_arg' &&
      comparison.right.kind === 'literal_vec'
    ) {
      scopedArgumentIndices.add(comparison.left.index)
    }
  }
  if (
    contractConstraints.length > 0 &&
    functionConstraints.length > 0 &&
    scopedArgumentIndices.size > 0
  ) {
    const ctx = cloneContext(permitCtx)
    ctx.contract = distinctText(permitCtx.contract, 'authorized-call-contract')
    ctx.fn = distinctText(permitCtx.fn, 'authorized-call-function')
    for (const index of scopedArgumentIndices) {
      ctx.args[index] = { type: 'other', value: 'deny-case-authorized-call-argument' }
    }
    // `scope_contract_fn_arg` changes contract, fn, AND args simultaneously.
    // The first failing child of the AND decides the reason, and the contract
    // check (step 3) does fire first in the evaluator. The reason is therefore
    // CONTRACT_SCOPE for the canonical case, but a predicate that lists the
    // call_fn leaf first (or that has a `call_arg_field` for that arg index)
    // can flip the order. Pin the assertion here only when no `in` /
    // call_arg_field binds the same arg index exist - the canonical blend
    // case does have those binds, so the assertion would fire there.
    denies.push({ dimension: 'scope_contract_fn_arg', ctx })
  }

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

  // --- argument_reorder: swap first two address args ---
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

  // --- map_field_flip: flip a bound map field to a different valid value of
  // the same type. Mirrors argument_reorder: OPT-IN only, never ORIGINAL.
  // Targets each `call_arg_field` leaf and produces a ctx whose vec element
  // has a different value of the recorded field (different request_type,
  // different amount, different address). The blend-submit case uses this
  // to detect a missing request_type pin. ---
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

  // --- vec_append: append a new element to a bound vec. Mirrors map_field_flip:
  // OPT-IN only, never ORIGINAL. Targets every `call_arg_len` leaf; without the
  // length pin a caller can append an extra element to defeat per-element binds. ---
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

  // Version mismatch, malformed predicates, master authorization, and nonce replay are install-time checks and are intentionally omitted from model-evaluated cases.
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
    case 'or':
      for (const child of node.children) visit(child, facts)
      return
    case 'not':
      visit(node.child, facts)
      return
    case 'in':
      facts.memberships.push(node)
      return
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      facts.comparisons.push(node)
  }
}

function mutateBigIntRecord(
  permitCtx: EvalContext,
  recordKey: 'amountByToken' | 'windowSpentByToken',
  token: string,
  comparison: ComparisonNode,
  preferScaledAmount = true
): EvalContext | null {
  if (comparison.right.kind !== 'literal_i128') return null

  try {
    const current = BigInt(permitCtx[recordKey][token] ?? '0')
    const bound = BigInt(comparison.right.value)
    const value = violatingBigInt(comparison.op, current, bound, preferScaledAmount)
    const ctx = cloneContext(permitCtx)
    ctx[recordKey][token] = value.toString()
    return ctx
  } catch {
    return null
  }
}

function violatingBigInt(
  op: ComparisonOperator,
  current: bigint,
  bound: bigint,
  preferScaledAmount: boolean
): bigint {
  if (preferScaledAmount) {
    const scaledCandidates = [(current * 101n) / 100n, current * 10n]
    for (const candidate of scaledCandidates) {
      if (!bigIntComparison(op, candidate, bound)) return candidate
    }
  }

  return boundaryViolatingBigInt(op, bound)
}

/** The single value at the boundary that violates `<selector> op bound`:
 *  bound+1 for `lte`/`eq`, bound-1 for `gte`, and bound itself for the strict
 *  `lt`/`gt`. */
function boundaryViolatingBigInt(op: ComparisonOperator, bound: bigint): bigint {
  switch (op) {
    case 'lt':
    case 'gt':
      return bound
    case 'lte':
    case 'eq':
      return bound + 1n
    case 'gte':
      return bound - 1n
  }
}

function violatingNumber(op: ComparisonOperator, bound: number): number {
  switch (op) {
    case 'lt':
    case 'gt':
      return bound
    case 'lte':
    case 'eq':
      return bound + 1
    case 'gte':
      return bound - 1
  }
}

/** Build an ScVal that VIOLATES an ordered numeric bound on a call_arg, given
 *  the comparison op and its numeric-literal right-hand side. Returns null when
 *  the literal is not an integer (the bound is not a numeric compare). The arg
 *  is emitted as an i128 - the recorder's numeric args are read via BigInt, so
 *  the wire type only needs to be a numeric ScVal to exercise the bound. */
function violatingArgScVal(op: ComparisonOperator, right: PredicateLeaf): ScVal | null {
  const bound = literalNumericBigInt(right)
  if (bound === null) return null
  return { type: 'i128', value: boundaryViolatingBigInt(op, bound).toString() }
}

function bigIntComparison(op: ComparisonOperator, value: bigint, bound: bigint): boolean {
  switch (op) {
    case 'eq':
      return value === bound
    case 'lt':
      return value < bound
    case 'lte':
      return value <= bound
    case 'gt':
      return value > bound
    case 'gte':
      return value >= bound
  }
}

function mutateAsset(predicate: PredicateNode, permitCtx: EvalContext, token: string): EvalContext {
  const binding = findAddressBinding(predicate, token)
  const adjacent = adjacentAsset(token)
  const ctx = cloneContext(permitCtx)
  moveRecordEntry(ctx.amountByToken, token, adjacent)
  moveRecordEntry(ctx.windowSpentByToken, token, adjacent)
  if (binding.contract && ctx.contract === token) ctx.contract = adjacent
  for (const index of binding.argumentIndices) {
    const value = ctx.args[index]
    if (value) ctx.args[index] = replaceAddress(value, token, adjacent)
  }
  return ctx
}

function findAddressBinding(
  predicate: PredicateNode,
  address: string
): { contract: boolean; argumentIndices: Set<number> } {
  const facts = inspectPredicate(predicate)
  let contract = false
  const argumentIndices = new Set<number>()

  for (const comparison of facts.comparisons) {
    if (comparison.op !== 'eq' || !leafContainsAddress(comparison.right, address)) continue
    if (comparison.left.kind === 'call_contract') contract = true
    if (comparison.left.kind === 'call_arg') argumentIndices.add(comparison.left.index)
  }
  for (const membership of facts.memberships) {
    if (!membership.haystack.some((leaf) => leafContainsAddress(leaf, address))) continue
    if (membership.needle.kind === 'call_contract') contract = true
    if (membership.needle.kind === 'call_arg') argumentIndices.add(membership.needle.index)
  }

  return { contract, argumentIndices }
}

function leafContainsAddress(leaf: PredicateLeaf, address: string): boolean {
  if (leaf.kind === 'literal_address') return leaf.value === address
  if (leaf.kind === 'literal_vec') {
    return leaf.elements.some((element) => leafContainsAddress(element, address))
  }
  return false
}

function moveRecordEntry(record: Record<string, string>, from: string, to: string): void {
  const value = record[from]
  if (value === undefined) return
  delete record[from]
  record[to] = value
}

function replaceAddress(value: ScVal, from: string, to: string): ScVal {
  if (value.type === 'address') {
    return value.value === from ? { type: 'address', value: to } : { ...value }
  }
  if (value.type === 'vec') {
    return { type: 'vec', value: value.value.map((item) => replaceAddress(item, from, to)) }
  }
  return { ...value }
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

function adjacentAsset(asset: string): string {
  return asset === ADJACENT_ASSETS[0] ? ADJACENT_ASSETS[1] : ADJACENT_ASSETS[0]
}

function distinctText(value: string, label: string): string {
  return `${value}#${label}`
}

function cloneContext(ctx: EvalContext): EvalContext {
  const cloned: EvalContext = {
    contract: ctx.contract,
    fn: ctx.fn,
    args: ctx.args.map(cloneScVal),
    atLedger: ctx.atLedger,
    nowSeconds: ctx.nowSeconds,
    amountByToken: { ...ctx.amountByToken },
    windowSpentByToken: { ...ctx.windowSpentByToken },
    invocationCountByWindow: { ...ctx.invocationCountByWindow },
  }
  if (ctx.validUntilLedger !== undefined) cloned.validUntilLedger = ctx.validUntilLedger
  if (ctx.signerWeights !== undefined) cloned.signerWeights = { ...ctx.signerWeights }
  return cloned
}

/** Deep-copy an ScVal so a mutation cannot alias the recorded call.
 *  Exported so the permit-context builder shares this one implementation. */
export function cloneScVal(value: ScVal, depth = 0): ScVal {
  // Recursion is bounded by MAX_SCVAL_CLONE_DEPTH so a hand-crafted nested-vec
  // payload cannot RangeError the JS stack during deny-case mutation. Over-depth
  // throws a ToolError-shaped error that the `synthesizeFromRecording` envelope
  // (item 3) converts to a structured `{ok:false, error}`.
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
 *  changing the wire type (a type/arity change is rejected by host dispatch
 *  before Policy::enforce, so it is not the predicate's job). Returns null
 *  when the ScVal type has no obvious different value (e.g. opaque/other). */
function flipFieldValue(val: ScVal): ScVal | null {
  switch (val.type) {
    case 'address': {
      const a = 'GBFKRGJYZXLTDEI36ZCQEIM225NMOCR2VDBOIHJTXJ54FEFFVL2FKALE'
      const b = 'GD6XSMQJ47EHHJOWXQOND5YDVZC37JWZJHYHBKE6QJFSLLJ5KQXM5QS5'
      return { type: 'address', value: val.value === a ? b : a }
    }
    case 'i128':
    case 'u64':
    case 'u32':
      return { type: val.type, value: String(BigInt(val.value) + 1n) }
    case 'symbol':
      return { type: 'symbol', value: `${val.value}x` }
    default:
      return null
  }
}
