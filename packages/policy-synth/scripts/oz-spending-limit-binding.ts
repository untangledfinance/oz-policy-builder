// Does an OpenZeppelin `spending_limit` policy actually BIND when it sits on
// the same context rule as our interpreter?
//
// `oz-policy-composition.ts` settled the composition RULE - OZ requires every
// attached policy to permit (all-of), proven with two interpreter instances
// that disagreed. This script settles the remaining question, which is whether
// a REAL third-party policy - not a second copy of our own code - stops a call
// our interpreter would wave through. That is the difference between "the
// composition semantics allow a spend cap" and "a spend cap holds".
//
// One rule shape throughout. The only variable is the extra policy:
//
//   rule 1  CONTROL  interpreter only                       agentControl
//   rule 2  SUBJECT  interpreter + OZ spending_limit(CAP)   agentSubject
//
// Three calls, in this order, because each one is load-bearing:
//
//   1. CONTROL  over-cap transfer through rule 1  -> must PASS
//        Without this the deny below proves nothing: it could mean the
//        interpreter refused, or the amount was bad, or the account was broke.
//        This is what attributes the deny to the spend cap and nothing else.
//   2. SUBJECT  under-cap transfer through rule 2 -> must PASS
//        Proves the two-policy rule is well formed and that spending_limit
//        permits when it should. A rule that denies everything is not a bound,
//        it is a brick.
//   3. SUBJECT  over-cap transfer through rule 2  -> must DENY #3221
//        SpendingLimitExceeded. Any other code means something else refused.
//
// The OZ policy reads the amount from `args[2]` of a call named `transfer`
// (spending_limit.rs:242-244 at tag v0.7.2), and its `install` refuses any
// context rule type other than `CallContract` (line 376), so the rules below
// are pinned to the native SAC.
//
// Usage:
//   bun packages/policy-synth/scripts/oz-spending-limit-binding.ts --network testnet
//   bun packages/policy-synth/scripts/oz-spending-limit-binding.ts --network mainnet --secret S...

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
 *  OpenZeppelin/stellar-contracts at TAG v0.7.2 and deployed to both networks.
 *  wasm sha256 9ce30ea1fe5c2dc5c9c49cf3462adb32e2c11d7dfadb15ef43a51ba56568de2b,
 *  identical on both. Third-party code we did not audit - see
 *  docs/audit/README.md for the provenance note. */
const SPENDING_LIMIT_BY_NETWORK: Record<Net, string> = {
  testnet: 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP',
  mainnet: 'CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A',
}

/** `SpendingLimitError::SpendingLimitExceeded`. The deny has to carry THIS
 *  code; a different one means a different policy refused. */
const SPENDING_LIMIT_EXCEEDED = 3221

const FEE = '2000000'
const TIMEOUT = 120

/** Cap and the two amounts either side of it, in stroops. The under-cap
 *  transfer is spent first, so the over-cap one exceeds the cap on its own as
 *  well as cumulatively - the verdict does not depend on the rolling window
 *  having recorded anything. */
const CAP_STROOPS = 5_000_000n
const UNDER_CAP_STROOPS = 1_000_000n
const OVER_CAP_STROOPS = 20_000_000n
/** ~1 day. Long enough that the window never rolls over mid-run. */
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
// mainnet.sorobanrpc.com times out on submit; the gateway.fm endpoint does not.
const RPC_URL =
  NETWORK === 'mainnet'
    ? 'https://soroban-rpc.mainnet.stellar.gateway.fm'
    : RPC_URL_BY_NETWORK[NETWORK]

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
    // Name the result code as well as the raw XDR: `withSeqRetry` keys off the
    // name, and a bare base64 blob hides which failure this was.
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

/** The mainnet RPC's account view can lag a ledger behind a transaction it has
 *  already reported as confirmed, so the next build picks up a stale sequence
 *  and the submit comes back `txBadSeq`. That rejection happens before the
 *  transaction is nominated, so nothing landed and rebuilding from a fresh
 *  sequence is safe - unlike a submission TIMEOUT, which must be checked
 *  against Horizon before any retry. Retries only on that one code. */
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

/** One `PolicyInstallParams` map for our interpreter. Field order is the
 *  host's symbol-STRING order, already alphabetical for these four names. */
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

/** `SpendingLimitAccountParams`. Symbol-string order puts `period_ledgers`
 *  before `spending_limit`, which is also the order `stellar contract info
 *  interface` reports for the deployed instance. */
function spendingLimitParams(limit: bigint, periodLedgers: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('period_ledgers'),
      val: xdr.ScVal.scvU32(periodLedgers),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('spending_limit'), val: i128(limit) }),
  ])
}

/** `Map<Address, Val>`, sorted by the key's XDR bytes as the host requires for
 *  a non-symbol-keyed map. Built by hand because `buildAddContextRuleArgs`
 *  applies ONE set of install params to every policy, so it cannot express an
 *  interpreter and a spend cap on the same rule - which is the shape under
 *  test. */
function policiesMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const mapped = entries.map(
    ([addr, params]) => new xdr.ScMapEntry({ key: Address.fromString(addr).toScVal(), val: params })
  )
  mapped.sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()))
  return xdr.ScVal.scvMap(mapped)
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

const PERMITS_TRANSFER: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'transfer' },
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

  const secret = arg('secret') ?? process.env.E2E_SECRET
  let kp: Keypair
  if (NETWORK === 'mainnet') {
    if (!secret) throw new Error('mainnet needs --secret or E2E_SECRET')
    kp = Keypair.fromSecret(secret)
  } else {
    kp = secret ? Keypair.fromSecret(secret) : Keypair.random()
    if (!secret) await fundWithFriendbot(kp.publicKey())
  }
  const agentControl = Keypair.random()
  const agentSubject = Keypair.random()
  log('INFO', `admin (rule 0) ${kp.publicKey()}`)

  // Both agents need funded accounts: a delegated signer authenticates through
  // source-account credentials, so it has to be the transaction source.
  for (const agent of [agentControl, agentSubject]) {
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
  }
  log('PASS', `agents funded: control ${agentControl.publicKey()}`)
  log('PASS', `               subject ${agentSubject.publicKey()}`)

  // Smart account, admin on rule 0 (no policy, so it can install).
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

  // Fund it enough to cover the control's over-cap move plus the subject's.
  const sac = Asset.native().contractId(PASSPHRASE)
  const funding = OVER_CAP_STROOPS * 2n + UNDER_CAP_STROOPS + 10_000_000n
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

  // Both rules are `CallContract(SAC)`: spending_limit's install refuses any
  // other context rule type, and the control has to match the subject in every
  // respect except the extra policy. Names stay within MAX_NAME_SIZE (20).
  const ruleArgs = (name: string, agent: Keypair, policies: xdr.ScVal): xdr.ScVal[] => [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CallContract'), Address.fromString(sac).toScVal()]),
    xdr.ScVal.scvString(name),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([delegatedSigner(agent.publicKey())]),
    policies,
  ]

  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      'control-no-cap',
      agentControl,
      policiesMap([[INTERPRETER, interpreterParams(PERMITS_TRANSFER, 1)]])
    ),
    contextRuleIds: [0],
  })
  log('PASS', 'rule 1 installed: interpreter only')

  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      'subject-with-cap',
      agentSubject,
      policiesMap([
        [INTERPRETER, interpreterParams(PERMITS_TRANSFER, 1)],
        [SPENDING_LIMIT, spendingLimitParams(CAP_STROOPS, PERIOD_LEDGERS)],
      ])
    ),
    contextRuleIds: [0],
  })
  log('PASS', `rule 2 installed: interpreter + spending_limit(cap ${CAP_STROOPS})`)

  // The admin's own account is the destination: it already exists on both
  // networks, so no extra account has to be created to receive the XLM.
  const dest = Address.fromString(kp.publicKey()).toScVal()
  const transferArgs = (stroops: bigint): xdr.ScVal[] => [
    Address.fromString(smartAccount).toScVal(),
    dest,
    i128(stroops),
  ]

  // ---- 1. CONTROL: over-cap through the interpreter-only rule ----
  try {
    await invokeAsAccount({
      kp: agentControl,
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs(OVER_CAP_STROOPS),
      contextRuleIds: [1],
    })
    log('PASS', `CONTROL: ${OVER_CAP_STROOPS} permitted through rule 1 (no cap attached)`)
  } catch (e) {
    log('FAIL', `CONTROL denied - experiment inconclusive: ${String(e).slice(0, 300)}`)
    process.exit(1)
  }

  // ---- 2. SUBJECT under the cap: the rule must still permit ----
  try {
    await invokeAsAccount({
      kp: agentSubject,
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs(UNDER_CAP_STROOPS),
      contextRuleIds: [2],
    })
    log('PASS', `SUBJECT: ${UNDER_CAP_STROOPS} permitted through rule 2 (under the cap)`)
  } catch (e) {
    log(
      'FAIL',
      `SUBJECT under-cap denied - the cap is a brick, not a bound: ${String(e).slice(0, 300)}`
    )
    process.exit(1)
  }

  // ---- 3. SUBJECT over the cap: the verdict ----
  try {
    await invokeAsAccount({
      kp: agentSubject,
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs(OVER_CAP_STROOPS),
      contextRuleIds: [2],
    })
    log('RESULT', `NOT BOUND: ${OVER_CAP_STROOPS} SUCCEEDED with a cap of ${CAP_STROOPS} attached.`)
    process.exit(1)
  } catch (e) {
    const msg = String(e)
    const code = Number(msg.match(/#(\d+)/)?.[1] ?? Number.NaN)
    if (code === SPENDING_LIMIT_EXCEEDED) {
      log('RESULT', `BOUND: over-cap transfer DENIED #${code} (SpendingLimitExceeded).`)
      log('RESULT', 'The control permitted the same amount, so the cap is what refused it.')
    } else {
      log(
        'FAIL',
        `denied by #${code || '(no contract code)'}, NOT SpendingLimitExceeded #${SPENDING_LIMIT_EXCEEDED}`
      )
      log('FAIL', msg.slice(0, 300))
      process.exit(1)
    }
  }
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 400))
  process.exit(1)
})
