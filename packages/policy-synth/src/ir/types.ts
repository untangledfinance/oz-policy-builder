// src/ir/types.ts - the PolicyIR ("Policy Tree").
//
// `PolicyIR` is the custody-agnostic "Policy Tree" hub (the diagram's Policy
// Tree) that every CustodyAdapter compiles FROM. It generalizes the NEAR-V2
// policy schema (roles / scope filter / guard / constraint / comparison leaves /
// default behaviour) into one chain-neutral shape and extends it with the
// single IR can serve every backend. NEAR-V2 has no stateful spend window,
// below and are only lowered by adapters that declare support for them.

/** Comparison operator. Mirrors NEAR-V2 `CompOp`. */
export type IRCompOp = 'eq' | 'lt' | 'lte' | 'gt' | 'gte'

/** Boolean combinator. Mirrors NEAR-V2 `LogicOp`. */
export type IRLogic = 'and' | 'or'

/** Vector match mode for a repeated arg. Mirrors NEAR-V2 `VecMode`. */
export type IRVecMode = 'all' | 'any'

/** Scalar value type. Mirrors NEAR-V2 `ScValType`, superset for OZ. */
export type IRScalarType =
  | 'address'
  | 'i128'
  | 'u128'
  | 'u32'
  | 'u64'
  | 'i64'
  | 'symbol'
  | 'bytes'
  | 'bool'

/** WHERE in the authorized call a value is read. NEAR-V2 selectors first, OZ
 *  extensions after (an adapter that cannot express an extension flags it). */
export type IRSelector =
  // --- NEAR-V2 selectors ---
  | {
      kind: 'arg'
      argIndex: number
      fieldIndex?: number
      vecMode?: IRVecMode
      scalarType: IRScalarType
    } // Stellar StellarComp
  | { kind: 'arg_len'; argIndex: number } // length of a vec-typed argument as u32
  | {
      kind: 'arg_field'
      argIndex: number
      element: number
      field: string
      scalarType: IRScalarType
    } // field of a map element within a vec-typed argument
  | { kind: 'calldata'; offset: number; length: number } // EVM ByteComp
  | { kind: 'value' } // EVM tx.value
  // --- OZ extensions (not in NEAR-V2; lowered only by adapters that support them) ---
  | { kind: 'amount'; token: string } // token amount this call moves
  | { kind: 'now' }
  | { kind: 'valid_until' }

/** A single comparison leaf. `value` is a decimal/hex string (i128-safe;
 *  never a JS number). */
export interface IRCompare {
  selector: IRSelector
  operator: IRCompOp
  value: string
  /** Decimal basis of `value`, for selectors whose comparand is not on a basis
   *  9 dp and an undeclared basis fails OPEN. */
  valueDecimals?: number
}

/** Condition tree. NEAR-V2 guard/constraint are flat And/Or; the IR allows
 *  nesting + `not` + `in` + `eq_seq` so the same IR can later lower to the OZ
 *  predicate DSL. Week-1 adapters only lower the flat supported subset and flag
 *  the rest. */
export type IRCondition =
  | { op: 'and' | 'or'; children: IRCondition[] }
  | { op: 'not'; child: IRCondition }
  | { op: 'compare'; compare: IRCompare }
  | { op: 'in'; selector: IRSelector; values: string[] }
  /** Exact ordered sequence equality. The IR-level selector value MUST EQUAL
   *  `values` as an ORDERED sequence (e.g. a swap hop `path`). `in` is pure
   *  set membership and cannot express order; `eq_seq` is the construct that
   *  does. Adapters that cannot express an exact ordered vector (OZ built-ins)
   *  flag this as `uncovered` rather than silently dropping it. */
  | { op: 'eq_seq'; selector: IRSelector; values: string[] }

export interface IRPolicyRule {
  /** NEAR-V2 roles whitelist (empty = any; owner exempt). */
  roles: string[]
  /** NEAR-V2 scope filter; each field optional (absent = wildcard). */
  scope: { chainId?: number; contract?: string; method?: string }
  /** NEAR-V2 guard (applicability; skip the rule when it fails). */
  guard?: IRCondition
  /** NEAR-V2 constraint (AND; reject the transaction when any fails). */
  constraints: IRCondition[]
  // --- OZ extensions ---
  /** M-of-N approval (OZ threshold primitives). */
  approval?: { kind: 'threshold'; threshold: number; weights?: Record<string, number> }
  /** OZ context-rule expiry. */
  expiry?: { validUntilLedger?: number; validUntilUnixSeconds?: number }
}

export interface PolicyIR {
  /** NEAR-V2 PolicyChain. */
  chain: 'stellar' | 'evm'
  /** NEAR-V2 DefaultBehavior. OZ context rules are deny-by-default, so
   *  `deny_all` is the OZ default fallback when no rule matches. */
  defaultBehavior: 'allow_all' | 'deny_all'
  rules: IRPolicyRule[]
}
