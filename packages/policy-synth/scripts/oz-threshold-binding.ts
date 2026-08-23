// Does an OpenZeppelin `simple_threshold` restore m-of-n beside our interpreter?
//
// This is the question "two signers must approve every transfer" turns into on
// an OZ smart account, and the naive answer is WRONG in the dangerous
// direction. A no-policy context rule requires the FULL signer set (all-of-N),
// but attaching ANY policy defers signer validation to the policy
// (`storage.rs:322`, "With policies, defer full validation to enforce()"), so a
// policed rule lets any ONE signer act alone. Adding a second signer "for two
// approvals" therefore produces the OPPOSITE of the intent unless something on
// the rule counts signatures.
//
// `simple_threshold` is that something: its `enforce` is
// `authenticated_signers.len() >= threshold` else panic `#3202`
// (`policies/simple_threshold.rs:184-208` at tag v0.7.2).
//
// One rule shape throughout - TWO signers on every rule. Only the extra policy
// varies:
//
//   rule 1  CONTROL  interpreter only                      signers A + B
//   rule 2  SUBJECT  interpreter + simple_threshold(2)     signers A + B
//
// Four calls, each load-bearing:
//
//   1. CONTROL  A alone            -> must PASS
//        This IS the any-of-N inversion, shown rather than asserted. It is also
//        what attributes the deny below: the same lone signature passes when
//        the threshold is absent.
//   2. SUBJECT  A alone            -> must DENY #3202 SimpleThresholdError::NotAllowed
//   3. SUBJECT  A + B together     -> must PASS
//        Without this the deny proves only that the rule is broken. A rule that
//        refuses everything is not a threshold.
//   4. MUTATION threshold 1, A alone -> must PASS  (run with --threshold 1)
//        Shows the verdict tracks the threshold VALUE, not the presence of a
//        second policy.
//
// Signing detail that makes this harder than the spend-cap experiment: a
// `Signer::Delegated` authenticates through `require_auth_for_args`, and only
// ONE signer can be the transaction source. The second signer therefore needs
// its own auth entry with ADDRESS credentials, signed over the standard Soroban
// preimage - see `delegatedSignerAddressEntry` below.
//
// Usage:
//   bun packages/policy-synth/scripts/oz-threshold-binding.ts --network testnet
//   bun packages/policy-synth/scripts/oz-threshold-binding.ts --network testnet --threshold 1
//   bun packages/policy-synth/scripts/oz-threshold-binding.ts --network mainnet --secret S...

import { createHash } from 'node:crypto'
import {
  Address,
  Asset,
  authorizeEntry,
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
  PINNED_OZ_POLICY_ADDRESS_BY_NETWORK,
  RPC_URL_BY_NETWORK,
} from '../src/run/schemas.ts'
import type { PredicateNode } from '../src/types.ts'

type Net = 'testnet' | 'mainnet'

/** sha256 of `multisig_account_example.wasm`, already uploaded to BOTH
 *  networks, so an account is created by deploy alone with no wasm upload. */
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

/** `SimpleThresholdError::NotAllowed` - too few authenticated signers. The deny
 *  has to carry THIS code; anything else means something other than the
 *  threshold refused. */
const NOT_ALLOWED = 3202

const FEE = '2000000'
const TIMEOUT = 120
const TRANSFER_STROOPS = 1_000_000n

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const NETWORK = (arg('network') ?? 'testnet') as Net
if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
  throw new Error(`--network must be testnet or mainnet, got ${NETWORK}`)
}
/** 2 is the real case. `--threshold 1` is the mutation: call 2 must flip to a
 *  permit, which is what proves the threshold value drives the verdict. */
const THRESHOLD = Number(arg('threshold') ?? 2)
if (!Number.isInteger(THRESHOLD) || THRESHOLD < 1 || THRESHOLD > 2) {
  throw new Error(`--threshold must be 1 or 2 (the rule carries 2 signers), got ${THRESHOLD}`)
}

const PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
const INTERPRETER = PINNED_INTERPRETER_ADDRESS_BY_NETWORK[NETWORK]
const SIMPLE_THRESHOLD = PINNED_OZ_POLICY_ADDRESS_BY_NETWORK[NETWORK].simple_threshold
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

/** See the note in oz-spending-limit-binding.ts: the mainnet RPC can serve a
 *  stale sequence right after a tx it already reported confirmed. `txBadSeq` is
 *  rejected before nomination, so nothing landed and a rebuild is safe. */
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

/** `SimpleThresholdAccountParams { threshold: u32 }` - a one-field struct, so
 *  no key ordering question. */
function thresholdParams(threshold: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('threshold'),
      val: xdr.ScVal.scvU32(threshold),
    }),
  ])
}

/** `Map<Address, Val>`, sorted by the key's XDR bytes as the host requires. */
function policiesMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const mapped = entries.map(
    ([addr, params]) => new xdr.ScMapEntry({ key: Address.fromString(addr).toScVal(), val: params })
  )
  mapped.sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()))
  return xdr.ScVal.scvMap(mapped)
}

/** The nested entry for a delegated signer that is NOT the transaction source.
 *
 *  `delegatedSignerEntry` uses source-account credentials, which the host
 *  satisfies from the envelope signature - that only works for one signer. A
 *  co-signer needs ADDRESS credentials carrying its own signature over the
 *  standard Soroban authorization preimage for the same
 *  `__check_auth(digest)` frame. `authorizeEntry` builds that preimage and
 *  produces the account-address signature shape the host verifies. */
async function delegatedSignerAddressEntry(
  accountId: string,
  digest: Buffer,
  signer: Keypair,
  expLedger: number
): Promise<xdr.SorobanAuthorizationEntry> {
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer.publicKey()).toScAddress(),
        // Any nonce unused by this address; the host records it to prevent
        // replay of this exact entry.
        nonce: new xdr.Int64(Math.floor(Math.random() * 2 ** 48)),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(accountId).toScAddress(),
          functionName: '__check_auth',
          args: [xdr.ScVal.scvBytes(digest)],
        })
      ),
      subInvocations: [],
    }),
  })
  return authorizeEntry(unsigned, signer, expLedger, PASSPHRASE)
}

/** Invoke with ONE or TWO delegated signers on the named rule.
 *
 *  `signers[0]` is the transaction source and rides source-account credentials;
 *  every further signer gets its own address-credential entry. The account's
 *  own `AuthPayload` lists ALL of them, which is what `do_check_auth`
 *  authenticates and hands to the policies as `authenticated_signers`. */
async function invokeAsAccountOnce(opts: {
  signers: Keypair[]
  smartAccount: string
  contract?: string
  fnName: string
  args: xdr.ScVal[]
  contextRuleIds: number[]
}): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { signers, smartAccount, fnName, args, contextRuleIds } = opts
  const source = signers[0]
  if (!source) throw new Error('at least one signer required')
  const target = opts.contract ?? smartAccount
  const built = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
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

  const entries: xdr.SorobanAuthorizationEntry[] = [
    accountEntry(
      accountsOwn,
      expLedger,
      authPayload(
        signers.map((s) => s.publicKey()),
        contextRuleIds,
        () => Buffer.alloc(0)
      )
    ),
    delegatedSignerEntry(smartAccount, digest),
  ]
  for (const co of signers.slice(1)) {
    entries.push(await delegatedSignerAddressEntry(smartAccount, digest, co, expLedger))
  }

  const authed = new TransactionBuilder(await server.getAccount(source.publicKey()), {
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
  // `assembleTransaction` keeps the operation's existing auth and only falls
  // back to the simulation's when there is none
  // (`rpc/transaction.js`: `existingAuth.length > 0 ? existingAuth : ...`), so
  // the hand-built co-signer entry survives. Rebuilding the operation to
  // "protect" it would drop the sorobanData this call just added, and the
  // network rejects that as txMalformed.
  const prepared = rpc.assembleTransaction(authed, sim2).build()
  prepared.sign(source)
  return submit(prepared)
}

const invokeAsAccount = (opts: Parameters<typeof invokeAsAccountOnce>[0]) =>
  withSeqRetry(() => invokeAsAccountOnce(opts))

const PERMITS_TRANSFER: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'transfer' },
}

async function main(): Promise<void> {
  log('INFO', `network          ${NETWORK}`)
  log(
    'INFO',
    `interpreter      ${INTERPRETER} (pinned, grammar ${PINNED_INTERPRETER_GRAMMAR_VERSION})`
  )
  log('INFO', `simple_threshold ${SIMPLE_THRESHOLD} (OZ v0.7.2, third-party)`)
  log('INFO', `rpc              ${RPC_URL}`)
  log(
    'INFO',
    `threshold        ${THRESHOLD} of 2 signers${THRESHOLD === 1 ? '  (MUTATION RUN)' : ''}`
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
  // A and B sit on BOTH rules. Only A is ever a transaction source, but B needs
  // a funded account too: address credentials are checked against a real
  // account's signers and thresholds.
  const agentA = Keypair.random()
  const agentB = Keypair.random()
  log('INFO', `admin (rule 0)   ${kp.publicKey()}`)

  for (const agent of [agentA, agentB]) {
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
  log('PASS', `signer A         ${agentA.publicKey()}`)
  log('PASS', `signer B         ${agentB.publicKey()}`)

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
  log('PASS', `smart account    ${smartAccount}`)

  const sac = Asset.native().contractId(PASSPHRASE)
  const funding = TRANSFER_STROOPS * 4n + 10_000_000n
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
  log('PASS', `account funded   ${funding} stroops`)

  // BOTH rules carry BOTH signers. `simple_threshold`'s install validates the
  // threshold against the rule's signer count, and the control has to match the
  // subject in every respect except the extra policy.
  const ruleArgs = (name: string, policies: xdr.ScVal): xdr.ScVal[] => [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CallContract'), Address.fromString(sac).toScVal()]),
    xdr.ScVal.scvString(name),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([delegatedSigner(agentA.publicKey()), delegatedSigner(agentB.publicKey())]),
    policies,
  ]

  await invokeAsAccount({
    signers: [kp],
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      'control-no-thresh',
      policiesMap([[INTERPRETER, interpreterParams(PERMITS_TRANSFER, 1)]])
    ),
    contextRuleIds: [0],
  })
  log('PASS', 'rule 1 installed: interpreter only, signers A + B')

  await invokeAsAccount({
    signers: [kp],
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      'subject-thresh',
      policiesMap([
        [INTERPRETER, interpreterParams(PERMITS_TRANSFER, 1)],
        [SIMPLE_THRESHOLD, thresholdParams(THRESHOLD)],
      ])
    ),
    contextRuleIds: [0],
  })
  log('PASS', `rule 2 installed: interpreter + simple_threshold(${THRESHOLD}), signers A + B`)

  const dest = Address.fromString(kp.publicKey()).toScVal()
  const transferArgs = [Address.fromString(smartAccount).toScVal(), dest, i128(TRANSFER_STROOPS)]

  // ---- 1. CONTROL: A alone through the un-thresholded rule ----
  try {
    await invokeAsAccount({
      signers: [agentA],
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs,
      contextRuleIds: [1],
    })
    log('PASS', 'CONTROL: signer A ALONE permitted through rule 1 - this is the any-of-N inversion')
  } catch (e) {
    log('FAIL', `CONTROL denied - experiment inconclusive: ${String(e).slice(0, 300)}`)
    process.exit(1)
  }

  // ---- 2. SUBJECT: A alone against the threshold ----
  let loneDeny: number | null = null
  try {
    await invokeAsAccount({
      signers: [agentA],
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs,
      contextRuleIds: [2],
    })
    if (THRESHOLD === 1) {
      log('RESULT', 'MUTATION: threshold 1 PERMITS the lone signer, as it must.')
    } else {
      log('RESULT', `NOT BOUND: signer A alone SUCCEEDED against a ${THRESHOLD}-of-2 threshold.`)
      process.exit(1)
    }
  } catch (e) {
    const msg = String(e)
    loneDeny = Number(msg.match(/#(\d+)/)?.[1] ?? Number.NaN)
    if (THRESHOLD === 1) {
      log('FAIL', `MUTATION: threshold 1 denied the lone signer #${loneDeny} - unexpected`)
      process.exit(1)
    }
    if (loneDeny !== NOT_ALLOWED) {
      log('FAIL', `denied by #${loneDeny || '(no code)'}, NOT NotAllowed #${NOT_ALLOWED}`)
      log('FAIL', msg.slice(0, 300))
      process.exit(1)
    }
    log('PASS', `SUBJECT: signer A alone DENIED #${loneDeny} (SimpleThresholdError::NotAllowed)`)
  }

  // ---- 3. SUBJECT: A and B together ----
  try {
    await invokeAsAccount({
      signers: [agentA, agentB],
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs,
      contextRuleIds: [2],
    })
    log('PASS', 'SUBJECT: signers A + B TOGETHER permitted through rule 2')
  } catch (e) {
    log(
      'FAIL',
      `two-signer call denied - the threshold is a brick, not a bound: ${String(e).slice(0, 300)}`
    )
    process.exit(1)
  }

  if (THRESHOLD === 2) {
    log('RESULT', `BOUND: ${THRESHOLD}-of-2 holds - one signer denied #${loneDeny}, two permitted.`)
    log('RESULT', 'The control permitted that same lone signer, so the threshold is what refused.')
  }
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 400))
  process.exit(1)
})
