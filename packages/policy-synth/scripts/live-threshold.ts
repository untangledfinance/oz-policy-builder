// Live, on TESTNET only, with throwaway keys: a rule this builder installs with `threshold`
// (2 of 2) on a real OpenZeppelin smart account, then the same transfer authorised by ONE
// signer (denied by the policy, #3202) and by BOTH (permitted, and sent).
//
//   bun scripts/live-threshold.ts            (POLICY_BUILDER_RPC_URL_TESTNET picks the endpoint)
//
// Nothing here is a secret: the keys are made for the run and funded by friendbot.
import { execFileSync } from 'node:child_process'
import {
  Address,
  authorizeEntry,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { connect } from '../src/chain.ts'
import { OZ_ACCOUNT_WASM, thresholdAddress } from '../src/config.ts'
import { digest } from '../src/install.ts'
import { readRules } from '../src/rules.ts'
import { run } from '../src/tools.ts'
import { toScVal } from '../src/wire.ts'

const NET = 'testnet' as const
const WASM = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' // the native asset
const INTERP = 'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV'
if (!OZ_ACCOUNT_WASM.has(WASM)) throw new Error('the account build is not one the package knows')

const server = connect({ network: NET })
const say = (tag: string, text: string) => console.log(`${tag.padEnd(6)} ${text}`)
const [A, B] = [Keypair.random(), Keypair.random()]

// Throwaway keys are funded by friendbot, or (it is flaky under load) by a testnet `stellar keys`
// identity named in LIVE_FUNDER: one createAccount for both.
async function fund(keys: Keypair[]) {
  if (process.env.LIVE_FUNDER) {
    const funder = Keypair.fromSecret(
      execFileSync('stellar', ['keys', 'show', process.env.LIVE_FUNDER]).toString().trim()
    )
    const tx = new TransactionBuilder(await server.getAccount(funder.publicKey()), {
      fee: '1000',
      networkPassphrase: Networks.TESTNET,
    })
    for (const k of keys)
      tx.addOperation(
        Operation.createAccount({ destination: k.publicKey(), startingBalance: '200' })
      )
    const built = tx.setTimeout(60).build()
    built.sign(funder)
    const sent = await server.sendTransaction(built)
    await server.pollTransaction(sent.hash, { attempts: 30 })
    return
  }
  for (const k of keys) {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${k.publicKey()}`)
    if (!r.ok)
      throw new Error(`friendbot ${r.status} (set LIVE_FUNDER to a funded testnet identity)`)
  }
}
async function send(tx: ReturnType<TransactionBuilder['build']>, signer: Keypair) {
  tx.sign(signer)
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') throw new Error(JSON.stringify(sent.errorResult))
  const done = await server.pollTransaction(sent.hash, { attempts: 40 })
  if (done.status !== 'SUCCESS') throw new Error(`${done.status} ${sent.hash}`)
  return { hash: sent.hash, done }
}
const build = async (op: xdr.Operation, source: Keypair) =>
  new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: '2000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(120)
    .build()
const call = (
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[] = []
) =>
  Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    auth,
  })

say(
  'INFO',
  `network ${NET}; threshold policy ${thresholdAddress(NET, false)}; interpreter ${INTERP}`
)
await fund([A, B])
say('PASS', `signer A ${A.publicKey()}, signer B ${B.publicKey()} (throwaway, funded)`)

// 1. an OZ smart account whose rule 0 is signer A.
const created = await server.prepareTransaction(
  await build(
    Operation.createCustomContract({
      address: new Address(A.publicKey()),
      wasmHash: Buffer.from(WASM, 'hex'),
      salt: Buffer.from(Keypair.random().rawPublicKey()),
      constructorArgs: [toScVal([['Delegated', A.publicKey()]]), xdr.ScVal.scvMap([])],
    }),
    A
  )
)
const made = await send(created, A)
const ACCOUNT = Address.fromScVal(made.done.returnValue as xdr.ScVal).toString()
say('PASS', `smart account ${ACCOUNT}`)

// 2. the funds to move (10 XLM) from A to the account.
const funding = await server.prepareTransaction(
  await build(
    call(SAC, 'transfer', [
      new Address(A.publicKey()).toScVal(),
      new Address(ACCOUNT).toScVal(),
      nativeToScVal(100_000_000n, { type: 'i128' }),
    ]),
    A
  )
)
await send(funding, A)
say('PASS', 'account funded with 10 XLM')

// 3. the rule, built by install_policy: transfers of the native asset out of the account, at most
//    0.01 XLM each, both signers required (threshold 2).
const installed = (await run('install_policy', {
  network: NET,
  smartAccount: ACCOUNT,
  sourceAccount: A.publicKey(),
  signers: [A.publicKey(), B.publicKey()],
  threshold: { simple: 2 },
  allowOverlap: true, // rule 0 has no policy and shares signer A: the test names the rule it wants
  intent: {
    calls: [
      {
        contract: SAC,
        fn: 'transfer',
        where: [
          { constraint: 'pin', at: [0], to: ACCOUNT },
          { constraint: 'cap', at: [2], max: '100000' },
        ],
      },
    ],
  },
})) as {
  ok: boolean
  data: { unsignedXdr: string; describes: { args: unknown[] } }
  error?: unknown
}
if (!installed.ok) throw new Error(JSON.stringify(installed.error))
await send(TransactionBuilder.fromXDR(installed.data.unsignedXdr, Networks.TESTNET) as never, A)
const { rules } = await readRules(server, NET, ACCOUNT, INTERP)
const rule = rules.find((r) => r.policies.includes(thresholdAddress(NET, false)))
if (!rule) throw new Error('the rule is not on the account')
say('PASS', `rule ${rule.id} installed: interpreter + simple_threshold(2), signers A + B`)

// 4. the same transfer, authorised by one signer and by both.
async function attempt(signers: Keypair[]) {
  const args = [
    new Address(ACCOUNT).toScVal(),
    new Address(A.publicKey()).toScVal(),
    nativeToScVal(10_000n, { type: 'i128' }),
  ]
  const recording = await server.simulateTransaction(await build(call(SAC, 'transfer', args), A))
  if (rpc.Api.isSimulationError(recording)) throw new Error(recording.error)
  const original = (recording.result?.auth ?? []).find(
    (e) =>
      e.credentials().switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(e.credentials().address().address()).toString() === ACCOUNT
  ) as xdr.SorobanAuthorizationEntry
  const until = recording.latestLedger + 300
  const creds = original.credentials().address()
  const ids = [rule?.id as number]
  const account = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: creds.address(),
        nonce: creds.nonce(),
        signatureExpirationLedger: until,
        signature: toScVal({
          map: [
            ['context_rule_ids', ids],
            [
              'signers',
              {
                map: signers.map(
                  (k) => [['Delegated', k.publicKey()], { bytes: '' }] as [never, never]
                ),
              },
            ],
          ],
        } as never),
      })
    ),
    rootInvocation: original.rootInvocation(),
  })
  const check = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(ACCOUNT).toScAddress(),
        functionName: '__check_auth',
        args: [
          xdr.ScVal.scvBytes(digest(NET, creds.nonce(), until, original.rootInvocation(), ids)),
        ],
      })
    ),
    subInvocations: [],
  })
  const forSigner = async (k: Keypair) =>
    k.publicKey() === A.publicKey()
      ? new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: check,
        })
      : authorizeEntry(
          new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
              new xdr.SorobanAddressCredentials({
                address: new Address(k.publicKey()).toScAddress(),
                nonce: xdr.Int64.fromString(String(Math.floor(Math.random() * 2 ** 52))),
                signatureExpirationLedger: until,
                signature: xdr.ScVal.scvVoid(),
              })
            ),
            rootInvocation: check,
          }),
          k,
          until,
          Networks.TESTNET
        )
  const auth = [account, ...(await Promise.all(signers.map(forSigner)))]
  const tx = await build(call(SAC, 'transfer', args, auth), A)
  return { tx, sim: await server.simulateTransaction(tx) }
}

const one = await attempt([A])
const denied = rpc.Api.isSimulationError(one.sim) ? one.sim.error : ''
if (!denied.includes('Error(Contract, #3202)'))
  throw new Error(`one signer was not refused by the threshold: ${denied || 'it passed'}`)
say('PASS', 'signer A alone DENIED #3202 (SimpleThresholdError::NotAllowed)')

const both = await attempt([A, B])
if (rpc.Api.isSimulationError(both.sim))
  throw new Error(`both signers were refused: ${both.sim.error}`)
const sent = await send(rpc.assembleTransaction(both.tx, both.sim).build(), A)
say('PASS', `signers A + B together PERMITTED, transfer sent ${sent.hash}`)
say('RESULT', '2-of-2 holds on a real OZ account: one signer denied #3202, two permitted.')
