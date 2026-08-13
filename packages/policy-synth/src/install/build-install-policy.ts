// src/install/build-install-policy.ts - builds the unsigned Soroban transaction
// XDR for `account.add_context_rule(...)` and `account.remove_context_rule(...)`.
//
// The MCP server is stateless and holds no key material, so this module NEVER
// signs. The caller (wallet / CLI / SDK consumer) wraps the returned XDR in a
// transaction envelope and signs that envelope with their wallet; the wallet
// signature IS the user-confirmation step.
//
// We deliberately depart from the original design, which called for a
// two-call `install_policy`/`confirm_install` pair backed by a host-signed
// short-TTL `action_id`. That contract requires stateful store + key material
// the server does not have, so we ship the simpler ONE-CALL shape. The wallet
// signature covers the change.
//
// `buildInstallPolicyXdr` installs the policy in ONE call. `add_context_rule`
// takes `policies` as a `Map<policy_address, install_param>` and the account
// forwards each install_param to that policy, so the interpreter stores the
// predicate document as part of this same transaction.

import { createHash } from 'node:crypto'
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  rpc,
  scValToBigInt,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { buildAddContextRuleArgs, DEFAULT_GRAMMAR_VERSION } from './build-add-context-rule.ts'
import {
  accountEntry,
  authDigest,
  authPayload,
  delegatedSignerEntry,
  signaturePayload,
} from './oz-auth.ts'

/** Minimal Soroban RPC surface the install pipeline needs. Test seams
 *  inject a stub so the builder stays deterministic; production builds
 *  the real one via `createRpcServer` from `../record/rpc.ts`. */
export interface InstallRpcClient {
  getAccount(address: string): Promise<{ sequenceNumber(): string }>
  simulateTransaction(
    tx: Transaction | Parameters<rpc.Server['simulateTransaction']>[0]
  ): Promise<rpc.Api.SimulateTransactionResponse>
  getLatestLedger(): Promise<{ sequence: number }>
  /** Live `grammar_version()` lookup. Returns the deployed u32. */
  getContractVersion(address: string): Promise<number>
}

/** Convert a real rpc.Server into the InstallRpcClient surface. The
 *  `getContractVersion` lookup uses `simulateTransaction` against
 *  `contract.call('grammar_version')` and decodes the returned u32.
 *
 *  The passphrase is a REQUIRED argument (not read off the server): `rpc.Server`
 *  does not carry one, so reaching for `server.networkPassphrase` returned a
 *  non-string and every version probe died with "Invalid passphrase provided to
 *  Transaction". The caller knows which network it dialled; make it say so. */
export function rpcClientFromServer(
  server: rpc.Server,
  networkPassphrase: string
): InstallRpcClient {
  return {
    getAccount: (address) => server.getAccount(address),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    getLatestLedger: () => server.getLatestLedger(),
    async getContractVersion(address: string): Promise<number> {
      // The source account is constructed locally rather than fetched. This is
      // a read-only simulation, so the sequence number is never checked, and a
      // random key does NOT exist on chain - asking the network for it returns
      // 404 and the version probe fails for a reason that has nothing to do
      // with the contract being probed.
      const account = new Account(Keypair.random().publicKey(), '0')
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(new Contract(address).call('grammar_version'))
        .setTimeout(30)
        .build()
      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`getContractVersion: simulateTransaction failed: ${sim.error}`)
      }
      if (!sim.result?.retval) {
        throw new Error('getContractVersion: grammar_version() returned no value')
      }
      const native = scValToBigInt(sim.result.retval)
      if (typeof native !== 'bigint') {
        throw new Error('getContractVersion: grammar_version() did not return an integer')
      }
      return Number(native)
    },
  }
}

/** Inputs for the install-policy build. */
export interface BuildInstallPolicyArgs {
  /** The smart account contract address (C...). */
  smartAccount: string
  /** The signer that authorises the install (G... wallet). */
  sourceAccount: string
  /** Network passphrase - pins the hash the auth digest binds. */
  networkPassphrase: string
  /** The new rule to install. Mirrors the core `ContextRuleDraft`. */
  rule: BuildInstallPolicyRuleDraft
  /** Per-rule install nonce; 1 for a fresh install. */
  installNonce: number
  /** Already-encoded (base64) canonical ScVal of the predicate. */
  encodedPredicate: string
  /** Hex sha256 of the canonical predicate XDR bytes. */
  predicateHash: string
  /** Per-policy oracle overrides. */
  oracleParams?: {
    maxStalenessSeconds?: number
    maxDeviationBps?: number
    maxCrossFeedDeviationBps?: number
  }
  /** Grammar version override; defaults to 1. */
  grammarVersion?: number
  /** Base fee in stroops; defaults to BASE_FEE (100). */
  baseFee?: number
  /** RPC client to use for the simulation pass; injected for tests. */
  rpc: InstallRpcClient
  /** Ledger window (in ledgers) for the auth entry's `validUntil`. */
  authValidUntilLedgers?: number
}

export type BuildInstallPolicyRuleDraft = {
  contextRuleType:
    | { kind: 'default' }
    | { kind: 'call_contract'; contract: string }
    | { kind: 'create_contract'; wasmHash: string }
  name: string
  validUntilLedger: number | null
  signers: BuildInstallPolicySignerDraft[]
  policies: BuildInstallPolicyPolicyRef[]
}

export type BuildInstallPolicySignerDraft =
  | { kind: 'delegated'; address: string }
  | { kind: 'external'; verifier: string; keyBytes: string }

export type BuildInstallPolicyPolicyRef =
  | {
      kind: 'interpreter'
      interpreterAddress: string
      predicateBlobBase64: string
    }
  | {
      kind: 'oz_builtin'
      instanceAddress: string
      primitive: {
        primitive: 'spending_limit' | 'simple_threshold' | 'weighted_threshold'
        params: Record<string, unknown>
      }
    }

/** Human-readable description of the install call, decoded FROM the built
 *  XDR (not from the input args). The XDR is the source of truth: a
 *  human approving a review card needs the description to mirror the bytes
 *  the wallet will sign. Deriving `describes` from the input args would
 *  re-describe the caller's intent rather than the transaction. */
export interface InstallCallDescribes {
  /** Smart account that owns the new rule (echoed from the XDR). */
  targetContract: string
  /** The fn name on the target (always `add_context_rule` today). */
  fnName: 'add_context_rule'
  /** The new rule's display name, decoded from args[1]. */
  ruleName: string
  /** The `validUntil` ledger sequence decoded from args[2] (null when void). */
  validUntilLedger: number | null
  /** The signers attached to the rule, decoded from args[3]. The
   *  `verifier`/`keyBytes` payload of an external signer is omitted - it
   *  is not material to the review card and stays opaque to keep the
   *  description focused on what the human has to recognise. */
  signers: Array<{ kind: 'delegated'; address: string } | { kind: 'external'; verifier: string }>
  /** Cross-layer L1: a human-readable note about the OZ any-of-N signer
   *  semantic that fires for rules with multiple signers. Present only
   *  when `signers.length >= 2` (a single-signer rule is trivially any-of-1,
   *  and the note would just add noise). The note is purely additive to
   *  the review card text - it does NOT alter the wire bytes or the
   *  signer-set constraint, only the description a human reads before
   *  signing the install. */
  signerNote: string | null
  /** One entry per policy attached to the rule, decoded from the policies
   *  map (args[4]). The address is the map key; the kind + extras below
   *  describe the value. The interpreter policy also reports the
   *  sha256 of the predicate blob actually embedded in the XDR - so a
   *  mismatch between the wire bytes and the review card is detectable
   *  by reading `describes`. */
  policies: Array<
    | {
        kind: 'interpreter'
        address: string
        installNonce: number
        predicateHash: string
        predicateSha256OfEmbeddedBytes: string
      }
    | {
        kind: 'oz_builtin'
        address: string
        primitive: 'spending_limit' | 'simple_threshold' | 'weighted_threshold'
      }
  >
  /** The install nonce, decoded from the interpreter policy's
   *  `install_nonce` field. Echoed at the top level for reviewer convenience;
   *  the per-policy entry is the source of truth. */
  installNonce: number
}

/** Output of the install-policy build. The unsigned XDR is the wallet's
 *  input; the captured auth nonce + invocation root make the response
 *  self-describing for callers that want to inspect what they signed. */
export interface BuildInstallPolicyResult {
  /** Unsigned Soroban transaction envelope, base64 XDR. */
  unsignedXdr: string
  /** Smart account contract address (echo). */
  smartAccount: string
  /** Source account (echo) - the address that must sign. */
  sourceAccount: string
  /** The host-call target + fn name. This single call installs the policy
   *  outright: `add_context_rule` takes `policies` as a
   *  `Map<policy_address, install_param>`, and the account forwards each
   *  install_param to that policy. For an interpreter policy the param
   *  carries the predicate and its hash, so the interpreter stores the
   *  document as part of this transaction. There is no second call.
   *
   *  Verified on testnet 2026-08-01: a rule created by this builder alone
   *  permits a matching operator call and denies a non-matching one with
   *  interpreter code #100 - not #206 MissingState. */
  call: { contract: string; fn: 'add_context_rule' }
  /** Human-readable description of the install call, decoded FROM the
   *  built unsigned XDR (not from the input args). The wallet signature
   *  binds to bytes; the review card has to bind to the same bytes, so
   *  this is the only safe source. */
  describes: InstallCallDescribes
  /** The auth nonce the host assigned to this call (snapshot). */
  authNonce: string
  /** The ledger sequence + window the auth entry expires at. */
  authValidUntilLedger: number
  /** The captured rootInvocation so a downstream caller can verify the
   *  signature payload matches the one the host expects. */
  rootInvocationXdr: string
}

/** Build the unsigned transaction envelope for `account.add_context_rule(...)`.
 *  The output XDR is signed by the wallet, not by us. */
export async function buildInstallPolicyXdr(
  args: BuildInstallPolicyArgs
): Promise<BuildInstallPolicyResult> {
  // 1. Pure arg encoding first - fail closed on any limit / shape problem
  //    BEFORE we burn a network round-trip on a malformed call.
  const callArgs = buildAddContextRuleArgs(
    {
      contextRuleType: args.rule.contextRuleType,
      name: args.rule.name,
      validUntilLedger: args.rule.validUntilLedger,
      signers: args.rule.signers,
      policies: args.rule.policies.map(adaptPolicyRef),
    },
    {
      signers: args.rule.signers,
      policies: args.rule.policies.map(adaptPolicyRef),
      installNonce: args.installNonce,
      encodedPredicate: args.encodedPredicate,
      predicateHash: args.predicateHash,
      ...(args.oracleParams ? { oracleParams: args.oracleParams } : {}),
      ...(args.grammarVersion !== undefined ? { grammarVersion: args.grammarVersion } : {}),
    }
  )

  // 2. Fetch the source sequence, then build the recording transaction with a
  //    bare host call. The recording pass assigns the smart-account auth nonce
  //    and root invocation needed to construct OZ's AuthPayload.
  const source = await args.rpc.getAccount(args.sourceAccount)
  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(args.smartAccount).toScAddress(),
      functionName: 'add_context_rule',
      args: [...callArgs],
    })
  )
  const makeOperation = (auth: xdr.SorobanAuthorizationEntry[] = []) =>
    Operation.invokeHostFunction({ func: hostFunction, auth })
  const baseFee = args.baseFee !== undefined ? String(args.baseFee) : BASE_FEE
  const buildTx = (op: xdr.Operation) =>
    buildUnsignedTx({
      sourceAccount: args.sourceAccount,
      sequence: source.sequenceNumber(),
      fee: baseFee,
      networkPassphrase: args.networkPassphrase,
      op,
    })
  const recordingTx = buildTx(makeOperation())

  // 3. Recording simulation: capture the smart account's nonce and invocation
  //    tree. Nothing is signed here.
  const recorded = await args.rpc.simulateTransaction(recordingTx)
  if (rpc.Api.isSimulationError(recorded)) {
    // Short, stable reason. The full `simulateTransaction` error (which
    // carries host + URL detail) stays in the SDK's own logs - never
    // reflected back into a user-facing message where it would
    // reconnoitre the RPC.
    throw new Error('install_policy: simulateTransaction failed')
  }
  const original = (recorded.result?.auth ?? []).find(
    (entry) =>
      entry.credentials().switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(entry.credentials().address().address()).toString() ===
        args.smartAccount
  )
  if (!original) {
    throw new Error(
      `install_policy: no Soroban auth entry for smart account ${args.smartAccount}; this call does not route through the smart account`
    )
  }

  // 4. `add_context_rule` is authorised by the deploy-time admin rule (rule 0).
  //    The delegated signer uses source-account credentials, so its signature
  //    bytes stay empty and the ordinary transaction-envelope signature covers
  //    the call when the consumer signs it.
  const validUntilLedger =
    (await args.rpc.getLatestLedger()).sequence +
    (args.authValidUntilLedgers ?? DEFAULT_AUTH_VALID_UNTIL_LEDGERS)
  const contextRuleIds = [0]
  const digest = authDigest(
    signaturePayload(
      args.networkPassphrase,
      original.credentials().address().nonce(),
      validUntilLedger,
      original.rootInvocation()
    ),
    contextRuleIds
  )
  const authEntries = [
    accountEntry(
      original,
      validUntilLedger,
      authPayload([args.sourceAccount], contextRuleIds, () => Buffer.alloc(0))
    ),
    ...contextRuleIds.map(() => delegatedSignerEntry(args.smartAccount, digest)),
  ]

  // 5. Simulate again with the OZ entries already attached. The SDK preserves
  //    existing auth during assembly and adds the simulated Soroban footprint +
  //    resource fee, yielding a complete unsigned envelope.
  const txWithAuth = buildTx(makeOperation(authEntries))
  const enforcing = await args.rpc.simulateTransaction(txWithAuth)
  if (rpc.Api.isSimulationError(enforcing)) {
    throw new Error('install_policy: auth simulateTransaction failed')
  }
  const finalTx = rpc.assembleTransaction(txWithAuth, enforcing).build()

  // 6. Decode the structured description FROM the final assembled transaction.
  //    The human approval binds to the exact bytes the wallet will sign.
  const describes = decodeInstallCallDescribes(finalTx, args.installNonce)

  return {
    unsignedXdr: finalTx.toEnvelope().toXDR().toString('base64'),
    smartAccount: args.smartAccount,
    sourceAccount: args.sourceAccount,
    call: { contract: args.smartAccount, fn: 'add_context_rule' },
    describes,
    authNonce: original.credentials().address().nonce().toString(),
    authValidUntilLedger: validUntilLedger,
    rootInvocationXdr: original.rootInvocation().toXDR().toString('base64'),
  }
}

/** Build an unsigned XDR for `account.remove_context_rule(ruleId)`. The
 *  smart account itself handles uninstalling each attached policy (calling
 *  `interpreter.uninstall` for the interpreter policy); this builder only
 *  emits the account-side removal call.
 *
 *  Who may authorise it is the ACCOUNT's decision, and the account's source is
 *  not in this repo. The interpreter's own `uninstall` is master-gated, but
 *  that is a different entry point from this one, so do not restate it as the
 *  rule for this call. What is proven on testnet is that the account's
 *  deployer can revoke. This builder does not pre-check the signer: it would
 *  be guessing at a contract it cannot read, and the chain is the authority. */
export async function buildRevokePolicyXdr(args: {
  smartAccount: string
  sourceAccount: string
  ruleId: number
  networkPassphrase: string
  rpc: InstallRpcClient
  baseFee?: number
  authValidUntilLedgers?: number
}): Promise<BuildRevokePolicyResult> {
  const source = await args.rpc.getAccount(args.sourceAccount)
  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(args.smartAccount).toScAddress(),
      functionName: 'remove_context_rule',
      args: [xdr.ScVal.scvU32(args.ruleId)],
    })
  )
  const makeOperation = (auth: xdr.SorobanAuthorizationEntry[] = []) =>
    Operation.invokeHostFunction({ func: hostFunction, auth })
  const baseFee = args.baseFee !== undefined ? String(args.baseFee) : BASE_FEE
  const buildTx = (op: xdr.Operation) =>
    buildUnsignedTx({
      sourceAccount: args.sourceAccount,
      sequence: source.sequenceNumber(),
      fee: baseFee,
      networkPassphrase: args.networkPassphrase,
      op,
    })

  const recorded = await args.rpc.simulateTransaction(buildTx(makeOperation()))
  if (rpc.Api.isSimulationError(recorded)) {
    // Short, stable reason. The full `simulateTransaction` error (which
    // carries host + URL detail) stays in the SDK's own logs - never
    // reflected back into a user-facing message where it would
    // reconnoitre the RPC.
    throw new Error('revoke_policy: simulateTransaction failed')
  }
  const original = (recorded.result?.auth ?? []).find(
    (entry) =>
      entry.credentials().switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(entry.credentials().address().address()).toString() ===
        args.smartAccount
  )
  if (!original) {
    throw new Error(
      `revoke_policy: no Soroban auth entry for smart account ${args.smartAccount}; this call does not route through the smart account`
    )
  }

  // Removal is master-only, so the deploy-time admin rule authorises it. The
  // recorded rootInvocation still includes remove_context_rule(ruleId), binding
  // the auth payload to the exact rule being removed. As with install,
  // source-account credentials carry the delegated signer entry and the
  // consumer supplies only the ordinary envelope signature.
  const validUntilLedger =
    (await args.rpc.getLatestLedger()).sequence +
    (args.authValidUntilLedgers ?? DEFAULT_AUTH_VALID_UNTIL_LEDGERS)
  const contextRuleIds = [0]
  const digest = authDigest(
    signaturePayload(
      args.networkPassphrase,
      original.credentials().address().nonce(),
      validUntilLedger,
      original.rootInvocation()
    ),
    contextRuleIds
  )
  const authEntries = [
    accountEntry(
      original,
      validUntilLedger,
      authPayload([args.sourceAccount], contextRuleIds, () => Buffer.alloc(0))
    ),
    ...contextRuleIds.map(() => delegatedSignerEntry(args.smartAccount, digest)),
  ]
  const txWithAuth = buildTx(makeOperation(authEntries))
  const enforcing = await args.rpc.simulateTransaction(txWithAuth)
  if (rpc.Api.isSimulationError(enforcing)) {
    throw new Error('revoke_policy: auth simulateTransaction failed')
  }
  const finalTx = rpc.assembleTransaction(txWithAuth, enforcing).build()

  return {
    unsignedXdr: finalTx.toEnvelope().toXDR().toString('base64'),
    smartAccount: args.smartAccount,
    sourceAccount: args.sourceAccount,
    call: { contract: args.smartAccount, fn: 'remove_context_rule', ruleId: args.ruleId },
    authNonce: original.credentials().address().nonce().toString(),
    authValidUntilLedger: validUntilLedger,
    rootInvocationXdr: original.rootInvocation().toXDR().toString('base64'),
  }
}

export interface BuildRevokePolicyResult {
  unsignedXdr: string
  smartAccount: string
  sourceAccount: string
  call: { contract: string; fn: 'remove_context_rule'; ruleId: number }
  authNonce: string
  authValidUntilLedger: number
  rootInvocationXdr: string
}

/** ~25 minutes at 5s/ledger. */
const DEFAULT_AUTH_VALID_UNTIL_LEDGERS = 300

// ---- internals ----

/** Adapter: turn the install-policy wire `PolicyRef` shape into the core
 *  `PolicyRef` shape `buildAddContextRuleArgs` expects. Keeps the wire
 *  schema hand-rolled + flat (the strict union would need a recursive
 *  schema) while delegating to the proven encoder for the actual bytes. */
function adaptPolicyRef(p: BuildInstallPolicyPolicyRef) {
  if (p.kind === 'interpreter') {
    return {
      kind: 'interpreter' as const,
      interpreterAddress: p.interpreterAddress,
      predicateBlobBase64: p.predicateBlobBase64,
    }
  }
  return {
    kind: 'oz_builtin' as const,
    instanceAddress: p.instanceAddress,
    primitive: p.primitive,
  }
}

/** Build an unsigned Soroban transaction envelope. The `sequence` is
 *  whatever `getAccount().sequenceNumber()` returned (a string of digits
 *  the SDK accepts). No signing. The returned Transaction is what
 *  `simulateTransaction` accepts. */
function buildUnsignedTx(args: {
  sourceAccount: string
  sequence: string
  // String, not number: the SDK's BASE_FEE is a decimal string and
  // TransactionBuilder wants one, so carrying a number here forced a
  // conversion at every call site and the two disagreed.
  fee: string
  networkPassphrase: string
  op: xdr.Operation
}): Transaction {
  const account = new Account(args.sourceAccount, args.sequence)
  const tx = new TransactionBuilder(account, {
    fee: args.fee,
    networkPassphrase: args.networkPassphrase,
  })
    .addOperation(args.op)
    .setTimeout(0)
    .build()
  // `TransactionBuilder.build()` returns a Transaction whose envelope
  // has empty signatures. The wallet re-reads the unsigned XDR, appends
  // its signature, and broadcasts. We do NOT sign here.
  return tx
}

/** Decode the install call's structured fields directly out of the final
 *  assembled transaction. The bytes are the source of truth: a human reviewing
 *  the install wants to see what the wallet will actually sign, not what we
 *  think it will. The decode is deliberately strict - any shape we did not
 *  build ourselves throws, since that would mean the XDR was tampered with (or
 *  the encoder changed and this descriptor lags).
 *
 *  `expectedInstallNonce` is a fallback for the rare case where the
 *  install has no interpreter policy (no `install_nonce` to read); the
 *  caller already knows it. */
function decodeInstallCallDescribes(
  tx: Transaction,
  expectedInstallNonce: number
): InstallCallDescribes {
  const operations = tx.toEnvelope().v1().tx().operations()
  if (operations.length !== 1 || !operations[0]) {
    throw new Error(
      `install_policy: final transaction has ${operations.length} operations, expected 1`
    )
  }
  const op = operations[0]
  const hostFn = op.body().invokeHostFunctionOp()?.hostFunction()
  if (hostFn?.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Error(
      'install_policy: built op is not an invokeHostFunction(invokeContract(...)) call'
    )
  }
  const invokeArgs = hostFn.invokeContract()
  if (!invokeArgs) {
    throw new Error('install_policy: built op has no InvokeContractArgs payload')
  }
  const targetContract = Address.fromScAddress(invokeArgs.contractAddress()).toString()
  const fnName = invokeArgs.functionName().toString()
  if (fnName !== 'add_context_rule') {
    throw new Error(`install_policy: built op fn name is "${fnName}", expected "add_context_rule"`)
  }
  const scvArgs = invokeArgs.args()
  if (scvArgs.length !== 5) {
    throw new Error(
      `install_policy: built op has ${scvArgs.length} args, expected 5 (context_type, name, valid_until, signers, policies)`
    )
  }
  const contextType = scvArgs[0]
  const nameScv = scvArgs[1]
  const validUntilScv = scvArgs[2]
  const signersScv = scvArgs[3]
  const policiesScv = scvArgs[4]
  // The length check above pins these as defined; the local references
  // satisfy noUncheckedIndexedAccess on the accessors below.
  if (!nameScv || !validUntilScv || !signersScv || !policiesScv || !contextType) {
    throw new Error('install_policy: built op args include an undefined slot despite length check')
  }

  // name
  if (nameScv.switch().name !== 'scvString') {
    throw new Error('install_policy: args[1] (name) is not an ScVal::String')
  }
  const ruleName = nameScv.str().toString()

  // valid_until (Option<u32> -> void when absent)
  let validUntilLedger: number | null
  if (validUntilScv.switch().name === 'scvVoid') {
    validUntilLedger = null
  } else if (validUntilScv.switch().name === 'scvU32') {
    validUntilLedger = validUntilScv.u32()
  } else {
    throw new Error('install_policy: args[2] (valid_until) is neither void nor u32')
  }

  // signers (Vec<Vec<Symbol, Address[, Bytes]>>)
  if (signersScv.switch().name !== 'scvVec') {
    throw new Error('install_policy: args[3] (signers) is not an ScVal::Vec')
  }
  const signers: InstallCallDescribes['signers'] = []
  for (const signerScv of signersScv.vec() ?? []) {
    if (signerScv.switch().name !== 'scvVec') {
      throw new Error('install_policy: a signer entry is not an ScVal::Vec')
    }
    const tuple = signerScv.vec() ?? []
    const tag = tuple[0]?.sym().toString()
    const inner = tuple[1]
    if (tag === 'Delegated') {
      if (inner?.switch().name !== 'scvAddress') {
        throw new Error('install_policy: a Delegated signer is missing its Address')
      }
      signers.push({
        kind: 'delegated',
        address: Address.fromScAddress(inner.address()).toString(),
      })
      continue
    }
    if (tag === 'External') {
      if (inner?.switch().name !== 'scvAddress') {
        throw new Error('install_policy: an External signer is missing its verifier Address')
      }
      signers.push({
        kind: 'external',
        verifier: Address.fromScAddress(inner.address()).toString(),
      })
      continue
    }
    throw new Error(`install_policy: signer tag "${tag ?? '<missing>'}" is not Delegated|External`)
  }

  // policies (Map<Address, Val>). Re-derive an interpreter-vs-OZ primitive
  // classification by inspecting the value's map keys (PolicyInstallParams
  // starts with `grammar_version`/`install_nonce`/`predicate`; OZ primitive
  // params start with `spending_limit`/`threshold`/`period_ledgers`).
  if (policiesScv.switch().name !== 'scvMap') {
    throw new Error('install_policy: args[4] (policies) is not an ScVal::Map')
  }
  const policies: InstallCallDescribes['policies'] = []
  let observedInstallNonce: number | null = null
  for (const entry of policiesScv.map() ?? []) {
    const key = entry.key()
    if (key.switch().name !== 'scvAddress') {
      throw new Error('install_policy: a policies map entry has a non-Address key')
    }
    const address = Address.fromScAddress(key.address()).toString()
    const val = entry.val()
    if (val.switch().name !== 'scvMap') {
      throw new Error(
        `install_policy: policies[${address}] value is not an ScVal::Map (got ${val.switch().name})`
      )
    }
    const fields = new Map<string, xdr.ScVal>()
    for (const inner of val.map() ?? []) {
      const fk = inner.key()
      if (fk.switch().name !== 'scvSymbol') {
        throw new Error(`install_policy: policies[${address}] field key is not an ScVal::Symbol`)
      }
      fields.set(fk.sym().toString(), inner.val())
    }
    // Interpreter policy fields carry grammar_version/install_nonce/predicate.
    // OZ primitives carry spending_limit/period_ledgers/threshold/signers.
    if (fields.has('predicate') || fields.has('grammar_version') || fields.has('install_nonce')) {
      const installNonceScv = fields.get('install_nonce')
      if (installNonceScv?.switch().name !== 'scvU32') {
        throw new Error(
          `install_policy: interpreter policy ${address} is missing a u32 install_nonce`
        )
      }
      const installNonce = installNonceScv.u32()
      const predicateScv = fields.get('predicate')
      if (predicateScv?.switch().name !== 'scvBytes') {
        throw new Error(
          `install_policy: interpreter policy ${address} is missing its bytes predicate`
        )
      }
      const predicateBytes = Buffer.from(predicateScv.bytes())
      const predicateSha256OfEmbeddedBytes = createHash('sha256')
        .update(predicateBytes)
        .digest('hex')
      const predicateHashScv = fields.get('predicate_hash')
      const predicateHash =
        predicateHashScv && predicateHashScv.switch().name === 'scvBytes'
          ? Buffer.from(predicateHashScv.bytes()).toString('hex')
          : ''
      policies.push({
        kind: 'interpreter',
        address,
        installNonce,
        predicateHash,
        predicateSha256OfEmbeddedBytes,
      })
      observedInstallNonce = installNonce
      continue
    }
    // OZ built-in primitive. Distinguish by the parameter shape we
    // emitted; matching one of the three primitives exactly pins the
    // kind we built.
    if (fields.has('spending_limit') && fields.has('period_ledgers')) {
      policies.push({ kind: 'oz_builtin', address, primitive: 'spending_limit' })
      continue
    }
    if (fields.has('threshold') && fields.has('signer_weights')) {
      policies.push({ kind: 'oz_builtin', address, primitive: 'weighted_threshold' })
      continue
    }
    if (fields.has('threshold')) {
      policies.push({ kind: 'oz_builtin', address, primitive: 'simple_threshold' })
      continue
    }
    throw new Error(
      `install_policy: policies[${address}] value has an unknown field set; the encoder may have drifted`
    )
  }
  // `observedInstallNonce` is the nonce baked into whichever interpreter
  // policy is present; when none, fall back to the caller-supplied value.
  const installNonce = observedInstallNonce ?? expectedInstallNonce
  // Cross-layer L1: OZ Accounts context rules follow any-of-N semantics for
  // the signers they accept - any ONE attached signer may authorise a
  // permitted op under the rule. A user with multiple signers attached
  // therefore has a strict superset of authority of a single-signer rule,
  // not a stricter one; the install succeeds as written, but a human
  // reviewing the install card may expect the opposite (and choose the
  // wrong threshold because of it). Surface the any-of-N note on the
  // description so the human reads the same wire-level semantic the
  // contract enforces.
  const signerNote =
    signers.length >= 2
      ? 'any ONE signer may authorise a permitted op under this rule (OZ any-of-N semantic)'
      : null
  return {
    targetContract,
    fnName: 'add_context_rule',
    ruleName,
    validUntilLedger,
    signers,
    signerNote,
    policies,
    installNonce,
  }
}

/** Re-export so the run-layer does not need to import from
 *  build-add-context-rule.ts (keeps the install/ -> install/ dependency
 *  direction intact). */
export { Contract, DEFAULT_GRAMMAR_VERSION }

// Local re-import to avoid pulling the class from the SDK module path
// at the top of the file (avoids the unused-import lint).
import { Account } from '@stellar/stellar-sdk'
