// The owner's side of the review (P0-3): what an unsigned install or removal does, read out of
// the bytes alone. It asks no RPC and takes nothing from the agent but the XDR, so a wallet or the
// Prime app can run it on the transaction it is about to sign. It checks that the bytes are shaped
// as the builder shapes them and are internally consistent; it cannot tell a consistent rewrite
// from the owner's intent, so the review shows the authority the bytes grant for the owner to read.

import {
  Address,
  FeeBumpTransaction,
  StrKey,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk'
import {
  type Authority,
  authority,
  fact,
  followed,
  group,
  lines,
  type Node,
  addr as show,
  tree,
  type View,
  warned,
} from './card.ts'
import type { ContractKind } from './chain.ts'
import {
  type AccountAuth,
  accountAuth,
  authLedgers,
  CLOCK_SKEW,
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETERS,
  isThreshold,
  LEDGER_SECONDS,
  maxResourceFee,
  type Network,
  PASSPHRASE,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
  spendingLimits,
  thresholdAddress,
} from './config.ts'
import { messageOf, Refusal } from './envelope.ts'
import {
  checkAuthArg,
  executorProblem,
  isAddressEntry,
  keyedSafeOnNoGate,
  ruleWarnings,
  signerProblem,
  WORD_LEAK,
  xlm,
} from './install.ts'
import { callOf } from './record.ts'
import type { Followed } from './rules.ts'
import { unboundedExpr } from './synth.ts'
import {
  CEILINGS,
  decode,
  type Expr,
  fields,
  fromScVal,
  hashOf,
  isMap,
  referenceOf,
  type Val,
  validate,
} from './wire.ts'

/** How a review names each authorisation form. */
const FORM_NAME: Record<AccountAuth, string> = {
  digest: 'OpenZeppelin 0.7.2-line digest',
  preimage: 'OpenZeppelin 0.8.0 preimage',
}

/** The most a base fee may bid, as `install_policy` caps it: 1 XLM. */
const MAX_BASE_FEE = 10_000_000

export interface UnsignedReview {
  network: Network
  smartAccount: string
  sourceAccount: string
  sequence: string
  /** The one call the transaction makes. */
  call: { contract: string; fn: string; args: Val[] }
  /** In stroops. */
  fee: { total: number; resource: number }
  /** The time bound (unix seconds), `null` when it has none. */
  validBefore: number | null
  /** The smart account's authorisation, as signed: nonce, expiry ledger, the rules it names. */
  auth: {
    nonce: string
    validUntilLedger: number
    contextRuleIds: number[]
    /** The form the source account's `__check_auth` entry is in (`OZ_ACCOUNT_AUTH`): the 0.7.2-line
     *  digest bytes or the OpenZeppelin 0.8.0 preimage struct; absent when it is neither. */
    form?: AccountAuth
  } | null
  /** For `add_context_rule`: what the rule lets its signers do, and its predicate. */
  authority?: Authority
  /** `predicate`: the one in the bytes; for a rule that `follows` another, that rule's predicate as
   *  it was read (`null` when it was not read). */
  rule?: {
    scope: Val
    name: string
    predicateHash: string | null
    predicate: Expr | null
    follows?: Followed
  }
  /** For `remove_context_rule`: the rule it removes. */
  removes?: { ruleId: number }
  /** For `bind_executor`: the rule it binds and the executor. */
  binds?: { ruleId: number; executor: string }
  /** Each one is a reason not to sign. */
  problems: string[]
  /** What the owner must know before signing, none of it a problem: a keyless rule that follows
   *  another (E-38). `signable` does not look at them. */
  warnings: string[]
  signable: boolean
  review: string[]
  reviewTree: Node[]
}

const notOurs = (why: string) =>
  new Refusal('INVALID_INPUT', `not a transaction this package builds: ${why}`)

/** The review of an unsigned transaction from `install_policy` or `revoke_policy`, from its bytes. */
export function reviewUnsigned(i: {
  network: Network
  xdr: string
  /** The account the owner means to change: any other is a problem. */
  smartAccount?: string | undefined
  raw?: boolean | undefined
  /** What each contract signer is, as the caller read it off the ledger (`contractKinds`). Without
   *  it, what a contract signer runs is not in the bytes, so each one is a problem. */
  contracts?: Record<string, ContractKind> | undefined
  /** The rule an install follows, as the caller read it off the pinned interpreter (`readFollowed`),
   *  or why it could not. Without it, what such a rule permits is not in the bytes: a problem. */
  followed?: { expr: Expr; follows: Followed } | { error: string } | undefined
  /** The account's code as the caller read it off the ledger (`codeHash`), or why it could not.
   *  With it, an authorisation in another form than the account's build asks for, or an account
   *  that runs no build the package knows, is a problem. Without it, the form is the bytes' own. */
  accountCode?: { wasmSha256: string | undefined } | { error: string } | undefined
}): UnsignedReview {
  const { network } = i
  let env: Transaction | FeeBumpTransaction
  try {
    env = TransactionBuilder.fromXDR(i.xdr, PASSPHRASE[network])
  } catch (e) {
    throw new Refusal('INVALID_INPUT', `the XDR is not a transaction envelope: ${messageOf(e)}`)
  }
  if (env instanceof FeeBumpTransaction) throw notOurs('a fee bump wraps it')
  const tx = env
  const body = tx.toEnvelope().v1().tx()
  const ops = body.operations()
  const op = ops.length === 1 ? ops[0] : undefined
  if (op?.body().switch().name !== 'invokeHostFunction')
    throw notOurs(`${ops.length} operation(s), and the builder makes one contract call`)
  const host = op.body().invokeHostFunctionOp()
  if (host.hostFunction().switch().name !== 'hostFunctionTypeInvokeContract')
    throw notOurs('the operation is not a contract call')
  const ic = host.hostFunction().invokeContract()
  const problems: string[] = []
  const flag = (p: string) => problems.push(p)
  const warnings: string[] = []
  /** A value the builder never writes (an error, a contract instance) has no wire form: a problem. */
  const read = (x: xdr.ScVal): Val => {
    try {
      return fromScVal(x)
    } catch (e) {
      flag(`it carries an argument the builder never writes (${messageOf(e)})`)
      return null
    }
  }
  const call = callOf(ic, read)
  // A binding is a call to the interpreter naming the account's rule; the rest call the account.
  const bind = call.fn === 'bind_executor' ? bindOf(call.args) : undefined
  const account = bind?.account ?? call.contract

  if (!['add_context_rule', 'remove_context_rule', 'bind_executor'].includes(call.fn))
    flag(
      `it calls ${call.fn}; the builder makes only add_context_rule, remove_context_rule and bind_executor`
    )
  if (call.fn === 'bind_executor' && !bind)
    flag('bind_executor does not carry a rule (account, id) and an executor')
  if (i.smartAccount === undefined)
    flag(
      `no smartAccount was given, so whether ${account} is the account the owner means cannot be checked`
    )
  else if (i.smartAccount !== account)
    flag(`it changes ${account}; the account under review is ${i.smartAccount}`)
  if (op.sourceAccount()) flag('the operation names a source account of its own')
  if (tx.signatures.length > 0)
    flag(
      `it already carries ${tx.signatures.length} signature(s): this is a review of unsigned bytes, and a signed envelope can be submitted by whoever holds it`
    )
  if (tx.memo.type !== 'none') flag('it carries a memo, which the builder never sets')
  const cond = body.cond().switch().name
  if ((cond !== 'precondTime' && cond !== 'precondNone') || Number(tx.timeBounds?.minTime ?? 0) > 0)
    flag(
      'it carries preconditions the builder never sets (a start time, ledger bounds, a minimum sequence or extra signers)'
    )

  // The authorisation: the account's own entry for exactly this call, and the source account's
  // `__check_auth` over that entry's digest. Anything else would be signed too.
  const entries = host.auth()
  const own = entries.filter((e) => isAddressEntry(e, account))
  const fnOf = (inv: xdr.SorobanAuthorizedInvocation) =>
    inv.function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn'
      ? inv.function().contractFn()
      : undefined
  const bySource = entries.filter(
    (e) => e.credentials().switch().name === 'sorobanCredentialsSourceAccount'
  )
  // The source's `__check_auth` entry, and (for a binding) its own authorisation of the call as the
  // rule's admin: exactly the call, nothing under it.
  const source = bySource.filter(
    (e) => fnOf(e.rootInvocation())?.functionName().toString() === '__check_auth'
  )
  const asAdmin = bySource.filter(
    (e) =>
      fnOf(e.rootInvocation())?.toXDR('base64') === ic.toXDR('base64') &&
      e.rootInvocation().subInvocations().length === 0
  )
  const admin = bind ? 1 : 0
  let auth: UnsignedReview['auth'] = null
  if (
    entries.length !== 2 + admin ||
    own.length !== 1 ||
    source.length !== 1 ||
    asAdmin.length !== admin
  )
    flag(
      `it carries ${entries.length} authorisation entries (${own.length} for the account, ${source.length} for the source account${bind ? `, ${asAdmin.length} for the source account as the rule's admin` : ''}); the builder makes exactly one of each`
    )
  const mine = own[0]
  if (mine) {
    const root = mine.rootInvocation()
    const c = mine.credentials().address()
    if (fnOf(root)?.toXDR('base64') !== ic.toXDR('base64'))
      flag('the account authorises another call than the one the transaction makes')
    if (root.subInvocations().length > 0)
      flag(`the account authorises ${root.subInvocations().length} more call(s) under this one`)
    const payload = fields(read(c.signature()))
    const ids = Array.isArray(payload.context_rule_ids) ? payload.context_rule_ids : []
    const contextRuleIds = ids.filter((x): x is number => typeof x === 'number')
    if (contextRuleIds.length !== ids.length || ids.length === 0)
      flag('the authorisation names no context rule, or one that is not a rule id')
    else if (contextRuleIds.length !== 1 || contextRuleIds[0] !== 0)
      flag(
        `the authorisation is by rule ${contextRuleIds.join(', ')}; the builder always names the account's admin rule, rule 0`
      )
    auth = {
      nonce: c.nonce().toString(),
      validUntilLedger: c.signatureExpirationLedger(),
      contextRuleIds,
    }
    const pairs = isMap(payload.signers) ? payload.signers.map : []
    const named = pairs.map(([k]) => delegatedOf(k))
    if (named.length !== 1 || named[0] !== tx.source)
      flag('the authorisation names a signer other than the transaction source alone')
    // The source signs through its own entry, so the account's payload carries no signature bytes.
    const sealed = pairs.filter(([, v]) => (v as { bytes?: string })?.bytes !== '')
    if (sealed.length > 0)
      flag(
        `the account's authorisation already carries a signature for ${sealed.map(([k]) => delegatedOf(k) ?? 'a signer').join(', ')}`
      )
    const check = source[0]
    const fn = check && fnOf(check.rootInvocation())
    const sent = fn?.args()[0]
    // Either form commits to the same account entry (nonce, expiry, the call tree, the rule ids):
    // the 0.7.2-line digest bytes, or the 0.8.0 preimage struct, which also names the account.
    // Each is checked against what it must be, byte for byte.
    const form: AccountAuth | undefined =
      sent?.switch().name === 'scvBytes'
        ? 'digest'
        : sent?.switch().name === 'scvMap'
          ? 'preimage'
          : undefined
    const expected =
      form &&
      checkAuthArg(
        form,
        network,
        account,
        c.nonce(),
        c.signatureExpirationLedger(),
        root,
        contextRuleIds
      )
    if (
      !fn ||
      Address.fromScAddress(fn.contractAddress()).toString() !== account ||
      fn.functionName().toString() !== '__check_auth' ||
      fn.args().length !== 1 ||
      !expected ||
      sent?.toXDR('base64') !== expected.toXDR('base64') ||
      (check?.rootInvocation().subInvocations().length ?? 0) > 0
    )
      flag(
        `the source account's __check_auth does not match the account's authorisation on ${network}: another network, or an entry changed after the build`
      )
    else auth.form = form
    // The form the account's own code asks for, when it was read: any other is refused by the
    // account, and an account that runs no known build is not one the builder signs for.
    const code = i.accountCode
    if (code && 'error' in code) flag(`the account's code could not be read (${code.error})`)
    else if (code) {
      const wants = accountAuth(code.wasmSha256)
      if (!wants)
        flag(
          `${account} runs ${code.wasmSha256 ? `code ${code.wasmSha256}` : 'no contract code'}, not an OpenZeppelin smart account build this package signs for`
        )
      else if (form && wants !== form)
        flag(
          `the authorisation is in the ${FORM_NAME[form]} form, but ${account} runs a build that asks for the ${FORM_NAME[wants]}: the account would refuse it`
        )
    }
  }

  // The fee and how long the signed transaction stays valid.
  const ext = body.ext()
  const resource = ext.switch() === 1 ? Number(ext.sorobanData().resourceFee().toBigInt()) : 0
  if (ext.switch() !== 1) flag('it carries no Soroban resources')
  const total = Number(tx.fee)
  if (resource < 0) flag(`it carries a negative resource fee (${resource} stroops)`)
  if (resource > maxResourceFee())
    flag(
      `it asks a resource fee of ${xlm(resource)} XLM, above the ceiling of ${xlm(maxResourceFee())} XLM`
    )
  if (total - resource > MAX_BASE_FEE)
    flag(`it bids ${xlm(total - resource)} XLM beside the resources, above the 1 XLM cap`)
  const max = Number(tx.timeBounds?.maxTime ?? 0)
  const validBefore = max > 0 ? max : null
  const now = Math.floor(Date.now() / 1000)
  if (validBefore === null)
    flag(
      `it has no time bound: once signed, it stays valid until its authorisation lapses${auth ? ` (ledger ${auth.validUntilLedger})` : ''}`
    )
  else if (validBefore > MAX_DATE) flag(`its time bound is out of range (${validBefore})`)
  else if (validBefore <= now) flag('its time bound has passed: build it again')
  else if (validBefore - now > authLedgers() * LEDGER_SECONDS + CLOCK_SKEW)
    flag(
      `it stays valid for ${validBefore - now} s, longer than the ${authLedgers() * LEDGER_SECONDS} s window and the ${CLOCK_SKEW} s allowed for clocks`
    )

  // What it does to the account.
  // Only the account the owner named is called the smart account.
  const roles: Record<string, string> = {
    [account]: i.smartAccount === account ? 'smart account' : 'called account',
    [tx.source]: 'source account',
  }
  const view: View = { roles, raw: i.raw, network }
  const until =
    auth &&
    `by rule ${auth.contextRuleIds.join(', ')}, valid through ledger ${auth.validUntilLedger}${auth.form ? `, signed as the ${FORM_NAME[auth.form]}` : ''}`
  const head = group('Transaction', 'transaction', [
    fact('calls', `${show(call.contract, view)}  ${call.fn}`),
    fact('source', `${show(tx.source, view)}, sequence ${tx.sequence}`),
    fact('fee', `${xlm(total)} XLM in all, of which ${xlm(resource)} XLM for resources`),
    fact(
      'valid before',
      validBefore === null
        ? 'no time bound'
        : validBefore > MAX_DATE
          ? `${validBefore} (out of range)`
          : `${new Date(validBefore * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
    ),
    ...(until ? [fact('authorisation', until)] : []),
  ])
  const out: Pick<UnsignedReview, 'authority' | 'rule' | 'removes' | 'binds'> = {}
  let body2: Node[] = []
  if (call.fn === 'add_context_rule') {
    const r = ruleOf(call.args, network, account, flag)
    const ref = r?.rule.follows
    if (r && ref) {
      const got = i.followed
      const which = `rule ${ref.ruleId} of ${ref.account}`
      if (
        got &&
        'expr' in got &&
        got.follows.account === ref.account &&
        got.follows.ruleId === ref.ruleId
      ) {
        r.rule.follows = got.follows
        r.rule.predicate = got.expr
      } else
        flag(
          got && 'error' in got
            ? `the rule follows ${which}, which could not be read: ${got.error}`
            : `the rule carries no predicate: it follows ${which}, whose predicate is not in these bytes (and which that rule's admins can change without this account's signature); review with readContracts to read it`
        )
    }
    if (r) {
      const scope = r.rule.scope
      const scopedTo =
        Array.isArray(scope) && scope[0] === 'CallContract' ? String(scope[1]) : undefined
      for (const s of r.authority.signers.filter((x) => x.startsWith('C'))) {
        const kind = i.contracts?.[s]
        const problem =
          kind === undefined
            ? `signer ${s} is a contract, and what it runs is not in the bytes (an execution adapter bound to no gate would let an agent spend past its caps, and one signing a rule scoped to itself that does not pin run would answer anyone); review with readContracts`
            : signerProblem(s, kind, scopedTo, r.rule.predicate)
        if (problem) flag(problem)
      }
      for (const a of r.authority.admins ?? []) roles[a] ??= 'admin'
      for (const s of r.authority.signers) roles[s] ??= 'signer'
      // E-36: a keyed rule scoped to a no-gate adapter must hold its grants to none.
      const safe = keyedSafeOnNoGate(r.rule.predicate, r.rule.follows !== undefined)
      if (scopedTo && r.authority.signers.length > 0 && !safe) {
        const kind = i.contracts?.[scopedTo]
        if (kind === 'null-gate adapter') flag(WORD_LEAK(scopedTo))
        else if (kind === undefined)
          flag(
            `the rule has signers and ${r.rule.follows ? "follows another rule's predicate, which can come to permit" : 'permits'} a call to execute on ${scopedTo} without holding its grants (argument 1) to none: if that contract is an execution adapter with no gate, a signer could have it hand out its word to this account's policy; review with readContracts`
          )
      }
      // E-38: no signer (of any kind: an External one is a problem of its own), and a predicate
      // another account re-installs at will. Allowed, and said.
      warnings.push(...ruleWarnings(call.args[3] as Val[], r.rule.follows))
      // the finished predicate is walked here too, so a rule that leaves an amount or a
      // swap's least output unbounded (perhaps installed behind an override) is never signed in
      // silence; the owner reads each open question as a warning.
      if (r.rule.predicate) warnings.push(...unboundedExpr(r.rule.predicate).map((a) => a.question))
      out.authority = r.authority
      out.rule = r.rule
      const v = { ...view, contract: scopedTo }
      let held: Node
      try {
        held = authority(r.authority, v)
      } catch (e) {
        // Flagged in `ruleOf` (a threshold with no number): shown as unreadable, never guessed.
        held = group('Authority', 'authority', [fact('unreadable', messageOf(e))])
      }
      const source = r.rule.follows ? [followed(r.rule.follows, v)] : []
      body2 = [held, ...source, ...(r.rule.predicate === null ? [] : tree(r.rule.predicate, v))]
    }
  } else if (call.fn === 'remove_context_rule') {
    const id = call.args.length === 1 ? call.args[0] : undefined
    if (typeof id !== 'number') flag('remove_context_rule takes one rule id')
    else {
      out.removes = { ruleId: id }
      const note =
        "rule 0 is the account's first rule: removing it can lock the account out of its own administration for good"
      const facts = [fact('rule', `${id} of ${show(account, view)}`)]
      body2 = [group('Removes', 'removes', id === 0 ? [...facts, fact('note', note)] : facts, id)]
    }
  } else if (bind) {
    const pin = INTERPRETER[network]
    if (pin?.address !== call.contract)
      flag(
        pin
          ? `it binds a rule on ${call.contract}, not the pinned ${network} interpreter ${pin.address}`
          : `no interpreter is pinned for ${network}, so ${call.contract} cannot be checked from the bytes`
      )
    const kind = i.contracts?.[bind.executor]
    const problem =
      kind === undefined
        ? `executor ${bind.executor}: what it is, and so what it will vouch for, is not in the bytes; review with readContracts`
        : executorProblem(bind.executor, kind, undefined, null)
    if (problem) flag(problem)
    out.binds = { ruleId: bind.ruleId, executor: bind.executor }
    roles[bind.executor] ??= 'executor'
    const facts = [
      fact('rule', `${bind.ruleId} of ${show(account, view)}`, bind.ruleId),
      fact(
        'executor',
        kind === 'null-gate adapter'
          ? `${show(bind.executor, view)}, an execution adapter with no gate: anyone may call its execute with an immediate batch, and it vouches for every call of that batch, so the rule's predicate becomes the only fence on such a batch`
          : `${show(bind.executor, view)}${kind ? ` (${kind})` : ''}`,
        bind.executor
      ),
      fact(
        'effect',
        "from now on the rule permits a call only with this executor's grant for it (its own run excepted), and a rule with no signer permits exactly what the executor vouches for; the rule's predicate is not in these bytes: bind_policy's review shows it"
      ),
    ]
    body2 = [group('Binds', 'binds', facts, [account, bind.ruleId])]
  }
  const warn = group(
    `Do not sign: ${problems.length} problem(s)`,
    'problems',
    problems.map((p) => fact('problem', p))
  )
  const reviewTree = [
    ...(problems.length ? [warn] : []),
    ...(warnings.length ? [warned(warnings)] : []),
    head,
    ...body2,
  ]
  return {
    network,
    smartAccount: account,
    sourceAccount: tx.source,
    sequence: tx.sequence,
    call,
    fee: { total, resource },
    validBefore,
    auth,
    ...out,
    problems,
    warnings,
    signable: problems.length === 0,
    review: lines(reviewTree),
    reviewTree,
  }
}

/** `bind_executor`'s arguments: the rule `(account, id)` and the executor, or undefined. */
function bindOf(args: Val[]) {
  const [rule, executor] = args
  if (args.length !== 2 || !Array.isArray(rule) || rule.length !== 2) return undefined
  const [account, ruleId] = rule
  return typeof account === 'string' &&
    StrKey.isValidContract(account) &&
    typeof ruleId === 'number' &&
    typeof executor === 'string' &&
    StrKey.isValidContract(executor)
    ? { account, ruleId, executor }
    : undefined
}

/** The last second a JavaScript date can show: 8.64e15 ms, in the year 275,760. */
const MAX_DATE = 8_640_000_000_000

const delegatedOf = (v: Val): string | undefined =>
  Array.isArray(v) && v[0] === 'Delegated' && typeof v[1] === 'string' ? v[1] : undefined

/** The five arguments of `add_context_rule`, read back into the authority they grant. */
function ruleOf(args: Val[], network: Network, account: string, flag: (p: string) => void) {
  const [scope, name, until, signers, policies] = args
  if (args.length !== 5 || !Array.isArray(signers) || !isMap(policies)) {
    flag('add_context_rule does not carry the five arguments of a rule')
    return undefined
  }
  if (!Array.isArray(scope) || scope[0] !== 'CallContract')
    flag(
      `the rule is scoped ${Array.isArray(scope) ? `${scope[0]}` : 'oddly'} instead of to one contract: it would cover every such call of the account`
    )
  else if (POLICY_CONTRACTS.has(scope[1] as string) || scope[1] === account)
    flag(
      'the rule is scoped to a policy contract or to the account itself, which exposes its admin calls'
    )
  const keys = signers.map((s) => delegatedOf(s))
  if (keys.some((k) => k === undefined))
    flag('a signer is not a Delegated address (an External signer)')
  const a: Authority = {
    signers: keys.filter((k): k is string => k !== undefined),
    validUntil: typeof until === 'number' ? until : null,
  }
  const rule: NonNullable<UnsignedReview['rule']> = {
    scope: scope ?? null,
    name: name && typeof name === 'object' && 'string' in name ? name.string : '',
    predicateHash: null,
    predicate: null,
  }
  let interpreters = 0
  for (const [address, params] of (policies as { map: [Val, Val][] }).map) {
    const at = String(address)
    const p = fields(params)
    // A superseded instance (an older build of the same OpenZeppelin policy) is read like the
    // current one, and flagged: this builder attaches only the current one.
    const superseded = (current: string) =>
      at !== current &&
      flag(`${at} is a superseded ${network} policy instance; this builder attaches ${current}`)
    if (spendingLimits(network).includes(at)) {
      superseded(SPENDING_LIMIT[network])
      a.total = {
        amount: (p.spending_limit as { i128?: string })?.i128 ?? '',
        periodLedgers: Number(p.period_ledgers),
      }
    } else if (isThreshold(network, at, false) || isThreshold(network, at, true)) {
      superseded(thresholdAddress(network, isThreshold(network, at, true)))
      const weights = isMap(p.signer_weights)
        ? Object.fromEntries(
            p.signer_weights.map.map(([k, w]) => [delegatedOf(k) ?? JSON.stringify(k), Number(w)])
          )
        : undefined
      if (isMap(p.signer_weights) && p.signer_weights.map.some(([k]) => !delegatedOf(k)))
        flag('a threshold weight is given to a key that is not a Delegated address')
      if (typeof p.threshold !== 'number' || p.threshold < 1)
        flag('the threshold policy carries no threshold, so what it requires cannot be read')
      a.threshold = { n: Number(p.threshold), ...(weights ? { weights } : {}), raw: params }
    } else if ('grammar_version' in p) {
      interpreters++
      a.interpreter = at
      const pin = INTERPRETER[network]
      if (pin?.address !== at)
        flag(
          INTERPRETERS.has(at)
            ? `${at} is an interpreter this project deployed that this build does not trust, not the ${network} pin`
            : pin
              ? `${at} is not the pinned ${network} interpreter ${pin.address}`
              : `no interpreter is pinned for ${network}, so ${at} cannot be checked from the bytes`
        )
      else a.limits = pin.limits
      if (p.grammar_version !== GRAMMAR_VERSION)
        flag(
          `the install asks for grammar_version ${String(p.grammar_version)}; this builder writes grammar_version ${GRAMMAR_VERSION}`
        )
      const admins = Array.isArray(p.policy_admins) ? p.policy_admins : []
      if (admins.some((x) => !delegatedOf(x)))
        flag('an admin is not a Delegated address (an External admin)')
      a.admins = admins.map((x) => delegatedOf(x) ?? JSON.stringify(x))
      const bytes = (p.predicate as { bytes?: string })?.bytes
      const said = (p.predicate_hash as { bytes?: string })?.bytes ?? null
      rule.predicateHash = said
      if (bytes === undefined) flag('the interpreter is given no predicate')
      else {
        const b64 = Buffer.from(bytes, 'hex').toString('base64')
        if (said !== hashOf(b64)) flag('the predicate hash does not match the predicate bytes')
        // A reference to another rule, as the interpreter reads one: the hash commits to it.
        const ref = referenceOf(b64)
        if (ref) rule.follows = ref
        else
          try {
            const e = decode(b64)
            validate(e, pin?.address === at ? pin.limits : CEILINGS)
            rule.predicate = e
          } catch (x) {
            flag(`the predicate is not one the interpreter reads: ${messageOf(x)}`)
          }
      }
    } else {
      flag(`a policy this package does not know is attached: ${at}`)
    }
  }
  if (interpreters !== 1)
    flag(
      interpreters === 0
        ? 'no interpreter polices the rule: its signers would act with no predicate'
        : `${interpreters} interpreters are attached; the builder attaches one`
    )
  if (a.total === undefined) a.total = null
  return { authority: a, rule }
}
