// src/adapters/oz/adapter.ts - the OZ Accounts CustodyAdapter.
//
// Compiles a PolicyIR to an OZ `ProposedPolicy` using OZ built-in policy
// primitives. Only the constructs OZ can express natively are lowered:
//   scope.contract            -> ContextRuleType.call_contract (else default)
//   expiry.validUntilLedger   -> ContextRuleDraft.validUntilLedger
//   window_spent(t,w) <= L    -> `spending_limit` primitive
//   approval.threshold        -> `simple_threshold` / `weighted_threshold`
// Anything needing a capability this backend lacks (oracle price, invocation
// count, per-arg comparison/allowlist, guard, nested boolean predicate) is NOT
// emitted: it is named in `uncovered` and `covered` is set false. Nothing is
// silently dropped.
//
// OZ built-in policy instance addresses are per-network deploy artifacts we do
// not have yet (install is a later phase). They are injected via config; week-1
// ships a clearly-labelled [VERIFY] placeholder so nothing invents an address.

import type { IRCondition, IRPolicyRule, IRSelector, PolicyIR } from '../../ir/types.ts'
import type {
  CompileResult,
  CustodyAdapter,
  CustodyCapabilities,
  SimulationResult,
} from '../../seams/types.ts'
import type {
  ContextRuleDraft,
  Network,
  ParseConfidence,
  PolicyRef,
  ProposedPolicy,
} from '../../types.ts'
import { OZ_LIMITS, SOROBAN_LIMITS } from '../../types.ts'

/** OZ built-in policy contract instance addresses, per primitive. */
export interface OzPrimitiveInstances {
  spending_limit: string
  simple_threshold: string
  weighted_threshold: string
}

/** Per-network config for the OZ adapter. */
export interface OzAdapterConfig {
  network: Network
  instances: OzPrimitiveInstances
}

/** [VERIFY] NOT real deployed addresses. The OZ built-in policy instances are
 *  per-network deploy artifacts we do not have yet; install is a later phase.
 *  Injected so the adapter never invents a Stellar contract address. */
export const PLACEHOLDER_OZ_INSTANCES: OzPrimitiveInstances = {
  spending_limit: 'VERIFY-oz-spending-limit-instance-address',
  simple_threshold: 'VERIFY-oz-simple-threshold-instance-address',
  weighted_threshold: 'VERIFY-oz-weighted-threshold-instance-address',
}

/** Week-1 OZ adapter config with placeholder instance addresses. */
export function placeholderOzConfig(network: Network): OzAdapterConfig {
  return { network, instances: PLACEHOLDER_OZ_INSTANCES }
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

const CAPABILITIES: CustodyCapabilities = {
  supportsSpendWindow: true,
  supportsThreshold: true,
  supportsTimeExpiry: true,
  supportsOraclePrice: false,
  supportsInvocationCount: false,
  supportsGeneralPredicate: false,
}

export function createOzAdapter(config: OzAdapterConfig): CustodyAdapter {
  return {
    name: 'oz-accounts',
    mode: 'enforce',
    capabilities: () => ({ ...CAPABILITIES }),
    compile: (ir) => compile(ir, config),
    simulate: () => simulateStub(),
    export: (ir) => canonicalStringify(ir),
  }
}

function compile(ir: PolicyIR, config: OzAdapterConfig): CompileResult {
  const uncovered: string[] = []

  const firstRule = ir.rules[0]
  if (!firstRule) {
    return { covered: false, uncovered: ['empty PolicyIR (no rules to compile)'] }
  }
  if (ir.rules.length > 1) {
    uncovered.push(
      `multi-rule PolicyIR: ${ir.rules.length - 1} rule(s) beyond the first are not compiled (a ProposedPolicy carries a single context rule in this slice)`
    )
  }

  const lowered = lowerRule(firstRule, config)
  uncovered.push(...lowered.uncovered)

  const result: CompileResult = { covered: uncovered.length === 0, uncovered }
  if (!lowered.capExceeded) {
    const proposed: ProposedPolicy = {
      contextRule: lowered.contextRule,
      policyDocuments: [],
      policyRefs: lowered.policyRefs,
      parseConfidence: { ...FULL_PARSE_CONFIDENCE },
      warnings: [],
      ambiguities: [],
    }
    result.proposed = proposed
  }
  return result
}

interface LoweredRule {
  contextRule: ContextRuleDraft
  policyRefs: PolicyRef[]
  uncovered: string[]
  capExceeded: boolean
}

function lowerRule(rule: IRPolicyRule, config: OzAdapterConfig): LoweredRule {
  const uncovered: string[] = []
  const policyRefs: PolicyRef[] = []

  // scope -> context rule type. OZ scopes by contract (CallContract); a
  // method-level restriction is flagged as not covered because CallContract
  // alone permits other methods on the same contract (e.g. an unbounded approve
  // alongside a capped transfer).
  const contextRuleType: ContextRuleDraft['contextRuleType'] =
    rule.scope.contract !== undefined
      ? { kind: 'call_contract', contract: rule.scope.contract }
      : { kind: 'default' }

  if (rule.scope.method !== undefined && rule.scope.contract !== undefined) {
    uncovered.push(
      `per-method scoping to \`${rule.scope.method}\` (OZ CallContract scopes by contract only; requires the interpreter predicate)`
    )
  }

  if (rule.scope.chainId !== undefined) {
    uncovered.push(
      `chainId \`${rule.scope.chainId}\` not bindable by the Stellar OZ adapter (network is per-context, not per-rule)`
    )
  }

  if (rule.roles.length > 0) {
    uncovered.push(
      `roles [${rule.roles.join(', ')}] dropped (role-to-signer mapping is a later phase; OZ signers carry addresses, not role names)`
    )
  }

  // expiry -> validUntilLedger. Unix-timestamp expiry cannot be expressed by an
  // OZ context rule (it expires by ledger sequence), so flag it.
  let validUntilLedger: number | null = null
  if (rule.expiry) {
    if (rule.expiry.validUntilLedger !== undefined) {
      validUntilLedger = rule.expiry.validUntilLedger
    } else if (rule.expiry.validUntilUnixSeconds !== undefined) {
      uncovered.push(
        'time expiry given as a unix timestamp (OZ context rules expire by ledger sequence; supply expiry.validUntilLedger)'
      )
    }
  }

  // guard -> not covered (applicability predicates are not an OZ built-in).
  if (rule.guard) {
    uncovered.push(`guard: ${describeCondition(rule.guard)}`)
  }

  // constraints -> spending_limit where they match; else not covered. The OZ
  // spending_limit takes `{ spending_limit: i128, period_ledgers: u32 }` and
  // has NO token param: it only accepts a CallContract context rule
  // (OnlyCallContractAllowed) and limits transfers of that context's contract,
  // so the spent token must equal the scope contract, and the window is a
  // ledger count (~5s/ledger), not seconds.
  for (const c of rule.constraints) {
    const spend = matchSpendingLimit(c)
    if (!spend) {
      uncovered.push(describeCondition(c))
      continue
    }
    if (contextRuleType.kind !== 'call_contract' || spend.token !== contextRuleType.contract) {
      uncovered.push(
        `spending_limit on token ${spend.token} needs a CallContract context scoped to that token (OZ pins the limit to the context contract, not a token param)`
      )
      continue
    }
    policyRefs.push({
      kind: 'oz_builtin',
      primitive: {
        primitive: 'spending_limit',
        params: {
          spending_limit: spend.limit,
          period_ledgers: secondsToLedgers(spend.windowSeconds),
        },
      },
      instanceAddress: config.instances.spending_limit,
    })
  }

  // approval.threshold -> simple/weighted threshold primitive. A threshold < 1
  // is not a real M-of-N gate (0 approvals authorises everything), so refuse to
  // emit a no-op primitive and flag it as not covered.
  if (rule.approval) {
    if (!Number.isInteger(rule.approval.threshold) || rule.approval.threshold < 1) {
      uncovered.push(
        `approval threshold ${rule.approval.threshold} is not a positive integer (a 0 or negative threshold is not an M-of-N gate)`
      )
    } else {
      const weights = rule.approval.weights
      if (weights && Object.keys(weights).length > 0) {
        policyRefs.push({
          kind: 'oz_builtin',
          primitive: {
            primitive: 'weighted_threshold',
            params: { threshold: rule.approval.threshold, weights },
          },
          instanceAddress: config.instances.weighted_threshold,
        })
      } else {
        policyRefs.push({
          kind: 'oz_builtin',
          primitive: {
            primitive: 'simple_threshold',
            params: { threshold: rule.approval.threshold },
          },
          instanceAddress: config.instances.simple_threshold,
        })
      }
    }
  }

  const capExceeded = policyRefs.length > OZ_LIMITS.maxPoliciesPerRule
  if (capExceeded) {
    uncovered.push(
      `policy count ${policyRefs.length} exceeds OZ maxPoliciesPerRule (${OZ_LIMITS.maxPoliciesPerRule})`
    )
  }

  const contextRule: ContextRuleDraft = {
    contextRuleType,
    name:
      contextRuleType.kind === 'call_contract'
        ? `call_contract:${contextRuleType.contract}`
        : 'default',
    validUntilLedger,
    signers: [],
    policies: policyRefs,
  }

  return { contextRule, policyRefs, uncovered, capExceeded }
}

/** Convert a spend window in seconds to OZ `period_ledgers` (u32, >= 1).
 *  Stellar targets a ~5s ledger close time. */
function secondsToLedgers(windowSeconds: number): number {
  return Math.max(1, Math.round(windowSeconds / SOROBAN_LIMITS.secondsPerLedger))
}

interface SpendingLimitMatch {
  token: string
  limit: string
  windowSeconds: number
}

/** Match the `window_spent(token, window) <= limit` compare that lowers to the
 *  OZ `spending_limit` primitive. Only `lte` matches (the spend-cap semantic). */
function matchSpendingLimit(c: IRCondition): SpendingLimitMatch | null {
  if (c.op !== 'compare') return null
  const { selector, operator, value } = c.compare
  if (selector.kind !== 'window_spent' || operator !== 'lte') return null
  return { token: selector.token, limit: value, windowSeconds: selector.windowSeconds }
}

/** Human-readable descriptor for a construct the OZ built-in-primitive backend
 *  cannot express, used to populate `uncovered`. */
function describeCondition(cond: IRCondition): string {
  switch (cond.op) {
    case 'slippage_floor':
      // OZ primitives bound a value against a constant; this bounds one call
      // argument against another, which none of them can express.
      return `slippage floor on arg[${cond.outArgIndex}] (OZ built-ins cannot bound one argument against another)`
    case 'in':
      return `value allowlist on ${describeSelector(cond.selector)} (arg allowlist)`
    case 'eq_seq':
      return `exact ordered sequence on ${describeSelector(cond.selector)} (OZ built-ins cannot express an exact vector)`
    case 'not':
      return 'negated condition (predicate DSL)'
    case 'and':
    case 'or':
      return `nested ${cond.op} condition (predicate DSL)`
    case 'compare': {
      const s = cond.compare.selector
      switch (s.kind) {
        case 'oracle_price':
          return `oracle price condition on ${s.asset} (oracle price not supported in week-1)`
        case 'invocation_count':
          return `invocation-count window (${s.windowSeconds}s) condition (not supported in week-1)`
        case 'window_spent':
          return `spend-window comparison with operator '${cond.compare.operator}' (only 'lte' lowers to spending_limit)`
        case 'amount':
          return `per-call amount comparison on ${s.token} (predicate DSL)`
        case 'arg':
          return `argument comparison on arg ${s.argIndex} (predicate DSL)`
        case 'arg_len':
          return `vec length comparison on arg ${s.argIndex} (predicate DSL)`
        case 'arg_field':
          return `map field comparison on arg ${s.argIndex}.${s.field} (predicate DSL)`
        case 'calldata':
          return 'EVM calldata comparison (predicate DSL)'
        case 'value':
          return 'tx.value comparison (predicate DSL)'
        case 'now':
        case 'valid_until':
          return 'time comparison (predicate DSL)'
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
    case 'oracle_price':
      return `oracle_price(${s.asset})`
    case 'invocation_count':
      return `invocation_count(${s.windowSeconds}s)`
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
