// src/types.ts - shared domain types (single source of truth)

export type Network = 'mainnet' | 'testnet'

/** Decoded Soroban value - the normalised subset synthesis needs. */
export type ScVal =
  | { type: 'address'; value: string }
  | { type: 'i128'; value: string }
  | { type: 'u64'; value: string }
  | { type: 'u32'; value: string }
  | { type: 'symbol'; value: string }
  | { type: 'vec'; value: ScVal[] }
  | { type: 'bytes'; value: string }
  /** Map<Symbol, ScVal> carried forward for SAC/SEP-41 transfer event data,
   *  which uses a Map shape (key "amount" -> I128) on Stellar mainnet. The
   *  entry key is captured as its symbol/form string so readAmount can route
   *  to the conventional field name without re-decoding the full XDR. */
  | { type: 'map'; value: Array<{ key: string; val: ScVal }> }
  | { type: 'other'; value: string }

/** OZ Accounts framework hard limits (verified against canonical OZ source). */
export const OZ_LIMITS = {
  maxPoliciesPerRule: 5,
  maxSignersPerRule: 15,
  // NO per-account rule cap - OZ imposes none.
} as const

/** Soroban / Stellar protocol limits used to bound inputs fail-closed. Single
 *  source so the schema boundary and the core validators cannot drift. */
export const SOROBAN_LIMITS = {
  /** `valid_until` and other ledger-sequence fields are u32. */
  u32Max: 4294967295,
  /** Upper bound on top-level invocations in a recorded transaction; a real
   *  Stellar tx caps operations well below this. Bounds a hand-crafted payload. */
  maxInvocations: 512,
  /** Stellar targets a ~5s ledger close time (DAY_IN_LEDGERS = 17280 = 86400/5),
   *  used to convert a spend window in seconds to OZ `period_ledgers`. */
  secondsPerLedger: 5,
} as const

/** Maximum recursion depth for decoding Recursive `ScVal` shapes (vec-in-vec).
 *  A real Stellar tx caps nesting well below this; the bound hard-caps a
 *  hand-crafted payload so the recorder fails CLOSED (records the over-depth
 *  branch as opaque `depth-exceeded`) rather than RangeErroring the JS stack.
 *  Mirrors the `MAX_AUTH_TREE_DEPTH = 16` boundary the auth-tree decoder
 *  already enforces; lifted to 30 so legitimate nested args (a path vec
 *  inside an order vec inside a market-data vec) decode cleanly while a
 *  malformed ~10000-deep payload still trips the cap. */
export const MAX_SCVAL_DEPTH = 30 as const

/** Maximum recursion depth for cloning nested `ScVal` shapes (vec-in-vec) into
 *  the simulator / verify / harness contexts. Mirrors `MAX_SCVAL_DEPTH` above
 *  so a hand-crafted nested-vec payload cannot RangeError the JS stack during
 *  context building. Over-depth throws a ToolError (caught by the
 *  `synthesizeFromRecording` envelope + the simulator/verify boundaries) so
 *  the caller gets a structured `{ok:false, error}` instead of a thrown
 *  RangeError. */
export const MAX_SCVAL_CLONE_DEPTH = 30 as const

/** Predicate-document caps - enforced fail-closed at install by BOTH the synth (TS)
 *  AND the interpreter (Rust). Single source: a CI test asserts the two cap sets are
 *  byte-identical (TS reads the same JSON manifest the Rust build emits). If they
 *  disagree, the interpreter is authoritative. Rationale per cap:
 *    - MAX_DEPTH = 5:             3 walkthroughs need depth 2; budget = 2x growth + 1 for `not` chain.
 *    - MAX_LEAVES = 200:         allowlists (recipients, paths) typically < 100; budget = 2x + 1 nested allowlist.
 *    - MAX_PREDICATE_BYTES = 32 KB: well under the per-ledger-entry 64 KB persistent-storage limit.
 *    - MAX_ORACLE_READS = 6:     two-round confirmation per asset consumes 2 reads; cap accommodates a predicate that references up to 3 unique oracle assets (3 * 2 = 6 reads). Stays a fail-closed install-time cap.
 *    - MAX_IN_OPERAND_COUNT = 32: allowlist < 32 is a UX-natural bound. */
export const PREDICATE_CAPS = {
  MAX_DEPTH: 5,
  MAX_LEAVES: 200,
  MAX_PREDICATE_BYTES: 32 * 1024,
  MAX_ORACLE_READS: 6,
  MAX_IN_OPERAND_COUNT: 32,
} as const

/** OZ context-rule draft - the unit the install builder builds add_context_rule from. */
export type ContextRuleDraft = {
  contextRuleType:
    | { kind: 'default' }
    | { kind: 'call_contract'; contract: string }
    | { kind: 'create_contract'; wasmHash: string }
  name: string
  /** Ledger sequence (u32). Soroban `valid_until: Option<u32>`. */
  validUntilLedger: number | null
  /** Mirrors OZ `Signer` enum exactly: `Delegated(Address) | External(Address, Bytes)`.
   *  The verifier address + key bytes for an external signer are carried in the
   *  `External` variant - there is no `Key` or `SmartAccount` variant, and no
   *  master/non-master discriminator lives on the type itself. */
  signers: SignerDraft[]
  policies: PolicyRef[]
}

/** Mirrors OZ `Signer` exactly: `Signer::Delegated(Address) | Signer::External(Address, Bytes)`. */
export type SignerDraft =
  | { kind: 'delegated'; address: string }
  | { kind: 'external'; verifier: string; keyBytes: string }

/** Reference to one policy attached to a context rule. */
export type PolicyRef =
  | { kind: 'oz_builtin'; primitive: OZPrimitiveConfig; instanceAddress: string }
  | { kind: 'interpreter'; interpreterAddress: string; predicateBlobBase64: string }

/** A serialised predicate document stored against a (smart_account, rule_id) pair. */
export interface PolicyDocument {
  /** Grammar version baked into the interpreter wasm. Fail-closed strict match at install
   *  AND at evaluate (defence in depth). NOT the per-edit revision. */
  grammarVersion: 1
  /** Per-rule install nonce. Must equal the interpreter's stored nonce + 1 at install.
   *  First install accepts nonce = 1 with stored nonce = 0. Re-install is structurally
   *  possible by incrementing the nonce; uninstall removes the nonce with state so a
   *  subsequent install returns to nonce = 1. Replay of an old install denied. */
  installNonce: number
  /** Canonical ScVal encoding (NOT JSON) - the version-match bypass is closed by the
   *  on-chain serialisation, not by a parser. */
  encodedPredicate: string // base64 of canonical ScVal
  /** Hash of the post-canonicalisation bytes of encodedPredicate. Stored alongside the
   *  doc and re-verified at evaluate. */
  predicateHash: string
  /** Per-policy overrides of oracle thresholds; absent = use defaults.
   *  Overrides may TIGHTEN only (never widen) - the interpreter rejects any per-policy
   *  value looser than the wasm-level defaults at install. */
  oracleParams?: {
    /** Seconds; must be <= MAX_ORACLE_STALENESS_SECONDS (600). */
    maxStalenessSeconds?: number
    /** Basis points; must be <= MAX_ORACLE_DEVIATION_BPS (200). */
    maxDeviationBps?: number
  }
}

/** The versioned predicate AST (interpreter side). Tagged union. */
export type PredicateNode =
  | { op: 'and'; children: PredicateNode[] }
  | { op: 'or'; children: PredicateNode[] }
  | { op: 'not'; child: PredicateNode }
  | { op: 'eq'; left: PredicateLeaf; right: PredicateLeaf }
  | { op: 'lt' | 'lte' | 'gt' | 'gte'; left: PredicateLeaf; right: PredicateLeaf }
  | {
      op: 'in'
      needle: PredicateLeaf
      haystack: PredicateLeaf[] /** set-valued only - the haystack is always sorted by canonical XDR bytes (pure membership). */
    }

export type PredicateLeaf =
  | { kind: 'call_contract' }
  | { kind: 'call_fn' }
  | { kind: 'call_arg'; index: number }
  // Length of a vec-typed argument as a u32. Binds the OUTER vec length so
  // a caller cannot append a new element to defeat a per-element pin.
  // Paired with `call_arg_field` per element - pinning only the field leaves
  // an element-append vulnerability; this leaf closes it.
  | { kind: 'call_arg_len'; index: number }
  // Value of `field` in the map at `element` of the vec at argument `index`.
  // Fixed-arity: index, element, field. The leaf is resolved against the
  // recorded ScVal type. A non-vec arg, missing element, missing field, or
  // type mismatch all DENY (fail-closed).
  | { kind: 'call_arg_field'; index: number; element: number; field: string }
  // `call_arg_scaled(index, num, den)` evaluates to `args[index] * num / den`
  // (truncating toward zero). The slippage-floor leaf: a swap policy
  // expresses `call_arg[out] >= call_arg_scaled(in, num, den)` as "the
  // minimum output must be at least this ratio of the input". `num`/`den`
  // are decimal strings on i128 (mirrors `literal_i128`); the contract
  // refuses `den == 0` and `num <= 0` / `den <= 0` at install.
  | { kind: 'call_arg_scaled'; index: number; num: string; den: string }
  // `call_sub_invocation[i]` is NOT in v1 grammar. OZ `Policy::enforce`
  // receives one `Context`, not a sub-invocation tree; sub-invocations live under
  // `InvokerContractAuthEntry::Contract(SubContractInvocation)`, not in the
  // enforce Context. Scope is per-authorized-context; a v1.1 sub-invocation
  // tree leaf is gated on the enforce-Context-shape spike result.
  | { kind: 'amount'; token: string }
  | { kind: 'window_spent'; token: string; windowSeconds: number }
  | { kind: 'now' }
  | { kind: 'valid_until' }
  | { kind: 'invocation_count_in_window'; windowSecs: number }
  | { kind: 'oracle_price'; asset: string } // Stellar Address (SAC address for SEP-41; XLM uses its network SAC)
  // The right-hand side of an oracle comparison. It carries its own decimal
  // basis because the contract cannot recover it: prices normalise to 9 dp, so
  // a raw 14-dp threshold is ~10^5 too large and `price <= threshold` becomes
  // trivially true. `value` is a decimal string on i128, like `literal_i128`.
  | { kind: 'oracle_threshold'; value: string; decimals: number }
  // Literal leaves: bare ScVal on the wire (no selector-tuple wrapper). Right-hand side of
  // comparisons, elements of `in` haystacks, and operands to future arithmetic nodes.
  | { kind: 'literal_address'; value: string }
  | { kind: 'literal_i128'; value: string }
  | { kind: 'literal_symbol'; value: string }
  | { kind: 'literal_u32'; value: number }
  | { kind: 'literal_u64'; value: string }
  | { kind: 'literal_bytes'; value: string } // hex string; wrapped as ScVal::Bytes at encode time
  // Exact ordered vector of literals (e.g. a swap hop path). Encodes to a bare
  // ScVal::Vec with the caller's order preserved verbatim - the order IS the
  // semantic. An exact ordered sequence equality is expressed by `eq(selector,
  // literal_vec([...]))`. `in` is reserved for pure set membership (sorted).
  | { kind: 'literal_vec'; elements: PredicateLeaf[] }

export interface OZPrimitiveConfig {
  primitive: 'spending_limit' | 'simple_threshold' | 'weighted_threshold'
  params: Record<string, unknown>
}

export interface ContractInvocation {
  contract: string
  fn: string
  args: ScVal[]
  subInvocations: ContractInvocation[]
}

export interface TokenMovement {
  token: string
  from: string
  to: string
  amount: string
}

export interface OnChainEvent {
  contract: string
  topics: string[]
  data: ScVal
}

export interface RecordedTransaction {
  network: Network
  /** Authorising signers (the agent / owner set). */
  signers: string[]
  /** Top-level call + nested sub-invocations captured for analysis:
   *  v1 grammar matches only the top-level call's own `(contract, fn_name, args)`
   *  that `Policy::enforce` receives - sub-invocations are NOT walked in v1. */
  invocations: ContractInvocation[]
  /** All token movements (from events). */
  tokenMovements: TokenMovement[]
  /** Raw on-chain events from getTransaction (used for validation). */
  events: OnChainEvent[]
  /** Soroban auth entries (which signers, which contracts, which fns). */
  authEntries: unknown[]
  ledgerSequence: number
  fetchedAt: number
  /** The parsed-decoding freshness, computed by the recorder. The synth refuses on
   *  parseConfidence.overall < parseConfidence.thresholdUsed. */
  parseConfidence: ParseConfidence
  /** Source account (already recorded, needed by install + reviewer). */
  sourceAccount: string
}

export interface ProposedPolicy {
  contextRule: ContextRuleDraft
  policyDocuments: PolicyDocument[]
  policyRefs: PolicyRef[]
  /** Parsed-decoding freshness mirror; the orchestrator refuses when below threshold. */
  parseConfidence: ParseConfidence
  warnings: string[]
  ambiguities: AmbiguityPrompt[]
}

export interface AmbiguityPrompt {
  code: AmbiguityCode
  question: string
}

/** Catalogue of named ambiguity codes (the skill's prompt files are one-per-code).
 *  Adding a code is a synthesizer decision; the prompt authoring must not
 *  invent codes outside this union. */
export type AmbiguityCode =
  | 'DURATION_UNSPECIFIED'
  | 'AMOUNT_BOUND_MISSING'
  | 'RECIPIENT_ALLOWLIST_EMPTY'
  | 'FREQUENCY_BOUND_MISSING'
  | 'ORACLE_ASSET_UNKNOWN'
  | 'MULTIPLE_UNRELATED_TARGETS'

/** Structured recording freshness. `overall` is the gate threshold (default 1.0); the
 *  breakdown is the diagnostic the user / agent sees when the gate fires. The
 *  computation rule is pinned: `overall = 1 - (unknownContracts + opaqueScVals) / total`.
 *
 *  `noInvocations` (item 1) is a recorder-side marker set ONLY when the envelope
 *  contained zero `invokeContract` host functions (e.g. a `createContract` or
 *  `uploadContractWasm` op). The math is unchanged: that case still scores 1.0
 *  via the `denom === 0` guard. The marker exists so a consumer does not have
 *  to infer the situation from `invocations.length === 0` next to `overall: 1.0`
 *  — a downstream synth refuses such recordings with a specific, actionable
 *  error rather than silently producing a useless empty scope. */
export interface ParseConfidence {
  overall: number // 0..1
  knownContracts: string[]
  unknownContracts: Array<{
    contract: string
    reason: 'no-abi' | 'version-mismatch' | 'opaque-result'
  }>
  opaqueScVals: Array<{ path: string; type: string }>
  thresholdUsed: number // 1.0 by default; > 0 only via explicit confidence_override
  /** True iff the recorder decoded zero contract invocations. Absent on
   *  recordings that pre-date this field; consumers should treat `undefined`
   *  as "no marker" and rely on `invocations.length` as the fallback. */
  noInvocations?: true
}
