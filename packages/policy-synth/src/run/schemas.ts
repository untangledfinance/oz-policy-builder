// packages/policy-synth/src/run/schemas.ts
//
// Zod schemas mirroring the policy-synth core domain types. These are the
// public input / output shapes exposed over MCP and the CLI. They are kept
// hand-written (rather than derived) because the MCP SDK needs a runtime
// Zod object at the transport boundary; a drift test asserts they stay in
// step with the TS source of truth.
//
// i128 amounts and other large integers are carried as base-10 decimal strings
// end-to-end. Networks are pinned to the same closed set the core defines.
// `source` is a single-variant discriminator (`recording`); it stays a union
// so an unknown value is rejected with a discriminator error.
//
// This module is the SINGLE source of truth for these shapes. The MCP package
// imports them here so its tool-shape bindings stay in step; the CLI imports
// them here so it can build the same args envelope the MCP transport builds.

import { StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'
import { isStellarAddress } from '../synth/address.ts'

/** Soroban `valid_until` is a u32 ledger sequence; a value above this cannot be
 *  installed on-chain, so reject it at the boundary (fail-closed). */
const U32_MAX = 4294967295
/** Upper bound on top-level invocations in a recorded transaction. A real
 *  Stellar tx caps operations well below this; the bound stops a hand-crafted
 *  payload from turning one request into an unbounded synthesis (DoS). */
const MAX_INVOCATIONS = 512

export const NetworkSchema = z.enum(['mainnet', 'testnet'])
export type Network = z.infer<typeof NetworkSchema>

/** ScVal subset - normalised subset the synth consumes. Mirrors
 *  `ScVal` in packages/policy-synth/src/types.ts. */
export const ScValSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('address'), value: z.string() }),
    // i128 is SIGNED: real events carry negatives (e.g. a fee-adjustment/refund),
    // so the recorder's own output must round-trip through this schema. u64/u32
    // are unsigned and stay non-negative.
    z.object({ type: z.literal('i128'), value: z.string().regex(/^-?[0-9]+$/) }),
    z.object({ type: z.literal('u64'), value: z.string().regex(/^[0-9]+$/) }),
    z.object({ type: z.literal('u32'), value: z.string().regex(/^[0-9]+$/) }),
    z.object({ type: z.literal('symbol'), value: z.string() }),
    z.object({ type: z.literal('vec'), value: z.array(ScValSchema) }),
    // Map mirrors the core ScVal. Real Blend `submit` calls carry a vec of maps
    // as the request argument, so omitting it here made the synthesizer reject a
    // recording its own recorder had just produced at full confidence.
    z.object({
      type: z.literal('map'),
      value: z.array(z.object({ key: z.string(), val: ScValSchema })),
    }),
    z.object({ type: z.literal('bytes'), value: z.string() }),
    z.object({ type: z.literal('other'), value: z.string() }),
  ])
)

/** ContractInvocation mirrors the core. Annotated with an explicit
 *  `z.ZodType<unknown>` (like ScValSchema above) so the self-referential
 *  `subInvocations` field does not trip TS's circular type inference. */
export const ContractInvocationSchema: z.ZodType<unknown> = z.object({
  contract: z.string(),
  fn: z.string(),
  args: z.array(ScValSchema),
  subInvocations: z.array(z.lazy(() => ContractInvocationSchema)),
})

export const TokenMovementSchema = z.object({
  token: z.string(),
  from: z.string(),
  to: z.string(),
  // The recorder reads the amount straight from the signed i128 event value
  // (record/movements.ts readAmount), so a non-standard token that emits a
  // negative transfer/mint/burn amount round-trips as a negative string. Mirror
  // that here; the synth gate, not the wire schema, decides what to do with it.
  amount: z.string().regex(/^-?[0-9]+$/),
})

export const OnChainEventSchema = z.object({
  contract: z.string(),
  topics: z.array(z.string()),
  data: ScValSchema,
})

export const ParseConfidenceSchema = z.object({
  overall: z.number().min(0).max(1),
  knownContracts: z.array(z.string()),
  unknownContracts: z.array(
    z.object({
      contract: z.string(),
      reason: z.enum(['no-abi', 'version-mismatch', 'opaque-result']),
    })
  ),
  opaqueScVals: z.array(z.object({ path: z.string(), type: z.string() })),
  thresholdUsed: z.number().min(0).max(1),
})

/** RecordedTransaction mirrors the core RecordedTransaction. The output shape
 *  is referenced by name in the tool result structured content; we deliberately
 *  type it loosely (`z.unknown()`) on the success path so the core remains the
 *  single source of truth for the wire payload. */
export const RecordedTransactionSchema = z
  .object({
    network: NetworkSchema,
    signers: z.array(z.string()),
    invocations: z.array(ContractInvocationSchema).max(MAX_INVOCATIONS),
    tokenMovements: z.array(TokenMovementSchema),
    events: z.array(OnChainEventSchema),
    authEntries: z.array(z.unknown()),
    ledgerSequence: z.number().int().nonnegative(),
    fetchedAt: z.number().int().nonnegative(),
    parseConfidence: ParseConfidenceSchema,
    sourceAccount: z.string(),
  })
  .passthrough()

export const ComposeUserResponsesSchema = z
  .object({
    validUntilLedger: z.number().int().positive().max(U32_MAX).optional(),
    limitAmount: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    // Swap recipient allowlist (SoroSwap call_arg[3]). Each entry must be a
    // Stellar address (G... wallet or C... contract); supplying it REPLACES the
    // default pin to the recorded recipient. Validated with the shared StrKey
    // helper (no hand-rolled regex).
    swapRecipientAllowlist: z
      .array(z.string().refine(isStellarAddress, 'must be a Stellar address (G... or C...)'))
      .optional(),
  })
  // Strict, not passthrough: a response key the synthesiser no longer reads
  // (or a typo) would otherwise be accepted in silence, and the caller would
  // believe they had answered a question that is still open.
  .strict()

export const RecordTransactionInputSchema = z
  .object({
    hash: z.string().min(1).optional(),
    xdr: z.string().min(1).optional(),
    network: NetworkSchema,
    confidenceOverride: z.number().min(0).max(1).optional(),
  })
  .refine((v) => !(v.hash && v.xdr), {
    message: 'provide exactly one of `hash` or `xdr`, not both',
  })
  .refine((v) => Boolean(v.hash) || Boolean(v.xdr), {
    message: 'one of `hash` or `xdr` is required',
  })
export type RecordTransactionInput = z.infer<typeof RecordTransactionInputSchema>

export const InterpreterOptionsSchema = z.object({
  smartAccountAddress: z.string(),
  installNonce: z.number().int().positive().optional(),
})

export const SynthesizePolicyInputSchema = z
  .object({
    source: z.literal('recording'),
    // Two ways to name the recording, because an MCP client has no variable to
    // pass by reference. `recordedTx` is the full RecordedTransaction, which a
    // programmatic caller can hand straight over from `record_transaction`. An
    // agent cannot: it sees that output as text and has to retype it, and the
    // payload is thousands of characters and a dozen levels deep, with exact
    // i128 strings that do not survive the round trip. `transactionHash` lets the
    // agent carry a 64-character handle instead and have the server re-record.
    //
    // Re-recording rather than caching keeps the server stateless (see
    // build-install-policy.ts). Recording is deterministic for a settled
    // transaction, so the second read returns the same thing as the first.
    recordedTx: RecordedTransactionSchema.optional(),
    transactionHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'transaction hash must be 64 lowercase hex characters')
      .optional(),
    network: NetworkSchema,
    userResponses: ComposeUserResponsesSchema.optional(),
    confidenceOverride: z.object({ threshold: z.number().min(0).max(1) }).optional(),
    interpreter: InterpreterOptionsSchema.optional(),
    // --explain opt-in. When true, the orchestrator attaches the
    // in-memory PredicateNode + the corresponding SimulationResult
    // (real one from the self-verify pipeline when the interpreter is
    // engaged, minimal honest value otherwise) to the success envelope.
    // Absent or false -> the success envelope is unchanged (byte-identical
    // to today). The flag is ADDITIVE: the existing ProposedPolicy fields
    // (encodedPredicate, predicateHash, etc.) are never altered by enabling
    // explain.
    explain: z.boolean().optional(),
  })
  .refine((v) => v.recordedTx !== undefined || v.transactionHash !== undefined, {
    message:
      'supply either `recordedTx` (the full recording) or `transactionHash` (and the server will record it)',
  })

export type SynthesizePolicyInput = z.infer<typeof SynthesizePolicyInputSchema>

// ===== PredicateNode / PredicateLeaf =====
//
// Hand-written zod mirrors of the predicate grammar in types.ts:132-180.
// Recursive (`and`/`or`/`not` nest), so the schemas use the same
// `z.lazy` + explicit `z.ZodType<unknown>` annotation that ScValSchema
// already uses - without the annotation TS's circular type inference
// breaks the recursive reference. i128-shaped numerics (`num`, `den`)
// are decimal STRINGS, never JS numbers, matching the on-chain i128
// convention used everywhere else in this file. The grammar is the
// single source of truth (types.ts); a drift test in this package
// asserts the two stay in step.

/** PredicateLeaf mirrors the core `PredicateLeaf` union. Every variant
 *  is a `kind` discriminator; literals carry their primitive value inline.
 *  `literal_vec.elements` is recursive (a vec may contain literals that
 *  themselves nest) so the leaf schema is lazily self-referential. */
export const PredicateLeafSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('call_contract') }),
    z.object({ kind: z.literal('call_fn') }),
    z.object({ kind: z.literal('call_arg'), index: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('call_arg_len'), index: z.number().int().nonnegative() }),
    z.object({
      kind: z.literal('call_arg_field'),
      index: z.number().int().nonnegative(),
      element: z.number().int().nonnegative(),
      field: z.string(),
    }),
    // num/den are i128 decimal strings, matching `literal_i128`. The regex
    // is the boundary guard; the ratio's SIGN is checked at encode, where
    // the message can explain that a negative ratio inverts the comparison.
    z.object({
      kind: z.literal('call_arg_scaled'),
      index: z.number().int().nonnegative(),
      num: z.string().regex(/^-?[0-9]+$/),
      den: z.string().regex(/^-?[0-9]+$/),
    }),
    z.object({ kind: z.literal('literal_address'), value: z.string() }),
    z.object({ kind: z.literal('literal_i128'), value: z.string().regex(/^-?[0-9]+$/) }),
    z.object({ kind: z.literal('literal_symbol'), value: z.string() }),
    // `literal_u32` is u32 on chain. A negative value would wrap, and a
    // value above U32_MAX would be refused at the encode boundary
    // anyway. Bound at the schema so the wire cannot carry a value the
    // contract will reject.
    z.object({
      kind: z.literal('literal_u32'),
      value: z.number().int().nonnegative().max(U32_MAX),
    }),
    // elements are themselves PredicateLeaf; lazy to break the cycle.
    z.object({ kind: z.literal('literal_vec'), elements: z.array(PredicateLeafSchema) }),
  ])
)

/** PredicateNode mirrors the core `PredicateNode` union. Recursive through
 *  `and`; the lazy + annotation pattern keeps the recursion type-safe. */
export const PredicateNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('and'), children: z.array(PredicateNodeSchema) }),
    z.object({ op: z.literal('or'), children: z.array(PredicateNodeSchema) }),
    z.object({
      op: z.literal('eq'),
      left: PredicateLeafSchema,
      right: PredicateLeafSchema,
    }),
    z.object({
      op: z.literal('lt'),
      left: PredicateLeafSchema,
      right: PredicateLeafSchema,
    }),
    z.object({
      op: z.literal('lte'),
      left: PredicateLeafSchema,
      right: PredicateLeafSchema,
    }),
    z.object({
      op: z.literal('gt'),
      left: PredicateLeafSchema,
      right: PredicateLeafSchema,
    }),
    z.object({
      op: z.literal('gte'),
      left: PredicateLeafSchema,
      right: PredicateLeafSchema,
    }),
    z.object({
      op: z.literal('in'),
      needle: PredicateLeafSchema,
      haystack: z.array(PredicateLeafSchema),
    }),
  ])
)

// ===== simulate_policy / verify_policy =====
//
// Both tools evaluate the same predicate against the same recording, so they
// take the same input. A null predicate used to mean "OZ built-in policies
// only"; that backend is gone, so every policy carries a predicate and there is
// nothing to simulate without one.
export const SimulatePolicyInputSchema = z
  .object({
    // Same two ways in as `synthesize_policy`, for the same reason. The tree
    // is only returned under `explain`, so a caller who did not ask for it has
    // nothing to pass here and skips the check entirely - which is the one
    // step that must not be skippable by accident. `transactionHash` re-records and
    // re-synthesizes, so the predicate checked is the predicate that was built.
    predicate: PredicateNodeSchema.optional(),
    /** The canonical encoding `declare_policy` and `synthesize_policy` both
     *  return. A DECLARED policy has no recording behind it, so re-synthesizing
     *  from a hash would check a different predicate than the one declared -
     *  and the tree is the shape callers mistype. One opaque string is the
     *  handle that path was missing. */
    encodedPredicate: z.string().optional(),
    permitTx: RecordedTransactionSchema.optional(),
    transactionHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'transaction hash must be 64 lowercase hex characters')
      .optional(),
    network: NetworkSchema.optional(),
    /** Needed only with `transactionHash`: lowering a recording to an interpreter
     *  predicate is scoped to the account it will be installed on, and the
     *  self-call gate is defined against it. */
    smartAccount: z.string().optional(),
    userResponses: ComposeUserResponsesSchema.optional(),
    validUntilLedger: z.number().int().positive().max(U32_MAX).optional(),
  })
  // Two halves, each satisfiable on its own terms: something to check, and a
  // call to check it against. `transactionHash` alone answers both.
  .refine(
    (v) =>
      v.transactionHash !== undefined ||
      ((v.predicate !== undefined || v.encodedPredicate !== undefined) && v.permitTx !== undefined),
    {
      message:
        'supply `transactionHash` (and the server will record and synthesize), or a predicate (`predicate` tree or `encodedPredicate` string) together with `permitTx` or `transactionHash`',
    }
  )
export type SimulatePolicyInput = z.infer<typeof SimulatePolicyInputSchema>

export const VerifyPolicyInputSchema = SimulatePolicyInputSchema
export type VerifyPolicyInput = z.infer<typeof VerifyPolicyInputSchema>

// ===== install_policy / revoke_policy / get_interpreter_info =====
//
// The install/revoke pair drives the OZ smart-account admin flow. Both surface
// unsigned Soroban transaction XDRs (base64) and the tool body NEVER signs:
// the wallet signature IS the user-confirmation step. See `run/index.ts` for
// the rationale (no `action_id` two-call pair; the MCP server is stateless).
//
// `get_interpreter_info` is a read-only fingerprint lookup. It returns the
// pinned address + grammar version + wasm hash AND, when requested, runs an
// optional `grammar_version()` RPC call to check whether the deployed contract
// matches the pin. A mismatch is worth MORE than a fabricated audit field.
//
// All three input schemas live BELOW the ContextRuleDraftSchema declaration
// so the const reference there is not in the temporal dead zone (no JS hoisting
// for `const`).

/** Minimal rule-draft schema for the install input. Mirrors ContextRuleDraft
 *  from the core (`types.ts`); we keep this hand-rolled + flat rather than
 *  importing the recursive discriminated union because the wire shape is
 *  fixed (the user supplies one rule, not a nested AST). Declared BEFORE
 *  InstallPolicyInputSchema below so the const reference there is not in
 *  the temporal dead zone (no JS hoisting for `const`). */
const MAX_SIGNERS_PER_RULE = 15
const MAX_POLICIES_PER_RULE = 5

const SignerDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delegated'), address: z.string() }),
  z.object({ kind: z.literal('external'), verifier: z.string(), keyBytes: z.string() }),
])

const ContextTypeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }),
  z.object({ kind: z.literal('call_contract'), contract: z.string() }),
  z.object({ kind: z.literal('create_contract'), wasmHash: z.string() }),
])

/** A rule ALREADY on the account, as the caller observed it. Supplying these
 *  turns on the cross-rule authority scan: a signer belonging to several rules
 *  picks which one applies, so a predicate only constrains a key when the
 *  policed rule is the only rule that key is on. */
export const ObservedRuleSchema = z.object({
  id: z.number().int().nonnegative(),
  contextType: ContextTypeSchema,
  signers: z.array(SignerDraftSchema),
  policyAddresses: z.array(z.string()),
  predicate: PredicateNodeSchema.optional(),
})

const ContextRuleDraftSchema = z
  .object({
    contextRuleType: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('default') }),
      z.object({ kind: z.literal('call_contract'), contract: z.string() }),
      z.object({ kind: z.literal('create_contract'), wasmHash: z.string() }),
    ]),
    name: z.string().min(1),
    validUntilLedger: z.number().int().positive().max(U32_MAX).nullable(),
    signers: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('delegated'), address: z.string() }),
          z.object({
            kind: z.literal('external'),
            verifier: z.string(),
            keyBytes: z.string(),
          }),
        ])
      )
      .max(MAX_SIGNERS_PER_RULE),
    /** Policies on one rule compose as ALL-OF, so an interpreter predicate and
     *  an OpenZeppelin built-in can sit together and both must permit. That
     *  pairing is what expresses a rolling total: the predicate bounds each
     *  call, the built-in bounds the sum across calls. */
    policies: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('interpreter'),
            interpreterAddress: z.string(),
            predicateBlobBase64: z.string().min(1),
          }),
          z.object({
            kind: z.literal('spending_limit'),
            policyAddress: z.string(),
            /** LEDGERS, not seconds. */
            periodLedgers: z.number().int().positive().max(U32_MAX),
            spendingLimit: z.string().regex(/^[0-9]+$/),
          }),
        ])
      )
      .max(MAX_POLICIES_PER_RULE),
  })
  .passthrough()
  .refine(
    (v) => !(v.signers.length === 0 && v.policies.length === 0),
    'a rule with no signers and no policies is refused at install (NoSignersAndPolicies)'
  )

// install/revoke/get_info schemas live HERE (after the helper) so the const
// reference resolves at module init. They are the new tools on top of the
// existing four.

/** Pinned interpreter address (testnet).
 *  Single source for the MCP layer; do not embed elsewhere. */
export const PINNED_INTERPRETER_TESTNET_ADDRESS =
  'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5'

/** Pinned interpreter address (mainnet), redeployed 2026-08-22 for grammar 4, from a reproducible build. The mainnet
 *  interpreter IS the binary exercised on testnet - both instances were created
 *  from the same uploaded wasm hash (see PINNED_INTERPRETER_WASM_SHA256), and
 *  both were read back with `grammar_version()` returning 4. The address differs
 *  because instance ids are network-scoped. UNAUDITED at the time of writing.
 *
 *  These four constants move together or not at all. The grammar version and
 *  wasm hash are single values covering BOTH networks, so re-pinning one network
 *  alone would have the builder emit a version the other network refuses - with
 *  a green test run, since `grammar-version-parity.test.ts` would then pass. */
export const PINNED_INTERPRETER_MAINNET_ADDRESS =
  'CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52'

/** Pinned interpreter wasm sha256 (hex). */
export const PINNED_INTERPRETER_WASM_SHA256 =
  'b5ba1e35ccf20cd8c13c3a2c3098bf337033a92bcaf475d63c03ddc0cba0fcae'

/** The grammar version the interpreter enforces (matches SELF_VERSION in
 *  contracts/policy-interpreter/src/version.rs). */
export const PINNED_INTERPRETER_GRAMMAR_VERSION = 4

/** Default Soroban RPC for the install / revoke / info tools. The recorder
 *  keeps its own copy in record/rpc.ts because it hands back a fetcher rather
 *  than a Server; the two are deliberately different surfaces, so this is
 *  pinned beside the addresses it is used with rather than shared. */
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org'

/** Mainnet Soroban RPC. Pinned beside MAINNET counterparts so the install
 *  and get_interpreter_info gates compare against the matching network's
 *  RPC rather than always testnet. Public mainnet endpoint, the same one
 *  the deploy script hit during the 2026-08-04 mainnet rollout. */
export const MAINNET_RPC_URL = 'https://mainnet.sorobanrpc.com'

/** Pin + RPC lookup for the gate enforcement. The interpreters' wasm sha256
 *  is identical across both networks (the same binary was uploaded both
 *  places), so `PINNED_INTERPRETER_WASM_SHA256` stays
 *  a single constant - only the addresses and RPCs are network-scoped. */
export const PINNED_INTERPRETER_ADDRESS_BY_NETWORK: Record<Network, string> = {
  testnet: PINNED_INTERPRETER_TESTNET_ADDRESS,
  mainnet: PINNED_INTERPRETER_MAINNET_ADDRESS,
}
export const RPC_URL_BY_NETWORK: Record<Network, string> = {
  testnet: TESTNET_RPC_URL,
  mainnet: MAINNET_RPC_URL,
}

/** The OpenZeppelin built-in policies we deployed instances of. These are OZ
 *  EXAMPLE contracts, built by us from `OpenZeppelin/stellar-contracts` at tag
 *  v0.7.2 and deployed by us. We have NOT audited them and upstream ships an
 *  "experimental software ... as is" disclaimer; anything surfacing one of
 *  these to a user must say so rather than implying we vouch for the code.
 *  Provenance detail in `docs/audit/README.md` finding 7. */
export type OzBuiltinPolicy = 'spending_limit' | 'simple_threshold' | 'weighted_threshold'

/** The upstream tag the deployed policy instances were built from. Exported so
 *  `scripts/upstream-drift-check.ts` can compare it against the latest upstream
 *  release; a tag recorded only in prose cannot be checked by anything. */
export const PINNED_OZ_STELLAR_CONTRACTS_TAG = 'v0.7.2'

/** Instance addresses per network. Exported so consumers import the pin
 *  instead of copying a literal - a copied address is how a testnet id ends up
 *  being queried against mainnet, which returns `Error(Storage, MissingValue)`
 *  and reads exactly like "nothing is deployed there".
 *
 *  Instance ids are network-scoped, so the addresses differ while the wasm
 *  hash does not: each pair below was created from the same uploaded wasm (see
 *  `PINNED_OZ_POLICY_WASM_SHA256`), verified by fetching the deployed bytes
 *  back from both networks. */
export const PINNED_OZ_POLICY_ADDRESS_BY_NETWORK: Record<
  Network,
  Record<OzBuiltinPolicy, string>
> = {
  testnet: {
    spending_limit: 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP',
    simple_threshold: 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6',
    weighted_threshold: 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2',
  },
  mainnet: {
    spending_limit: 'CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A',
    simple_threshold: 'CDOGPGUFGGUDG25P3TG6XIXJKRRYOZ3PXUZIEPVH74KXRZIDKZ5HYEOS',
    weighted_threshold: 'CDWPZ4YZ3YIJ64XSHRMERRF2L2H7XD6SPUZDP3KI56T7QXQCICC25V3J',
  },
}

/** sha256 of each deployed policy wasm, identical across both networks. */
export const PINNED_OZ_POLICY_WASM_SHA256: Record<OzBuiltinPolicy, string> = {
  spending_limit: '9ce30ea1fe5c2dc5c9c49cf3462adb32e2c11d7dfadb15ef43a51ba56568de2b',
  simple_threshold: '01c0be09eb6fb288cab2e878b4e890f7a38f75afab99aeb197861f44e2e2dfe6',
  weighted_threshold: '78030272b06afb09d2949ab8877c9a8ae1ab9025b48f4edafd5816cc44f76eaa',
}

/** Stellar network passphrases. Pinned here so the XDR envelope uses the
 *  matching passphrase when the wallet signs (a mismatch yields invalid
 *  hashes). */
export const NETWORK_PASSPHRASES: Record<Network, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
}

// Stellar strkey shapes (StrKey base32, no checksum byte, version byte
// 0x30/0x40 prefixed by the decoder, then 32 base32 chars giving a 56-char
// total). The shared `isStellarAddress` helper accepts BOTH wallet (G...) and
// contract (C...) addresses; the install schema has to distinguish them
// because the smart account is a contract (C...) - a wallet address would
// mean the rule is being installed against the WRONG account kind entirely.
// `sourceAccount` is the signing wallet (G...).
const STELLAR_CONTRACT_ADDRESS = /^C[2-7A-Z]{55}$/
const STELLAR_ACCOUNT_ADDRESS = /^G[2-7A-Z]{55}$/

// The regexes above check SHAPE only. A wrong-but-well-formed address - the
// classic case being one an agent reproduced from memory - passes them and then
// fails the SDK's StrKey decoder deep inside the build, where the throw is
// caught by the tool envelope and reported as a bare "invalid checksum" naming
// no field. A caller holding several addresses then cannot tell which one is
// wrong. Validating the checksum HERE keeps the field name attached.
const contractAddress = (field: string) =>
  z
    .string()
    .regex(STELLAR_CONTRACT_ADDRESS, `${field} must be a Stellar contract address (C...)`)
    .refine(
      StrKey.isValidContract,
      `${field} is not a valid contract address: the checksum does not match, so this address does not exist`
    )
const accountAddress = (field: string) =>
  z
    .string()
    .regex(STELLAR_ACCOUNT_ADDRESS, `${field} must be a Stellar account address (G...)`)
    .refine(
      StrKey.isValidEd25519PublicKey,
      `${field} is not a valid account address: the checksum does not match, so this address does not exist`
    )

// ===== declare_policy =====
//
// The declarative front-end: the constraint stated outright, with no
// transaction to decode. Deliberately NOT a revival of the removed
// `MandateSpec` - that carried a rolling `spendingLimit` the interpreter
// cannot evaluate and an `approvalThreshold` needing OZ primitives nobody
// deployed. Only fields grammar 3 can actually enforce appear here.
export const DeclarePolicyInputSchema = z
  .object({
    fn: z.string().min(1, 'fn must name the method to pin'),
    contract: z
      .string()
      .regex(STELLAR_CONTRACT_ADDRESS, 'contract must be a Stellar contract address (C...)')
      .optional(),
    /** Smallest unit, unsigned decimal STRING - an i128 is wider than
     *  Number.MAX_SAFE_INTEGER, so a number here would silently round. */
    maxAmount: z
      .string()
      .regex(/^[0-9]+$/, 'maxAmount must be an unsigned integer in the smallest unit')
      .optional(),
    amountArgIndex: z.number().int().nonnegative().max(U32_MAX).optional(),
    /** Nested amount location, for a call whose amount is a field inside a
     *  struct argument rather than an argument of its own. Every coordinate is
     *  REQUIRED - `declarePredicate` defaults none of them, because a nested
     *  path guessed wrong caps something the caller never named. */
    amountPath: z
      .object({
        argIndex: z.number().int().nonnegative().max(U32_MAX),
        field: z.string().min(1),
        /** How many entries the vec may carry. EVERY one is capped; see
         *  `declarePredicate`, which refuses a single-element bound because it
         *  would leave the rest of the vec unconstrained. */
        elements: z.number().int().min(1).max(U32_MAX).optional(),
      })
      .optional(),
    recipients: z.array(z.string()).min(1, 'recipients must not be empty').optional(),
    recipientArgIndex: z.number().int().nonnegative().max(U32_MAX).optional(),
    allowZeroCap: z.boolean().optional(),
    /** Minimum output as a ratio of the call's own input. num/den are decimal
     *  STRINGS for the same reason maxAmount is: an i128 ratio does not
     *  survive a JS number. */
    minOutputRatio: z
      .object({
        num: z.string().regex(/^[0-9]+$/, 'num must be an unsigned integer'),
        den: z.string().regex(/^[0-9]+$/, 'den must be an unsigned integer'),
        inputArgIndex: z.number().int().nonnegative().max(U32_MAX),
        outputArgIndex: z.number().int().nonnegative().max(U32_MAX),
      })
      .strict()
      .optional(),
  })
  .strict()
export type DeclarePolicyInput = z.infer<typeof DeclarePolicyInputSchema>

export const InstallPolicyInputSchema = z
  .object({
    /** Rules already on the account. Supplying them turns on the cross-rule
     *  authority scan, which reports every existing rule a signer of this
     *  install could name INSTEAD - including an unpoliced one, against which
     *  the predicate never runs. Absent means the scan is skipped, and the
     *  result says so rather than reporting "no overlaps found". */
    existingRules: z.array(ObservedRuleSchema).optional(),
    /** The smart account contract address (C...) that will receive the rule. */
    smartAccount: contractAddress('smartAccount'),
    /** The signer that authorises the install (G... wallet). Used only for
     *  sequence number + auth nonce simulation; never persisted, never signed. */
    sourceAccount: accountAddress('sourceAccount'),
    /** Target network for the install. Selects which interpreter pin and
     *  which RPC URL are valid by default. Defaults to `testnet` so the
     *  pre-mainnet callers keep working: they were always pointing at
     *  the testnet pin, so defaulting testnet here is the conservative
     *  continuation, NOT a silent fall-through that bypasses the gate.
     *  A caller that targets mainnet MUST set this to `mainnet` (the
     *  pin and RPC pin do not move by themselves). */
    network: NetworkSchema.optional(),
    /** The proposed rule draft. Mirrors the core `ContextRuleDraft` shape.
     *
     *  Optional because of `fromHash` below. An agent cannot reliably retype the
     *  `contextRule` that `synthesize_policy` returned - it is nested, and the
     *  observed failures were exactly that: `validUntilLedger` sent as a string,
     *  `signers` as "", `policies` as an object instead of an array. Supplying
     *  `fromHash` instead lets the server rebuild the same rule it just
     *  produced, rather than asking the caller to transcribe it. */
    rule: ContextRuleDraftSchema.optional(),
    /** Build the rule here instead of receiving it: record this transaction,
     *  synthesize against `smartAccount`, and install the result. The
     *  agent-friendly counterpart to `rule`, and the same handle
     *  `synthesize_policy` accepts. */
    fromHash: z
      .object({
        transactionHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/, 'transaction hash must be 64 lowercase hex characters'),
        /** The keys this rule governs. Synthesis cannot choose them: it reads a
         *  transaction, and which keys a rule binds is the caller's security
         *  decision, not an inference from one recording. Naming a key here
         *  attaches it as a delegated signer. A rule with no signer is refused
         *  on chain, so this is required in practice; the `rule` form remains
         *  the way to attach an external (verifier + key bytes) signer. */
        signers: z
          .array(z.string().refine(isStellarAddress, 'must be a Stellar address (G... or C...)'))
          .max(MAX_SIGNERS_PER_RULE)
          .optional(),
        userResponses: ComposeUserResponsesSchema.optional(),
      })
      .optional(),
    /** Install a predicate the caller ALREADY holds - the base64 string
     *  `declare_policy` returns.
     *
     *  Without this there is no route from `declare_policy` to here:
     *  `fromHash` re-synthesizes from a recording and would discard the
     *  declared predicate, and `rule` means hand-building a draft that the
     *  tool boundary types as `unknown`, so the caller is guessing. An agent
     *  asked to do that invented a requirement to deploy a signer contract,
     *  which is not a thing - a delegated signer is a plain account address.
     *
     *  The context rule type is taken FROM the predicate: if it pins a
     *  contract, the rule is scoped to that contract. One source of truth, so
     *  the rule's scope cannot drift from what the predicate actually checks. */
    fromPredicate: z
      .object({
        encodedPredicate: z.string().min(1),
        /** The keys this rule governs, as plain Stellar account addresses. */
        signers: z
          .array(z.string().refine(isStellarAddress, 'must be a Stellar address (G... or C...)'))
          .min(1)
          .max(MAX_SIGNERS_PER_RULE),
        name: z.string().min(1).optional(),
        validUntilLedger: z.number().int().positive().max(U32_MAX).optional(),
      })
      .optional(),
    /** Per-rule install nonce. Defaults to 1, which is the only correct value
     *  here: this tool builds `add_context_rule`, the account assigns a NEW
     *  rule id, and the interpreter has no stored nonce for a rule that does
     *  not exist yet. Required, it was undiscoverable - an agent has no way to
     *  read it, and asking cost a round trip on a value the server already
     *  knows. Supply it only to re-install over an existing rule, where the
     *  interpreter wants `stored_nonce + 1`. */
    installNonce: z.number().int().positive().optional(),
    /** Optional RPC URL override. Defaults to the pinned RPC for the
     *  selected `network` (testnet by default, mainnet when
     *  `network: 'mainnet'`); the override is refused unless
     *  `allowUnpinnedRpcUrl: true`, because the auth nonce and
     *  rootInvocation in the response come from whichever RPC answered. */
    rpcUrl: z.string().url().optional(),
    /** Opt-in to using a non-pinned RPC URL. Without this flag the tool
     *  refuses any `rpcUrl` other than the pinned RPC for the selected
     *  network because the caller's auth-digest binds to whatever the
     *  RPC returned. */
    allowUnpinnedRpcUrl: z.boolean().optional(),
    /** Attach an OpenZeppelin `spending_limit` beside the predicate, giving the
     *  rule a ROLLING TOTAL as well as a per-call bound. Both must permit,
     *  because policies on one rule compose as all-of.
     *
     *  This is the only way to express "N per day": the interpreter is handed
     *  one call and keeps no state, so a predicate cannot add up spending
     *  across calls. Composes with all three ways of naming the rule.
     *
     *  The primitive meters the third argument of a call named exactly
     *  `transfer` and requires a `call_contract` rule scope, so the rule must
     *  be pinned to the token whose transfers it meters. */
    spendingLimit: z
      .object({
        /** Rolling total in the token's smallest unit. */
        amount: z
          .string()
          .regex(/^[0-9]+$/, 'amount must be a base-10 integer in the smallest unit'),
        /** Window length in LEDGERS. Stellar closes one in roughly five
         *  seconds, so a period in seconds is an approximation of this. */
        periodLedgers: z.number().int().positive().max(U32_MAX),
      })
      .optional(),
    /** Opt-in to installing a rule that bounds no amount, when the recording
     *  behind `fromHash` showed a spend.
     *
     *  Default-deny, because the failure is silent and reads as success: such
     *  a rule installs cleanly, verifies cleanly - a missing constraint
     *  generates no deny case to fail - and caps nothing. That combination
     *  reached the chain once already. A rule with no spend to bound is
     *  unaffected; only the case the synthesizer explicitly flagged is
     *  refused. */
    allowUnboundedAmount: z.boolean().optional(),
    /** Opt-in to pointing the rule's interpreter policy at any address
     *  other than the pinned interpreter for the selected network.
     *  Default-deny: a caller that controls the interpreter can permit
     *  everything. Selecting `network: 'mainnet'` is NOT an opt-in -
     *  the mainnet pin is its own deny-by-default anchor. */
    allowUnpinnedInterpreter: z.boolean().optional(),
    /** Base fee in stroops; defaults to BASE_FEE (100). */
    baseFee: z.number().int().positive().optional(),
  })
  .refine(
    (v) => v.rule !== undefined || v.fromHash !== undefined || v.fromPredicate !== undefined,
    {
      message:
        'name the rule one of three ways: `fromHash` (server records, synthesizes and installs), `fromPredicate` (a predicate you already hold, plus the keys it governs), or `rule` (the full ContextRuleDraft, for programmatic callers)',
    }
  )
  .refine((v) => Boolean(v.smartAccount) && Boolean(v.sourceAccount), {
    message: 'smartAccount and sourceAccount are required',
  })
export type InstallPolicyInput = z.infer<typeof InstallPolicyInputSchema>

export const RevokePolicyInputSchema = z
  .object({
    /** The smart account contract address (C...). */
    smartAccount: contractAddress('smartAccount'),
    /** The wallet that will sign the removal. The ACCOUNT decides whether it
     *  accepts that signer; this schema does not assert a rule it cannot
     *  verify, since the account's source is not in this repo. Proven on
     *  testnet: the account's deployer can revoke. */
    sourceAccount: accountAddress('sourceAccount'),
    /** Target network for the revoke. Same `testnet`-default as install,
     *  so pre-mainnet callers keep working without an explicit flag. */
    network: NetworkSchema.optional(),
    /** The rule id to remove from the smart account + interpreter. */
    ruleId: z.number().int().nonnegative(),
    /** Optional RPC URL override; same per-network pin as install. */
    rpcUrl: z.string().url().optional(),
    /** Opt-in to using a non-pinned RPC URL. Same semantics as install. */
    allowUnpinnedRpcUrl: z.boolean().optional(),
    /** Base fee in stroops; defaults to BASE_FEE (100). */
    baseFee: z.number().int().positive().optional(),
  })
  .refine((v) => Boolean(v.smartAccount) && Boolean(v.sourceAccount), {
    message: 'smartAccount and sourceAccount are required',
  })
export type RevokePolicyInput = z.infer<typeof RevokePolicyInputSchema>

export const GetInterpreterInfoInputSchema = z.object({
  /** Network to query. The pin differs per network; defaults to testnet. */
  network: NetworkSchema.optional(),
  /** When true, perform an optional live `grammar_version()` RPC call to
   *  verify the deployed contract matches the pin. */
  verifyLive: z.boolean().optional(),
  /** Optional RPC URL override. When `verifyLive` is true, the URL must
   *  equal the pinned RPC for the selected network unless
   *  `allowUnpinnedRpcUrl: true` is also set (same opt-in shape as
   *  install/revoke - the live grammar_version() answer binds to whichever
   *  RPC returned it). */
  rpcUrl: z.string().url().optional(),
  /** Opt-in to using a non-pinned RPC URL when `verifyLive` is true. Same
   *  semantics as install/revoke: the caller accepts the trust shift. */
  allowUnpinnedRpcUrl: z.boolean().optional(),
})
export type GetInterpreterInfoInput = z.infer<typeof GetInterpreterInfoInputSchema>

// ===== Error envelope (canonical) =====
//
// Mirrors ToolError from packages/policy-synth/src/errors.ts. We use a
// `z.string()` for `code` (not an enum) because the core's ErrorCode union
// evolves over time; the transport contract only promises a string code the
// caller can dispatch on. A drift test asserts the canonical codes still
// pass through unchanged.
export const ToolErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(['info', 'warning', 'error', 'fatal']),
    retryable: z.boolean(),
    remediation: z
      .object({
        toolCall: z.object({ name: z.string(), args: z.record(z.unknown()) }).optional(),
        userQuestion: z.object({ code: z.string(), question: z.string() }).optional(),
        docsUrl: z.string().optional(),
      })
      .optional(),
    details: z.unknown().optional(),
  })
  .passthrough()
