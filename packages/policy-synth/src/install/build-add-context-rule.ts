// src/install/build-add-context-rule.ts - pure builder for the OZ
// `add_context_rule` invocation arguments.
//
// Hand-rolled instead of reusing the scripts' helpers because the product
// path (Phase 06 install_policy) needs a single callable that takes a typed
// `ContextRuleDraft` + predicate bytes and returns the `ScVal` argument list
// the host will pass to `add_context_rule`. The script-level helpers stay
// out of `src/` to avoid dragging the ts-node SDK into the library surface.
//
// The OZ trait signature is pinned in
// `stellar-contracts::smart_account::SmartAccount::add_context_rule`:
//
//     fn add_context_rule(
//         e: &Env,
//         context_type: ContextRuleType,
//         name: String,
//         valid_until: Option<u32>,
//         signers: Vec<Signer>,
//         policies: Map<Address, Val>,
//     ) -> ContextRule
//
// The default body calls `e.current_contract_address().require_auth()`, so
// installation goes through the account's `__check_auth` -> `do_check_auth`.
// That requires the DEPLOYER to have shipped an admin rule with NO
// restrictive policy, otherwise the policy would refuse the very call that
// installs it. The caller is responsible for that contract; this builder
// just emits the args.
//
// Two hard limits the contract enforces (verified against
// `storage::validate_signers_and_policies` at /tmp/ozsc):
//   - signers.len() <= MAX_SIGNERS (15)
//   - policies.len() <= MAX_POLICIES (5)
//   - signers and policies must not both be empty
// The same limits are mirrored in `OZ_LIMITS` (see src/types.ts) and
// checked here fail-closed before any encoding work - the user gets a
// typed error with the specific cap, not a runtime trap.
//
// Policypayloads are `Map<Address, Val>`. The host orders map entries by the
// symbol STRING of the key, NOT by the key's XDR bytes (a length prefix
// would otherwise put `amount` before `address` and produce a map the
// contract reads differently - a previous session lost hours to this). Our
// only key is an `Address`, so we build a single-entry map and the ordering
// question is moot, but the comment is here so the next map-bearing code
// in this file does not regress.
//
// Pure: no network, no signing. The caller hands the returned ScVal[] to
// `Operation.invokeHostFunction` AFTER wiring the auth entries, otherwise
// the account refuses with `Error(Auth, InvalidAction)`.

import { createHash } from 'node:crypto'
import { Address, xdr } from '@stellar/stellar-sdk'
import type { ToolError } from '../errors.ts'
import {
  type ContextRuleDraft,
  OZ_LIMITS,
  type OZPrimitiveConfig,
  type PolicyRef,
  type SignerDraft,
} from '../types.ts'

/** Inputs for `buildAddContextRuleArgs`. The fields are the ones the contract
 *  validates at install; everything else is downstream. */
export interface BuildAddContextRuleArgs {
  /** The auth-context rule signers to attach - `Vec<Signer>` wire form.
   *  These are the SIGNERS the new rule authorises, not the deployer's
   *  admin session. The deployer signs the install call via the admin rule
   *  already on the account, which is separate from this list. */
  signers: SignerDraft[]
  /** The policy(ies) to attach to the new rule. Only `interpreter` refs
   *  reach the wire today; `oz_builtin` is reserved for Phase 06 follow-ups. */
  policies: PolicyRef[]
  /** Per-policy install nonce; 1 for a fresh install. */
  installNonce: number
  /** Already-encoded (base64) canonical ScVal of the predicate. The builder
   *  decodes it to bytes for the `predicate` field and re-hashes to confirm
   *  the caller-supplied `predicateHash` matches. */
  encodedPredicate: string
  /** Hex sha256 of the canonical predicate XDR bytes. */
  predicateHash: string
  /** Hard pin to the interpreter's wasm grammar. Refusing here fails closed
   *  before the chain does; the contract will refuse a mismatch again. */
  grammarVersion?: number
}

export const DEFAULT_GRAMMAR_VERSION = 2 as const

/** The verb `add_context_rule` takes on the wire. */
export const ADD_CONTEXT_RULE_SYMBOL = 'add_context_rule' as const

/** Tuple of `ScVal` arguments to pass to `Operation.invokeHostFunction` for
 *  `add_context_rule`. Order matches the OZ trait signature. */
export type AddContextRuleArgs = readonly [
  contextType: xdr.ScVal,
  name: xdr.ScVal,
  validUntil: xdr.ScVal,
  signers: xdr.ScVal,
  policies: xdr.ScVal,
]

/** Build the `add_context_rule` invocation args. Throws a `ToolError`-shaped
 *  error on limit breaches or malformed input. */
export function buildAddContextRuleArgs(
  draft: ContextRuleDraft,
  args: BuildAddContextRuleArgs
): AddContextRuleArgs {
  // ---- 1. Cap checks (fail-closed before any encoding) ----
  if (args.signers.length > OZ_LIMITS.maxSignersPerRule) {
    throw limitError(
      'INSTALL_BUILD_FAILED',
      `signers ${args.signers.length} exceed MAX_SIGNERS_PER_RULE ${OZ_LIMITS.maxSignersPerRule}`
    )
  }
  if (args.policies.length > OZ_LIMITS.maxPoliciesPerRule) {
    throw limitError(
      'INSTALL_BUILD_FAILED',
      `policies ${args.policies.length} exceed MAX_POLICIES_PER_RULE ${OZ_LIMITS.maxPoliciesPerRule}`
    )
  }
  if (args.signers.length === 0 && args.policies.length === 0) {
    throw limitError(
      'INSTALL_BUILD_FAILED',
      'a rule with no signers and no policies is refused at install (NoSignersAndPolicies)'
    )
  }
  // OZ's spending_limit caps spend on the CONTEXT CONTRACT - it takes no
  // token argument - so it refuses a Default rule on chain with a bare
  // #3227. Say which rule shape it needs here, before the encoding, rather
  // than letting the user read a numeric trap.
  if (
    args.policies.some((p) => p.kind === 'oz_builtin' && p.primitive.primitive === 'spending_limit')
  ) {
    if (draft.contextRuleType.kind !== 'call_contract') {
      throw limitError(
        'INSTALL_BUILD_FAILED',
        `spending_limit caps spend on the rule's context contract, so the rule must be call_contract-scoped to that token - a "${draft.contextRuleType.kind}" rule is refused on chain (#3227)`
      )
    }
  }

  // ---- 2. context_type encoding ----
  const contextType = encodeContextRuleType(draft.contextRuleType)

  // ---- 3. name (string) + valid_until (Option<u32>) ----
  const name = xdr.ScVal.scvString(draft.name)
  const validUntil =
    draft.validUntilLedger === null ? xdr.ScVal.scvVoid() : xdr.ScVal.scvU32(draft.validUntilLedger)

  // ---- 4. signers ----
  const signersVec = xdr.ScVal.scvVec(args.signers.map(encodeSigner))

  // ---- 5. policies Map<Address, Val> ----
  const policies = encodePoliciesMap(args)

  return [contextType, name, validUntil, signersVec, policies] as const
}

// ---- helpers ----

/** Field order of the `PolicyInstallParams` struct. The contract's
 *  `#[contracttype]` derives a Map<Symbol, Val> encoding, so the host
 *  sorts by symbol STRING (NOT by XDR bytes). This explicit list is the
 *  single source of truth for the field order. */
const POLICY_INSTALL_PARAM_FIELDS = [
  'grammar_version',
  'install_nonce',
  'predicate',
  'predicate_hash',
] as const

function encodeContextRuleType(
  rule:
    | { kind: 'default' }
    | { kind: 'call_contract'; contract: string }
    | { kind: 'create_contract'; wasmHash: string }
): xdr.ScVal {
  switch (rule.kind) {
    case 'default':
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')])
    case 'call_contract':
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('CallContract'),
        Address.fromString(rule.contract).toScVal(),
      ])
    case 'create_contract':
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('CreateContract'),
        xdr.ScVal.scvBytes(Buffer.from(rule.wasmHash, 'hex')),
      ])
  }
}

function encodeSigner(s: SignerDraft): xdr.ScVal {
  switch (s.kind) {
    case 'delegated':
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Delegated'),
        Address.fromString(s.address).toScVal(),
      ])
    case 'external':
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('External'),
        Address.fromString(s.verifier).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(s.keyBytes, 'hex')),
      ])
  }
}

function encodePoliciesMap(args: BuildAddContextRuleArgs): xdr.ScVal {
  const entries: xdr.ScMapEntry[] = []
  for (const ref of args.policies) {
    if (ref.kind === 'interpreter') {
      entries.push(
        new xdr.ScMapEntry({
          key: Address.fromString(ref.interpreterAddress).toScVal(),
          val: encodePolicyInstallParams(args),
        })
      )
    } else if (ref.kind === 'oz_builtin') {
      entries.push(
        new xdr.ScMapEntry({
          key: Address.fromString(ref.instanceAddress).toScVal(),
          val: encodeOzPrimitiveParams(ref.primitive),
        })
      )
    }
  }
  entries.sort(sortByScValSymbolString)
  return xdr.ScVal.scvMap(entries)
}

/** Encode the install params for one OZ built-in policy.
 *
 *  Field names and types are read from the deployed contracts' own spec:
 *    SpendingLimitAccountParams   { period_ledgers: u32, spending_limit: i128 }
 *    SimpleThresholdAccountParams { threshold: u32 }
 *    WeightedThresholdAccountParams { signer_weights: map, threshold: u32 }
 *  Entries are symbol-string ordered for the same reason the interpreter's
 *  are: the host orders by symbol, not by XDR bytes.
 */
function encodeOzPrimitiveParams(primitive: OZPrimitiveConfig): xdr.ScVal {
  const entries: xdr.ScMapEntry[] = []
  const push = (name: string, val: xdr.ScVal) =>
    entries.push(new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val }))
  const p = primitive.params as Record<string, unknown>
  switch (primitive.primitive) {
    case 'spending_limit': {
      const limit = p.spending_limit
      const period = p.period_ledgers
      if (typeof limit !== 'string' || typeof period !== 'number') {
        throw limitError(
          'INSTALL_BUILD_FAILED',
          'spending_limit needs { spending_limit: string; period_ledgers: number }'
        )
      }
      push('period_ledgers', xdr.ScVal.scvU32(period))
      push('spending_limit', encodeI128(limit))
      break
    }
    case 'simple_threshold': {
      const threshold = p.threshold
      if (typeof threshold !== 'number') {
        throw limitError('INSTALL_BUILD_FAILED', 'simple_threshold needs { threshold: number }')
      }
      push('threshold', xdr.ScVal.scvU32(threshold))
      break
    }
    case 'weighted_threshold': {
      const threshold = p.threshold
      const weights = p.weights as Record<string, number> | undefined
      if (typeof threshold !== 'number' || !weights) {
        throw limitError(
          'INSTALL_BUILD_FAILED',
          'weighted_threshold needs { threshold: number; weights: Record<address, number> }'
        )
      }
      const weightEntries = Object.entries(weights)
        .map(
          ([addr, w]) =>
            new xdr.ScMapEntry({
              key: Address.fromString(addr).toScVal(),
              val: xdr.ScVal.scvU32(w),
            })
        )
        .sort((a, b) => (a.key().toXDR('base64') < b.key().toXDR('base64') ? -1 : 1))
      push('signer_weights', xdr.ScVal.scvMap(weightEntries))
      push('threshold', xdr.ScVal.scvU32(threshold))
      break
    }
  }
  entries.sort((a, b) => sortBySymbolString(a.key(), b.key()))
  return xdr.ScVal.scvMap(entries)
}

function encodeI128(value: string): xdr.ScVal {
  const v = BigInt(value)
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: new xdr.Int64(BigInt.asIntN(64, v >> 64n)),
      lo: new xdr.Uint64(BigInt.asUintN(64, v)),
    })
  )
}

function encodePolicyInstallParams(args: BuildAddContextRuleArgs): xdr.ScVal {
  const predicate = Buffer.from(args.encodedPredicate, 'base64')
  const computedHash = createHash('sha256').update(predicate).digest('hex')
  if (computedHash !== args.predicateHash) {
    throw limitError(
      'INSTALL_BUILD_FAILED',
      `predicateHash ${args.predicateHash.slice(0, 16)}... does not match sha256(encodedPredicate) ${computedHash.slice(0, 16)}...`
    )
  }
  // Per-field value encoders. Each entry returns the ScVal to drop into the
  // map; the key symbol comes from the surrounding loop. Adding a field is
  // one row here plus the symbol in POLICY_INSTALL_PARAM_FIELDS.
  const valueFor: Record<(typeof POLICY_INSTALL_PARAM_FIELDS)[number], () => xdr.ScVal> = {
    grammar_version: () => xdr.ScVal.scvU32(args.grammarVersion ?? DEFAULT_GRAMMAR_VERSION),
    install_nonce: () => xdr.ScVal.scvU32(args.installNonce),
    predicate: () => xdr.ScVal.scvBytes(predicate),
    predicate_hash: () => xdr.ScVal.scvBytes(Buffer.from(args.predicateHash, 'hex')),
  }
  const entries = POLICY_INSTALL_PARAM_FIELDS.map(
    (k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: valueFor[k]() })
  )
  // The host orders map entries by the SYMBOL STRING, not by XDR bytes. A
  // length prefix in the XDR encoding would otherwise put `amount` before
  // `address` and produce a struct the contract reads differently. Emit the
  // entries in symbol-string order so the wire form matches the host's view.
  entries.sort((a, b) => sortBySymbolString(a.key(), b.key()))
  return xdr.ScVal.scvMap(entries)
}

/** Sort host-map keys by their symbol-string form. The host orders map
 *  entries by the SYMBOL STRING, not by the key's XDR bytes (a length
 *  prefix in the encoding would otherwise put `amount` before `address`).
 *  For non-symbol keys we fall back to length-prefixed XDR bytes; the
 *  caller's only Address keys today are length-stable so this is moot, but
 *  the helper stands ready for the multi-policy variant. */
function sortByScValSymbolString(a: xdr.ScMapEntry, b: xdr.ScMapEntry): number {
  return sortBySymbolString(a.key(), b.key())
}

function sortBySymbolString(a: xdr.ScVal, b: xdr.ScVal): number {
  const aSym = a.switch().name === 'scvSymbol' ? a.sym().toString() : null
  const bSym = b.switch().name === 'scvSymbol' ? b.sym().toString() : null
  if (aSym !== null && bSym !== null) {
    return aSym < bSym ? -1 : aSym > bSym ? 1 : 0
  }
  return Buffer.compare(a.toXDR(), b.toXDR())
}

function limitError(code: ToolError['code'], message: string): ToolError {
  const err = new Error(message) as Error & {
    code: ToolError['code']
    severity: string
    retryable: boolean
  }
  err.code = code
  err.severity = 'error'
  err.retryable = false
  throw err
}
