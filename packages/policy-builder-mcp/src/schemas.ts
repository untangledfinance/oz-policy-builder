// packages/policy-builder-mcp/src/schemas.ts
//
// MCP-only tool shapes. The CORE input/output schemas and the MCP server
// registrations all live on `@crediolabs/policy-synth` (the tool-body glue
// sits at `@crediolabs/policy-synth/run`; the underlying Zod input schemas
// live at `@crediolabs/policy-synth/run`). What stays here is just the flat
// `ZodRawShape` needed by `@modelcontextprotocol/sdk`'s `tool()` registration
// API, which does not accept the strict discriminated union `synthesize_policy`
// needs.
//
// The body of every tool call re-validates against the strict schemas via
// `runRecordTransaction` / `runSynthesizePolicy`, so wire inputs still
// fail closed. The mutual-exclusion rules (e.g. exactly-one-of hash/xdr)
// live on the strict schemas, NOT on the tool shape; the SDK does not
// invoke `.refine()` at registration time, so any refined rule must be
// re-checked in the body.
//
// The tool-shape fields below are hand-rolled simple types rather than
// references into the refined strict schemas (`.refine()` returns
// `ZodEffects`, which has no `.shape`). They MUST stay in lockstep with
// the strict schemas - a drift in field type or optionality breaks the
// SDK's emitted JSON Schema.

import {
  ComposeUserResponsesSchema,
  GetInterpreterInfoInputSchema,
  InstallPolicyInputSchema,
  InterpreterOptionsSchema,
  NetworkSchema,
  PredicateNodeSchema,
  RecordedTransactionSchema,
  RecordTransactionInputSchema,
  RevokePolicyInputSchema,
  SynthesizePolicyInputSchema,
  ToolErrorSchema,
} from '@crediolabs/policy-synth/run'
import { z } from 'zod'

// Re-export the strict schemas so MCP package consumers (and existing tests)
// still get them from this module. The canonical home is
// `@crediolabs/policy-synth/run`; the re-exports here are a shim kept for
// backward compatibility with downstream callers that imported from the MCP
// package directly.
export {
  ComposeUserResponsesSchema,
  GetInterpreterInfoInputSchema,
  InstallPolicyInputSchema,
  InterpreterOptionsSchema,
  NetworkSchema,
  PredicateNodeSchema,
  RecordedTransactionSchema,
  RecordTransactionInputSchema,
  RevokePolicyInputSchema,
  SynthesizePolicyInputSchema,
  ToolErrorSchema,
}

/** Flat ZodRawShape used for the MCP SDK tool registration. The body
 *  re-validates against `RecordTransactionInputSchema` so the mutual-exclusion
 *  rule still fires (the SDK does not invoke `.refine()` at registration time). */
export const RecordTransactionToolShape = {
  hash: z.string().min(1).optional(),
  xdr: z.string().min(1).optional(),
  network: NetworkSchema,
  confidenceOverride: z.number().min(0).max(1).optional(),
} as const

/** Flat ZodRawShape used for MCP tool registration. Every field is optional
 *  so the JSON-Schema the SDK exposes to clients stays permissive; the body
 *  re-validates against the strict schema. */
export const SynthesizePolicyToolShape = {
  source: z.literal('recording').optional(),
  recordedTx: RecordedTransactionSchema.optional(),
  network: NetworkSchema.optional(),
  userResponses: ComposeUserResponsesSchema.optional(),
  confidenceOverride: z.object({ threshold: z.number().min(0).max(1) }).optional(),
  interpreter: InterpreterOptionsSchema.optional(),
  // Without this the tool chain has no join. A ProposedPolicy carries
  // `policyDocuments[].encodedPredicate` (canonical ScVal bytes), while
  // `simulate_policy` and `verify_policy` both want the PredicateNode TREE,
  // and the tree is only returned under `explain`. Omitting it here left an
  // MCP client able to synthesize a policy and then unable to prove anything
  // about it - the two checks were reachable only with `predicate: null`,
  // which skips the interpreter predicate entirely.
  explain: z.boolean().optional(),
} as const

/** `simulate_policy` and `verify_policy` share their input: the predicate tree
 *  (from `synthesize_policy` under `explain`) plus the recording it was
 *  synthesised from. */
const PolicyCheckToolShape = {
  predicate: PredicateNodeSchema,
  permitTx: RecordedTransactionSchema,
  validUntilLedger: z.number().int().positive().optional(),
} as const

export const SimulatePolicyToolShape = { ...PolicyCheckToolShape } as const
export const VerifyPolicyToolShape = { ...PolicyCheckToolShape } as const

export type {
  GetInterpreterInfoInput,
  InstallPolicyInput,
  RevokePolicyInput,
  SimulatePolicyInput,
  VerifyPolicyInput,
} from '@crediolabs/policy-synth/run'

/** Common base for `install_policy` and `revoke_policy`: smartAccount,
 *  sourceAccount, target network, optional RPC URL, optional base fee. Both
 *  share the same smart-account context, so the SDK-emitted JSON Schema stays
 *  identical for those fields. The body re-validates against the strict
 *  schemas in `@crediolabs/policy-synth/run`. */
const SmartAccountToolShape = {
  smartAccount: z.string().min(1).optional(),
  sourceAccount: z.string().min(1).optional(),
  /** Omitting this from the shape made both tools testnet-ONLY. The input
   *  schema defaults `network` to `testnet` and expects a mainnet caller to
   *  set it, but a field absent from the tool shape is STRIPPED before the
   *  body runs, so an MCP client could not reach the mainnet pin at all. The
   *  failure presented as a deliberate testnet pin rather than as a missing
   *  parameter, which sent integrators to build the install by hand. */
  network: NetworkSchema.optional(),
  rpcUrl: z.string().url().optional(),
  baseFee: z.number().int().positive().optional(),
}

/** Flat ZodRawShape for `declare_policy`. The DECLARATIVE front-end: the
 *  constraint stated outright, with no transaction to decode. Every field is
 *  optional except `fn`; the body re-validates against the strict
 *  `DeclarePolicyInputSchema`, which is `.strict()` and so refuses the removed
 *  MandateSpec fields (`spendingLimit`, `approvalThreshold`) rather than
 *  accepting them in silence. */
export const DeclarePolicyToolShape = {
  fn: z.string().min(1),
  contract: z.string().optional(),
  maxAmount: z.string().optional(),
  amountArgIndex: z.number().int().nonnegative().optional(),
  amountPath: z
    .object({
      argIndex: z.number().int().nonnegative(),
      element: z.number().int().nonnegative(),
      field: z.string().min(1),
    })
    .optional(),
  recipients: z.array(z.string()).optional(),
  recipientArgIndex: z.number().int().nonnegative().optional(),
  allowZeroCap: z.boolean().optional(),
  minOutputRatio: z
    .object({
      num: z.string(),
      den: z.string(),
      inputArgIndex: z.number().int().nonnegative(),
      outputArgIndex: z.number().int().nonnegative(),
    })
    .optional(),
} as const

/** Flat ZodRawShape for `install_policy`. `rule` is typed as `z.unknown()`
 *  at the tool boundary because the rule schema is a discriminated union
 *  the SDK does not accept at registration; the body re-validates
 *  against `InstallPolicyInputSchema`. `encodedPredicate` /
 *  `predicateHash` live INSIDE `rule.policies[].predicateBlobBase64`
 *  (the policy already carries the encoded predicate); the run-layer
 *  extracts them from there. */
export const InstallPolicyToolShape = {
  ...SmartAccountToolShape,
  /** Rules already on the account. Supplying them turns on the cross-rule
   *  authority scan; omitting them returns `authorityScan: null`, which means
   *  "not checked" rather than "nothing found". */
  existingRules: z.array(z.unknown()).optional(),
  rule: z.unknown().optional(),
  installNonce: z.number().int().positive().optional(),
  interpreterAddress: z.string().optional(),
} as const

/** Flat ZodRawShape for `revoke_policy`. */
export const RevokePolicyToolShape = {
  ...SmartAccountToolShape,
  ruleId: z.number().int().nonnegative().optional(),
  interpreterAddress: z.string().optional(),
} as const

/** Flat ZodRawShape for `get_interpreter_info`. `verifyLive` triggers an
 *  optional RPC `grammar_version()` call so the caller can verify the
 *  deployed contract matches the pin. */
export const GetInterpreterInfoToolShape = {
  network: z.enum(['mainnet', 'testnet']).optional(),
  verifyLive: z.boolean().optional(),
  rpcUrl: z.string().url().optional(),
} as const
