// src/ir/types.ts - the PolicyIR ("Policy Tree").
//
// `PolicyIR` is the custody-agnostic "Policy Tree" hub (the diagram's Policy
// Tree) that every CustodyAdapter compiles FROM. It generalizes the NEAR-V2
// policy schema (roles / scope filter / guard / constraint / comparison leaves /
// default behaviour) into one chain-neutral shape and extends it with the
// single IR can serve every backend. NEAR-V2 has no stateful spend window,
// below and are only lowered by adapters that declare support for them.

/** Comparison operator. Mirrors NEAR-V2 `CompOp`. */
export type IRCompOp = 'eq' | 'lte'

/** Boolean combinator. Mirrors NEAR-V2 `LogicOp`. */
export type IRLogic = 'and'

/** Scalar value type. The subset the predicate grammar has a literal for. */
export type IRScalarType = 'address' | 'i128' | 'u32' | 'symbol'

/** WHERE in the authorized call a value is read. NEAR-V2 selectors first, OZ
 *  extensions after (an adapter that cannot express an extension flags it). */
export type IRSelector =
  // --- NEAR-V2 selectors ---
  | { kind: 'arg'; argIndex: number; scalarType: IRScalarType } // Stellar StellarComp
  | { kind: 'arg_len'; argIndex: number } // length of a vec-typed argument as u32
  | {
      kind: 'arg_field'
      argIndex: number
      element: number
      field: string
      scalarType: IRScalarType
    } // field of a map element within a vec-typed argument

/** A single comparison leaf. `value` is a decimal/hex string (i128-safe;
 *  never a JS number). */
export interface IRCompare {
  selector: IRSelector
  operator: IRCompOp
  value: string
}

/** Condition tree. NEAR-V2 guard/constraint are flat And/Or; the IR allows
 *  nesting + `not` + `in` + `eq_seq` so the same IR can later lower to the OZ
 *  predicate DSL. Week-1 adapters only lower the flat supported subset and flag
 *  the rest. */
export type IRCondition =
  | { op: 'and'; children: IRCondition[] }
  | { op: 'compare'; compare: IRCompare }
  | { op: 'in'; selector: IRSelector; values: string[] }
  /** Exact ordered sequence equality. The IR-level selector value MUST EQUAL
   *  `values` as an ORDERED sequence (e.g. a swap hop `path`). `in` is pure
   *  set membership and cannot express order; `eq_seq` is the construct that
   *  does. Adapters that cannot express an exact ordered vector (OZ built-ins)
   *  flag this as `uncovered` rather than silently dropping it. */
  | { op: 'eq_seq'; selector: IRSelector; values: string[] }

export interface IRPolicyRule {
  /** NEAR-V2 scope filter; each field optional (absent = wildcard). */
  scope: { contract?: string; method?: string }
  /** NEAR-V2 constraint (AND; reject the transaction when any fails). */
  constraints: IRCondition[]
  /** OZ context-rule expiry, by ledger sequence - the only clock the OZ
   *  account model exposes to a rule. */
  expiry?: { validUntilLedger?: number }
}

export interface PolicyIR {
  rules: IRPolicyRule[]
}
