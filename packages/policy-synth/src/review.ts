// The owner's side of the review (P0-3): what an unsigned install or removal does, read out of
// the bytes alone. It asks no RPC and takes nothing from the agent but the XDR, so a wallet or the
// Prime app can run it on the transaction it is about to sign. Every check here is a check the
// builder already made; a transaction it did not build, or one changed since, shows as a problem.

import {
  Address,
  FeeBumpTransaction,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk'
import {
  type Authority,
  authority,
  lines,
  type Node,
  addressText as show,
  tree,
  type View,
} from './card.ts'
import {
  authLedgers,
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETERS,
  LEDGER_SECONDS,
  maxResourceFee,
  type Network,
  PASSPHRASE,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
  thresholdAddress,
} from './config.ts'
import { messageOf, Refusal } from './envelope.ts'
import { digest, xlm } from './install.ts'
import {
  CEILINGS,
  decode,
  type Expr,
  fields,
  fromScVal,
  hashOf,
  type Val,
  validate,
} from './wire.ts'

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
  auth: { nonce: string; validUntilLedger: number; contextRuleIds: number[] } | null
  /** For `add_context_rule`: what the rule lets its signers do, and its predicate. */
  authority?: Authority
  rule?: { scope: Val; name: string; predicateHash: string | null; predicate: Expr | null }
  /** For `remove_context_rule`: the rule it removes. */
  removes?: { ruleId: number }
  /** Each one is a reason not to sign. */
  problems: string[]
  signable: boolean
  review: string[]
  reviewTree: Node[]
}

const notOurs = (why: string) =>
  new Refusal('INVALID_INPUT', `not a transaction this package builds: ${why}`)

const fact = (label: string, value: string): Node => ({ label, op: 'fact', value, raw: null })

/** The review of an unsigned transaction from `install_policy` or `revoke_policy`, from its bytes. */
export function reviewUnsigned(i: {
  network: Network
  xdr: string
  /** The account the owner means to change: any other is a problem. */
  smartAccount?: string | undefined
  raw?: boolean | undefined
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
  const call = {
    contract: Address.fromScAddress(ic.contractAddress()).toString(),
    fn: ic.functionName().toString(),
    args: ic.args().map((x) => fromScVal(x)),
  }
  const problems: string[] = []
  const flag = (p: string) => problems.push(p)
  const account = call.contract

  if (call.fn !== 'add_context_rule' && call.fn !== 'remove_context_rule')
    flag(`it calls ${call.fn}; the builder makes only add_context_rule and remove_context_rule`)
  if (i.smartAccount !== undefined && i.smartAccount !== account)
    flag(`it changes ${account}, not the account under review ${i.smartAccount}`)
  if (op.sourceAccount()) flag('the operation names a source account of its own')
  if (tx.memo.type !== 'none') flag('it carries a memo, which the builder never sets')
  if (
    Number(tx.timeBounds?.minTime ?? 0) > 0 ||
    tx.ledgerBounds ||
    tx.minAccountSequence ||
    tx.minAccountSequenceAge ||
    tx.minAccountSequenceLedgerGap ||
    (tx.extraSigners?.length ?? 0) > 0
  )
    flag(
      'it carries preconditions the builder never sets (a start time, ledger bounds, sequence or extra signers)'
    )

  // The authorisation: the account's own entry for exactly this call, and the source account's
  // `__check_auth` over that entry's digest. Anything else would be signed too.
  const entries = host.auth()
  const isAccount = (e: xdr.SorobanAuthorizationEntry) =>
    e.credentials().switch().name === 'sorobanCredentialsAddress' &&
    Address.fromScAddress(e.credentials().address().address()).toString() === account
  const own = entries.filter(isAccount)
  const source = entries.filter(
    (e) => e.credentials().switch().name === 'sorobanCredentialsSourceAccount'
  )
  const fnOf = (inv: xdr.SorobanAuthorizedInvocation) =>
    inv.function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn'
      ? inv.function().contractFn()
      : undefined
  let auth: UnsignedReview['auth'] = null
  if (entries.length !== 2 || own.length !== 1 || source.length !== 1)
    flag(
      `it carries ${entries.length} authorisation entries (${own.length} for the account, ${source.length} for the source account); the builder makes exactly one of each`
    )
  const mine = own[0]
  if (mine) {
    const root = mine.rootInvocation()
    const c = mine.credentials().address()
    if (fnOf(root)?.toXDR('base64') !== ic.toXDR('base64'))
      flag('the account authorises another call than the one the transaction makes')
    if (root.subInvocations().length > 0)
      flag(`the account authorises ${root.subInvocations().length} more call(s) under this one`)
    const payload = fields(fromScVal(c.signature()))
    const ids = Array.isArray(payload.context_rule_ids) ? payload.context_rule_ids : []
    const contextRuleIds = ids.filter((x): x is number => typeof x === 'number')
    if (contextRuleIds.length !== ids.length || ids.length === 0)
      flag('the authorisation names no context rule, or one that is not a rule id')
    auth = {
      nonce: c.nonce().toString(),
      validUntilLedger: c.signatureExpirationLedger(),
      contextRuleIds,
    }
    const named = (isMap(payload.signers) ? payload.signers.map : []).map(([k]) => delegatedOf(k))
    if (named.length !== 1 || named[0] !== tx.source)
      flag('the authorisation names a signer other than the transaction source alone')
    const check = source[0]
    const fn = check && fnOf(check.rootInvocation())
    const sent = fn?.args()[0]
    const expected = digest(network, c.nonce(), c.signatureExpirationLedger(), root, contextRuleIds)
    if (
      !fn ||
      Address.fromScAddress(fn.contractAddress()).toString() !== account ||
      fn.functionName().toString() !== '__check_auth' ||
      fn.args().length !== 1 ||
      sent?.switch().name !== 'scvBytes' ||
      !Buffer.from(sent.bytes()).equals(expected) ||
      (check?.rootInvocation().subInvocations().length ?? 0) > 0
    )
      flag(
        `the source account's __check_auth does not match the account's authorisation on ${network}: another network, or an entry changed after the build`
      )
  }

  // The fee and how long the signed transaction stays valid.
  const ext = body.ext()
  const resource = ext.switch() === 1 ? Number(ext.sorobanData().resourceFee().toBigInt()) : 0
  if (ext.switch() !== 1) flag('it carries no Soroban resources')
  const total = Number(tx.fee)
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
  else if (validBefore <= now) flag('its time bound has passed: build it again')
  else if (validBefore - now > authLedgers() * LEDGER_SECONDS)
    flag(
      `it stays valid for ${validBefore - now} s, longer than the ${authLedgers() * LEDGER_SECONDS} s window`
    )

  // What it does to the account.
  const roles: Record<string, string> = {
    [account]: 'smart account',
    [tx.source]: 'source account',
  }
  const view: View = { roles, raw: i.raw, network }
  const head: Node[] = [
    {
      label: 'Transaction',
      op: 'transaction',
      raw: null,
      children: [
        fact('calls', `${show(account, view)}  ${call.fn}`),
        fact('source', `${show(tx.source, view)}, sequence ${tx.sequence}`),
        fact('fee', `${xlm(total)} XLM in all, of which ${xlm(resource)} XLM for resources`),
        fact(
          'valid before',
          validBefore === null
            ? 'no time bound'
            : `${new Date(validBefore * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
        ),
        ...(auth
          ? [
              fact(
                'authorisation',
                `by rule ${auth.contextRuleIds.join(', ')}, valid through ledger ${auth.validUntilLedger}`
              ),
            ]
          : []),
      ],
    },
  ]
  const out: Pick<UnsignedReview, 'authority' | 'rule' | 'removes'> = {}
  let body2: Node[] = []
  if (call.fn === 'add_context_rule') {
    const r = ruleOf(call.args, network, account, flag)
    if (r) {
      for (const a of r.authority.admins ?? []) roles[a] ??= 'admin'
      for (const s of r.authority.signers) roles[s] ??= 'signer'
      out.authority = r.authority
      out.rule = r.rule
      const scoped = Array.isArray(r.rule.scope) && r.rule.scope[0] === 'CallContract'
      const v = { ...view, contract: scoped ? (r.rule.scope as string[])[1] : undefined }
      body2 = [
        authority(r.authority, v),
        ...(r.rule.predicate === null ? [] : tree(r.rule.predicate, v)),
      ]
    }
  } else if (call.fn === 'remove_context_rule') {
    const id = call.args.length === 1 ? call.args[0] : undefined
    if (typeof id !== 'number') flag('remove_context_rule takes one rule id')
    else {
      out.removes = { ruleId: id }
      body2 = [
        {
          label: 'Removes',
          op: 'removes',
          raw: id,
          children: [
            fact('rule', `${id} of ${show(account, view)}`),
            ...(id === 0
              ? [
                  fact(
                    'note',
                    "rule 0 is the account's first rule: removing it can lock the account out of its own administration for good"
                  ),
                ]
              : []),
          ],
        },
      ]
    }
  }
  const warn: Node[] = problems.length
    ? [
        {
          label: `Do not sign: ${problems.length} problem(s)`,
          op: 'problems',
          raw: null,
          children: problems.map((p) => fact('problem', p)),
        },
      ]
    : []
  const reviewTree = [...warn, ...head, ...body2]
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
    signable: problems.length === 0,
    review: lines(reviewTree),
    reviewTree,
  }
}

const isMap = (v: Val | undefined): v is { map: [Val, Val][] } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'map' in v
const delegatedOf = (v: Val): string | undefined =>
  Array.isArray(v) && v[0] === 'Delegated' && typeof v[1] === 'string' ? v[1] : undefined

/** The five arguments of `add_context_rule`, read back into the authority they grant. */
function ruleOf(args: Val[], network: Network, account: string, flag: (p: string) => void) {
  const [scope, name, until, signers, policies] = args
  if (args.length !== 5 || !Array.isArray(signers) || !isMap(policies ?? null)) {
    flag('add_context_rule does not carry the five arguments of a rule')
    return undefined
  }
  if (!Array.isArray(scope) || scope[0] !== 'CallContract')
    flag(
      `the rule is scoped ${Array.isArray(scope) ? `${scope[0]}` : 'oddly'}, not to one contract: it would cover every such call of the account`
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
    if (at === SPENDING_LIMIT[network]) {
      a.total = {
        amount: (p.spending_limit as { i128?: string })?.i128 ?? '',
        periodLedgers: Number(p.period_ledgers),
      }
    } else if (at === thresholdAddress(network, false) || at === thresholdAddress(network, true)) {
      const weights = isMap(p.signer_weights)
        ? Object.fromEntries(
            p.signer_weights.map.map(([k, w]) => [delegatedOf(k) ?? JSON.stringify(k), Number(w)])
          )
        : undefined
      a.threshold = { n: Number(p.threshold), ...(weights ? { weights } : {}), raw: params }
    } else if ('grammar_version' in p) {
      interpreters++
      a.interpreter = at
      const pin = INTERPRETER[network]
      if (pin?.address !== at)
        flag(
          INTERPRETERS.has(at)
            ? `${at} is an interpreter this project superseded or of another grammar, not the ${network} pin`
            : pin
              ? `${at} is not the pinned ${network} interpreter ${pin.address}`
              : `no interpreter is pinned for ${network}, so ${at} cannot be checked from the bytes`
        )
      else a.limits = pin.limits
      if (p.grammar_version !== GRAMMAR_VERSION)
        flag(
          `the interpreter is asked for grammar ${String(p.grammar_version)}, not ${GRAMMAR_VERSION}`
        )
      a.admins = (Array.isArray(p.policy_admins) ? p.policy_admins : []).map(
        (x) => delegatedOf(x) ?? JSON.stringify(x)
      )
      const bytes = (p.predicate as { bytes?: string })?.bytes
      const said = (p.predicate_hash as { bytes?: string })?.bytes ?? null
      rule.predicateHash = said
      if (bytes === undefined) flag('the interpreter is given no predicate')
      else {
        const b64 = Buffer.from(bytes, 'hex').toString('base64')
        if (said !== hashOf(b64)) flag('the predicate hash does not match the predicate bytes')
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
