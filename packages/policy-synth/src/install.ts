// The unsigned transaction that installs or removes a rule, and the OpenZeppelin
// authorisation it needs. Nothing here signs: the wallet's signature is the
// confirmation. `add_context_rule` carries the interpreter's install parameters,
// so one signed transaction installs the predicate.
//
// Both calls are the smart account calling itself, so each is built the same way:
// simulate once to learn the nonce and invocation OZ's auth payload binds, attach
// the account's own auth entries, simulate again for the footprint and fee, and
// assemble. The arguments are wire values (`toScVal`), the same codec as a predicate.

import { createHash } from 'node:crypto'
import {
  Account,
  Address,
  BASE_FEE,
  hash,
  Operation,
  rpc,
  type Transaction,
  xdr,
} from '@stellar/stellar-sdk'
import { type Fingerprint, interpreterFor, mismatch, reasonOf, txOf } from './chain.ts'
import {
  GRAMMAR_VERSION,
  type Network,
  PASSPHRASE,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
  safeRead,
  thresholdAddress,
} from './config.ts'
import { type ErrorCode, Refusal } from './envelope.ts'
import {
  type ObservedRule,
  type Overlap,
  overlaps,
  type RulesRead,
  type Scope,
  selectors,
} from './rules.ts'
import { type Expr, fromScVal, toScVal, type Val } from './wire.ts'

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

const MAX_SIGNERS = 15
const AUTH_LEDGERS = 300 // about 25 minutes

const delegated = (a: string): Val => ['Delegated', a]

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
  const no = (m: string) => new Refusal('INSTALL_BUILD_FAILED', m)
  if (d.signers.length === 0) throw no('the rule names no signer, so it would govern no key')
  if (d.signers.length > MAX_SIGNERS)
    throw no(`${d.signers.length} signers; OpenZeppelin allows ${MAX_SIGNERS}`)
  if (d.admins.length === 0)
    throw no('the rule names no policy admin: the interpreter refuses an empty admin set')
  const policies: [Val, Val][] = [
    [
      interpreter,
      {
        map: [
          ['grammar_version', GRAMMAR_VERSION],
          ['install_nonce', d.nonce],
          ['policy_admins', d.admins.map(delegated)],
          ['predicate', { bytes: Buffer.from(d.predicate.encoded, 'base64').toString('hex') }],
          ['predicate_hash', { bytes: d.predicate.hash }],
        ],
      },
    ],
  ]
  if (d.cap) {
    policies.push([
      d.cap.address,
      {
        map: [
          ['period_ledgers', d.cap.periodLedgers],
          ['spending_limit', { i128: d.cap.amount }],
        ],
      },
    ])
  }
  policies.push(...(d.extra ?? []))
  return [scope, { string: d.name }, d.validUntil, d.signers.map(delegated), { map: policies }]
}

export interface Built {
  unsignedXdr: string
  /** Length and sha256 of `unsignedXdr`: a truncated copy fails later as a malformed transaction. */
  unsignedXdrLength: number
  unsignedXdrSha256: string
  smartAccount: string
  sourceAccount: string
  /** What the built bytes call, decoded back out of them. */
  describes: { contract: string; fn: string; args: Val[] }
  authNonce: string
  authValidUntilLedger: number
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
  const original = (recorded.result?.auth ?? []).find(
    (e) =>
      e.credentials().switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(e.credentials().address().address()).toString() === a.smartAccount
  )
  if (!original)
    throw new Refusal(
      code,
      `${fn}: no auth entry for ${a.smartAccount}; the call does not route through the smart account`
    )
  // The simulation reports the ledger it ran at: no separate (and heavy) latest-ledger call.
  const until = recorded.latestLedger + AUTH_LEDGERS
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
  const final = rpc.assembleTransaction(withAuth, await simulate(withAuth, 'enforcing')).build()
  const unsignedXdr = final.toEnvelope().toXDR('base64')
  return {
    unsignedXdr,
    unsignedXdrLength: unsignedXdr.length,
    unsignedXdrSha256: createHash('sha256').update(unsignedXdr).digest('hex'),
    smartAccount: a.smartAccount,
    sourceAccount: a.sourceAccount,
    describes: describe(final),
    authNonce: creds.nonce().toString(),
    authValidUntilLedger: until,
  }
}

/** What the transaction calls, read back out of the bytes the wallet will sign. */
export function describe(tx: Transaction): Built['describes'] {
  const ops = tx.toEnvelope().v1().tx().operations()
  const host = ops.length === 1 ? ops[0]?.body().invokeHostFunctionOp().hostFunction() : undefined
  if (host?.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Refusal('INSTALL_BUILD_FAILED', 'the built transaction is not a single contract call')
  }
  const c = host.invokeContract()
  return {
    contract: Address.fromScAddress(c.contractAddress()).toString(),
    fn: c.functionName().toString(),
    args: c.args().map((x) => fromScVal(x)),
  }
}

export const buildInstall = (a: BuildArgs, d: RuleDraft, interpreter: string) =>
  buildSelfCall(a, 'add_context_rule', ruleArgs(d, interpreter))

export const buildRevoke = (a: BuildArgs, ruleId: number) =>
  buildSelfCall(a, 'remove_context_rule', [ruleId], 'REVOKE_BUILD_FAILED')

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
  i: { ruleId: number; smartAccount: string; allowAdminRule?: boolean | undefined },
  chain: RevokeChain
) {
  const [rule, built] = await Promise.allSettled([chain.readRule(i.ruleId), chain.build(i.ruleId)])
  if (rule.status === 'rejected') throw rule.reason
  const removes = rule.value
  if (removes === undefined) {
    if (built.status === 'rejected') throw built.reason
    throw new Refusal('REVOKE_BUILD_FAILED', `the account has no rule ${i.ruleId}`)
  }
  // Rule 0, a Default scope, and a scope on the account itself (it authorises add_context_rule).
  const own = removes.scope.kind === 'call_contract' && removes.scope.contract === i.smartAccount
  if (!i.allowAdminRule && (i.ruleId === 0 || removes.scope.kind === 'default' || own)) {
    throw new Refusal(
      'REVOKE_BUILD_FAILED',
      `rule ${i.ruleId} is ${removes.scope.kind === 'default' ? 'Default-scoped' : own ? 'scoped to the account itself' : "the account's first rule"}: removing it can lock the account out of its own administration for good. Set allowAdminRule to build it anyway.`
    )
  }
  if (built.status === 'rejected') throw built.reason
  return { ...built.value, removes }
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
  expr: Expr
  encoded: string
  hash: string
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
}

/** Every refusal an install can meet, in the order a reader should hear of them:
 *  the input, the interpreter, the account's other rules, the build. Anything the
 *  scan cannot judge is refused too; `allowOverlap` is the one override. */
export async function planInstall(i: InstallInput, rule: Chosen, chain: Chain) {
  const no = (m: string) => new Refusal('INSTALL_BUILD_FAILED', m)
  if (rule.unanswered && !i.allowUnboundedAmount) {
    throw no(
      `${rule.unanswered} Answer with \`limit\` or \`limits\`, or set allowUnboundedAmount to install without it.`
    )
  }
  if (rule.openSlippage && !i.allowOpenSlippage) {
    throw no(
      `${rule.openSlippage} Set a floor or minOut in an intent, or set allowOpenSlippage to install without one.`
    )
  }
  if (POLICY_CONTRACTS.has(rule.contract) || rule.contract === i.smartAccount) {
    throw no(
      'a rule scoped to a policy contract or to the account itself would expose its admin calls; scope it to the contract the calls go to'
    )
  }
  const interpreter = interpreterFor(i.network, i.interpreterAddress)
  const [t, k] = [i.threshold, i.signers.length]
  const total = t?.weights ? Object.values(t.weights).reduce((x, y) => x + y, 0) : k
  const covers =
    !t?.weights || Object.keys(t.weights).sort().join() === [...i.signers].sort().join()
  if (t && i.anyOne) throw no('anyOne and a threshold contradict each other')
  if (t ? t.n > total || !covers : k > 1 && !i.anyOne)
    throw no(
      t
        ? `threshold ${t.n} can never be met (weights must cover exactly the signers and total at least n)`
        : `${k} signers and no threshold: with a policy on the rule any ONE of the ${k} signers acts alone (1-of-${k}). Give \`threshold\`, or \`anyOne: true\` to install 1-of-${k} on purpose.`
    )
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
  const reads = [...JSON.stringify(rule.expr).matchAll(/\["read","(C\w{55})","([^"]*)"/g)].filter(
    (m) => !safeRead(i.network, m[1] as string, m[2] as string)
  )
  if (reads.length > 0 && process.env.POLICY_BUILDER_ALLOW_SPOT_READS !== '1')
    throw new Refusal(
      'READ_UNSAFE',
      `the rule reads a live value an agent can move within one transaction (${reads.map((m) => `${m[2]} on ${m[1]}`).join(', ')}): only an oracle on the safe list is trusted. The operator can allow spot reads with POLICY_BUILDER_ALLOW_SPOT_READS=1.`
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
  // The three do not depend on each other, so they run together; what each found is
  // judged in a fixed order, so the same input is refused for the same reason.
  const [live, scan, built] = await Promise.allSettled([
    chain.fingerprint(interpreter),
    chain.readRules(i.smartAccount, interpreter),
    chain.build(draft, interpreter),
  ])
  const got = <T>(r: PromiseSettledResult<T>): T => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  }
  const fingerprint = got(live)
  if (!fingerprint.matches) throw mismatch(fingerprint)
  const read = got(scan)
  const found = overlaps({ ...draft, expr: rule.expr }, read.rules, interpreter, i.network)
  if (i.allowOverlap !== true) {
    const refused = found.filter((o: Overlap) => o.severity === 'refuse')
    if (refused.length > 0) {
      throw no(
        `refused: ${refused.map((o) => o.advice).join(' ')} Set allowOverlap to install anyway.`
      )
    }
    if (!read.complete)
      throw no(
        "the account's rules could not all be read, so whether this rule can bind is not known; set allowOverlap to install anyway"
      )
  }
  return {
    ...got(built),
    rule: { contract: rule.contract, predicateHash: rule.hash },
    interpreter: fingerprint,
    authorityScan: { complete: read.complete, overlaps: found },
  }
}
