// transfer-through-account.ts - move a token OUT of an OpenZeppelin smart
// account, so the account's installed policies decide whether the payment
// happens.
//
// This is the enforcement leg for a ROLLING TOTAL. The interpreter predicate
// bounds each call; an OpenZeppelin `spending_limit` on the same rule bounds the
// SUM across calls, and both must permit. Two identical transfers therefore get
// two different verdicts once the window's allowance is spent - which is the one
// thing a per-call cap can never do.
//
// WHY THIS EXISTS AND THE CLI DOES NOT DO IT. `stellar contract invoke` signs as
// a plain account. An OZ smart account authorises through its own
// `__check_auth`, which needs a payload carrying the context rule ids and a
// signature over that digest; the CLI has no way to construct one and fails with
// `Missing signing key for account C...`. This program builds that payload and
// nothing else - the policy, the rule and the verdict are all the chain's.
//
// A PERMITTED result is a payment that actually settled on chain; a REFUSED one
// never became a transaction, because the account turned it down at
// simulation. Run it twice with the same amount to see the rolling total bite.
//
//   provision  deploy a fresh account, fund it, mint the agent key
//   send       one transfer attempt as the agent key, on a named rule
//
// Usage:
//   bun packages/policy-synth/scripts/transfer-through-account.ts provision
//   bun packages/policy-synth/scripts/transfer-through-account.ts send \
//     --account C... --to G... --rule 1 --amount 153000000
//   (the agent key is read from AGENT_SEC in the environment, never argv)

import {
  Address,
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
import { RPC_URL_BY_NETWORK } from '../src/run/schemas.ts'

const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const FEE = '2000000'
const TIMEOUT = 120
const PASSPHRASE = Networks.TESTNET
const server = new rpc.Server(RPC_URL_BY_NETWORK.testnet, { allowHttp: false })

/** The native XLM SAC on testnet, used when `--token` is not given. */
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
/** `SpendingLimitExceeded` from the OpenZeppelin spend cap. */
const SPENDING_LIMIT_EXCEEDED = 3221

function log(status: string, message: string): void {
  process.stdout.write(`${status.padEnd(11)} ${message}\n`)
}

function i128(v: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(v) }))
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

async function friendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`)
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status}`)
}

async function submit(tx: Transaction): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    throw new Error(`send failed: ${sent.errorResult?.toXDR('base64')}`)
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') throw new Error(`tx ${sent.hash} FAILED`)
  }
  throw new Error(`tx ${sent.hash} did not confirm`)
}

/** Sign and submit as a PLAIN account - used for setup, never for the transfer. */
async function invokeAsSelf(
  kp: Keypair,
  contract: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const built = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(TIMEOUT)
    .build()
  const sim = await server.simulateTransaction(built)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sim failed: ${sim.error}`)
  const prepared = rpc.assembleTransaction(built, sim).build()
  prepared.sign(kp)
  return submit(prepared)
}

async function provision(): Promise<void> {
  const admin = Keypair.random()
  const agent = Keypair.random()
  log('STEP', 'funding the operator and agent keys')
  await friendbot(admin.publicKey())
  await friendbot(agent.publicKey())

  log('STEP', 'deploying a fresh smart account with the operator on rule 0')
  const built = new TransactionBuilder(await server.getAccount(admin.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(admin.publicKey()),
        wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
        constructorArgs: [
          xdr.ScVal.scvVec([delegatedSigner(admin.publicKey())]),
          xdr.ScVal.scvMap([]),
        ],
      })
    )
    .setTimeout(TIMEOUT)
    .build()
  const prepared = await server.prepareTransaction(built)
  prepared.sign(admin)
  const res = await submit(prepared)
  const account = Address.fromScAddress(res.returnValue?.address() as xdr.ScAddress).toString()

  log('STEP', 'funding the smart account with XLM so it has something to trade')
  await invokeAsSelf(admin, XLM, 'transfer', [
    Address.fromString(admin.publicKey()).toScVal(),
    Address.fromString(account).toScVal(),
    i128(2000000000n),
  ])

  log('RECEIPT', `smart account   ${account}`)
  log('RECEIPT', `operator key    ${admin.publicKey()}`)
  log('RECEIPT', `operator secret ${admin.secret()}`)
  log('RECEIPT', `agent key       ${agent.publicKey()}`)
  log('RECEIPT', `agent secret    ${agent.secret()}`)
}

/** One transfer attempt, authorised BY the smart account on a named rule. */
async function send(): Promise<void> {
  const smartAccount = arg('account')
  // The agent key comes from the environment, never argv - a secret passed on a
  // command line is rendered in the terminal and captured by any screen capture.
  const agentSecret = process.env.AGENT_SEC
  if (agentSecret === undefined || agentSecret === '') {
    throw new Error('set AGENT_SEC in the environment (do not pass a secret on the command line)')
  }
  const kp = Keypair.fromSecret(agentSecret)
  const ruleIds = arg('rule')
    .split(',')
    .map((s) => Number(s.trim()))
  const to = arg('to')
  const amount = BigInt(arg('amount'))
  const token = arg('token', XLM)

  const args = [
    Address.fromString(smartAccount).toScVal(),
    Address.fromString(to).toScVal(),
    i128(amount),
  ]
  log('STEP', `moving ${Number(amount) / 1e7} out of the treasury`)

  const probe = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(token).call('transfer', ...args))
    .setTimeout(TIMEOUT)
    .build()
  const sim = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`)

  const latest = await server.getLatestLedger()
  const expLedger = latest.sequence + 100
  const own = (sim.result?.auth ?? []).find(
    (e) =>
      e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(e.credentials().address().address()).toString() === smartAccount
  )
  if (!own) throw new Error('no address-credential entry for the smart account')

  const digest = authDigest(
    signaturePayload(
      PASSPHRASE,
      own.credentials().address().nonce(),
      expLedger,
      own.rootInvocation()
    ),
    ruleIds
  )
  const entries = [
    accountEntry(
      own,
      expLedger,
      authPayload([kp.publicKey()], ruleIds, () => Buffer.alloc(0))
    ),
    delegatedSignerEntry(smartAccount, digest),
  ]

  const authed = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: token,
        function: 'transfer',
        args,
        auth: entries,
      })
    )
    .setTimeout(TIMEOUT)
    .build()

  const sim2 = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2)) {
    const text = String(sim2.error)
    // Report the CODE. #3221 is the rolling total refusing; #100 is the
    // per-call bound; they mean different things about which policy acted.
    const code = text.match(/Error\(Contract, #(\d+)\)/)?.[1]
    if (code === String(SPENDING_LIMIT_EXCEEDED)) {
      log('REFUSED', `the account refused the payment - #${code} SpendingLimitExceeded`)
      log('REFUSED', 'the allowance for this window is already spent')
      return
    }
    log('REFUSED', `refused with ${code ? `#${code}` : 'no contract code'}`)
    log('DETAIL', text.slice(0, 300))
    return
  }

  const prepared = rpc.assembleTransaction(authed, sim2).build()
  prepared.sign(kp)
  const res = await submit(prepared)
  log('PERMITTED', `the payment went through - tx ${res.txHash}`)
  log('PERMITTED', `${Number(amount) / 1e7} moved`)
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'provision') return provision()
  if (mode === 'send') return send()
  throw new Error('usage: transfer-through-account.ts provision|send')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
