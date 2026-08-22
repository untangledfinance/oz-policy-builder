// Does OpenZeppelin compose MULTIPLE policies on ONE context rule as all-of
// or any-of?
//
// This decides whether an OZ `spending_limit` attached beside our interpreter
// is a real bound or a bypassable one. If OZ requires every attached policy to
// permit (all-of), the combination holds. If any single policy permitting is
// enough (any-of), then satisfying the interpreter alone clears the rule and
// the spend cap next to it means nothing.
//
// Two interpreter instances go on ONE rule, with predicates that disagree
// about the same call:
//
//   A (pinned)  eq(call_fn, "transfer")   -> PERMITS transfer
//   B (fresh)   eq(call_fn, "approve")    -> DENIES  transfer
//
// Then the agent calls `transfer`:
//   denied    => ALL-OF  (B's refusal is decisive)  -> combination is sound
//   succeeds  => ANY-OF  (A's permit is enough)     -> combination is a hole
//
// A control rule carrying ONLY A runs first. Without it, a denial proves
// nothing: it could just as easily mean the two-policy rule was malformed, or
// that A never permitted anything to begin with.
//
// Usage: bun packages/policy-synth/scripts/oz-policy-composition.ts

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
  PINNED_INTERPRETER_WASM_SHA256,
  RPC_URL_BY_NETWORK,
} from '../src/run/schemas.ts'
import type { PredicateNode } from '../src/types.ts'

const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const FEE = '2000000'
const TIMEOUT = 60
const PASSPHRASE = Networks.TESTNET
const RPC_URL = RPC_URL_BY_NETWORK.testnet
const INTERPRETER_A = PINNED_INTERPRETER_ADDRESS_BY_NETWORK.testnet
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
  if (sent.status === 'ERROR') throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') throw new Error(`tx FAILED: ${JSON.stringify(got.resultXdr)}`)
  }
  throw new Error('tx did not settle')
}

/** One `PolicyInstallParams` map. Field order is the host's symbol-STRING
 *  order, which is already alphabetical for these four names. */
function installParams(predicate: PredicateNode, nonce: number): xdr.ScVal {
  const { encodedPredicate, predicateHash } = encodePredicate(predicate)
  const bytes = Buffer.from(encodedPredicate, 'base64')
  const computed = createHash('sha256').update(bytes).digest('hex')
  if (computed !== predicateHash) throw new Error('hash mismatch building params')
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('grammar_version'),
      val: xdr.ScVal.scvU32(PINNED_INTERPRETER_GRAMMAR_VERSION),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('install_nonce'),
      val: xdr.ScVal.scvU32(nonce),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('predicate'), val: xdr.ScVal.scvBytes(bytes) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('predicate_hash'),
      val: xdr.ScVal.scvBytes(Buffer.from(predicateHash, 'hex')),
    }),
  ])
}

/** `Map<Address, PolicyInstallParams>`, sorted by the key's XDR bytes as the
 *  host requires for a non-symbol-keyed map. Built by hand because
 *  `buildAddContextRuleArgs` applies ONE set of install params to every
 *  policy, so it cannot express two interpreters with different predicates -
 *  which is exactly the shape under test. */
function policiesMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const mapped = entries.map(
    ([addr, params]) => new xdr.ScMapEntry({ key: Address.fromString(addr).toScVal(), val: params })
  )
  mapped.sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()))
  return xdr.ScVal.scvMap(mapped)
}

async function invokeAsAccount(opts: {
  kp: Keypair
  smartAccount: string
  contract?: string
  fnName: string
  args: xdr.ScVal[]
  contextRuleIds: number[]
}): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
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
const DENIES_TRANSFER: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'approve' },
}

async function main(): Promise<void> {
  log('INFO', `network       testnet`)
  log('INFO', `interpreter A ${INTERPRETER_A} (pinned)`)

  const kp = Keypair.random()
  await fundWithFriendbot(kp.publicKey())
  const agentControl = Keypair.random()
  const agentBoth = Keypair.random()
  await fundWithFriendbot(agentControl.publicKey())
  await fundWithFriendbot(agentBoth.publicKey())

  // A SECOND interpreter instance from the same pinned wasm. Same code, its
  // own storage, so it can hold a different predicate for the same rule.
  const deploySrc = await server.getAccount(kp.publicKey())
  const deployB = new TransactionBuilder(deploySrc, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(kp.publicKey()),
        wasmHash: Buffer.from(PINNED_INTERPRETER_WASM_SHA256, 'hex'),
        salt: createHash('sha256').update(`composition-${Date.now()}`).digest(),
      })
    )
    .setTimeout(TIMEOUT)
    .build()
  const preparedB = await server.prepareTransaction(deployB)
  preparedB.sign(kp)
  const deployedB = await submit(preparedB)
  const INTERPRETER_B = Address.fromScAddress(
    deployedB.returnValue?.address() as xdr.ScAddress
  ).toString()
  log('INFO', `interpreter B ${INTERPRETER_B} (fresh instance, same wasm)`)

  // Smart account, admin on rule 0.
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
  const accDeployed = await submit(accPrepared)
  const smartAccount = Address.fromScAddress(
    accDeployed.returnValue?.address() as xdr.ScAddress
  ).toString()
  log('PASS', `smart account ${smartAccount}`)

  // Fund it so a transfer has something to move.
  const sac = Asset.native().contractId(PASSPHRASE)
  const fundSrc = await server.getAccount(kp.publicKey())
  const fundTx = new TransactionBuilder(fundSrc, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(
      new Contract(sac).call(
        'transfer',
        Address.fromString(kp.publicKey()).toScVal(),
        Address.fromString(smartAccount).toScVal(),
        xdr.ScVal.scvI128(
          new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(1_000_000_000n) })
        )
      )
    )
    .setTimeout(TIMEOUT)
    .build()
  const fundPrepared = await server.prepareTransaction(fundTx)
  fundPrepared.sign(kp)
  await submit(fundPrepared)
  log('PASS', 'account funded')

  const ruleArgs = (name: string, agent: Keypair, policies: xdr.ScVal): xdr.ScVal[] => [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')]),
    xdr.ScVal.scvString(name),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([delegatedSigner(agent.publicKey())]),
    policies,
  ]

  // ---- CONTROL: rule 1 carries ONLY interpreter A ----
  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      'control-A-only',
      agentControl,
      policiesMap([[INTERPRETER_A, installParams(PERMITS_TRANSFER, 1)]])
    ),
    contextRuleIds: [0],
  })
  log('PASS', 'rule 1 installed: A only (permits transfer)')

  // ---- SUBJECT: rule 2 carries BOTH A and B ----
  await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs(
      'subject-A-and-B',
      agentBoth,
      policiesMap([
        [INTERPRETER_A, installParams(PERMITS_TRANSFER, 1)],
        [INTERPRETER_B, installParams(DENIES_TRANSFER, 1)],
      ])
    ),
    contextRuleIds: [0],
  })
  log('PASS', 'rule 2 installed: A (permits transfer) + B (denies transfer)')

  const dest = Keypair.random()
  await fundWithFriendbot(dest.publicKey())
  const transferArgs = [
    Address.fromString(smartAccount).toScVal(),
    Address.fromString(dest.publicKey()).toScVal(),
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(1_000_000n) })
    ),
  ]

  // Control first: if this denies, the experiment says nothing.
  let controlOk = false
  try {
    await invokeAsAccount({
      kp: agentControl,
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs,
      contextRuleIds: [1],
    })
    controlOk = true
    log('PASS', 'CONTROL: transfer permitted through rule 1 (A alone permits)')
  } catch (e) {
    log('FAIL', `CONTROL transfer denied - experiment is inconclusive: ${String(e).slice(0, 200)}`)
  }
  if (!controlOk) process.exit(1)

  // Subject: A permits, B denies. Which wins?
  try {
    await invokeAsAccount({
      kp: agentBoth,
      smartAccount,
      contract: sac,
      fnName: 'transfer',
      args: transferArgs,
      contextRuleIds: [2],
    })
    log('RESULT', 'ANY-OF: transfer SUCCEEDED with a policy on the rule that denies it.')
    log('RESULT', 'A second policy attached beside the interpreter does NOT bind.')
  } catch (e) {
    const msg = String(e)
    const code = msg.match(/#(\d+)/)?.[0] ?? '(no contract code)'
    log('RESULT', `ALL-OF: transfer DENIED ${code} - the refusing policy was decisive.`)
    log('RESULT', 'Every attached policy must permit, so a spend cap beside the interpreter binds.')
  }
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 400))
  process.exit(1)
})
