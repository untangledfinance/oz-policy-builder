// src/adapters/interpreter/adapter.ts - the interpreter-policy CustodyAdapter.
//
// Compiles a PolicyIR to a single interpreter `PolicyDocument` + `PolicyRef`
// carrying the canonical predicate encoding from `predicate/encode.ts`. Second
// backend (the OZ built-in adapter is the first); the compose step (P3) routes
// IR constructs between them.
//
// Three fail-closed enforcement gates (per spec):
//   - an `in` allowlist (or a `compare eq` vs an address, or any value in an
//     `eq_seq`) that targets the smart account's own address throws
//     SCOPE_SELF_CALL.
//
// Anything the adapter genuinely cannot express (EVM calldata / value, unix
// expiry, etc.) is named in `uncovered` rather than silently dropped.

import type { ToolError } from '../../errors.ts'
import type {
  IRCompare,
  IRCondition,
  IRPolicyRule,
  IRScalarType,
  IRSelector,
  PolicyIR,
} from '../../ir/types.ts'
import { encodePredicate } from '../../predicate/encode.ts'
import type {
  ContextRuleDraft,
  Network,
  ParseConfidence,
  PolicyDocument,
  PolicyRef,
  PredicateLeaf,
  PredicateNode,
  ProposedPolicy,
  RecordedTransaction,
} from '../../types.ts'

/** [VERIFY] NOT a real deployed address. The interpreter is a per-network
 *  deploy artifact we do not have yet; install is a later phase. */
export const PLACEHOLDER_INTERPRETER_ADDRESS = 'VERIFY-interpreter-address'

export interface InterpreterAdapterConfig {
  network: Network
  /** Per-rule install nonce (first install = 1; replay-protected). */
  installNonce: number
  /** The smart account this interpreter policy will be installed against. Used
   *  by the self-call gate: any `in`-allowlist containing this address is
   *  rejected as `SCOPE_SELF_CALL`. */
  smartAccountAddress: string
}

/** What this backend can express. A construct needing a false flag is reported
 *  as `uncovered` by the adapter, never silently dropped. */
export interface CustodyCapabilities {
  supportsSpendWindow: boolean
  supportsTimeExpiry: boolean
  supportsThreshold: boolean
  supportsGeneralPredicate: boolean
}

/** The result of compiling a PolicyIR for this backend. */
export interface CompileResult {
  /** false => some IR construct this backend cannot express (see `uncovered`). */
  covered: boolean
  /** Human-readable list of unsupported constructs. */
  uncovered: string[]
  /** The installable policy, assembled when a rule lowered. */
  proposed?: ProposedPolicy
}

/** Result of a simulate() dry-run against the off-chain TS model. */
export interface SimulationResult {
  backend: 'ts-model'
  permitted: boolean | null
  evaluations: unknown[]
  notes: string[]
}

/** Compile a PolicyIR to an installable interpreter policy. */
export interface CustodyAdapter {
  readonly name: string
  readonly mode: 'enforce'
  capabilities(): CustodyCapabilities
  compile(ir: PolicyIR): CompileResult
  simulate(ir: PolicyIR, permitTx: RecordedTransaction): SimulationResult
  /** Canonical JSON of the IR (portability / audit). */
  export(ir: PolicyIR): string
}

const CAPABILITIES: CustodyCapabilities = {
  supportsSpendWindow: true,
  supportsThreshold: false, // thresholds are the OZ adapter's job
  // Expiry is via the context rule's validUntilLedger, not a predicate - the
  // interpreter refuses a `valid_until` leaf at install.
  supportsTimeExpiry: false,
  supportsGeneralPredicate: true,
}

/** Parse confidence for a deterministic (non-decoded) input: full (1.0). A
 *  mandate needs no decoding, so the gate is not applicable. */
const FULL_PARSE_CONFIDENCE: ParseConfidence = {
  overall: 1,
  knownContracts: [],
  unknownContracts: [],
  opaqueScVals: [],
  thresholdUsed: 1,
}

export function createInterpreterAdapter(config: InterpreterAdapterConfig): CustodyAdapter {
  return {
    name: 'interpreter',
    mode: 'enforce',
    capabilities: () => ({ ...CAPABILITIES }),
    compile: (ir) => compile(ir, config),
    simulate: () => simulateStub(),
    export: (ir) => canonicalStringify(ir),
  }
}

/** Lower a single IR rule to the canonical pre-encoding `PredicateNode`. The
 *  orchestrator uses this to wire the self-verify + minimise pipeline: after
 *  `compile(ir)` succeeds it re-derives the PredicateNode via this helper to
 *  drive `minimize` and `runHarness` on the SAME shape the encoder saw. Pure
 *  and deterministic: same `rule + config` -> byte-identical PredicateNode.
 *  The `uncovered` list is NOT re-derived - callers needing it must use
 *  `compile(ir)`. */
export function lowerRuleToPredicate(
  rule: IRPolicyRule,
  config: InterpreterAdapterConfig
): PredicateNode {
  return lowerRule(rule, config).predicate
}

function compile(ir: PolicyIR, config: InterpreterAdapterConfig): CompileResult {
  const firstRule = ir.rules[0]
  if (!firstRule) {
    return { covered: false, uncovered: ['empty PolicyIR (no rules to compile)'] }
  }
  if (ir.rules.length > 1) {
    return {
      covered: false,
      uncovered: [
        `multi-rule PolicyIR: ${ir.rules.length - 1} rule(s) beyond the first are not compiled (the interpreter adapter handles one rule per document in this slice)`,
      ],
    }
  }

  const lowered = lowerRule(firstRule, config)
  if (lowered.uncovered.length > 0) {
    return { covered: false, uncovered: lowered.uncovered }
  }

  const { encodedPredicate, predicateHash } = encodePredicate(lowered.predicate)
  const policyDocument: PolicyDocument = {
    grammarVersion: 2,
    installNonce: config.installNonce,
    encodedPredicate,
    predicateHash,
  }
  const policyRef: PolicyRef = {
    kind: 'interpreter',
    interpreterAddress: PLACEHOLDER_INTERPRETER_ADDRESS,
    predicateBlobBase64: encodedPredicate,
  }
  const proposed: ProposedPolicy = {
    contextRule: lowered.contextRule,
    policyDocuments: [policyDocument],
    policyRefs: [policyRef],
    parseConfidence: { ...FULL_PARSE_CONFIDENCE },
    warnings: [],
    ambiguities: [],
  }
  return { covered: true, uncovered: [], proposed }
}

interface LoweredRule {
  predicate: PredicateNode
  contextRule: ContextRuleDraft
  uncovered: string[]
}

function lowerRule(rule: IRPolicyRule, config: InterpreterAdapterConfig): LoweredRule {
  const uncovered: string[] = []

  // scope -> context rule + sibling predicates. contract/method each become
  // their own `eq` leaf and are merged into the top-level `and` alongside the
  // constraints. The top-level MUST be `and` for canonical hash stability.
  const scopeContract: string | undefined = rule.scope.contract
  const scopeMethod: string | undefined = rule.scope.method
  if (rule.scope.chainId !== undefined) {
    uncovered.push(
      `chainId \`${rule.scope.chainId}\` not bindable by the interpreter adapter (network is per-context, not per-rule)`
    )
  }

  if (rule.roles.length > 0) {
    uncovered.push(
      `roles [${rule.roles.join(', ')}] dropped (role-to-signer mapping is a later phase; interpreter policies reference addresses, not role names)`
    )
  }

  if (rule.guard) {
    uncovered.push(
      `guard: ${describeCondition(rule.guard)} (interpreter adapter currently treats guards as uncovered)`
    )
  }

  // expiry -> context rule validUntilLedger only. The interpreter has no
  // expiry selector of its own, and the IR contract already says "OZ context
  // rules expire by ledger sequence", so a unix-timestamp expiry is Path-B and
  // both adapters keep one expiry model.
  let validUntilLedger: number | null = null
  if (rule.expiry) {
    if (rule.expiry.validUntilLedger !== undefined) {
      validUntilLedger = rule.expiry.validUntilLedger
    } else if (rule.expiry.validUntilUnixSeconds !== undefined) {
      uncovered.push(
        'time expiry given as a unix timestamp (interpreter adapter currently lowers expiry only via the OZ context-rule validUntilLedger; supply expiry.validUntilLedger)'
      )
    }
  }

  // approval is the OZ adapter's job (it lowers to simple_threshold /
  // weighted_threshold primitives). Surface it here so a caller that drops it
  // through to the interpreter adapter sees an explicit uncovered entry
  // instead of a silently-dropped M-of-N gate.
  if (rule.approval) {
    uncovered.push(
      `approval threshold ${rule.approval.threshold} not emitted by the interpreter adapter (thresholds lower to OZ built-in primitives in the OZ adapter)`
    )
  }

  // Pre-scan constraints: anything the interpreter adapter cannot express is
  // named in `uncovered` and skipped from the predicate lowering. We surface
  // these BEFORE lowering so the predicate is built from only the
  // expressible subset.
  const expressibleConstraints: IRCondition[] = []
  for (const c of rule.constraints) {
    const unsupp = unsupportedConstruct(c)
    if (unsupp !== null) {
      uncovered.push(unsupp)
    } else {
      expressibleConstraints.push(c)
    }
  }

  // Build the top-level `and` of scope + expressible constraints. The
  // top-level MUST be `and` for canonical hash stability.
  const topChildren: PredicateNode[] = []
  if (scopeContract !== undefined) {
    topChildren.push({
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: scopeContract },
    })
  }
  if (scopeMethod !== undefined) {
    topChildren.push({
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: scopeMethod },
    })
  }
  for (const c of expressibleConstraints) {
    topChildren.push(lowerCondition(c, config))
  }

  const predicate: PredicateNode =
    topChildren.length === 1 && topChildren[0] !== undefined
      ? topChildren[0]
      : { op: 'and', children: topChildren }

  // Scope the context rule to the contract when the IR names one, matching
  // what OZ's CallContract scoping did. A `default` rule would route EVERY
  // call through this policy instead of only calls to the scoped contract.
  const contextRule: ContextRuleDraft = {
    contextRuleType:
      scopeContract !== undefined
        ? { kind: 'call_contract', contract: scopeContract }
        : { kind: 'default' },
    name: 'interpreter',
    validUntilLedger,
    signers: [],
    policies: [],
  }

  return { predicate, contextRule, uncovered }
}

/** Detect IR constructs the interpreter adapter cannot express; return a
 *  human-readable descriptor (or null if the construct IS expressible). Used
 *  by `lowerRule` to populate `uncovered` before lowering. */
function unsupportedConstruct(cond: IRCondition): string | null {
  switch (cond.op) {
    case 'in':
      return (
        unsourceableSelector(cond.selector) ??
        (cond.selector.kind === 'calldata' || cond.selector.kind === 'value'
          ? `EVM \`${cond.selector.kind}\` selector on allowlist (predicate DSL)`
          : null)
      )
    case 'eq_seq':
      return (
        unsourceableSelector(cond.selector) ??
        (cond.selector.kind === 'calldata' || cond.selector.kind === 'value'
          ? `EVM \`${cond.selector.kind}\` selector on ordered-sequence equality (predicate DSL)`
          : null)
      )
    case 'compare': {
      const s = cond.compare.selector
      if (s.kind === 'calldata') return 'EVM calldata comparison (predicate DSL)'
      if (s.kind === 'value') return 'tx.value comparison (predicate DSL)'
      // The on-chain interpreter sees ONE authorized call - no
      // `Context.sub_invocations` in v1 - so it cannot observe token
      // movements. `amount` has no value to read, and `window_spent`
      // accumulates BY that amount, so its counter would never move.
      // Deriving either from the call payload would quietly swap "value
      // actually moved" for "value the caller declared" - a weaker guarantee
      // than the review card would be claiming.
      //
      // Rolling spend caps belong to the OZ `spending_limit` primitive (already
      // audited, emitted by the OZ adapter). A per-call cap is expressible here
      // as `arg_field`.
      return unsourceableSelector(s)
    }
    // Recurse: a nested `and`/`or`/`not` must not smuggle a selector past the
    // pre-scan, which only sees top-level constraints.
    case 'and':
      return cond.children.map(unsupportedConstruct).find((u) => u !== null) ?? null
    case 'or':
      return cond.children.map(unsupportedConstruct).find((u) => u !== null) ?? null
    case 'not':
      return unsupportedConstruct(cond.child)
  }
}

/** Selectors whose value the on-chain interpreter has no way to obtain. */
function unsourceableSelector(s: IRSelector): string | null {
  if (s.kind === 'amount') {
    return `per-call amount comparison on ${s.token} - the interpreter cannot observe token movements; express a per-call cap with arg_field, or a rolling cap with the OZ spending_limit primitive`
  }
  if (s.kind === 'window_spent') {
    return `rolling spend cap on ${s.token} over ${s.windowSeconds}s - not enforceable by the interpreter; use the OZ spending_limit primitive, or bound the per-call value with arg_field`
  }
  if (s.kind === 'valid_until') {
    return 'expiry comparison - the interpreter has no `valid_until` selector; expiry belongs to the context rule (expiry.validUntilLedger)'
  }
  return null
}

/** Lower one IR condition to a PredicateNode.
 *  the self-call rule (`in` allowlist / `compare eq` vs the smart account
 *  address -> SCOPE_SELF_CALL). */
function lowerCondition(cond: IRCondition, config: InterpreterAdapterConfig): PredicateNode {
  switch (cond.op) {
    case 'and':
      return { op: 'and', children: cond.children.map((c) => lowerCondition(c, config)) }
    case 'or':
      return { op: 'or', children: cond.children.map((c) => lowerCondition(c, config)) }
    case 'not':
      return { op: 'not', child: lowerCondition(cond.child, config) }
    case 'in': {
      for (const v of cond.values) {
        assertNotSelfCallAddress(v, config)
      }
      // `in` is PURE set membership; the encoder sorts the haystack. An exact
      // ordered sequence (e.g. swap hop path) is expressed as `eq_seq` and
      // lowers to `eq(selector, literal_vec)` instead - never to `in` with an
      // `ordered` flag.
      return {
        op: 'in',
        needle: lowerSelector(cond.selector),
        haystack: cond.values.map((v) => literalFromScalar(v, selectorScalarType(cond.selector))),
      }
    }
    case 'eq_seq': {
      for (const v of cond.values) {
        assertNotSelfCallAddress(v, config)
      }
      // Exact ordered sequence equality: the right-hand side is a literal_vec
      // whose element order is preserved verbatim by the encoder. `eq` does
      // deep equality at evaluate time - this is the ONLY way to express an
      // exact ordered sequence in the predicate grammar (the path of a swap).
      return {
        op: 'eq',
        left: lowerSelector(cond.selector),
        right: {
          kind: 'literal_vec',
          elements: cond.values.map((v) => literalFromScalar(v, selectorScalarType(cond.selector))),
        },
      }
    }
    case 'compare': {
      // Self-call on an address eq.
      if (
        cond.compare.operator === 'eq' &&
        cond.compare.selector.kind === 'arg' &&
        cond.compare.selector.scalarType === 'address'
      ) {
        assertNotSelfCallAddress(cond.compare.value, config)
      }
      return {
        op: cond.compare.operator,
        left: lowerSelector(cond.compare.selector),
        right: literalFromIRCompare(cond.compare),
      }
    }
  }
}

/** Lower an IR selector to the matching PredicateLeaf. */
function lowerSelector(s: IRSelector): PredicateLeaf {
  switch (s.kind) {
    case 'arg':
      return { kind: 'call_arg', index: s.argIndex }
    case 'arg_len':
      return { kind: 'call_arg_len', index: s.argIndex }
    case 'arg_field':
      return { kind: 'call_arg_field', index: s.argIndex, element: s.element, field: s.field }
    // `amount` / `window_spent` / `valid_until` are filtered out by
    // `unsupportedConstruct` before lowering - the interpreter can source
    // none of them on chain. Reaching here means the pre-scan was bypassed;
    // fail loudly rather than emit a leaf the contract will refuse.
    case 'amount':
    case 'window_spent':
    case 'valid_until':
      throw new Error(
        `interpreter adapter cannot lower \`${s.kind}\`: it should have been reported as uncovered`
      )
    case 'now':
      return { kind: 'now' }
    case 'calldata':
    case 'value':
      // Unreachable: the caller flagged these as Path-B before reaching here.
      throw toolError(
        'SYNTHESIS_ERROR',
        `selector kind \`${s.kind}\` is not lowerable to a predicate leaf`
      )
  }
}

/** Build a literal leaf from the right-hand side of an IRCompare, mapping the
 *  selector kind to the matching `literal_*` kind. The IR compare value is a
 *  raw string (i128-safe); the selector kind fixes the canonical wire type:
 *    - arg       -> IR scalarType (set by the recorder/parser)
 *    - arg_len   -> u32 (vec length is a small non-negative integer)
 *    - arg_field -> IR scalarType (the field's recorded type)
 *    - amount    -> i128 (canonical Stellar token amount encoding)
 *    - window_spent -> i128 (canonical amount encoding)
 *    - invocation_count -> u32 (counts are small non-negative integers)
 *    - now / valid_until -> u64 (unix timestamps in seconds) */
function literalFromIRCompare(c: IRCompare): PredicateLeaf {
  const scalarType: IRScalarType = selectorScalarType(c.selector)
  return literalFromScalar(c.value, scalarType)
}

function literalScalarForSelector(kind: IRSelector['kind']): IRScalarType {
  switch (kind) {
    case 'amount':
    case 'window_spent':
      return 'i128'
    case 'arg_len':
      return 'u32'
    case 'now':
    case 'valid_until':
      return 'u64'
    case 'arg':
    case 'arg_field':
    case 'calldata':
    case 'value':
      // arg / arg_field -> caller handles scalarType; calldata/value -> unreachable (Path-B).
      return 'i128'
  }
}

/** Build a literal leaf from a raw string value + an IRScalarType hint. */
function literalFromScalar(value: string, scalarType: IRScalarType): PredicateLeaf {
  switch (scalarType) {
    case 'address':
      return { kind: 'literal_address', value }
    case 'i128':
    case 'u128':
      return { kind: 'literal_i128', value }
    case 'u32':
      return { kind: 'literal_u32', value: Number.parseInt(value, 10) }
    case 'u64':
    case 'i64':
      return { kind: 'literal_u64', value }
    case 'symbol':
      return { kind: 'literal_symbol', value }
    case 'bytes':
      return { kind: 'literal_bytes', value }
    case 'bool':
      throw toolError(
        'MALFORMED_PREDICATE',
        `boolean literal not supported in v1 predicate grammar`
      )
  }
}

/** Scalar type of an IRSelector for the purpose of building literal leaves
 *  (the right-hand side of `eq` / elements of an `in` haystack / elements of
 *  a `literal_vec`). Mirrors `literalScalarForSelector` for OZ extensions and
 *  uses the selector's own `scalarType` for `arg` and `arg_field` selectors. */
function selectorScalarType(selector: IRSelector): IRScalarType {
  if (selector.kind === 'arg') return selector.scalarType
  if (selector.kind === 'arg_field') return selector.scalarType
  return literalScalarForSelector(selector.kind)
}

/** Reject a value that targets the smart account's own address (a self-call
 *  is a structural privilege-escalation hole the interpreter forbids). */
function assertNotSelfCallAddress(value: string, config: InterpreterAdapterConfig): void {
  if (value === config.smartAccountAddress) {
    throw toolError(
      'SCOPE_SELF_CALL',
      `value \`${value}\` is the smart account's own address (self-call in an allowlist / compare is rejected)`
    )
  }
}

/** Human-readable descriptor for a construct the interpreter adapter cannot
 *  express. Mirrors the OZ adapter's `describeCondition` for parity. */
function describeCondition(cond: IRCondition): string {
  switch (cond.op) {
    case 'in':
      return `value allowlist on ${describeSelector(cond.selector)} (predicate DSL)`
    case 'eq_seq':
      return `exact ordered sequence on ${describeSelector(cond.selector)} (predicate DSL)`
    case 'not':
      return 'negated condition (predicate DSL)'
    case 'and':
    case 'or':
      return `nested ${cond.op} condition (predicate DSL)`
    case 'compare': {
      const s = cond.compare.selector
      switch (s.kind) {
        case 'window_spent':
          return `spend-window comparison with operator '${cond.compare.operator}'`
        case 'amount':
          return `per-call amount comparison on ${s.token}`
        case 'arg':
          return `argument comparison on arg ${s.argIndex}`
        case 'arg_len':
          return `vec length comparison on arg ${s.argIndex}`
        case 'arg_field':
          return `map field comparison on arg ${s.argIndex}.${s.field}`
        case 'calldata':
          return 'EVM calldata comparison'
        case 'value':
          return 'tx.value comparison'
        case 'now':
        case 'valid_until':
          return 'time comparison'
      }
    }
  }
}

function describeSelector(s: IRSelector): string {
  switch (s.kind) {
    case 'arg':
      return `arg ${s.argIndex}`
    case 'arg_len':
      return `arg_len(${s.argIndex})`
    case 'arg_field':
      return `arg_field(${s.argIndex}, ${s.element}, ${s.field})`
    case 'amount':
      return `amount(${s.token})`
    case 'window_spent':
      return `window_spent(${s.token})`
    case 'calldata':
      return `calldata[${s.offset}:${s.offset + s.length}]`
    default:
      return s.kind
  }
}

function simulateStub(): SimulationResult {
  return {
    backend: 'ts-model',
    permitted: null,
    evaluations: [],
    notes: ['stub: real permit/deny semantics wiring is a later phase'],
  }
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

/** Build a synthetic Error carrying the ToolError code/severity/retryable
 *  fields the existing ToolError shape uses (the encoder pattern). Callers
 *  inspect `e.code` in catch blocks. */
function toolError(code: ToolError['code'], message: string): Error {
  const err = new Error(message) as Error & {
    code: ToolError['code']
    severity: ToolError['severity']
    retryable: boolean
  }
  err.code = code
  err.severity = 'error'
  err.retryable = false
  return err
}
