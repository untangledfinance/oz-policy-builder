// packages/policy-synth/src/run/index.ts
//
// Tool-body adapters for the two core front-ends. Reachable as
// `@crediolabs/policy-synth/run` from both the MCP server (which re-exports
// for tool-registration glue) and the CLI (which calls them directly). Each
// body is a THIN adapter over the pure core:
//
//   1. Re-validate the parsed input via Zod. This is a defence-in-depth check -
//      the SDK has already parsed it through the registered schema, but we never
//      want a tool body to throw on garbage (the SDK treats uncaught throws as
//      transport errors and the agent loses the machine-readable ToolError).
//   2. Dispatch to the matching core entry point with the minimum required
//      inputs.
//   3. Return the core's ToolResponse<T> unchanged. The server layer maps it
//      to the MCP envelope; nothing here knows about MCP.
//
// No business logic. No retries. No session state. The same call shape can
// drive the CLI (which calls into the same core directly without MCP).

import { createHash } from 'node:crypto'
import { rpc } from '@stellar/stellar-sdk'
import {
  declarePredicate,
  type ErrorCode,
  encodePredicate,
  type Network,
  type PredicateNode,
  type ProposedPolicy,
  type RecordedTransaction,
  recordTransaction,
  type SynthesizeFromRecordingOptions,
  synthesizeFromRecording,
  type ToolError,
  type ToolResponse,
} from '../index.ts'
import {
  type BuildInstallPolicyResult,
  type BuildRevokePolicyResult,
  buildInstallPolicyXdr,
  buildRevokePolicyXdr,
  type InstallRpcClient,
  rpcClientFromServer,
} from '../install/build-install-policy.ts'
import { getInterpreterInfo } from '../install/get-interpreter-info.ts'
import { type EvalContext, evaluate, generateCases } from '../simulate/index.ts'
import {
  DeclarePolicyInputSchema,
  type GetInterpreterInfoInput,
  GetInterpreterInfoInputSchema,
  type InstallPolicyInput,
  InstallPolicyInputSchema,
  NETWORK_PASSPHRASES,
  PINNED_INTERPRETER_ADDRESS_BY_NETWORK,
  PINNED_INTERPRETER_GRAMMAR_VERSION,
  PINNED_INTERPRETER_WASM_SHA256,
  type RecordTransactionInput,
  RecordTransactionInputSchema,
  type RevokePolicyInput,
  RevokePolicyInputSchema,
  RPC_URL_BY_NETWORK,
  type SimulatePolicyInput,
  SimulatePolicyInputSchema,
  type SynthesizePolicyInput,
  SynthesizePolicyInputSchema,
  type VerifyPolicyInput,
  VerifyPolicyInputSchema,
} from './schemas.ts'

export type {
  DeclarePolicyInput,
  GetInterpreterInfoInput,
  InstallPolicyInput,
  RecordTransactionInput,
  RevokePolicyInput,
  SimulatePolicyInput,
  SynthesizePolicyInput,
  VerifyPolicyInput,
} from './schemas.ts'
// Re-export the underlying Zod schemas so the MCP package (and any other
// downstream consumer) can import the canonical input shapes from the same
// module that owns the tool-body glue. The strict schemas are the source of
// truth - MCP tool shapes are derived from them.
export {
  ComposeUserResponsesSchema,
  DeclarePolicyInputSchema,
  GetInterpreterInfoInputSchema,
  InstallPolicyInputSchema,
  InterpreterOptionsSchema,
  MAINNET_RPC_URL,
  NetworkSchema,
  PINNED_INTERPRETER_ADDRESS_BY_NETWORK,
  PINNED_INTERPRETER_GRAMMAR_VERSION,
  PINNED_INTERPRETER_MAINNET_ADDRESS,
  PINNED_INTERPRETER_TESTNET_ADDRESS,
  PINNED_INTERPRETER_WASM_SHA256,
  PredicateLeafSchema,
  PredicateNodeSchema,
  RecordedTransactionSchema,
  RecordTransactionInputSchema,
  RevokePolicyInputSchema,
  RPC_URL_BY_NETWORK,
  SynthesizePolicyInputSchema,
  TESTNET_RPC_URL,
  ToolErrorSchema,
} from './schemas.ts'

export type RunRecordTransactionInput = RecordTransactionInput
export type RunSynthesizePolicyInput = SynthesizePolicyInput
export type RunSimulatePolicyInput = SimulatePolicyInput
export type RunVerifyPolicyInput = VerifyPolicyInput

type RunToolName =
  | 'record_transaction'
  | 'synthesize_policy'
  | 'declare_policy'
  | 'simulate_policy'
  | 'verify_policy'
  | 'install_policy'
  | 'revoke_policy'
  | 'get_interpreter_info'

/** Map every tool name to its canonical domain error code. Replaces a 7-way
 *  if/else so adding a tool adds one line here rather than a new branch in
 *  each envelope call. */
const TOOL_ERROR_CODE: Record<RunToolName, ErrorCode> = {
  record_transaction: 'RECORDING_FAILED',
  synthesize_policy: 'SYNTHESIS_ERROR',
  declare_policy: 'SYNTHESIS_ERROR',
  simulate_policy: 'SIMULATION_ERROR',
  verify_policy: 'VERIFICATION_FAILED',
  install_policy: 'INSTALL_BUILD_FAILED',
  revoke_policy: 'REVOKE_BUILD_FAILED',
  get_interpreter_info: 'RECORDING_FAILED',
}

/** `record_transaction` body - wraps `recordTransaction`. The tool input
 *  matches the core RecordInput minus the injected `fetcher` (the transport
 *  layer does not own the RPC). Returns the core ToolResponse unchanged.
 *
 *  Item 6: a try/catch envelope wraps the core call. The core's own
 *  `recordTransaction` already returns `{ok:false, error}` for Zod + decoder
 *  failures, but a throw from the SDK (e.g. a malformed hash handed to
 *  `@stellar/stellar-sdk`'s StrKey decoder) would otherwise surface as
 *  "[object Object]" in the MCP transport. The envelope converts any
 *  non-ToolResponse throw into a structured `RECORDING_FAILED` ToolError so
 *  the agent always sees a machine-readable error code. */
export async function runRecordTransaction(
  raw: unknown
): Promise<ToolResponse<RecordedTransaction>> {
  const parsed = RecordTransactionInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('record_transaction', parsed.error.issues) }
  }
  const input: RecordTransactionInput = parsed.data
  // Strip the wire-only `confidenceOverride` and pass the rest straight through.
  const coreInput = {
    network: input.network,
    ...(input.hash !== undefined ? { hash: input.hash } : {}),
    ...(input.xdr !== undefined ? { xdr: input.xdr } : {}),
    ...(input.confidenceOverride !== undefined
      ? { confidenceOverride: input.confidenceOverride }
      : {}),
  }
  try {
    return await recordTransaction(coreInput)
  } catch (e) {
    return toolFailure('record_transaction', e)
  }
}

/** `synthesize_policy` body - discriminated union on `source`:
 *    - `recording` -> synthesizeFromRecording
 *  Exposing BOTH front-ends through ONE tool keeps the MCP surface tiny while
 *  letting the agent pick the deterministic or the inferred path. The CLI
 *  routes the same way.
 *
 *  Item 6: same try/catch envelope as `runRecordTransaction`. The core
 *  `synthesizeFromRecording` already converts ToolError-shaped throws to
 *  `{ok:false, error}`, but a raw throw from the SDK (e.g. an unexpected
 *  XDR decode error in the adapter) would otherwise surface as
 *  "[object Object]" in the MCP transport. */
export async function runSynthesizePolicy(raw: unknown): Promise<
  ToolResponse<ProposedPolicy> & {
    explain?: {
      predicateTree: PredicateNode | null
    }
  }
> {
  const parsed = SynthesizePolicyInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('synthesize_policy', parsed.error.issues) }
  }
  const input = parsed.data

  try {
    const recorded: RecordedTransaction = input.recordedTx as RecordedTransaction
    return await synthesizeFromRecording(recorded, {
      network: input.network,
      ...(input.userResponses !== undefined ? { userResponses: input.userResponses } : {}),
      ...(input.confidenceOverride !== undefined
        ? { confidenceOverride: input.confidenceOverride }
        : {}),
      ...(input.interpreter !== undefined ? { interpreter: input.interpreter } : {}),
      ...(input.explain === true ? { explain: true } : {}),
    } as SynthesizeFromRecordingOptions)
  } catch (e) {
    return toolFailure('synthesize_policy', e)
  }
}

export async function runInstallPolicy(
  raw: unknown
): Promise<ToolResponse<BuildInstallPolicyResult>> {
  const parsed = InstallPolicyInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('install_policy', parsed.error.issues) }
  }
  const input: InstallPolicyInput = parsed.data
  const network: Network = input.network ?? 'testnet'
  // ---- Pinning gates (default-deny) ----
  const expectedInterpreter = PINNED_INTERPRETER_ADDRESS_BY_NETWORK[network]
  const expectedRpc = RPC_URL_BY_NETWORK[network]
  const pinningError = enforceInterpreterPin(
    input.rule.policies,
    input.allowUnpinnedInterpreter,
    expectedInterpreter
  )
  if (pinningError) {
    return { ok: false, error: pinningError }
  }
  const rpcPinningError = enforceRpcPin(
    'install_policy',
    input.rpcUrl,
    input.allowUnpinnedRpcUrl,
    expectedRpc,
    network
  )
  if (rpcPinningError) {
    return { ok: false, error: rpcPinningError }
  }
  let rpcClient: InstallRpcClient
  try {
    rpcClient = buildRpcClientFromInput(input.rpcUrl, network)
  } catch (e) {
    return toolFailure('install_policy', e)
  }
  try {
    const interpreterPolicy = input.rule.policies.find((p) => p.kind === 'interpreter')
    const encodedPredicate = interpreterPolicy?.predicateBlobBase64 ?? ''
    const predicateHash = createHash('sha256')
      .update(Buffer.from(encodedPredicate, 'base64'))
      .digest('hex')
    const result = await buildInstallPolicyXdr({
      smartAccount: input.smartAccount,
      sourceAccount: input.sourceAccount,
      networkPassphrase: NETWORK_PASSPHRASES[network],
      rule: input.rule,
      installNonce: input.installNonce,
      encodedPredicate,
      predicateHash,
      rpc: rpcClient,
      ...(input.baseFee !== undefined ? { baseFee: input.baseFee } : {}),
    })
    return { ok: true, data: result }
  } catch (e) {
    return toolFailure('install_policy', e)
  }
}

/** `revoke_policy` body - thin wrapper over `buildRevokePolicyXdr`.
 *  Emits an unsigned XDR for `account.remove_context_rule(ruleId)`; the
 *  smart account itself handles uninstalling each attached policy. Auth
 *  is master-only; the source account MUST be the master signer set.
 *
 *  Same RPC pin as install: a non-pinned `rpcUrl` is refused unless
 *  `allowUnpinnedRpcUrl: true`. Revoke does not carry an interpreter
 *  policy payload, so the interpreter pin is not re-checked here.
 *  Pin selection follows `input.network` (defaults to `testnet`). */
export async function runRevokePolicy(
  raw: unknown
): Promise<ToolResponse<BuildRevokePolicyResult>> {
  const parsed = RevokePolicyInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('revoke_policy', parsed.error.issues) }
  }
  const input: RevokePolicyInput = parsed.data
  const network: Network = input.network ?? 'testnet'
  const expectedRpc = RPC_URL_BY_NETWORK[network]
  const rpcPinningError = enforceRpcPin(
    'revoke_policy',
    input.rpcUrl,
    input.allowUnpinnedRpcUrl,
    expectedRpc,
    network
  )
  if (rpcPinningError) {
    return { ok: false, error: rpcPinningError }
  }
  let rpcClient: InstallRpcClient
  try {
    rpcClient = buildRpcClientFromInput(input.rpcUrl, network)
  } catch (e) {
    return toolFailure('revoke_policy', e)
  }
  try {
    const result = await buildRevokePolicyXdr({
      smartAccount: input.smartAccount,
      sourceAccount: input.sourceAccount,
      ruleId: input.ruleId,
      networkPassphrase: NETWORK_PASSPHRASES[network],
      rpc: rpcClient,
      ...(input.baseFee !== undefined ? { baseFee: input.baseFee } : {}),
    })
    return { ok: true, data: result }
  } catch (e) {
    return toolFailure('revoke_policy', e)
  }
}

/** `get_interpreter_info` body - thin wrapper over `getInterpreterInfo`.
 *  Returns the pinned deployment fingerprint + an optional live
 *  `grammar_version()` comparison. The audit field is deliberately
 *  OMITTED (phase-04's "audit #44" has no source of truth in the repo -
 *  fabricating it would be a lie on a security surface; the live
 *  mismatch check is worth MORE).
 *
 *  Network-aware: `input.network` selects which interpreter pin and RPC
 *  to use. Mainnet was rolled out 2026-08-04 - the same wasm hash was
 *  uploaded to mainnet as was exercised on testnet, so a single
 *  `PINNED_INTERPRETER_WASM_SHA256` constant backs both networks.
 *  The address differs because instance ids are network-scoped.
 *  UNAUDITED at the time of writing.
 *
 *  Same RPC pin as install/revoke: when `verifyLive` triggers an outbound
 *  call, the auth-digest + the answer bind to whichever RPC answered, so
 *  a non-pinned `rpcUrl` would silently bind the caller to a host they
 *  picked. The pin is enforced here too, with the same `allowUnpinnedRpcUrl`
 *  opt-in as install/revoke. */
/** The call a predicate is evaluated against: the single top-level invocation
 *  the smart account authorises. `Policy::enforce` receives one `Context`, not
 *  a sub-invocation tree, so simulating anything deeper would claim a
 *  guarantee the contract does not make. */
function evalContextFromRecording(tx: RecordedTransaction): EvalContext | null {
  const top = tx.invocations[0]
  if (!top) return null
  return { contract: top.contract, fn: top.fn, args: top.args }
}

/** Both `simulate_policy` and `verify_policy` evaluate against a context derived
 *  from `permitTx`; neither has anything to evaluate when the recording carries
 *  no top-level invocation. */
function noInvocationError(toolName: 'simulate_policy' | 'verify_policy'): ToolError {
  return {
    code: TOOL_ERROR_CODE[toolName],
    message: `${toolName}: permitTx carries no invocation to evaluate`,
    severity: 'error',
    retryable: false,
  }
}

/** `simulate_policy` body - evaluate a predicate against one recorded call.
 *
 *  The evaluator is a second implementation of the on-chain semantics, and the
 *  conformance harness asserts it agrees with the Rust interpreter case for
 *  case. A verdict here is therefore a claim about what the contract would do,
 *  not a guess. */
export function runSimulatePolicy(raw: unknown): ToolResponse<{
  permitted: boolean
  reason: string | null
  call: { contract: string; fn: string; argCount: number }
}> {
  const parsed = SimulatePolicyInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('simulate_policy', parsed.error.issues) }
  }
  const input: SimulatePolicyInput = parsed.data
  const ctx = evalContextFromRecording(input.permitTx as RecordedTransaction)
  if (!ctx) return { ok: false, error: noInvocationError('simulate_policy') }
  try {
    const res = evaluate(input.predicate as PredicateNode, ctx)
    return {
      ok: true,
      data: {
        permitted: res.permit,
        reason: res.permit ? null : res.reason,
        call: { contract: ctx.contract, fn: ctx.fn, argCount: ctx.args.length },
      },
    }
  } catch (e) {
    return toolFailure('simulate_policy', e)
  }
}

/** `declare_policy` body - the DECLARATIVE front-end.
 *
 *  `synthesize_policy` infers a predicate from a transaction that happened;
 *  this takes the constraint stated outright. No RPC, no decoding and no
 *  parseConfidence, so nothing here can be refused for a contract the registry
 *  does not recognise - which is most of the point of having it.
 *
 *  The returned `warnings` are load-bearing, not decoration. An argument index
 *  the caller did not supply is DEFAULTED to the SEP-41 position, and a bound
 *  on the wrong argument constrains something the caller did not mean without
 *  ever announcing itself, so a caller that ignores warnings can install a
 *  predicate that reads correctly and binds nothing. */
export function runDeclarePolicy(raw: unknown): ToolResponse<{
  predicate: PredicateNode
  encodedPredicate: string
  predicateHash: string
  warnings: string[]
}> {
  const parsed = DeclarePolicyInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('declare_policy', parsed.error.issues) }
  }
  try {
    // Rebuilt field-by-field rather than passed through: the schema's
    // optionals are `T | undefined` and `PolicyDeclaration`'s are absent-or-T,
    // which `exactOptionalPropertyTypes` treats as different.
    const d = parsed.data
    const { predicate, warnings } = declarePredicate({
      fn: d.fn,
      ...(d.contract !== undefined ? { contract: d.contract } : {}),
      ...(d.maxAmount !== undefined ? { maxAmount: d.maxAmount } : {}),
      ...(d.amountArgIndex !== undefined ? { amountArgIndex: d.amountArgIndex } : {}),
      ...(d.recipients !== undefined ? { recipients: d.recipients } : {}),
      ...(d.recipientArgIndex !== undefined ? { recipientArgIndex: d.recipientArgIndex } : {}),
      ...(d.allowZeroCap !== undefined ? { allowZeroCap: d.allowZeroCap } : {}),
    })
    const { encodedPredicate, predicateHash } = encodePredicate(predicate)
    return { ok: true, data: { predicate, encodedPredicate, predicateHash, warnings } }
  } catch (e) {
    return toolFailure('declare_policy', e)
  }
}

/** `verify_policy` body - the permit case plus a generated deny case per
 *  dimension.
 *
 *  Two failure modes are being checked, and they are not the same thing. A
 *  permit case that denies means the policy is too STRICT: it would refuse the
 *  very transaction it was synthesised from. A deny case that permits means it
 *  is too LOOSE: some mutation of that transaction still gets through. `ok` is
 *  true only when neither holds. */
export function runVerifyPolicy(raw: unknown): ToolResponse<{
  ok: boolean
  permit: { permitted: boolean; reason: string | null }
  denies: Array<{ dimension: string; denied: boolean; reason: string | null }>
  dimensionsCovered: number
}> {
  const parsed = VerifyPolicyInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('verify_policy', parsed.error.issues) }
  }
  const input: VerifyPolicyInput = parsed.data
  const ctx = evalContextFromRecording(input.permitTx as RecordedTransaction)
  if (!ctx) return { ok: false, error: noInvocationError('verify_policy') }
  try {
    const predicate = input.predicate as PredicateNode
    const cases = generateCases(predicate, ctx)
    const permitRes = evaluate(predicate, cases.permit)
    const denies = cases.denies.map((d) => {
      const r = evaluate(predicate, d.ctx)
      return {
        dimension: d.dimension,
        denied: !r.permit,
        reason: r.permit ? null : r.reason,
      }
    })
    return {
      ok: true,
      data: {
        ok: permitRes.permit && denies.every((d) => d.denied),
        permit: { permitted: permitRes.permit, reason: permitRes.permit ? null : permitRes.reason },
        denies,
        dimensionsCovered: denies.length,
      },
    }
  } catch (e) {
    return toolFailure('verify_policy', e)
  }
}

export async function runGetInterpreterInfo(
  raw: unknown
): Promise<ToolResponse<ReturnType<typeof getInterpreterInfo>>> {
  const parsed = GetInterpreterInfoInputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: validationError('get_interpreter_info', parsed.error.issues) }
  }
  const input: GetInterpreterInfoInput = parsed.data
  const network: Network = input.network ?? 'testnet'
  const expectedRpc = RPC_URL_BY_NETWORK[network]
  // Pin enforcement only matters when the live RPC call is engaged. The
  // static-fingerprint branch is local data and a non-pinned URL never
  // reaches the network, so the gate is conditioned on `verifyLive` to
  // match the wire-level concern (an outbound request that returns a
  // caller-bound value). A caller that DOES NOT verifyLive can supply any
  // URL it likes; the field is still optional.
  if (input.verifyLive === true) {
    const rpcPinningError = enforceRpcPin(
      'get_interpreter_info',
      input.rpcUrl,
      input.allowUnpinnedRpcUrl,
      expectedRpc,
      network
    )
    if (rpcPinningError) {
      return { ok: false, error: rpcPinningError }
    }
  }
  const pinnedAddress = PINNED_INTERPRETER_ADDRESS_BY_NETWORK[network]
  try {
    let deployedGrammarVersion: number | undefined
    if (input.verifyLive === true) {
      const rpcClient = buildRpcClientFromInput(input.rpcUrl, network)
      deployedGrammarVersion = await rpcClient.getContractVersion(pinnedAddress)
    }
    const info = getInterpreterInfo({
      pinnedAddress,
      pinnedGrammarVersion: PINNED_INTERPRETER_GRAMMAR_VERSION,
      pinnedWasmHash: PINNED_INTERPRETER_WASM_SHA256,
      network,
      ...(deployedGrammarVersion !== undefined ? { deployedGrammarVersion } : {}),
    })
    return { ok: true, data: info }
  } catch (e) {
    return toolFailure('get_interpreter_info', e)
  }
}

/** Build an InstallRpcClient from an optional URL override + selected
 *  network, falling back to the pinned RPC for the network. The caller
 *  has already been gated against the pinned URL elsewhere, so the
 *  fallback here only ever picks from a finite, audited pair. */
function buildRpcClientFromInput(
  urlOverride: string | undefined,
  network: Network
): InstallRpcClient {
  const url = urlOverride ?? RPC_URL_BY_NETWORK[network]
  const passphrase = NETWORK_PASSPHRASES[network]
  // NOT `createRpcServer` - that returns an RpcFetcher, a bare
  // `(hash) => Promise<SorobanTxResponse|null>` for the RECORDER. Passing it
  // here produced a client whose `getAccount` was undefined, so every live
  // call died with "server.getAccount is not a function". The install path
  // needs the full Server surface.
  return rpcClientFromServer(new rpc.Server(url, { allowHttp: false }), passphrase)
}

/** Default-deny: refuse an interpreter policy whose address differs from the
 *  pinned interpreter for the selected network. An interpreter the caller
 *  controls can permit anything, so the smart account's authorization must
 *  bind to the pinned contract unless the caller opts in. OZ built-in
 *  policies are not interpreters and pass through. Returns a ToolError to
 *  surface through the run-layer envelope, or null when all interpreter
 *  policies are pinned. The caller resolves the expected pin per network;
 *  this function stays pure so it is easy to test. */
function enforceInterpreterPin(
  policies: InstallPolicyInput['rule']['policies'],
  allowUnpinned: boolean | undefined,
  expectedInterpreterAddress: string
): ToolError | null {
  for (const p of policies) {
    if (p.kind !== 'interpreter') continue
    if (p.interpreterAddress === expectedInterpreterAddress) continue
    if (allowUnpinned === true) continue
    return {
      code: 'INSTALL_BUILD_FAILED',
      message: `install_policy: interpreter policy address ${p.interpreterAddress} != pinned ${expectedInterpreterAddress}; set allowUnpinnedInterpreter: true to opt in to a non-pinned interpreter`,
      severity: 'error',
      retryable: false,
      remediation: { toolCall: { name: 'install_policy', args: {} } },
    }
  }
  return null
}

/** Default-deny: refuse an `rpcUrl` that is not the pinned RPC for the
 *  selected network. The auth nonce + rootInvocation in the install/revoke
 *  response come from whichever RPC answered, so a non-pinned RPC would
 *  silently bind the caller to a host they picked. The same applies to
 *  `get_interpreter_info` when `verifyLive` is true (the live grammar
 *  version is the caller-bound value). The caller may opt in via
 *  `allowUnpinnedRpcUrl: true`. Returns a ToolError or null when the URL is
 *  pinned (or absent, since the default is the pinned one). */
function enforceRpcPin(
  toolName: 'install_policy' | 'revoke_policy' | 'get_interpreter_info',
  rpcUrl: string | undefined,
  allowUnpinned: boolean | undefined,
  expectedRpc: string,
  network: Network
): ToolError | null {
  if (!rpcUrl || rpcUrl === expectedRpc || allowUnpinned === true) return null
  return {
    code: TOOL_ERROR_CODE[toolName],
    message: `${toolName}: rpcUrl must equal the pinned ${expectedRpc} (${network}); set allowUnpinnedRpcUrl: true to opt in to a custom endpoint`,
    severity: 'error',
    retryable: false,
    remediation: { toolCall: { name: toolName, args: {} } },
  }
}

/** Build a canonical ToolError for a Zod validation failure. The remediation
 *  hint points the agent back at the right tool with an empty arg bag - the
 *  tool name IS the machine-readable hint. */
function validationError(
  toolName: RunToolName,
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>
): ToolError {
  return {
    code: TOOL_ERROR_CODE[toolName],
    message: `${toolName}: invalid input: ${issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')}`,
    severity: 'error',
    retryable: false,
    remediation: { toolCall: { name: toolName, args: {} } },
  }
}

/** Build a canonical ToolError for a thrown exception caught by the tool
 *  envelope. The MCP SDK stringifies thrown objects as "[object Object]" by
 *  default, so we extract a string-friendly message and tag the original
 *  error in `details` for the agent to inspect. Exported as a test-only seam
 *  so the suite in run/index.test.ts can drive the envelope path without
 *  standing up a full recordTransaction pipeline. */
/** The fail-closed return every tool body uses in its `catch`. Taking only the
 *  tool name keeps the tool -> error-code mapping in TOOL_ERROR_CODE alone. */
function toolFailure(toolName: RunToolName, e: unknown): { ok: false; error: ToolError } {
  return { ok: false, error: caughtError(toolName, TOOL_ERROR_CODE[toolName], e) }
}

export function caughtError(toolName: RunToolName, code: ErrorCode, e: unknown): ToolError {
  return {
    code,
    message: `${toolName}: unhandled throw escaped core envelope: ${describeThrown(e, toolName)}`,
    severity: 'error',
    retryable: false,
    remediation: { toolCall: { name: toolName, args: {} } },
    details: { thrown: safeStringify(e) },
  }
}

/** Build a human-readable message for an unknown caught value. Order matters:
 *    1. `Error` instances use `.message` (or fallback to the class name).
 *    2. Native strings pass through verbatim.
 *    3. Objects with a string `message` field use that field (mirrors the
 *       shape thrown by some SDKs that package errors as plain objects).
 *    4. Anything else falls back to a JSON-shaped summary, never to
 *       "[object Object]".
 *  The full payload is also captured in `details.thrown` via
 *  `safeStringify` so the agent can inspect the original value without
 *  risking an infinite loop on circular refs. */
function describeThrown(e: unknown, toolName: string): string {
  if (e instanceof Error) {
    return e.message || `${toolName}: ${e.name || 'Error'}`
  }
  if (typeof e === 'string') {
    return e
  }
  if (e !== null && typeof e === 'object') {
    const obj = e as Record<string, unknown>
    const m = obj.message
    if (typeof m === 'string' && m.length > 0) {
      return truncate(m)
    }
    return truncate(safeStringify(e))
  }
  return `${toolName}: caught non-Error throw of type ${typeof e}`
}

/** Hard cap on the human-readable message embedded in the ToolError. The full
 *  payload is still preserved in `details.thrown` so the agent can inspect
 *  it - the truncation is only to keep the top-level message small enough to
 *  fit comfortably in transport logs. */
const MAX_MESSAGE_LEN = 512

/** JSON.stringify that survives circular refs and very large payloads. The
 *  output is itself bounded by the same `MAX_DETAILS_LEN` so a thrown object
 *  with megabytes of buffer data cannot bloat the WHOLE envelope. */
const MAX_DETAILS_LEN = 4096

function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    v,
    (_k, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
      // `stack` is a server-controlled diagnostic. Stack traces from a host
      // we do not own are reconnaissance, not a signal the caller can act on.
      // Surface `name` + `message` only.
      if (value instanceof Error) {
        return { name: value.name, message: value.message }
      }
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    },
    2
  )
  if (json === undefined) return '<unserializable>'
  return truncate(json, MAX_DETAILS_LEN)
}

function truncate(s: string, cap = MAX_MESSAGE_LEN): string {
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}\n…[truncated ${s.length - cap} chars]`
}
