// End-to-end proof against a REAL network.
//
// Deploys a fresh OZ smart account, installs an interpreter policy against the
// PINNED interpreter, then shows the same account permitting the call the
// predicate allows and denying the one it does not. Nothing here is mocked:
// every step is a submitted transaction, and the permit/deny verdicts come
// from the deployed contract.
//
// The permit/deny calls invoke the TOKEN directly, with the smart account as
// the authorising party. That matters: the policy is handed the call the
// account authorised, so calling the token makes `transfer` the authorised
// call. Routing through the account's own `execute` wrapper instead would
// present `execute` as the call, and a predicate pinning `transfer` would
// deny its own happy path.
//
// The predicate is `eq(call_fn, "transfer")`, so:
//   PERMIT  SAC.transfer(account, dest, amount)          -> succeeds
//   DENY    SAC.approve(account, spender, amount, exp)    -> interpreter #100
//
// Usage:
//   bun packages/policy-synth/scripts/e2e-network.ts --network testnet
//   bun packages/policy-synth/scripts/e2e-network.ts --network mainnet --secret S...
//
// Testnet funds itself through friendbot. Mainnet needs `--secret` (or
// E2E_SECRET) for an account that already holds XLM.

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
import { buildAddContextRuleArgs } from '../src/install/build-add-context-rule.ts'
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

/** sha256 of `multisig_account_example.wasm`, already uploaded to BOTH
 *  networks, so an account is created by deploy alone with no wasm upload. */
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

const FEE = '2000000'
const TIMEOUT = 120

type Net = 'testnet' | 'mainnet'

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
// mainnet.sorobanrpc.com times out on submit; the gateway.fm endpoint does not.
const RPC_URL =
  NETWORK === 'mainnet'
    ? 'https://soroban-rpc.mainnet.stellar.gateway.fm'
    : RPC_URL_BY_NETWORK[NETWORK]

const server = new rpc.Server(RPC_URL, { allowHttp: false })

function log(status: 'PASS' | 'FAIL' | 'INFO', message: string): void {
  console.log(`${status.padEnd(4)} ${message}`)
}

async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${address}`)
  if (!res.ok) throw new Error(`friendbot failed for ${address}: ${res.status}`)
}

/** Submit a signed transaction and poll to a final status. */
async function submit(tx: Transaction): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    throw new Error(`send failed: ${JSON.stringify(sent.errorResult?.toXDR('base64'))}`)
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

/** Invoke a function ON the smart account, authorised by one delegated signer
 *  through the OZ `AuthPayload` its `__check_auth` expects.
 *
 *  The host records the account's requirement during simulation but cannot
 *  produce the payload (it never runs `__check_auth` in recording mode), so
 *  the account's entry is rebuilt with the payload and the delegated signer's
 *  nested entry is constructed by hand. */
async function invokeAsAccount(opts: {
  kp: Keypair
  smartAccount: string
  /** Contract to invoke. Defaults to the smart account itself (install); for
   *  the permit/deny cases it is the token, so the authorised call the policy
   *  sees IS the token call rather than an `execute` wrapper around it. */
  contract?: string
  fnName: string
  args: xdr.ScVal[]
  contextRuleIds: number[]
}): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { kp, smartAccount, fnName, args, contextRuleIds } = opts
  const target = opts.contract ?? smartAccount
  const source = await server.getAccount(kp.publicKey())
  const op = new Contract(target).call(fnName, ...args)
  const built = new TransactionBuilder(source, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(TIMEOUT)
    .build()

  const sim = await server.simulateTransaction(built)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`)

  const latest = await server.getLatestLedger()
  const expLedger = latest.sequence + 100

  const recorded = sim.result?.auth ?? []
  const accountsOwn = recorded.find(
    (e) =>
      e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(e.credentials().address().address()).toString() === smartAccount
  )
  if (!accountsOwn)
    throw new Error('simulation recorded no address-credential entry for the account')

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
      // The signers-map bytes are ignored for a delegated signer: OZ
      // authenticates it through its own nested entry, not through these.
      authPayload([kp.publicKey()], contextRuleIds, () => Buffer.alloc(0))
    ),
    delegatedSignerEntry(smartAccount, digest),
  ]

  // Rebuild with the real auth, then assemble so the footprint and resource
  // fees are computed against the entries that will actually be submitted.
  const authed = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: target,
        function: fnName,
        args,
        auth: entries,
      })
    )
    .setTimeout(TIMEOUT)
    .build()

  const sim2 = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2))
    throw new Error(`authorised simulation failed: ${sim2.error}`)
  const prepared = rpc.assembleTransaction(authed, sim2).build()
  prepared.sign(kp)
  return submit(prepared)
}

async function main(): Promise<void> {
  log('INFO', `network        ${NETWORK}`)
  log('INFO', `interpreter    ${INTERPRETER}`)
  log('INFO', `grammar        ${PINNED_INTERPRETER_GRAMMAR_VERSION}`)
  log('INFO', `rpc            ${RPC_URL}`)

  // ---- 0. two signers, and the separation is the whole point ----
  // `kp` is the ADMIN: it owns rule 0, which the constructor creates with no
  // policy attached, so it can authorise anything. `agent` is the CONSTRAINED
  // key: it goes on the policed rule and NOWHERE ELSE.
  //
  // Putting both on the policed rule would make the deny meaningless. OZ takes
  // the authority of the rule the CALLER NAMES, not the strictest rule that
  // could apply, so a key sitting on both an unpoliced and a policed rule
  // simply names the unpoliced one and the predicate never runs. Verified on
  // testnet: the identical forbidden call is denied #100 naming the policed
  // rule and ALLOWED naming rule 0. The separation below is what makes
  // "this key can only transfer" a true statement rather than a scoped one.
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
  log('INFO', `admin  (rule 0) ${kp.publicKey()}`)
  log('INFO', `agent  (rule 1) ${agent.publicKey()}`)

  // ---- 1. deploy a fresh OZ smart account ----
  // Constructor: the initial signer set, and an empty policy map (policies are
  // installed against a rule that exists).
  const deploySource = await server.getAccount(kp.publicKey())
  const deployTx = new TransactionBuilder(deploySource, {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
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
  const deployPrepared = await server.prepareTransaction(deployTx)
  deployPrepared.sign(kp)
  const deployed = await submit(deployPrepared)
  const smartAccount = Address.fromScAddress(
    deployed.returnValue?.address() as xdr.ScAddress
  ).toString()
  log('PASS', `smart account deployed  ${smartAccount}`)

  // ---- 1b. the agent needs its own funded account ----
  // A delegated signer authenticates through source-account credentials here,
  // so it has to be the transaction source, which means it needs to exist and
  // hold a reserve.
  if (NETWORK === 'mainnet') {
    const createSrc = await server.getAccount(kp.publicKey())
    const createTx = new TransactionBuilder(createSrc, { fee: FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.createAccount({ destination: agent.publicKey(), startingBalance: '2' })
      )
      .setTimeout(TIMEOUT)
      .build()
    createTx.sign(kp)
    await submit(createTx)
  } else {
    await fundWithFriendbot(agent.publicKey())
  }
  log('PASS', 'agent account funded')

  // ---- 2. give the account something to move ----
  // A classic payment cannot target a contract address, so the XLM moves
  // through the native SAC's own `transfer`. The signer is the transaction
  // source, so its `require_auth` is carried by source-account credentials.
  const sac = Asset.native().contractId(PASSPHRASE)
  const stroops = NETWORK === 'mainnet' ? 50_000_000n : 1_000_000_000n
  const fundSource = await server.getAccount(kp.publicKey())
  const fundTx = new TransactionBuilder(fundSource, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(
      new Contract(sac).call(
        'transfer',
        Address.fromString(kp.publicKey()).toScVal(),
        Address.fromString(smartAccount).toScVal(),
        xdr.ScVal.scvI128(
          new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(stroops) })
        )
      )
    )
    .setTimeout(TIMEOUT)
    .build()
  const fundPrepared = await server.prepareTransaction(fundTx)
  fundPrepared.sign(kp)
  await submit(fundPrepared)
  log('PASS', `account funded with XLM (SAC ${sac})`)

  // ---- 3. install the policy: one add_context_rule call ----
  const predicate: PredicateNode = {
    op: 'eq',
    left: { kind: 'call_fn' },
    right: { kind: 'literal_symbol', value: 'transfer' },
  }
  const encoded = encodePredicate(predicate)
  log('INFO', `predicate hash ${encoded.predicateHash}`)

  const policyRef = {
    kind: 'interpreter',
    interpreterAddress: INTERPRETER,
    predicateBlobBase64: encoded.encodedPredicate,
  } as const
  // The AGENT is the only signer on the policed rule. The admin is not on it,
  // and the agent is not on rule 0, so neither key can borrow the other's
  // authority.
  const signers = [{ kind: 'delegated', address: agent.publicKey() }] as const
  const ruleArgs = buildAddContextRuleArgs(
    {
      contextRuleType: { kind: 'default' },
      name: 'e2e-transfer-only',
      validUntilLedger: null,
      signers: [...signers],
      policies: [policyRef],
    },
    {
      signers: [...signers],
      policies: [policyRef],
      installNonce: 1,
      encodedPredicate: encoded.encodedPredicate,
      predicateHash: encoded.predicateHash,
    }
  )
  const installed = await invokeAsAccount({
    kp,
    smartAccount,
    fnName: 'add_context_rule',
    args: [...ruleArgs],
    contextRuleIds: [0],
  })
  log('PASS', `policy installed against rule 1  (tx in ledger ${installed.ledger})`)

  // ---- 4. PERMIT: the call the predicate allows ----
  // The token calls `account.require_auth()`, so the call the policy is handed
  // is this `transfer` - which is what the predicate pins.
  const amount = xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(10_000_000) })
  )
  const permit = await invokeAsAccount({
    kp: agent,
    smartAccount,
    contract: sac,
    fnName: 'transfer',
    args: [
      Address.fromString(smartAccount).toScVal(),
      Address.fromString(kp.publicKey()).toScVal(),
      amount,
    ],
    contextRuleIds: [1],
  })
  log('PASS', `PERMIT transfer allowed by the interpreter (ledger ${permit.ledger})`)

  // ---- 5. DENY: the call it does not ----
  // The expiration ledger must be VALID or the token refuses `approve` on its
  // own terms and the policy is never consulted - a refusal that proves
  // nothing. It is set ahead of the current ledger so the ONLY thing left to
  // reject the call is the predicate.
  const denyLedger = (await server.getLatestLedger()).sequence + 1000
  const approveArgs = [
    Address.fromString(smartAccount).toScVal(),
    Address.fromString(kp.publicKey()).toScVal(),
    amount,
    xdr.ScVal.scvU32(denyLedger),
  ]
  const denied = await invokeAsAccount({
    kp: agent,
    smartAccount,
    contract: sac,
    fnName: 'approve',
    args: approveArgs,
    contextRuleIds: [1],
  }).then(
    () => ({ refused: false, why: '' }),
    (e: unknown) => ({ refused: true, why: e instanceof Error ? e.message : String(e) })
  )
  if (!denied.refused) {
    log('FAIL', 'DENY approve was ALLOWED - the predicate did not bind')
    process.exit(1)
  }
  // Refused is not enough: it has to be refused BY THE INTERPRETER. The
  // interpreter denies an argument mismatch with contract error #100, and the
  // trace names the interpreter contract. Anything else (a token-level
  // rejection, a fee problem) is a false pass.
  const byInterpreter = denied.why.includes(INTERPRETER)
  const argMismatch = /Error\(Contract, #100\)/.test(denied.why)
  if (!byInterpreter || !argMismatch) {
    log('FAIL', 'approve was refused, but NOT by the interpreter - this proves nothing')
    log('INFO', `interpreter named in trace: ${byInterpreter}; #100 ArgMismatch: ${argMismatch}`)
    console.log(denied.why.slice(0, 1500))
    process.exit(1)
  }
  log('PASS', 'DENY approve refused by the interpreter (#100 ArgMismatch)')

  // ---- 6. the deny has to be unroutable, not just correct ----
  // OZ takes the authority of the rule the CALLER NAMES. A key on both a
  // policed and an unpoliced rule therefore is not constrained at all: it
  // names the unpoliced one and the predicate never runs. The agent is on the
  // policed rule ONLY, so naming rule 0 must fail on MEMBERSHIP. Without this
  // step "the forbidden call was denied" would be a statement about one
  // routing choice rather than about the key.
  const bypass = await invokeAsAccount({
    kp: agent,
    smartAccount,
    contract: sac,
    fnName: 'approve',
    args: approveArgs,
    contextRuleIds: [0],
  }).then(
    () => ({ refused: false, why: '' }),
    (e: unknown) => ({ refused: true, why: e instanceof Error ? e.message : String(e) })
  )
  if (!bypass.refused) {
    log('FAIL', 'BYPASS the agent routed the forbidden call through unpoliced rule 0')
    process.exit(1)
  }
  log('PASS', 'BYPASS blocked: the agent is not a signer on unpoliced rule 0')

  console.log('')
  log('INFO', `smart account  ${smartAccount}`)
  log('INFO', `agent (constrained to transfer) ${agent.publicKey()}`)
  log('INFO', 'permit, deny and the unpoliced-rule bypass all proven on chain')
  log('INFO', 'the admin key retains full authority through rule 0, by design')
}

main().catch((e) => {
  log('FAIL', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
