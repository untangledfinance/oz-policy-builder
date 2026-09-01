// Can a rolling spend cap bound a Blend-shaped SUPPLY, and can the agent dodge
// it by naming the pool's rule for the token's transfer?
//
// `oz-spending-limit-binding.ts` settled that an OZ `spending_limit` binds a
// DIRECT `transfer` when it sits on the same rule as our interpreter. It could
// not answer the question people actually ask, because a supply is not a
// transfer: the built-in refuses any call not named `transfer`, so a spend cap
// CANNOT sit on the pool's rule at all.
//
// What makes a supply cappable is that it is not one authorization context. The
// mainnet envelopes decode to `submit` on the pool with a NESTED `transfer` on
// the token, and `do_check_auth` validates each context against its own
// declared rule, then enforces that rule's policies against that context. So
// the cap goes on a second, token-scoped rule and meters the nested leg.
//
// Three rules, one agent. The agent's declared ids are the only variable:
//
//   rule 1  POOL   CallContract(pool)  interpreter (submit shape + per-entry)
//   rule 2  CAPPED CallContract(SAC)   interpreter + spending_limit(CAP)
//   rule 3  CONTROL CallContract(SAC)  interpreter only, NO cap
//
// Four calls, each load-bearing:
//
//   1. CONTROL supply, ids [1,3]  -> must PASS
//        The over-cap amount through the UNCAPPED token rule. Without this a
//        later deny could mean the account was broke, the pool rejected the
//        request, or the predicate refused - not that the cap bit.
//   2. CAPPED under-cap, ids [1,2] -> must PASS
//        A cap that denies everything is a brick, not a bound.
//   3. CAPPED over-cap, ids [1,2] -> must DENY #3221
//        The verdict. Same call as (1), same agent, same amount; the only
//        difference is which token rule was named.
//   4. BYPASS attempt, ids [1,1]  -> must DENY
//        The agent names the POOL rule for the token's transfer context, which
//        is the "just use rule A" dodge. Rule 1 is CallContract(pool) and the
//        context is CallContract(SAC), so `get_validated_context_by_id` must
//        refuse it before any policy runs.
//
// Note what (1) also demonstrates: rule 3 is a live bypass of rule 2's cap for
// the same agent. That is R-4 cross-rule authority, on purpose, in one run.
//
// Usage:
//   bun packages/policy-synth/scripts/oz-two-rule-blend-cap.ts --network testnet

import { createHash } from 'node:crypto'
import {
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  accountEntry,
  authDigest,
  authPayload,
  delegatedSigner,
  delegatedSignerEntry,
  signaturePayload,
} from '../src/install/oz-auth.ts'
import { encodePredicate } from '../src/predicate/encode.ts'
import {
  PINNED_INTERPRETER_ADDRESS_BY_NETWORK,
  PINNED_INTERPRETER_GRAMMAR_VERSION,
  RPC_URL_BY_NETWORK,
} from '../src/run/schemas.ts'
import type { PredicateNode } from '../src/types.ts'

type Net = 'testnet' | 'mainnet'

/** sha256 of `multisig_account_example.wasm`, already uploaded to BOTH
 *  networks, so an account is created by deploy alone with no wasm upload. */
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

/** OZ `multisig-spending-limit-policy-example`, built by us from
 *  OpenZeppelin/stellar-contracts at TAG v0.7.2. Third-party code we did not
 *  audit - see docs/audit/README.md for the provenance note. */
const SPENDING_LIMIT_BY_NETWORK: Record<Net, string> = {
  testnet: 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP',
  mainnet: 'CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A',
}

/** `SpendingLimitError::SpendingLimitExceeded`. The deny must carry THIS code;
 *  anything else means something other than the cap refused. */
const SPENDING_LIMIT_EXCEEDED = 3221

/** `SmartAccountError`. 3002 is the context/rule type mismatch, 3014 is a
 *  `context_rule_ids` vector whose length does not match `auth_contexts`. */
const UNVALIDATED_CONTEXT = 3002
const CONTEXT_RULE_IDS_LENGTH_MISMATCH = 3014

const FEE = '2000000'
const TIMEOUT = 120

/** Blend's supply request type. Rule 1 pins it, so a withdraw is refused. */
const SUPPLY_REQUEST_TYPE = 2

/** The rolling cap, and the amounts either side of it. The per-call ceilings in
 *  BOTH predicates are deliberately far above the over-cap amount: if a
 *  predicate refused first the deny would carry #100 and prove nothing about
 *  the cap. The only bound that can refuse the over-cap call is the rolling
 *  total. */
const CAP_STROOPS = 5_000_000n
const UNDER_CAP_STROOPS = 1_000_000n
const OVER_CAP_STROOPS = 20_000_000n
const PER_CALL_CEILING = 100_000_000n
/** ~1 day, so the window never rolls over mid-run. */
const PERIOD_LEDGERS = 17280

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const NETWORK = (arg('network') ?? 'testnet') as Net
if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
  throw new Error(`--network must be testnet or mainnet, got ${NETWORK}`)
}
const PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
const INTERPRETER = PINNED_INTERPRETER_ADDRESS_BY_NETWORK[NETWORK]
const SPENDING_LIMIT = SPENDING_LIMIT_BY_NETWORK[NETWORK]
const RPC_URL =
  NETWORK === 'mainnet'
    ? 'https://soroban-rpc.mainnet.stellar.gateway.fm'
    : RPC_URL_BY_NETWORK[NETWORK]

const POOL_WASM = new URL(
  '../../../contracts/test-blend-pool/target/wasm32v1-none/release/test_blend_pool.wasm',
  import.meta.url
).pathname

const server = new rpc.Server(RPC_URL, { allowHttp: false })

function log(status: 'PASS' | 'FAIL' | 'INFO' | 'RESULT', message: string): void {
  process.stdout.write(`${status.padEnd(6)} ${message}\n`)
}

async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`)
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status}`)
}

async function submit(tx: Transaction): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    const code = sent.errorResult?.result().switch().name ?? 'unknown'
    throw new Error(`send failed: ${code} ${sent.errorResult?.toXDR('base64')}`)
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') {
      throw new Error(`tx ${sent.hash} FAILED: ${JSON.stringify(got.resultXdr?.toXDR('base64'))}`)
    }
  }
  throw new Error(`tx ${sent.hash} did not confirm`)
}

async function withSeqRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (i >= 3 || !String(e).includes('txBadSeq')) throw e
      log('INFO', `txBadSeq - RPC sequence was stale, rebuilding (attempt ${i + 2})`)
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
}

function i128(stroops: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(stroops) })
  )
}

function interpreterParams(predicate: PredicateNode, nonce: number): xdr.ScVal {
  const { encodedPredicate, predicateHash } = encodePredicate(predicate)
  const bytes = Buffer.from(encodedPredicate, 'base64')
  const computed = createHash('sha256').update(bytes).digest('hex')
  if (computed !== predicateHash) throw new Error('hash mismatch building params')
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('grammar_version'),
      val: xdr.ScVal.scvU32(PINNED_INTERPRETER_GRAMMAR_VERSION),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('install_nonce'), val: xdr.ScVal.scvU32(nonce) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('predicate'), val: xdr.ScVal.scvBytes(bytes) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('predicate_hash'),
      val: xdr.ScVal.scvBytes(Buffer.from(predicateHash, 'hex')),
    }),
  ])
}

function spendingLimitParams(limit: bigint, periodLedgers: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('period_ledgers'),
      val: xdr.ScVal.scvU32(periodLedgers),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('spending_limit'), val: i128(limit) }),
  ])
}

function policiesMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const mapped = entries.map(
    ([addr, params]) => new xdr.ScMapEntry({ key: Address.fromString(addr).toScVal(), val: params })
  )
  mapped.sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()))
  return xdr.ScVal.scvMap(mapped)
}

/** One Blend `Request`. Struct fields go on the wire as a symbol-keyed map in
 *  alphabetical order, which `address` / `amount` / `request_type` already are. */
function requestVal(token: string, amount: bigint, requestType: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('address'),
      val: Address.fromString(token).toScVal(),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: i128(amount) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('request_type'),
      val: xdr.ScVal.scvU32(requestType),
    }),
  ])
}

interface InvokeOpts {
  kp: Keypair
  smartAccount: string
  contract?: string
  fnName: string
  args: xdr.ScVal[]
  contextRuleIds: number[]
}

async function invokeAsAccount(
  opts: InvokeOpts
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  return withSeqRetry(() => invokeAsAccountOnce(opts))
}

async function invokeAsAccountOnce(
  opts: InvokeOpts
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { kp, smartAccount, fnName, args, contextRuleIds } = opts
  const target = opts.contract ?? smartAccount
  const source = await server.getAccount(kp.publicKey())
  const built = new TransactionBuilder(source, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(target).call(fnName, ...args))
    .setTimeout(TIMEOUT)
    .build()

  const sim = await server.simulateTransaction(built)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`)

  const latest = await server.getLatestLedger()
  const expLedger = latest.sequence + 100
  const accountsOwn = (sim.result?.auth ?? []).find(
    (e) =>
      e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(e.credentials().address().address()).toString() === smartAccount
  )
  if (!accountsOwn) throw new Error('no address-credential entry for the account')

  const payloadHash = signaturePayload(
    PASSPHRASE,
    accountsOwn.credentials().address().nonce(),
    expLedger,
    accountsOwn.rootInvocation()
  )
  const digest = authDigest(payloadHash, contextRuleIds)
  const entries = [
    accountEntry(
      accountsOwn,
      expLedger,
      authPayload([kp.publicKey()], contextRuleIds, () => Buffer.alloc(0))
    ),
    delegatedSignerEntry(smartAccount, digest),
  ]

  const authed = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: target, function: fnName, args, auth: entries })
    )
    .setTimeout(TIMEOUT)
    .build()
  const sim2 = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2)) throw new Error(`authorised sim failed: ${sim2.error}`)
  const prepared = rpc.assembleTransaction(authed, sim2).build()
  prepared.sign(kp)
  return submit(prepared)
}

/** Rule 1: the pool rule. Pins the pool, the method, exactly one request, the
 *  supply request type, the reserve token, and a per-entry ceiling. */
function poolPredicate(pool: string, token: string): PredicateNode {
  return {
    op: 'and',
    children: [
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: pool },
      },
      { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'submit' } },
      {
        op: 'eq',
        left: { kind: 'call_arg_len', index: 3 },
        right: { kind: 'literal_u32', value: 1 },
      },
      {
        op: 'eq',
        left: { kind: 'call_arg_field', index: 3, element: 0, field: 'request_type' },
        right: { kind: 'literal_u32', value: SUPPLY_REQUEST_TYPE },
      },
      {
        op: 'eq',
        left: { kind: 'call_arg_field', index: 3, element: 0, field: 'address' },
        right: { kind: 'literal_address', value: token },
      },
      {
        op: 'lte',
        left: { kind: 'call_arg_field', index: 3, element: 0, field: 'amount' },
        right: { kind: 'literal_i128', value: PER_CALL_CEILING.toString() },
      },
    ],
  }
}

/** Rules 2 and 3: the token rule. Pins the method and the destination, so the
 *  daily budget cannot be spent sending the token anywhere but the pool. The
 *  `call_fn == transfer` conjunct is what refuses an `approve`, which would
 *  otherwise grant an allowance the cap never sees. */
function tokenPredicate(token: string, pool: string): PredicateNode {
  return {
    op: 'and',
    children: [
      { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: token },
      },
      {
        op: 'in',
        needle: { kind: 'call_arg', index: 1 },
        haystack: [{ kind: 'literal_address', value: pool }],
      },
      {
        op: 'lte',
        left: { kind: 'call_arg', index: 2 },
        right: { kind: 'literal_i128', value: PER_CALL_CEILING.toString() },
      },
    ],
  }
}

async function main(): Promise<void> {
  log('INFO', `network        ${NETWORK}`)
  log(
    'INFO',
    `interpreter    ${INTERPRETER} (pinned, grammar ${PINNED_INTERPRETER_GRAMMAR_VERSION})`
  )
  log('INFO', `spending_limit ${SPENDING_LIMIT} (OZ v0.7.2, third-party)`)
  log('INFO', `rpc            ${RPC_URL}`)
  log('INFO', `cap ${CAP_STROOPS} / under ${UNDER_CAP_STROOPS} / over ${OVER_CAP_STROOPS} stroops`)
  log(
    'INFO',
    `per-call ceiling in BOTH predicates ${PER_CALL_CEILING} (so only the cap can refuse)`
  )

  const secret = arg('secret') ?? process.env.E2E_SECRET
  let kp: Keypair
  if (NETWORK === 'mainnet') {
    if (!secret) throw new Error('mainnet needs --secret or E2E_SECRET')
    kp = Keypair.fromSecret(secret)
  } else {
    kp = secret ? Keypair.fromSecret(secret) : Keypair.random()
    if (!secret) await fundWithFriendbot(kp.publicKey())
  }
  const agent = Keypair.random()
  log('INFO', `admin (rule 0) ${kp.publicKey()}`)
  log('INFO', `agent          ${agent.publicKey()}`)

  // The delegated signer authenticates through source-account credentials, so
  // it has to be the transaction source and therefore a funded account.
  if (NETWORK === 'mainnet') {
    await withSeqRetry(async () => {
      const src = await server.getAccount(kp.publicKey())
      const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: PASSPHRASE })
        .addOperation(
          Operation.createAccount({ destination: agent.publicKey(), startingBalance: '2' })
        )
        .setTimeout(TIMEOUT)
        .build()
      tx.sign(kp)
      return submit(tx)
    })
  } else {
    await fundWithFriendbot(agent.publicKey())
  }
  log('PASS', 'agent funded')

  // ---- deploy the Blend-shaped pool ----
  const wasm = await Bun.file(POOL_WASM).arrayBuffer()
  const uploaded = await withSeqRetry(async () => {
    const src = await server.getAccount(kp.publicKey())
    const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.uploadContractWasm({ wasm: Buffer.from(wasm) }))
      .setTimeout(TIMEOUT)
      .build()
    const prepared = await server.prepareTransaction(tx)
    prepared.sign(kp)
    return submit(prepared)
  })
  const uploadedHash = uploaded.returnValue?.value()
  if (!(uploadedHash instanceof Buffer)) {
    throw new Error('wasm upload returned no hash - nothing to deploy the pool from')
  }
  const poolWasmHash = uploadedHash.toString('hex')
  log('PASS', `pool wasm      ${poolWasmHash}`)

  const poolDeployed = await withSeqRetry(async () => {
    const src = await server.getAccount(kp.publicKey())
    const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.createCustomContract({
          address: Address.fromString(kp.publicKey()),
          wasmHash: Buffer.from(poolWasmHash, 'hex'),
        })
      )
      .setTimeout(TIMEOUT)
      .build()
    const prepared = await server.prepareTransaction(tx)
    prepared.sign(kp)
    return submit(prepared)
  })
  const pool = Address.fromScAddress(
    poolDeployed.returnValue?.address() as xdr.ScAddress
  ).toString()
  log('PASS', `pool           ${pool}`)

  // ---- smart account, admin on rule 0 ----
  const accDeployed = await withSeqRetry(async () => {
    const accSrc = await server.getAccount(kp.publicKey())
    const accTx = new TransactionBuilder(accSrc, { fee: FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.createCustomContract({
          address: Address.fromString(kp.publicKey()),
          wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
          constructorArgs: [
            xdr.ScVal.scvVec([delegatedSigner(kp.publicKey())]),
            xdr.ScVal.scvMap([]),
          ],
        })
      )
      .setTimeout(TIMEOUT)
      .build()
    const accPrepared = await server.prepareTransaction(accTx)
    accPrepared.sign(kp)
    return submit(accPrepared)
  })
  const smartAccount = Address.fromScAddress(
    accDeployed.returnValue?.address() as xdr.ScAddress
  ).toString()
  log('PASS', `smart account  ${smartAccount}`)

  const sac = Asset.native().contractId(PASSPHRASE)
  const funding = OVER_CAP_STROOPS * 3n + UNDER_CAP_STROOPS + 20_000_000n
  await withSeqRetry(async () => {
    const fundSrc = await server.getAccount(kp.publicKey())
    const fundTx = new TransactionBuilder(fundSrc, { fee: FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(sac).call(
          'transfer',
          Address.fromString(kp.publicKey()).toScVal(),
          Address.fromString(smartAccount).toScVal(),
          i128(funding)
        )
      )
      .setTimeout(TIMEOUT)
      .build()
    const fundPrepared = await server.prepareTransaction(fundTx)
    fundPrepared.sign(kp)
    return submit(fundPrepared)
  })
  log('PASS', `account funded ${funding} stroops (SAC ${sac})`)

  // ---- install the three rules ----
  const ruleArgs = (
    scope: string,
    name: string,
    signer: Keypair,
    policies: xdr.ScVal
  ): xdr.ScVal[] => [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CallContract'), Address.fromString(scope).toScVal()]),
    xdr.ScVal.scvString(name),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([delegatedSigner(signer.publicKey())]),
    policies,
  ]

  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      pool,
      'pool-supply',
      agent,
      policiesMap([[INTERPRETER, interpreterParams(poolPredicate(pool, sac), 1)]])
    ),
    contextRuleIds: [0],
  })
  log('PASS', 'rule 1 installed: pool, interpreter (submit shape + per-entry ceiling)')

  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      sac,
      'token-capped',
      agent,
      policiesMap([
        [INTERPRETER, interpreterParams(tokenPredicate(sac, pool), 1)],
        [SPENDING_LIMIT, spendingLimitParams(CAP_STROOPS, PERIOD_LEDGERS)],
      ])
    ),
    contextRuleIds: [0],
  })
  log('PASS', `rule 2 installed: token, interpreter + spending_limit(cap ${CAP_STROOPS})`)

  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      sac,
      'token-uncapped',
      agent,
      policiesMap([[INTERPRETER, interpreterParams(tokenPredicate(sac, pool), 1)]])
    ),
    contextRuleIds: [0],
  })
  log('PASS', 'rule 3 installed: token, interpreter only, NO cap (the control)')

  const supplyArgs = (stroops: bigint): xdr.ScVal[] => [
    Address.fromString(smartAccount).toScVal(),
    Address.fromString(smartAccount).toScVal(),
    Address.fromString(smartAccount).toScVal(),
    xdr.ScVal.scvVec([requestVal(sac, stroops, SUPPLY_REQUEST_TYPE)]),
  ]

  // ---- 1. CONTROL: over-cap supply through the UNCAPPED token rule ----
  try {
    const r = await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: pool,
      fnName: 'submit',
      args: supplyArgs(OVER_CAP_STROOPS),
      contextRuleIds: [1, 3],
    })
    log(
      'PASS',
      `CONTROL: supply of ${OVER_CAP_STROOPS} permitted via ids [1,3] (no cap) ${r.txHash}`
    )
  } catch (e) {
    log('FAIL', `CONTROL denied - experiment inconclusive: ${String(e).slice(0, 400)}`)
    process.exit(1)
  }

  // ---- 2. CAPPED, under the cap: the pair must still permit ----
  try {
    const r = await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: pool,
      fnName: 'submit',
      args: supplyArgs(UNDER_CAP_STROOPS),
      contextRuleIds: [1, 2],
    })
    log('PASS', `CAPPED: supply of ${UNDER_CAP_STROOPS} permitted via ids [1,2] ${r.txHash}`)
  } catch (e) {
    log(
      'FAIL',
      `CAPPED under-cap denied - the cap is a brick, not a bound: ${String(e).slice(0, 400)}`
    )
    process.exit(1)
  }

  // ---- 3. CAPPED, over the cap: the verdict ----
  try {
    await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: pool,
      fnName: 'submit',
      args: supplyArgs(OVER_CAP_STROOPS),
      contextRuleIds: [1, 2],
    })
    log(
      'RESULT',
      `NOT BOUND: supply of ${OVER_CAP_STROOPS} SUCCEEDED with a cap of ${CAP_STROOPS}.`
    )
    process.exit(1)
  } catch (e) {
    const msg = String(e)
    const code = Number(msg.match(/#(\d+)/)?.[1] ?? Number.NaN)
    if (code === SPENDING_LIMIT_EXCEEDED) {
      log('RESULT', `BOUND: over-cap supply DENIED #${code} (SpendingLimitExceeded).`)
      log('RESULT', 'The control permitted the identical supply, so the cap is what refused it.')
    } else {
      log('FAIL', `denied by #${code || '(no contract code)'}, NOT #${SPENDING_LIMIT_EXCEEDED}`)
      log('FAIL', msg.slice(0, 400))
      process.exit(1)
    }
  }

  // ---- 4. BYPASS: name the POOL rule for the token's transfer context ----
  // A bare "it failed" would not settle this: the call could die for a reason
  // that has nothing to do with rule selection, and the bypass would still be
  // open. The deny has to carry UnvalidatedContext.
  try {
    await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: pool,
      fnName: 'submit',
      args: supplyArgs(UNDER_CAP_STROOPS),
      contextRuleIds: [1, 1],
    })
    log('RESULT', 'BYPASSED: ids [1,1] SUCCEEDED - the pool rule served the token transfer.')
    process.exit(1)
  } catch (e) {
    const msg = String(e)
    if (msg.includes(`#${UNVALIDATED_CONTEXT}`)) {
      log('RESULT', `REFUSED: ids [1,1] denied #${UNVALIDATED_CONTEXT} (UnvalidatedContext).`)
      log('RESULT', 'Rule 1 is CallContract(pool); the nested context is CallContract(SAC).')
    } else {
      log('FAIL', `ids [1,1] denied, but NOT by #${UNVALIDATED_CONTEXT} - reason unconfirmed:`)
      log('FAIL', msg.slice(0, 1200))
      process.exit(1)
    }
  }

  // ---- 5. Can a context simply be dropped? ----
  // The agent supplies context_rule_ids; auth_contexts comes from the host. If
  // the lengths could differ, the token leg could go unjudged entirely.
  try {
    await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: pool,
      fnName: 'submit',
      args: supplyArgs(UNDER_CAP_STROOPS),
      contextRuleIds: [1],
    })
    log('RESULT', 'BYPASSED: ids [1] SUCCEEDED - the token context went unjudged.')
    process.exit(1)
  } catch (e) {
    const msg = String(e)
    if (msg.includes(`#${CONTEXT_RULE_IDS_LENGTH_MISMATCH}`)) {
      log(
        'RESULT',
        `REFUSED: ids [1] denied #${CONTEXT_RULE_IDS_LENGTH_MISMATCH} (ContextRuleIdsLengthMismatch).`
      )
      log(
        'RESULT',
        'A context cannot be omitted: one declared rule id per context, or nothing runs.'
      )
    } else {
      log('FAIL', `ids [1] denied, but NOT by #${CONTEXT_RULE_IDS_LENGTH_MISMATCH}:`)
      log('FAIL', msg.slice(0, 1200))
      process.exit(1)
    }
  }
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 500))
  process.exit(1)
})
