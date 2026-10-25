// The unsigned transaction that installs or removes a rule, and the OpenZeppelin
// authorisation it needs. Nothing here signs: the wallet's signature is the
// confirmation. `add_context_rule` carries the interpreter's install parameters,
// so one signed transaction installs the predicate.
//
// Both calls are the smart account calling itself, so each is built the same way:
// simulate once to learn the nonce and invocation OZ's auth payload binds, attach
// the account's own auth entries, simulate again for the footprint and fee, and
// assemble. The arguments are wire values (`toScVal`), the same codec as a predicate.

import {
  Account,
  Address,
  BASE_FEE,
  hash,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  type ContractKind,
  type Fingerprint,
  interpreterFor,
  mismatch,
  reasonOf,
  txOf,
} from './chain.ts'
import {
  authLedgers,
  GRAMMAR_VERSION,
  LEDGER_SECONDS,
  maxResourceFee,
  type Network,
  PASSPHRASE,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
  safeRead,
  thresholdAddress,
} from './config.ts'
import { type ErrorCode, Refusal } from './envelope.ts'
import {
  type Followed,
  type ObservedRule,
  type Overlap,
  overlaps,
  type RulesRead,
  type Scope,
  selectors,
} from './rules.ts'
import { type Expr, readsOf, toScVal, type Val } from './wire.ts'

export interface RuleDraft {
  scope: Scope
  name: string
  /** Ledger sequence after which the rule lapses (OZ `valid_until`). */
  validUntil: number | null
  /** Delegated signers (G... or C... accounts): the keys the rule governs. */
  signers: string[]
  /** The Policy Signer role: who may re-install, uninstall and rotate. */
  admins: string[]
  predicate: { encoded: string; hash: string }
  nonce: number
  /** A rolling total beside the predicate, as OZ's `spending_limit` on the same rule. */
  cap?: { address: string; amount: string; periodLedgers: number }
  /** Other policies beside the interpreter, as (address, install params): a threshold. */
  extra?: [string, Val][]
}

/** How far apart the two simulations of one build may report the ledger: seconds pass between them,
 *  and nodes behind one endpoint can lag each other, but not by hours. */
const LEDGER_DRIFT = 20

export const delegated = (a: string): Val => ['Delegated', a]
/** OZ `spending_limit`'s install params: a rolling total over a window of ledgers. */
export const spendingParams = (t: { amount: string; periodLedgers: number }): Val => ({
  map: [
    ['period_ledgers', t.periodLedgers],
    ['spending_limit', { i128: t.amount }],
  ],
})

/** OZ's threshold policy and its install params (`signer_weights`, a signer -> u32 map, if weighted). */
const thresholdPolicy = (net: Network, { n, weights: w }: NonNullable<InstallInput['threshold']>) =>
  [
    thresholdAddress(net, !!w),
    {
      map: [
        ...(w
          ? [['signer_weights', { map: Object.entries(w).map(([a, x]) => [delegated(a), x]) }]]
          : []),
        ['threshold', n],
      ],
    },
  ] as [string, Val]

/** The five arguments of OZ's `add_context_rule`, as wire values. */
export function ruleArgs(d: RuleDraft, interpreter: string): Val[] {
  const scope: Val =
    d.scope.kind === 'call_contract'
      ? ['CallContract', d.scope.contract]
      : d.scope.kind === 'create_contract'
        ? ['CreateContract', { bytes: d.scope.wasmHash }]
        : ['Default']
  // Over 15 signers and an empty admin set are left to the chain: OZ's add_context_rule (#3010) and
  // the interpreter's install (#209). planInstall refuses a signer twice (OZ would too, #3007).
  // A rule with no signer installs on chain (a keyless rule), so it is refused here.
  if (d.signers.length === 0)
    throw new Refusal('INSTALL_BUILD_FAILED', 'the rule names no signer, so it would govern no key')
  const predicate = { bytes: Buffer.from(d.predicate.encoded, 'base64').toString('hex') }
  const policies: [Val, Val][] = [
    [
      interpreter,
      {
        map: [
          ['grammar_version', GRAMMAR_VERSION],
          ['install_nonce', d.nonce],
          ['policy_admins', d.admins.map(delegated)],
          ['predicate', predicate],
          ['predicate_hash', { bytes: d.predicate.hash }],
        ],
      },
    ],
    ...(d.cap ? [[d.cap.address, spendingParams(d.cap)] as [Val, Val]] : []),
    ...(d.extra ?? []),
  ]
  return [scope, { string: d.name }, d.validUntil, d.signers.map(delegated), { map: policies }]
}

export interface Built {
  unsignedXdr: string
  smartAccount: string
  sourceAccount: string
  authNonce: string
  authValidUntilLedger: number
  /** The transaction's time bound (unix seconds, the builder's clock): it cannot run after it. */
  validBefore: number
  /** In stroops: the bid per operation, the resource fee (at most the operator's ceiling), their sum. */
  fee: { base: number; resource: number; total: number }
}

export interface BuildArgs {
  server: rpc.Server
  network: Network
  smartAccount: string
  sourceAccount: string
  baseFee?: number | undefined
}

/** The OZ auth payload, per `stellar-contracts` smart_account: the digest the signer
 *  commits to is sha256(sha256(preimage) || context_rule_ids as XDR). */
export const digest = (
  network: Network,
  nonce: xdr.Int64,
  until: number,
  inv: xdr.SorobanAuthorizedInvocation,
  ids: number[]
) =>
  hash(
    Buffer.concat([
      hash(
        xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId: hash(Buffer.from(PASSPHRASE[network])),
            nonce,
            signatureExpirationLedger: until,
            invocation: inv,
          })
        ).toXDR()
      ),
      toScVal(ids).toXDR(),
    ])
  )

/** Build `smartAccount.<fn>(args)` as an unsigned transaction with the account's
 *  own auth entries attached, authorised by rule 0 (the deploy-time admin rule). */
export async function buildSelfCall(
  a: BuildArgs,
  fn: string,
  args: Val[],
  code: ErrorCode = 'INSTALL_BUILD_FAILED'
): Promise<Built> {
  const { server, network } = a
  // The operator's bounds, read before the network is asked: a bad value refuses every build.
  const [window, ceiling] = [authLedgers(), maxResourceFee()]
  const op = (auth: xdr.SorobanAuthorizationEntry[] = []) =>
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(a.smartAccount).toScAddress(),
          functionName: fn,
          args: args.map(toScVal),
        })
      ),
      auth,
    })
  const tx = (o: xdr.Operation, sequence: string) =>
    txOf(network, new Account(a.sourceAccount, sequence), o, String(a.baseFee ?? BASE_FEE))
  const simulate = async (t: Transaction, what: string) => {
    const sim = await server.simulateTransaction(t)
    if (rpc.Api.isSimulationError(sim))
      throw new Refusal(code, `${fn}: ${what} simulation refused (${reasonOf(sim.error)})`)
    return sim
  }
  // The recording pass does not look at the sequence number, so it runs while the real one is fetched.
  const [source, recorded] = await Promise.all([
    server.getAccount(a.sourceAccount),
    simulate(tx(op(), '0'), 'recording'),
  ])
  const original = (recorded.result?.auth ?? []).find((e) => isAddressEntry(e, a.smartAccount))
  if (!original)
    throw new Refusal(
      code,
      `${fn}: no auth entry for ${a.smartAccount}; the call does not route through the smart account`
    )
  // The account signs this tree as the RPC reported it, and the review describes only the built
  // call. So the tree must be that call alone: the same contract, function and arguments, with
  // nothing under it. An RPC that adds a sub-invocation (a transfer out) or swaps the call is refused.
  const root = original.rootInvocation()
  const built = op().body().invokeHostFunctionOp().hostFunction().invokeContract()
  const same =
    root.function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn' &&
    root.function().contractFn().toXDR('base64') === built.toXDR('base64')
  if (!same || root.subInvocations().length > 0)
    throw new Refusal(
      code,
      `${fn}: the simulation asked ${a.smartAccount} to authorise something other than this call (${
        same ? `${root.subInvocations().length} sub-invocation(s) under it` : 'another call'
      }); the RPC answer is not trusted`
    )
  // The simulation reports the ledger it ran at: no separate (and heavy) latest-ledger call. The
  // enforcing pass must report about the same ledger, and the transaction's time bound, from this
  // clock, ends it within the window even if an RPC moved both.
  const until = recorded.latestLedger + window
  const creds = original.credentials().address()
  const ids = [0]
  const account = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: creds.address(),
        nonce: creds.nonce(),
        signatureExpirationLedger: until,
        // OZ AuthPayload { context_rule_ids, signers }: the source account signs, so its signature is empty here.
        signature: toScVal({
          map: [
            ['context_rule_ids', ids],
            ['signers', { map: [[delegated(a.sourceAccount), { bytes: '' }]] }],
          ],
        }),
      })
    ),
    rootInvocation: original.rootInvocation(),
  })
  // The smart account's `__check_auth` is itself authorised for the delegated signer.
  const checkAuth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(a.smartAccount).toScAddress(),
          functionName: '__check_auth',
          args: [
            xdr.ScVal.scvBytes(
              digest(network, creds.nonce(), until, original.rootInvocation(), ids)
            ),
          ],
        })
      ),
      subInvocations: [],
    }),
  })
  const withAuth = tx(op([account, checkAuth]), source.sequenceNumber())
  const enforced = await simulate(withAuth, 'enforcing')
  const drift = Math.abs(enforced.latestLedger - recorded.latestLedger)
  if (drift > LEDGER_DRIFT)
    throw new Refusal(
      code,
      `${fn}: the two simulations ran at ledgers ${recorded.latestLedger} and ${enforced.latestLedger}, ${drift} apart; the RPC answer is not trusted`
    )
  // `assembleTransaction` sets the fee to the base fee plus the resource fee, and `build` adds the
  // resource fee from the Soroban data again: bid the base fee once and let `build` add the resources.
  // The fee is judged as the RPC gave it, before any arithmetic on it.
  // A negative one is the network's to refuse (txMALFORMED), and review_unsigned flags it.
  const asked = enforced.transactionData.build().resourceFee().toBigInt()
  if (asked > BigInt(ceiling))
    throw new Refusal(
      code,
      `${fn}: the network asks a resource fee of ${xlm(asked)} XLM, above this builder's ceiling of ${xlm(ceiling)} XLM (POLICY_BUILDER_MAX_RESOURCE_FEE, in stroops); not built`
    )
  const assembled = rpc.assembleTransaction(withAuth, enforced).build()
  const sorobanData = assembled.toEnvelope().v1().tx().ext().sorobanData()
  const resource = Number(sorobanData.resourceFee().toBigInt())
  const base = a.baseFee ?? Number(BASE_FEE)
  const validBefore = Math.floor(Date.now() / 1000) + window * LEDGER_SECONDS
  const final = TransactionBuilder.cloneFrom(assembled, {
    fee: String(base),
    sorobanData,
    networkPassphrase: PASSPHRASE[network],
    timebounds: { minTime: 0, maxTime: validBefore },
  }).build()
  return {
    unsignedXdr: final.toEnvelope().toXDR('base64'),
    smartAccount: a.smartAccount,
    sourceAccount: a.sourceAccount,
    authNonce: creds.nonce().toString(),
    authValidUntilLedger: until,
    validBefore,
    fee: { base, resource, total: Number(final.fee) },
  }
}

/** Whether an auth entry carries the address credentials of `account`. */
export const isAddressEntry = (e: xdr.SorobanAuthorizationEntry, account: string) =>
  e.credentials().switch().name === 'sorobanCredentialsAddress' &&
  Address.fromScAddress(e.credentials().address().address()).toString() === account

/** Stroops as XLM, exactly: 2000000000 -> 200, 1711054 -> 0.1711054. */
export const xlm = (stroops: number | bigint): string => {
  const t = String(stroops).padStart(8, '0')
  const frac = t.slice(-7).replace(/0+$/, '')
  return frac ? `${t.slice(0, -7)}.${frac}` : t.slice(0, -7)
}

export const buildInstall = (a: BuildArgs, d: RuleDraft, interpreter: string) =>
  buildSelfCall(a, 'add_context_rule', ruleArgs(d, interpreter))

export const buildRevoke = (a: BuildArgs, ruleId: number) =>
  buildSelfCall(a, 'remove_context_rule', [ruleId], 'REVOKE_BUILD_FAILED')

/** Why a rule an execution adapter with no gate signs is refused (the review of #26, P4). */
export const NULL_ADAPTER_SIGNER = (signer: string) =>
  `signer ${signer} is an execution adapter bound to no gate: whoever the account lets call its execute (an agent) could cite this rule for a call the adapter makes, and move the account's funds past that agent's own capped rules`

/** Why a rule an execution adapter signs, scoped to that same adapter, is refused unless every
 *  branch pins `call_fn = run` (review-opb28 L1). The adapter's signature holds whenever it is the
 *  one asking the account, which it is for its own `execute`, `run` and `cancel`: such a rule
 *  answers whoever calls them, with no key. */
export const ADAPTER_SELF_RULE = (signer: string) =>
  `signer ${signer} is an execution adapter, and this rule is scoped to it without pinning call_fn = run in every branch: the adapter signs whenever it asks the account, so anyone, with no key, could have it approve an immediate execute (or a cancel) of the account's batches`

/** Whether every branch of a predicate pins `call_fn = run` (an unsatisfiable one pins nothing it
 *  could permit). A predicate the package cannot read pins nothing. */
export const pinsRun = (e: Expr | null | undefined): boolean =>
  e !== null && e !== undefined && selectors(e).every((s) => s.fn === 'run')

/** Why a contract signer may not sign a rule scoped to `scopedTo` with predicate `expr`, from what
 *  it is on the ledger: an adapter bound to no gate, an adapter signing a rule scoped to itself that
 *  does not pin `run`, or nothing deployed. No override waives these: the owners cannot see from the
 *  rule what a contract signer will do. */
export function signerProblem(
  signer: string,
  kind: ContractKind,
  scopedTo: string | undefined,
  expr: Expr | null
): string | undefined {
  if (kind === 'null-gate adapter') return NULL_ADAPTER_SIGNER(signer)
  if (kind === 'gated adapter' && signer === scopedTo && !pinsRun(expr))
    return ADAPTER_SELF_RULE(signer)
  if (kind === 'absent')
    return `signer ${signer} is not deployed, so what it will run cannot be checked; deploy it before a rule names it`
}

/** The signers that meet threshold `n` alone, by their weights. */
export const meetsAlone = (signers: string[], weights: Record<string, number>, n: number) =>
  signers.filter((s) => (weights[s] as number) >= n)

// ---- the overrides ----

/** The inputs that waive a refusal. An agent could read one off a refusal and set it, so no refusal
 *  names them, every one set is echoed, and on mainnet they need the operator's switch. */
export type OverrideFlag =
  | 'allowUnboundedAmount'
  | 'allowOpenSlippage'
  | 'allowOverlap'
  | 'allowAdminRule'
  | 'anyOne'

/** The overrides an install takes, in the order its refusals come. */
export const INSTALL_OVERRIDES = [
  'allowUnboundedAmount',
  'allowOpenSlippage',
  'anyOne',
  'allowOverlap',
] as const

/** An override the request set, with the refusal it waived (`null`: nothing needed it). */
export interface Override {
  flag: OverrideFlag
  waived: string | null
}

/** On mainnet an override is honoured only when the operator sets POLICY_BUILDER_ALLOW_OVERRIDES=1:
 *  refused before the network is asked. Testnet honours them, echoed all the same. */
export function gate(network: Network, set: OverrideFlag[], code: ErrorCode): void {
  if (network !== 'mainnet' || set.length === 0) return
  if (process.env.POLICY_BUILDER_ALLOW_OVERRIDES === '1') return
  throw new Refusal(
    code,
    `${set.join(', ')} ${set.length > 1 ? 'are' : 'is'} set, and on mainnet an override is honoured only when the operator sets POLICY_BUILDER_ALLOW_OVERRIDES=1; build without it, or take the refusal to the account's owners`
  )
}

// ---- the removal ----

/** What a removal asks of the network: the rule being removed, and the build. */
export interface RevokeChain {
  readRule: (id: number) => Promise<ObservedRule | undefined>
  build: (id: number) => Promise<Built>
}

/** The unsigned removal of a rule, with the rule it removes. Removing rule 0 or any
 *  Default-scoped rule can leave the account with nothing able to authorise its own
 *  administration, for good: refused unless `allowAdminRule`. */
export async function planRevoke(
  i: {
    network: Network
    ruleId: number
    smartAccount: string
    allowAdminRule?: boolean | undefined
  },
  chain: RevokeChain
) {
  const set: OverrideFlag[] = i.allowAdminRule === true ? ['allowAdminRule'] : []
  gate(i.network, set, 'REVOKE_BUILD_FAILED')
  const [rule, built] = await Promise.allSettled([chain.readRule(i.ruleId), chain.build(i.ruleId)])
  if (rule.status === 'rejected') throw rule.reason
  const removes = rule.value
  if (removes === undefined) {
    if (built.status === 'rejected') throw built.reason
    throw new Refusal('REVOKE_BUILD_FAILED', `the account has no rule ${i.ruleId}`)
  }
  // Rule 0, a Default scope, and a scope on the account itself (it authorises add_context_rule).
  const own = removes.scope.kind === 'call_contract' && removes.scope.contract === i.smartAccount
  let waived: string | null = null
  if (i.ruleId === 0 || removes.scope.kind === 'default' || own) {
    waived = `rule ${i.ruleId} is ${removes.scope.kind === 'default' ? 'Default-scoped' : own ? 'scoped to the account itself' : "the account's first rule"}: removing it can lock the account out of its own administration for good`
    if (i.allowAdminRule !== true) throw new Refusal('REVOKE_BUILD_FAILED', waived)
  }
  if (built.status === 'rejected') throw built.reason
  const overrides: Override[] = set.map((flag) => ({ flag, waived }))
  return { ...built.value, removes, overrides }
}

// ---- the install, with every refusal in one place ----

/** What an install is asked for, past the choice of the rule. */
export interface InstallInput {
  network: Network
  smartAccount: string
  sourceAccount: string
  signers: string[]
  admins?: string[] | undefined
  name?: string | undefined
  validUntilLedger?: number | undefined
  installNonce?: number | undefined
  spendingLimit?: { amount: string; periodLedgers: number } | undefined
  /** `n` of the signers must approve, or (with `weights`) signers whose weights total `n`. */
  threshold?: { n: number; weights?: Record<string, number> } | undefined
  /** Say it on purpose: with several signers and no threshold, any ONE of them acts alone. */
  anyOne?: boolean | undefined
  allowUnboundedAmount?: boolean | undefined
  allowOpenSlippage?: boolean | undefined
  allowOverlap?: boolean | undefined
  interpreterAddress?: string | undefined
}

/** The rule to install, and the amount question its source left unanswered. */
export interface Chosen {
  contract: string
  /** What the rule permits: its predicate, or (with `follows`) the followed rule's as it is now. */
  expr: Expr
  /** The install payload (base64) and its sha256: the predicate, or the reference with `follows`. */
  encoded: string
  hash: string
  /** The rule carries no predicate: it follows this rule's (`expr`), read at every call. */
  follows?: Followed | undefined
  unanswered?: string | undefined
  /** The least-output question of a swap whose floor nothing set. */
  openSlippage?: string | undefined
}

/** What an install asks of the network: the interpreter's live fingerprint, the
 *  account's rules, and the built transaction. Tests answer these without a network. */
export interface Chain {
  fingerprint: (interpreter: string) => Promise<Fingerprint>
  readRules: (account: string, interpreter: string) => Promise<RulesRead>
  build: (draft: RuleDraft, interpreter: string) => Promise<Built>
  /** Whether a contract is shown to be a SEP-41 token. */
  token: (contract: string) => Promise<boolean>
  /** What each contract signer is, read off the ledger. */
  contracts: (addresses: string[]) => Promise<Record<string, ContractKind>>
}

/** Every refusal an install can meet, in the order a reader should hear of them:
 *  the input, the interpreter, the account's other rules, the build. Anything the
 *  scan cannot judge is refused too. Three refusals can be waived by an override, and
 *  each override set comes back in `overrides` with what it waived. */
export async function planInstall(i: InstallInput, rule: Chosen, chain: Chain) {
  const no = (m: string) => new Refusal('INSTALL_BUILD_FAILED', m)
  const set = INSTALL_OVERRIDES.filter((f) => i[f] === true)
  gate(i.network, set, 'INSTALL_BUILD_FAILED')
  const waived: Partial<Record<OverrideFlag, string>> = {}
  /** Refuse with `message`, unless `flag` is set: then record what it waived (`what`). */
  const unless = (flag: OverrideFlag, what: string, message = what) => {
    if (i[flag as keyof InstallInput] !== true) throw no(message)
    waived[flag] = waived[flag] === undefined ? what : `${waived[flag]} ${what}`
  }
  if (rule.unanswered)
    unless(
      'allowUnboundedAmount',
      rule.unanswered,
      `${rule.unanswered} Answer with \`limit\` or \`limits\`.`
    )
  if (rule.openSlippage)
    unless(
      'allowOpenSlippage',
      rule.openSlippage,
      `${rule.openSlippage} Set a floor or minOut in an intent.`
    )
  if (POLICY_CONTRACTS.has(rule.contract) || rule.contract === i.smartAccount) {
    throw no(
      'a rule scoped to a policy contract or to the account itself would expose its admin calls; scope it to the contract the calls go to'
    )
  }
  const interpreter = interpreterFor(i.network, i.interpreterAddress)
  const [t, k] = [i.threshold, i.signers.length]
  // OZ refuses it too (#3007), but 1-of-n is judged here on distinct signers, whatever the account.
  if (new Set(i.signers).size !== k)
    throw no('a signer is listed twice: OpenZeppelin refuses a rule with duplicate signers')
  const total = t?.weights ? Object.values(t.weights).reduce((x, y) => x + y, 0) : k
  const covers =
    !t?.weights || Object.keys(t.weights).sort().join() === [...i.signers].sort().join()
  // 1-of-n is a threshold that one signer meets alone, or none at all.
  const w = t?.weights
  const oneOfN = k > 1 && (!t || (w ? Object.values(w).some((x) => x >= t.n) : t.n <= 1))
  if (t && (t.n > total || !covers))
    throw no(
      `threshold ${t.n} can never be met (weights must cover exactly the signers and total at least n)`
    )
  if (t && i.anyOne && !oneOfN) throw no('anyOne and a threshold contradict each other')
  if (oneOfN) {
    const alone = w
      ? `${meetsAlone(i.signers, w, t?.n ?? 0).join(', ')} alone meets the threshold of ${t?.n}`
      : `${t ? `a threshold of ${t.n}` : `${k} signers and no threshold`}: any ONE of the ${k} signers acts alone (1-of-${k})`
    unless('anyOne', alone, `${alone}. Give a threshold that needs more.`)
  }
  const draft: RuleDraft = {
    scope: { kind: 'call_contract', contract: rule.contract },
    name: i.name ?? `policy-${rule.hash.slice(0, 8)}`,
    validUntil: i.validUntilLedger ?? null,
    signers: i.signers,
    admins: i.admins ?? [i.sourceAccount],
    predicate: { encoded: rule.encoded, hash: rule.hash },
    nonce: i.installNonce ?? 1,
    ...(i.spendingLimit ? { cap: { address: SPENDING_LIMIT[i.network], ...i.spendingLimit } } : {}),
    ...(t ? { extra: [thresholdPolicy(i.network, t)] } : {}),
  }
  // A read is a live value: unless its source cannot be moved, an agent can move it just before the call.
  const reads = readsOf(rule.expr).filter(([c, f, args]) => !safeRead(i.network, c, f, args))
  if (reads.length > 0 && process.env.POLICY_BUILDER_ALLOW_SPOT_READS !== '1')
    throw new Refusal(
      'READ_UNSAFE',
      `the rule reads a live value an agent can move within one transaction (${reads.map(([c, f]) => `${f} on ${c}`).join(', ')}): only an oracle on the safe list is trusted. The operator can allow spot reads with POLICY_BUILDER_ALLOW_SPOT_READS=1.`
    )
  // OZ's spending_limit panics NotAllowed on every context but `transfer(from, to, amount)` of a token.
  if (i.spendingLimit) {
    if (selectors(rule.expr).some((s) => s.fn !== 'transfer'))
      throw no(
        'spendingLimit: OZ spending_limit denies every function but transfer: pin call_fn = transfer in the rule, or its other functions would always be refused'
      )
    if (!(await chain.token(rule.contract)))
      throw no(
        `spendingLimit: ${rule.contract} is not shown to be a token (a Stellar Asset Contract, or transfer(from, to, amount: i128) in its spec); retry if the network was slow`
      )
  }
  // The four do not depend on each other, so they run together; what each found is
  // judged in a fixed order, so the same input is refused for the same reason.
  const [live, kinds, scan, built] = await Promise.allSettled([
    chain.fingerprint(interpreter),
    chain.contracts(i.signers.filter((s) => s.startsWith('C'))),
    chain.readRules(i.smartAccount, interpreter),
    chain.build(draft, interpreter),
  ])
  const got = <T>(r: PromiseSettledResult<T>): T => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  }
  const fingerprint = got(live)
  if (!fingerprint.matches) throw mismatch(fingerprint)
  for (const [signer, kind] of Object.entries(got(kinds))) {
    const problem = signerProblem(signer, kind, rule.contract, rule.expr)
    if (problem) throw no(problem)
  }
  const read = got(scan)
  const found = overlaps(
    { ...draft, expr: rule.expr, ...(rule.follows ? { follows: rule.follows } : {}) },
    read.rules,
    interpreter,
    i.network
  )
  const refused = found.filter((o: Overlap) => o.severity === 'refuse')
  if (refused.length > 0)
    unless('allowOverlap', `refused: ${refused.map((o) => o.advice).join(' ')}`)
  if (!read.complete)
    unless(
      'allowOverlap',
      "the account's rules could not all be read, so whether this rule can bind is not known"
    )
  const overrides: Override[] = set.map((flag) => ({ flag, waived: waived[flag] ?? null }))
  return {
    ...got(built),
    authority: {
      signers: i.signers,
      threshold: t && { ...t, raw: draft.extra?.[0] as Val },
      admins: draft.admins,
      validUntil: draft.validUntil,
      total: i.spendingLimit ?? null,
      interpreter,
      limits: fingerprint.limits,
    },
    rule: {
      contract: rule.contract,
      predicateHash: rule.hash,
      ...(rule.follows ? { follows: rule.follows } : {}),
    },
    interpreter: fingerprint,
    authorityScan: { complete: read.complete, overlaps: found },
    overrides,
  }
}
