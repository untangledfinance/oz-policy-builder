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
  codeHash,
  type Fingerprint,
  interpreterFor,
  mismatch,
  reasonOf,
  txOf,
} from './chain.ts'
import {
  type AccountAuth,
  accountAuth,
  authLedgers,
  GRAMMAR_VERSION,
  LEDGER_SECONDS,
  maxResourceFee,
  type Network,
  OZ_ACCOUNT_AUTH,
  PASSPHRASE,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
  safeRead,
  thresholdAddress,
} from './config.ts'
import { type ErrorCode, messageOf, Refusal } from './envelope.ts'
import {
  FLIP,
  type Followed,
  type ObservedRule,
  type Overlap,
  overlaps,
  type RulesRead,
  type Scope,
  selectors,
} from './rules.ts'
import {
  type Expr,
  intOf,
  isConstant,
  isSelector,
  readsOf,
  toScVal,
  unlit,
  type Val,
} from './wire.ts'

export interface RuleDraft {
  scope: Scope
  name: string
  /** Ledger sequence after which the rule lapses (OZ `valid_until`). */
  validUntil: number | null
  /** Delegated signers (G... or C... accounts): the keys the rule governs. None: a keyless rule. */
  signers: string[]
  /** The executor a keyless rule will be bound to (`bind_executor`, a second transaction): it
   *  permits nothing until then. Not an argument of `add_context_rule`. */
  executor?: string | undefined
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
  // A rule with no signer installs on chain (a keyless rule): written only for an executor to bind.
  if (d.signers.length === 0 && !d.executor)
    throw new Refusal(
      'INSTALL_BUILD_FAILED',
      'the rule names no signer, so it would govern no key; a keyless rule names the `executor` it will be bound to'
    )
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

/** OZ 0.8.0's `AuthDigestPreimage { account, context_rule_ids, signature_payload }`, the struct a
 *  Delegated signer of an 0.8.0 account authorises through `require_auth_for_args` (fields in
 *  name order, as a contract type is encoded). It binds the account's address too. */
export const authPreimage = (
  network: Network,
  account: string,
  nonce: xdr.Int64,
  until: number,
  inv: xdr.SorobanAuthorizedInvocation,
  ids: number[]
): xdr.ScVal =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('account'),
      val: new Address(account).toScVal(),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('context_rule_ids'), val: toScVal(ids) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signature_payload'),
      val: xdr.ScVal.scvBytes(
        hash(
          xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new xdr.HashIdPreimageSorobanAuthorization({
              networkId: hash(Buffer.from(PASSPHRASE[network])),
              nonce,
              signatureExpirationLedger: until,
              invocation: inv,
            })
          ).toXDR()
        )
      ),
    }),
  ])

/** The one argument of the account's `__check_auth` that a Delegated signer authorises, in the form
 *  the account's build asks for (`OZ_ACCOUNT_AUTH`). */
export const checkAuthArg = (
  form: AccountAuth,
  network: Network,
  account: string,
  nonce: xdr.Int64,
  until: number,
  inv: xdr.SorobanAuthorizedInvocation,
  ids: number[]
): xdr.ScVal =>
  form === 'preimage'
    ? authPreimage(network, account, nonce, until, inv, ids)
    : xdr.ScVal.scvBytes(digest(network, nonce, until, inv, ids))

/** The authorisation form of the account's live code, read off the ledger. Anything but a known
 *  OpenZeppelin build is refused, and so is a failed read: the form is never guessed. */
export async function accountAuthOf(
  server: rpc.Server,
  account: string,
  fn: string,
  code: ErrorCode
): Promise<AccountAuth> {
  let wasm: string | undefined
  try {
    wasm = await codeHash(server, account)
  } catch (e) {
    throw new Refusal(code, `${fn}: could not read the code of ${account} (${messageOf(e)})`, {
      retryable: true,
    })
  }
  const form = accountAuth(wasm)
  if (!form)
    throw new Refusal(
      code,
      `${fn}: ${account} runs ${wasm ? `code ${wasm}` : 'no contract code'}, not an OpenZeppelin smart account build this package signs for (${Object.keys(OZ_ACCOUNT_AUTH).join(', ')}); not built`
    )
  return form
}

/** Build `smartAccount.<fn>(args)` (or, with `to`, `to.<fn>(args)`, a call that asks the account's
 *  authorisation) as an unsigned transaction with the account's own auth entries attached,
 *  authorised by rule 0 (the deploy-time admin rule). A call to another contract may also ask the
 *  source account's own authorisation for exactly that call (an admin of the rule); nothing else. */
export async function buildSelfCall(
  a: BuildArgs,
  fn: string,
  args: Val[],
  code: ErrorCode = 'INSTALL_BUILD_FAILED',
  to: string = a.smartAccount
): Promise<Built> {
  const { server, network } = a
  // The operator's bounds, read before the network is asked: a bad value refuses every build.
  const [window, ceiling] = [authLedgers(), maxResourceFee()]
  const op = (auth: xdr.SorobanAuthorizationEntry[] = []) =>
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(to).toScAddress(),
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
  // The recording pass does not look at the sequence number, so it runs while the real one is
  // fetched, and while the account's code is read for the form its signer authorises.
  const [source, recorded, form] = await Promise.all([
    server.getAccount(a.sourceAccount),
    simulate(tx(op(), '0'), 'recording'),
    accountAuthOf(server, a.smartAccount, fn, code),
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
  // The source account's own authorisation of the call, when it is one of the rule's admins: exactly
  // the built call, nothing under it. A self call takes none; anything else the RPC asks is refused.
  const own = (recorded.result?.auth ?? []).filter((e) => !isAddressEntry(e, a.smartAccount))
  const sourceEntry = (e: xdr.SorobanAuthorizationEntry) =>
    e.credentials().switch().name === 'sorobanCredentialsSourceAccount' &&
    e.rootInvocation().function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn' &&
    e.rootInvocation().function().contractFn().toXDR('base64') === built.toXDR('base64') &&
    e.rootInvocation().subInvocations().length === 0
  if (to !== a.smartAccount && !own.every(sourceEntry))
    throw new Refusal(
      code,
      `${fn}: the simulation asked for an authorisation other than the account's and the source account's for this call; the RPC answer is not trusted`
    )
  const extra = to === a.smartAccount ? [] : own
  // The smart account's `__check_auth` is itself authorised for the delegated signer, in the form
  // the account's build asks for.
  const checkAuth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(a.smartAccount).toScAddress(),
          functionName: '__check_auth',
          args: [
            checkAuthArg(
              form,
              network,
              a.smartAccount,
              creds.nonce(),
              until,
              original.rootInvocation(),
              ids
            ),
          ],
        })
      ),
      subInvocations: [],
    }),
  })
  const withAuth = tx(op([account, checkAuth, ...extra]), source.sequenceNumber())
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

/** `interpreter.bind_executor((smartAccount, ruleId), executor)`, unsigned. */
export const buildBind = (a: BuildArgs, interpreter: string, ruleId: number, executor: string) =>
  buildSelfCall(
    a,
    'bind_executor',
    [[a.smartAccount, ruleId], executor],
    'BIND_BUILD_FAILED',
    interpreter
  )

/** Why a rule an execution adapter with no gate signs is refused (the review of #26, P4). */
export const NULL_ADAPTER_SIGNER = (signer: string) =>
  `signer ${signer} is an execution adapter bound to no gate: whoever the account lets call its execute (an agent) could cite this rule for a call the adapter makes, and move the account's funds past that agent's own capped rules`

/** Why a rule a contract that merely wears the adapter symbols signs is refused (SYNTH-IO-01): the
 *  two instance symbols (`prime`, `gate`) are forgeable, and the builder vouches for an adapter only
 *  when it also runs a pinned adapter build whose `prime` is this account. */
export const UNVERIFIED_ADAPTER_SIGNER = (signer: string) =>
  `signer ${signer} holds the adapter symbols (prime, gate) but does not run a pinned execution-adapter build this account can verify (or its prime is not this account): what it would run and hand out cannot be checked, so a rule it signs is refused`

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

// ---- what a rule scoped to its own executor may approve (the interpreter's `pins_own`) ----

/** A leaf as a path into the call: `call_arg(i)`, `call_arg_field(i, ...)` and `call_path(...)` are
 *  the same steps, and a length (`call_arg_len`, `call_path(..., true)`) ends in `true`. */
const pathOf = (v: Val): string | undefined => {
  if (!isSelector(v)) return undefined
  // A step written as `lit(symbol)` is that symbol.
  const [head, ...r] = v.map(unlit)
  if (head === 'call_arg' || head === 'call_arg_field' || head === 'call_path')
    return JSON.stringify(r)
  return head === 'call_arg_len' ? JSON.stringify([...r, true]) : undefined
}

/** Whether every path to a permit fixes the leaf `sel` accepts to a constant `ok` accepts: an `eq`
 *  between them (either side), or with `set` an `in` whose every entry `ok` accepts. An `and` pins
 *  when any child does, an `or` only when every child does; nothing else pins (`dsl::pins`). */
function pins(e: Val, sel: (l: Val) => boolean, ok: (v: Val) => boolean, set: boolean): boolean {
  if (!isSelector(e)) return false
  const [op, a, b] = e as [string, Val, Val]
  const fixed = (l: Val) => isConstant(l) && ok(unlit(l))
  if (op === 'and') return Array.isArray(a) && a.some((k) => pins(k, sel, ok, set))
  if (op === 'or') return Array.isArray(a) && a.length > 0 && a.every((k) => pins(k, sel, ok, set))
  if (op === 'eq') return (sel(a) && fixed(b)) || (sel(b) && fixed(a))
  if (op === 'in') return set && sel(a) && Array.isArray(b) && b.every(fixed)
  return false
}

/** An integer of a type the interpreter reads as a number (not the 256-bit ones). */
const smallInt = (v: Val): bigint | undefined =>
  typeof v === 'object' && v !== null && ('i256' in v || 'u256' in v) ? undefined : intOf(v)

/** Whether a predicate permits only what a rule scoped to its own executor may approve, as the
 *  interpreter's `pins_own` decides it (221 otherwise, at `bind_executor`, at a re-install under the
 *  binding and at `enforce`): the executor's `run` (`eq(call_fn, run)` on every path), or an
 *  IMMEDIATE `execute` of a fixed batch shape: on every path `eq(call_fn, execute)`, the wait
 *  (argument 2) `eq` 0, the number of calls `eq` a constant n <= m, where m counts the leading
 *  calls whose `target` and `function_name` are both an `eq` or an all-constant `in`. A quantifier
 *  pins nothing. A predicate the package cannot read pins nothing. */
export function pinsOwn(e: Expr | null | undefined): boolean {
  if (e === null || e === undefined) return false
  const fn = (name: string) =>
    pins(
      e,
      (l) => isSelector(l) && l[0] === 'call_fn' && l.length === 1,
      (v) => v === name,
      false
    )
  if (fn('run')) return true
  const at = (steps: Val[]) => {
    const want = JSON.stringify(steps)
    return (l: Val) => pathOf(l) === want
  }
  if (!fn('execute') || !pins(e, at([2]), (v) => smallInt(v) === 0n, false)) return false
  let m = 0
  const field = (i: number, key: string) => pins(e, at([0, i, key]), () => true, true)
  while (field(m, 'target') && field(m, 'function_name')) m++
  const short = (v: Val) => {
    const n = smallInt(v)
    return n !== undefined && n <= BigInt(m)
  }
  return pins(e, at([0, true]), short, false)
}

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
  if (kind === 'unverified adapter') return UNVERIFIED_ADAPTER_SIGNER(signer)
  if (kind === 'gated adapter' && signer === scopedTo && !pinsRun(expr))
    return ADAPTER_SELF_RULE(signer)
  if (kind === 'absent')
    return `signer ${signer} is not deployed, so what it will run cannot be checked; deploy it before a rule names it`
}

/** Whether every path to a permit holds the number of grants (argument 1 of an adapter's `execute`)
 *  to 0: `eq` 0, `lte` 0 or `lt` 1, either side written. */
export function pinsNoGrants(e: Expr | null | undefined): boolean {
  if (e === null || e === undefined || !isSelector(e)) return false
  const [op, a, b] = e as [string, Val, Val]
  if (op === 'and') return Array.isArray(a) && a.some(pinsNoGrants)
  if (op === 'or') return Array.isArray(a) && a.length > 0 && a.every(pinsNoGrants)
  const len = (l: Val) => pathOf(l) === JSON.stringify([1, true])
  const n = (v: Val) => (isConstant(v) ? smallInt(unlit(v)) : undefined)
  const [sel, k, o] = len(a) ? [a, b, op] : len(b) ? [b, a, FLIP[op] ?? op] : [undefined, a, op]
  if (sel === undefined) return false
  const x = n(k)
  return (
    x !== undefined &&
    ((o === 'eq' && x === 0n) || (o === 'lte' && x <= 0n) || (o === 'lt' && x <= 1n))
  )
}

/** Whether a predicate can permit a call to `execute` at all: some branch leaves the function open
 *  or names `execute`. */
export const permitsExecute = (e: Expr | null | undefined): boolean =>
  e === null || e === undefined || selectors(e).some((s) => s.fn === 'execute' || s.fn === '*')

/** Whether a KEYED rule scoped to an execution adapter with no gate is safe there: its signer calls
 *  that adapter's `execute`, and in an immediate one the adapter hands out its word
 *  (`enforce(prime, context)`) for whatever the batch's grants name, which a keyless rule bound to the
 *  adapter takes in place of a key. So the rule must hold the grants (argument 1) to none on every
 *  path, or permit no `execute`. A predicate that follows another rule's can change: never safe. */
export const keyedSafeOnNoGate = (expr: Expr | null | undefined, follows: boolean): boolean =>
  !follows && expr !== null && expr !== undefined && (!permitsExecute(expr) || pinsNoGrants(expr))

/** Why a keyed rule scoped to an execution adapter with no gate is refused (STRIDE E-36). */
export const WORD_LEAK = (adapter: string, rule?: number) =>
  `${rule === undefined ? 'the rule' : `rule ${rule}`} has signers and is scoped to ${adapter}, an execution adapter with no gate, without holding the grants of execute (argument 1) to none on every branch: its signer could have the adapter hand out its word to this account's policy, which a keyless rule bound to that adapter accepts in place of a key, and move the account's funds. Pin the grants to 0 (\`count\` at [1] is 0), or keep keyless rules on a no-gate adapter that no keyed rule is scoped to`

/** The keyed rules scoped to no-gate adapter `adapter` that could hand out its word: refused while any
 *  rule is (or is to be) bound to it. A rule whose predicate was not read counts. */
export const wordLeaks = (rules: ObservedRule[], adapter: string): ObservedRule[] =>
  rules.filter(
    (r) =>
      r.signers.length > 0 &&
      r.scope.kind === 'call_contract' &&
      r.scope.contract === adapter &&
      !keyedSafeOnNoGate(r.expr, r.follows !== undefined)
  )

// ---- the warnings: allowed, and said before anyone signs ----

/** What a KEYLESS rule that FOLLOWS another rule hands over (STRIDE E-38). With no signer its
 *  predicate is its only fence, and that predicate is the followed rule's, which that rule's admins
 *  (its master set) can re-install with its account at will, without this account. Through an
 *  adapter with no gate the shape pin (221) holds only target and function, so anyone could then
 *  move funds; through a gated adapter the gate still limits destinations. A keyed follower keeps
 *  its own signers as a fence. Never refused: an issuer governing a borrower's keyless rule this way
 *  is the intended pattern. The finding id stays in the text, so it ties to the threat model.
 *  Without `executor` (the install bytes do not carry it) the adapter is named as the bound one. */
export function KEYLESS_FOLLOWER(
  f: Followed,
  executor?: { address: string; kind?: ContractKind | undefined }
): string {
  const who = `the followed rule's admins (its master set${f.admins?.length ? `: ${f.admins.join(', ')}` : ''})`
  const head = `E-38: this keyless rule's entire fence is the followed rule (rule ${f.ruleId} of ${f.account}); ${who} can re-install it with that account at will, without this account's signature`
  const tail =
    executor?.kind === 'gated adapter'
      ? `: they control the predicate, and this rule's executor ${executor.address} is a verified gated adapter, so its gate still bounds the destinations its execute allows - but only to the set that gate was configured with, and those admins choose any call within it`
      : `, and loosen it to allow anyone to move funds through ${
          executor === undefined
            ? 'the adapter this rule is bound to'
            : `this rule's executor ${executor.address}${executor.kind === 'null-gate adapter' ? ', an execution adapter with no gate' : ''}`
        }`
  return `${head}${tail}. Only follow a rule whose admins you trust with these funds.`
}

/** The warnings a rule's authority earns: E-38 when it has no signer and follows another rule. */
export const ruleWarnings = (
  signers: readonly unknown[],
  follows: Followed | undefined,
  executor?: { address: string; kind?: ContractKind | undefined }
): string[] => (signers.length === 0 && follows ? [KEYLESS_FOLLOWER(follows, executor)] : [])

/** Why a rule scoped to its own executor is refused: it pins neither `run` nor a whole immediate batch. */
export const EXECUTOR_SELF_RULE = (executor: string) =>
  `the rule is scoped to its executor ${executor} without pinning, on every branch, call_fn = run or an immediate execute of a fixed batch (call_fn = execute, the wait = 0, the number of calls = n, and the target and function_name of each of those calls): it answers that executor's own requests, so anything wider would approve a batch nobody shaped (the interpreter refuses it, 221)`

/** Why a rule may not be bound to `executor`, from what it is on the ledger: only an execution
 *  adapter hands out the grant a bound rule needs, and a gated adapter never vouches for its own
 *  `execute`, so a rule scoped to it that pins an immediate batch (and not `run`) would never permit.
 *  `scopedTo` and `expr` are the rule's scope and predicate. */
export function executorProblem(
  executor: string,
  kind: ContractKind,
  scopedTo: string | undefined,
  expr: Expr | null
): string | undefined {
  if (kind === 'absent')
    return `executor ${executor} is not deployed, so what it will vouch for cannot be checked`
  if (kind === 'contract')
    return `executor ${executor} is not an execution adapter (its instance holds no prime and gate), so what it will vouch for is not known`
  if (kind === 'unverified adapter')
    return `executor ${executor} holds the adapter symbols (prime, gate) but does not run a pinned execution-adapter build this account can verify (or its prime is not this account): binding a keyless rule to it would let its own code vouch for any call the rule's predicate still allows, so it is refused (SYNTH-IO-01)`
  if (scopedTo === executor && !pinsOwn(expr)) return EXECUTOR_SELF_RULE(executor)
  if (kind === 'gated adapter' && scopedTo === executor && !pinsRun(expr))
    return `executor ${executor} is an adapter with a gate, which never vouches for its own execute: a rule scoped to it that does not pin call_fn = run would never permit`
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

// ---- the binding ----

/** What a binding asks of the network: the rule (with its interpreter record), what the executor
 *  is, the interpreter's fingerprint, and the build. */
export interface BindChain {
  readRule: (id: number) => Promise<ObservedRule | undefined>
  /** Every rule on the account, read as the overlap scan reads them. */
  readRules: () => Promise<RulesRead>
  kind: (executor: string) => Promise<ContractKind>
  fingerprint: (interpreter: string) => Promise<Fingerprint>
  build: () => Promise<Built>
}

/** The unsigned `bind_executor` of rule `ruleId` to `executor`, with the rule it binds. Refused when
 *  the rule is not there or not policed by the interpreter, when its record or predicate cannot be
 *  read, when the executor is not an execution adapter or the rule scoped to it pins neither `run`
 *  nor a whole immediate batch (221), and when its admins are not the source account alone (each
 *  admin signs `bind_executor`, and this builder signs as the source). */
export async function planBind(
  i: { smartAccount: string; sourceAccount: string; ruleId: number; executor: string },
  interpreter: string,
  chain: BindChain
) {
  const no = (m: string) => new Refusal('BIND_BUILD_FAILED', m)
  const [rule, kind, live, built, all] = await Promise.allSettled([
    chain.readRule(i.ruleId),
    chain.kind(i.executor),
    chain.fingerprint(interpreter),
    chain.build(),
    chain.readRules(),
  ])
  const got = <T>(r: PromiseSettledResult<T>): T => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  }
  const fingerprint = got(live)
  if (!fingerprint.matches) throw mismatch(fingerprint)
  const r = got(rule)
  if (!r) throw no(`the account has no rule ${i.ruleId}`)
  if (!r.policies.includes(interpreter))
    throw no(
      `rule ${i.ruleId} is not policed by the interpreter ${interpreter}: there is nothing to bind`
    )
  if (r.expr === undefined)
    throw no(
      `rule ${i.ruleId}: its stored predicate cannot be read, so what the binding would let through is unknown`
    )
  const scopedTo = r.scope.kind === 'call_contract' ? r.scope.contract : undefined
  const problem = executorProblem(i.executor, got(kind), scopedTo, r.expr)
  if (problem) throw no(problem)
  // E-36: bound to a no-gate adapter, a rule takes the word any keyed rule scoped to that adapter can
  // have it hand out; refused while one could, or while the account's rules are not all read.
  if (got(kind) === 'null-gate adapter') {
    const read = got(all)
    const leaks = wordLeaks([...read.rules.filter((x) => x.id !== r.id), r], i.executor)
    if (leaks.length > 0) throw no(leaks.map((x) => WORD_LEAK(i.executor, x.id)).join(' '))
    if (!read.complete)
      throw no(
        `the account's rules could not all be read, so whether a keyed rule scoped to ${i.executor} could hand out its word is not known`
      )
  }
  if (r.admins?.length !== 1 || r.admins[0] !== i.sourceAccount)
    throw no(
      `rule ${i.ruleId}'s admins are ${(r.admins ?? []).join(', ') || 'unknown'}: bind_executor needs each of them to sign, and this builder signs as the source account ${i.sourceAccount} alone`
    )
  return {
    ...got(built),
    binds: { ...r, executor: i.executor },
    ...(r.executor && r.executor !== i.executor ? { rebinds: r.executor } : {}),
    executorKind: got(kind),
    interpreter: fingerprint,
    warnings: ruleWarnings(r.signers, r.follows, { address: i.executor, kind: got(kind) }),
  }
}

// ---- the install, with every refusal in one place ----

/** What an install is asked for, past the choice of the rule. */
export interface InstallInput {
  network: Network
  smartAccount: string
  sourceAccount: string
  signers: string[]
  /** An execution adapter the rule will be bound to (`bind_policy`): with no signers, a keyless rule
   *  it alone can make permit; with signers, a rule that also needs its grant. */
  executor?: string | undefined
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
  if (k === 0 && !i.executor)
    throw no(
      'the rule names no signer, so it would govern no key; a keyless rule names the `executor` it will be bound to'
    )
  // Scoped to its own executor, a rule answers the executor's own requests: the interpreter binds
  // it only if it pins `run` or a whole immediate batch (221), and it is refused here first.
  if (i.executor === rule.contract && !pinsOwn(rule.expr)) throw no(EXECUTOR_SELF_RULE(i.executor))
  const draft: RuleDraft = {
    scope: { kind: 'call_contract', contract: rule.contract },
    name: i.name ?? `policy-${rule.hash.slice(0, 8)}`,
    validUntil: i.validUntilLedger ?? null,
    signers: i.signers,
    admins: i.admins ?? [i.sourceAccount],
    predicate: { encoded: rule.encoded, hash: rule.hash },
    nonce: i.installNonce ?? 1,
    ...(i.executor ? { executor: i.executor } : {}),
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
  // A keyed rule that could hand out an adapter's word needs to know what its scope is (E-36).
  const askScope = k > 0 && !keyedSafeOnNoGate(rule.expr, rule.follows !== undefined)
  const [live, kinds, scan, built] = await Promise.allSettled([
    chain.fingerprint(interpreter),
    chain.contracts([
      ...i.signers.filter((s) => s.startsWith('C')),
      ...(i.executor ? [i.executor] : []),
      ...(askScope && !i.signers.includes(rule.contract) && rule.contract !== i.executor
        ? [rule.contract]
        : []),
    ]),
    chain.readRules(i.smartAccount, interpreter),
    chain.build(draft, interpreter),
  ])
  const got = <T>(r: PromiseSettledResult<T>): T => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  }
  const fingerprint = got(live)
  if (!fingerprint.matches) throw mismatch(fingerprint)
  const known = got(kinds)
  for (const signer of i.signers.filter((s) => s.startsWith('C'))) {
    const problem = signerProblem(signer, known[signer] ?? 'absent', rule.contract, rule.expr)
    if (problem) throw no(problem)
  }
  if (i.executor) {
    const problem = executorProblem(
      i.executor,
      known[i.executor] ?? 'absent',
      rule.contract,
      rule.expr
    )
    if (problem) throw no(problem)
  }
  const read = got(scan)
  // E-36: a keyed rule scoped to a no-gate adapter must hold its grants to none; no override.
  if (askScope && known[rule.contract] === 'null-gate adapter') throw no(WORD_LEAK(rule.contract))
  // Nor may a keyless rule be meant for a no-gate adapter beside a keyed rule on it that could vouch.
  if (i.executor && known[i.executor] === 'null-gate adapter') {
    const leaks = wordLeaks(read.rules, i.executor)
    if (leaks.length > 0)
      throw no(leaks.map((r) => WORD_LEAK(i.executor as string, r.id)).join(' '))
    if (!read.complete)
      throw no(
        `the account's rules could not all be read, so whether a keyed rule scoped to ${i.executor} could hand out its word is not known`
      )
  }
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
      ...(i.executor ? { executor: { address: i.executor, kind: known[i.executor] } } : {}),
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
    /** Allowed, and said before anyone signs (E-38): never a refusal, never waived. */
    warnings: ruleWarnings(
      i.signers,
      rule.follows,
      i.executor ? { address: i.executor, kind: known[i.executor] } : undefined
    ),
  }
}
