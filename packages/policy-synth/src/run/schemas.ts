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
// The discriminated union on `source` exposes BOTH synthesize_policy
// front-ends through a single tool input.
//
// This module is the SINGLE source of truth for these shapes. The MCP package
// imports them here so its tool-shape bindings stay in step; the CLI imports
// them here so it can build the same args envelope the MCP transport builds.

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

/** MandateSpec mirrors the core MandateSpec. The deterministic Mandate
 *  front-end needs no parseConfidence; the tool adapter injects the full
 *  confidence after synthesis so the orchestrator can compare. */
export const MandateSpecSchema = z
  .object({
    chain: z.literal('stellar'),
    contract: z.string(),
    method: z.string().optional(),
    spendingLimit: z
      .object({
        token: z.string(),
        limit: z.string().regex(/^[0-9]+$/),
        windowSeconds: z.number().int().positive(),
      })
      .optional(),
    // A threshold of 0 means "0 approvals", which is not a real M-of-N gate.
    approvalThreshold: z.number().int().positive().optional(),
    recipients: z.array(z.string()).optional(),
    expiry: z
      .object({
        validUntilLedger: z.number().int().positive().max(U32_MAX).optional(),
        validUntilUnixSeconds: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .passthrough()
  // TS-F4/F6: a `recipients` allowlist is only meaningful against a SEP-41
  // method whose arg 1 IS the recipient (SAC/SEP-41 `transfer(from, to,
  // amount)` and SEP-41 `mint(to, amount)`). Without this gate the
  // `to-ir.ts` lowering pins the allowlist to `RECIPIENT_ARG_INDEX = 1`
  // for any contract+method, which would let a non-SEP-41 method's
  // arg[1] (e.g. an amount, an op type, an arbitrary address payload)
  // be silently constrained as if it were a recipient. Refusing
  // non-SEP-41 methods at the boundary is the fail-closed shape.
  .refine(
    (v) =>
      v.recipients === undefined ||
      v.recipients.length === 0 ||
      v.method === 'transfer' ||
      v.method === 'mint',
    {
      message:
        'recipients is only valid when method is a SEP-41 method (transfer or mint); other methods do not have a recipient at arg[1]',
    }
  )

/** ComposeUserResponses mirrors the core. */
export const ComposeUserResponsesSchema = z
  .object({
    windowSeconds: z.number().int().positive().optional(),
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
  .passthrough()

/** OzAdapterConfig - the per-network OZ built-in instance addresses. */
export const OzAdapterConfigSchema = z.object({
  network: NetworkSchema,
  instances: z.object({
    spending_limit: z.string(),
    simple_threshold: z.string(),
    weighted_threshold: z.string(),
  }),
})

// ===== record_transaction =====

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

// ===== synthesize_policy =====
//
// Discriminated union on `source` exposes BOTH front-ends through ONE tool.
// - `source: 'mandate'` -> calls synthesizeFromMandate
// - `source: 'recording'` -> calls synthesizeFromRecording

export const SynthesizePolicyMandateInputSchema = z.object({
  source: z.literal('mandate'),
  mandate: MandateSpecSchema,
  ozConfig: OzAdapterConfigSchema.optional(),
  // --explain opt-in. When true, the orchestrator attaches the
  // in-memory predicate tree (null for the mandate path) + a minimal
  // honest SimulationResult to the success envelope. Absent or false
  // -> the success envelope is unchanged (byte-identical to today).
  explain: z.boolean().optional(),
})

/** Interpreter opt-in for the recording path. Present -> constraints OZ cannot
 *  hop paths) lower to a real interpreter predicate document instead of being
 *  surfaced as warnings. The core deep-validates `smartAccountAddress` (a C...
 *  bounds; the schema stays light so the core owns the friendly ToolErrors. */
export const InterpreterOptionsSchema = z.object({
  smartAccountAddress: z.string(),
  installNonce: z.number().int().positive().optional(),
})

export const SynthesizePolicyRecordingInputSchema = z.object({
  source: z.literal('recording'),
  recordedTx: RecordedTransactionSchema,
  network: NetworkSchema,
  userResponses: ComposeUserResponsesSchema.optional(),
  confidenceOverride: z.object({ threshold: z.number().min(0).max(1) }).optional(),
  interpreter: InterpreterOptionsSchema.optional(),
  ozConfig: OzAdapterConfigSchema.optional(),
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

export const SynthesizePolicyInputSchema = z.discriminatedUnion('source', [
  SynthesizePolicyMandateInputSchema,
  SynthesizePolicyRecordingInputSchema,
])
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
    z.object({ kind: z.literal('now') }),
    // Leaves outside the contract's grammar (`valid_until`, `amount`,
    // `window_spent`, `invocation_count_in_window`) are NOT accepted here.
    // The encoder throws on them, so admitting them at the schema would let a
    // hand-crafted payload through only to fail at encode time. A policy's
    // expiry is carried at the install layer (MandateSpec + validUntilLedger),
    // and value or frequency caps belong to the OZ primitives.
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
    z.object({ kind: z.literal('literal_u64'), value: z.string().regex(/^[0-9]+$/) }),
    // `literal_bytes` is hex on chain. `Buffer.from(value, 'hex')` silently
    // drops non-hex chars AND yields an empty buffer when the whole input
    // is non-hex - so a user passing 'zzzz' would get a predicate that
    // compares against empty bytes instead of being rejected. The
    // strict even-length hex regex closes that gap at the boundary.
    z.object({
      kind: z.literal('literal_bytes'),
      value: z
        .string()
        .regex(/^[0-9a-fA-F]*$/)
        .refine((v) => v.length % 2 === 0, 'must be even-length hex'),
    }),
    // elements are themselves PredicateLeaf; lazy to break the cycle.
    z.object({ kind: z.literal('literal_vec'), elements: z.array(PredicateLeafSchema) }),
  ])
)

/** PredicateNode mirrors the core `PredicateNode` union. Recursive through
 *  `and`/`or`/`not`; the lazy + annotation pattern keeps the recursion
 *  type-safe. */
export const PredicateNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('and'), children: z.array(PredicateNodeSchema) }),
    z.object({ op: z.literal('or'), children: z.array(PredicateNodeSchema) }),
    z.object({ op: z.literal('not'), child: PredicateNodeSchema }),
    z.object({
      op: z.literal('eq'),
      left: PredicateLeafSchema,
      right: PredicateLeafSchema,
    }),
    z.object({
      op: z.enum(['lt', 'lte', 'gt', 'gte']),
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
export const SimulatePolicyInputSchema = z.object({
  // simulatePolicy accepts a null predicate (OZ-only policy); verifyPolicy
  // does not. The asymmetry is mirrored at the schema boundary.
  predicate: PredicateNodeSchema.nullable(),
  permitTx: RecordedTransactionSchema,
  validUntilLedger: z.number().int().positive().max(U32_MAX).optional(),
})
export type SimulatePolicyInput = z.infer<typeof SimulatePolicyInputSchema>

export const VerifyPolicyInputSchema = z.object({
  // verifyPolicy requires a non-null predicate; the engine refuses
  // `null` outright. The schema mirrors that contract.
  predicate: PredicateNodeSchema,
  permitTx: RecordedTransactionSchema,
  validUntilLedger: z.number().int().positive().max(U32_MAX).optional(),
})
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
// All three input schemas live BELOW the MandateSpecSchemaForRule declaration
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

const MandateSpecSchemaForRule = z
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
    policies: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('interpreter'),
            interpreterAddress: z.string(),
            predicateBlobBase64: z.string().min(1),
          }),
          z.object({
            kind: z.literal('oz_builtin'),
            primitive: z.object({
              primitive: z.enum(['spending_limit', 'simple_threshold', 'weighted_threshold']),
              params: z.record(z.unknown()),
            }),
            instanceAddress: z.string(),
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
  'CDR4NLV22STCXFGZPNKDQTEANWLF7LZ6AJLY6B7CLJXKHDZGYJWIOKGP'

/** Pinned interpreter address (mainnet). Mainnet
 *  has now been deployed (2026-08-04); the mainnet interpreter IS the binary
 *  that was exercised on testnet (same wasm sha256, see
 *  PINNED_INTERPRETER_WASM_SHA256). The address differs because instance
 *  ids are network-scoped. UNAUDITED at the time of writing. */
export const PINNED_INTERPRETER_MAINNET_ADDRESS =
  'CALZAMUPREIRY4TULBEXIK77AUTOEJG63XLCPUWEHHQDOVK6ZVVS7VQ2'

/** Pinned interpreter wasm sha256 (hex). */
export const PINNED_INTERPRETER_WASM_SHA256 =
  '6e6c13d93e197aa380303a42cd120f5ddb080dd36ef2a343ee1dbd04ca52a443'

/** The grammar version the interpreter enforces (matches SELF_VERSION in
 *  contracts/policy-interpreter/src/version.rs). */
export const PINNED_INTERPRETER_GRAMMAR_VERSION = 1

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

/** Soroban `valid_until` window (ledgers) added to the latest ledger when
 *  building the auth entry. ~25 minutes at 5s/ledger. */
export const DEFAULT_AUTH_VALID_UNTIL_LEDGERS = 300

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

export const InstallPolicyInputSchema = z
  .object({
    /** The smart account contract address (C...) that will receive the rule. */
    smartAccount: z
      .string()
      .regex(STELLAR_CONTRACT_ADDRESS, 'smartAccount must be a Stellar contract address (C...)'),
    /** The signer that authorises the install (G... wallet). Used only for
     *  sequence number + auth nonce simulation; never persisted, never signed. */
    sourceAccount: z
      .string()
      .regex(STELLAR_ACCOUNT_ADDRESS, 'sourceAccount must be a Stellar account address (G...)'),
    /** Target network for the install. Selects which interpreter pin and
     *  which RPC URL are valid by default. Defaults to `testnet` so the
     *  pre-mainnet callers keep working: they were always pointing at
     *  the testnet pin, so defaulting testnet here is the conservative
     *  continuation, NOT a silent fall-through that bypasses the gate.
     *  A caller that targets mainnet MUST set this to `mainnet` (the
     *  pin and RPC pin do not move by themselves). */
    network: NetworkSchema.optional(),
    /** The proposed rule draft. Mirrors the core `ContextRuleDraft` shape. */
    rule: MandateSpecSchemaForRule,
    /** Per-rule install nonce; 1 for a fresh install. */
    installNonce: z.number().int().positive(),
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
    /** Opt-in to pointing the rule's interpreter policy at any address
     *  other than the pinned interpreter for the selected network.
     *  Default-deny: a caller that controls the interpreter can permit
     *  everything. Selecting `network: 'mainnet'` is NOT an opt-in -
     *  the mainnet pin is its own deny-by-default anchor. */
    allowUnpinnedInterpreter: z.boolean().optional(),
    /** Base fee in stroops; defaults to BASE_FEE (100). */
    baseFee: z.number().int().positive().optional(),
  })
  .refine((v) => Boolean(v.smartAccount) && Boolean(v.sourceAccount), {
    message: 'smartAccount and sourceAccount are required',
  })
export type InstallPolicyInput = z.infer<typeof InstallPolicyInputSchema>

export const RevokePolicyInputSchema = z
  .object({
    /** The smart account contract address (C...). */
    smartAccount: z
      .string()
      .regex(STELLAR_CONTRACT_ADDRESS, 'smartAccount must be a Stellar contract address (C...)'),
    /** The wallet that will sign the removal. The ACCOUNT decides whether it
     *  accepts that signer; this schema does not assert a rule it cannot
     *  verify, since the account's source is not in this repo. Proven on
     *  testnet: the account's deployer can revoke. */
    sourceAccount: z
      .string()
      .regex(STELLAR_ACCOUNT_ADDRESS, 'sourceAccount must be a Stellar account address (G...)'),
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
