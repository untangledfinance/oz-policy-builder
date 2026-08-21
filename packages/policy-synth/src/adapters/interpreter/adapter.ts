// src/adapters/interpreter/adapter.ts - the interpreter-policy CustodyAdapter.
//
// Compiles a PolicyIR to a single interpreter `PolicyDocument` + `PolicyRef`
// carrying the canonical predicate encoding from `predicate/encode.ts`. This is
// the only backend; the compose step lowers every constraint to it.
//
// Three fail-closed enforcement gates (per spec):
//   - an `in` allowlist (or a `compare eq` vs an address, or any value in an
//     `eq_seq`) that targets the smart account's own address throws
//     SCOPE_SELF_CALL.
//
// Anything the adapter genuinely cannot express (EVM calldata / value, unix
// expiry, etc.) is named in `uncovered` rather than silently dropped.

import type { ToolError } from '../../errors.ts'
import { encodePredicate } from '../../predicate/encode.ts'
import type { ComposedRule } from '../../synth/compose-from-recording.ts'
import {
  type ContextRuleDraft,
  GRAMMAR_VERSION,
  type Network,
  type ParseConfidence,
  type PolicyDocument,
  type PolicyRef,
  type PredicateLeaf,
  type PredicateNode,
  type ProposedPolicy,
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

/** The result of compiling a PolicyIR for this backend. */
export interface CompileResult {
  /** false => some IR construct this backend cannot express (see `uncovered`). */
  covered: boolean
  /** Human-readable list of unsupported constructs. */
  uncovered: string[]
  /** The installable policy, assembled when a rule lowered. */
  proposed?: ProposedPolicy
}

/** Parse confidence for a deterministic (non-decoded) input: full (1.0). An
 *  input that needs no decoding has nothing for the gate to judge. */
const FULL_PARSE_CONFIDENCE: ParseConfidence = {
  overall: 1,
  knownContracts: [],
  unknownContracts: [],
  opaqueScVals: [],
  thresholdUsed: 1,
}

/** Lower a single rule to the canonical pre-encoding `PredicateNode`. The
 *  orchestrator re-derives the PredicateNode through this helper so it holds the
 *  SAME shape the encoder saw. Pure and deterministic: same `rule + config` ->
 *  byte-identical PredicateNode. The `uncovered` list is NOT re-derived -
 *  callers needing it must use `compileInterpreterPolicy(rule, config)`. */
export function lowerRuleToPredicate(
  rule: ComposedRule,
  config: InterpreterAdapterConfig
): PredicateNode {
  return lowerRule(rule, config).predicate
}

/** Compile a composed rule to an installable interpreter policy. */
export function compileInterpreterPolicy(
  rule: ComposedRule,
  config: InterpreterAdapterConfig
): CompileResult {
  const lowered = lowerRule(rule, config)
  if (lowered.uncovered.length > 0) {
    return { covered: false, uncovered: lowered.uncovered }
  }

  const { encodedPredicate, predicateHash } = encodePredicate(lowered.predicate)
  const policyDocument: PolicyDocument = {
    grammarVersion: GRAMMAR_VERSION,
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

function lowerRule(rule: ComposedRule, config: InterpreterAdapterConfig): LoweredRule {
  const uncovered: string[] = []

  // scope -> context rule + sibling predicates. contract/method each become
  // their own `eq` leaf and are merged into the top-level `and` alongside the
  // constraints. The top-level MUST be `and` for canonical hash stability.
  const scopeContract: string | undefined = rule.scope.contract
  const scopeMethod: string | undefined = rule.scope.method
  // expiry -> the context rule's own validUntilLedger. The interpreter has no
  // expiry selector; a policy's lifetime is the OZ context rule's lifetime.
  const validUntilLedger: number | null = rule.expiry?.validUntilLedger ?? null

  // Pre-scan constraints: anything the interpreter adapter cannot express is
  // named in `uncovered` and skipped from the predicate lowering. We surface
  // these BEFORE lowering so the predicate is built from only the
  // expressible subset.
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
  topChildren.push(...rule.constraints)

  // One walk over the whole tree rejects any literal naming the smart account
  // itself. Previously three separate call sites did this per construct, which
  // meant a new construct could be added without one.
  for (const node of topChildren) {
    assertNoSelfCall(node, config)
  }

  const predicate: PredicateNode =
    topChildren.length === 1 && topChildren[0] !== undefined
      ? topChildren[0]
      : { op: 'and', children: topChildren }

  // Scope the context rule to the contract when the rule names one, matching
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

/** Reject a value that targets the smart account's own address (a self-call
 *  is a structural privilege-escalation hole the interpreter forbids). */
/** Reject any address literal anywhere in the predicate that names the smart
 *  account itself: a policy permitting the account to call itself would let an
 *  agent re-enter the guarded account and escape the scope the rule pins. */
function assertNoSelfCall(node: PredicateNode, config: InterpreterAdapterConfig): void {
  const checkLeaf = (leaf: PredicateLeaf): void => {
    if (leaf.kind === 'literal_vec') {
      for (const e of leaf.elements) checkLeaf(e)
      return
    }
    if (leaf.kind === 'literal_address' && leaf.value === config.smartAccountAddress) {
      throw toolError(
        'SCOPE_SELF_CALL',
        `value \`${leaf.value}\` is the smart account's own address (self-call in an allowlist / compare is rejected)`
      )
    }
  }
  switch (node.op) {
    case 'and':
      for (const c of node.children) assertNoSelfCall(c, config)
      return
    case 'in':
      // The needle is a selector; only the haystack carries literals.
      for (const h of node.haystack) checkLeaf(h)
      return
    default:
      checkLeaf(node.left)
      checkLeaf(node.right)
  }
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
