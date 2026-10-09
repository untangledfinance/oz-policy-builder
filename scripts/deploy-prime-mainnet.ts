// Put the Prime custody contracts on MAINNET: upload the custody gate and the
// execution adapter builds, upload the grammar-6 policy interpreter and create
// its shared instance, then extend the code the Prime app depends on.
//
//   contracts/prime/stellar/custody-gate/build-wasm.sh
//   contracts/prime/stellar/execution-adapter/build-wasm.sh
//   contracts/prime/stellar/policy-interpreter/build-wasm.sh
//   bun scripts/deploy-prime-mainnet.ts                          # dry run
//   bun scripts/deploy-prime-mainnet.ts --execute --fee-cap-xlm 140
//   bun scripts/deploy-prime-mainnet.ts --execute --extend --fee-cap-xlm 220
//
// --extend also pays rent to keep the three uploads, the OZ account code and the
// interpreter instance live for close to the network maximum (~180 days). Without
// it the uploads live for the network minimum (~120 days) and the keep-alive job
// has to extend them.
// DRY RUN BY DEFAULT. It checks every artifact against the hash the app pins,
// reads what mainnet already holds, simulates each transaction it would send
// and prints the plan and the fees. Nothing is signed. --execute sends, and
// refuses without --fee-cap-xlm; it stops before any transaction that would
// take the total over the cap.
//
// The deployer secret is read from DEPLOY_SECRET, or from
// MAINNET_DEPLOYER_SECRET in the file named by --env-file. It is never printed.
//
// Build on Linux (each build-wasm.sh says why): only a Linux build matches the
// hashes below, which CI rebuilds from source.
//
// The deployer keeps no power over anything this creates. The gate has no
// admin and no upgrade; each custody account deploys its own gate and each
// Prime its own adapter, from the uploaded code. The interpreter has no admin
// and no upgrade; the admins it knows are per-account policy admins.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Account,
  Address,
  Contract,
  hash,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  StrKey,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

// --network testnet rehearses the same steps on testnet, recording to
// deployments/prime-testnet-rehearsal.json instead.
const NETWORK =
  process.argv.includes('--network') &&
  process.argv[process.argv.indexOf('--network') + 1] === 'testnet'
    ? 'testnet'
    : 'mainnet'
const PASSPHRASE = NETWORK === 'testnet' ? Networks.TESTNET : Networks.PUBLIC
const RPC_URL =
  NETWORK === 'testnet' ? 'https://soroban-testnet.stellar.org' : 'https://mainnet.sorobanrpc.com'
const HORIZON_URL =
  NETWORK === 'testnet' ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org'
const HOME = join(import.meta.dir, '..')
const server = new rpc.Server(RPC_URL)

/** The builds the Prime app pins (gate, adapter) and CI rebuilds (all three). */
const ARTIFACTS = {
  'custody-gate': {
    file: 'contracts/prime/stellar/custody-gate/target/wasm32v1-none/release/custody_gate.wasm',
    sha256: 'b01024f31a24108f47b57fec3bfe40efa86ec002ddbe2d8445adbacb7f09fbab',
  },
  'execution-adapter': {
    file: 'contracts/prime/stellar/execution-adapter/target/wasm32v1-none/release/execution_adapter.wasm',
    sha256: '68d012e79fd4f9b88584447cfb32e0b0dbb55fb8bcd084b7212bad3e63b6dfdd',
  },
  'policy-interpreter': {
    file: 'contracts/prime/stellar/policy-interpreter/target/wasm32v1-none/release/policy_interpreter.wasm',
    sha256: '5143e64159378c9aac27e8cf1c9cb1f14364672885c151ccc5d887109f776126',
  },
} as const

/** Already on mainnet and used by every new Prime account; only extended here. */
const OZ_ACCOUNT_WASM = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

/** Same salt text as testnet, so the instance address follows from the deployer. */
const INTERPRETER_SALT = hash(Buffer.from('untangled.policy-interpreter.grammar6'))

/** Inclusion-fee bid in stroops. The network charges the clearing price, not the bid. */
const INCLUSION_BID = '200000'

/** How far to extend code and the interpreter instance: just under the network maximum. */
const TTL_MARGIN = 1_000

const has = (flag: string) => process.argv.includes(`--${flag}`)
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const xlm = (stroops: bigint | number) => (Number(stroops) / 1e7).toFixed(7)
const log = (tag: string, msg: string) => console.log(`[${tag.padEnd(7)}] ${msg}`)

function loadSecret(): string {
  if (process.env.DEPLOY_SECRET) return process.env.DEPLOY_SECRET.trim()
  const file = arg('env-file')
  if (!file)
    throw new Error('set DEPLOY_SECRET or pass --env-file <path> holding MAINNET_DEPLOYER_SECRET')
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('MAINNET_DEPLOYER_SECRET='))
  if (!line) throw new Error(`${file} has no MAINNET_DEPLOYER_SECRET`)
  return line
    .slice('MAINNET_DEPLOYER_SECRET='.length)
    .trim()
    .replace(/^["']|["']$/g, '')
}

const codeKey = (sha: string) =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(sha, 'hex') }))

const instanceKey = (id: string) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )

async function liveUntil(key: xdr.LedgerKey): Promise<number | null> {
  const r = await server.getLedgerEntries(key)
  return r.entries[0]?.liveUntilLedgerSeq ?? null
}

/** The contract id a deployer gets for a salt, before it exists. */
function contractIdFor(deployer: string, salt: Buffer): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt,
        })
      ),
    })
  )
  return StrKey.encodeContract(hash(preimage.toXDR()))
}

interface Step {
  label: string
  op: () => xdr.Operation
  /** Extend-TTL operations carry their footprint in the transaction data. */
  readOnly?: xdr.LedgerKey[]
  /** Needs an earlier step on chain first, so a dry run cannot simulate it. */
  dependsOnEarlier?: boolean
}

async function build(source: Account, step: Step) {
  let b = new TransactionBuilder(source, { fee: INCLUSION_BID, networkPassphrase: PASSPHRASE })
    .addOperation(step.op())
    .setTimeout(180)
  if (step.readOnly)
    b = b.setSorobanData(new SorobanDataBuilder().setReadOnly(step.readOnly).build())
  return b.build()
}

async function main() {
  const execute = has('execute')
  const capXlm = arg('fee-cap-xlm')
  if (execute && !capXlm) throw new Error('--execute needs --fee-cap-xlm <XLM>')
  const capStroops = capXlm ? BigInt(Math.round(Number(capXlm) * 1e7)) : 0n

  // 1. Artifacts match the pins.
  const wasm: Record<string, Buffer> = {}
  for (const [name, a] of Object.entries(ARTIFACTS)) {
    const bytes = readFileSync(join(HOME, a.file))
    const got = hash(bytes).toString('hex')
    if (got !== a.sha256)
      throw new Error(
        `${name}: built ${got}, expected ${a.sha256}. Rebuild on Linux with build-wasm.sh.`
      )
    wasm[name] = bytes
    log('ARTIFACT', `${name.padEnd(18)} ${got}  ${bytes.length} B`)
  }

  // 2. Deployer, read from mainnet.
  const kp = Keypair.fromSecret(loadSecret())
  const deployer = kp.publicKey()
  const horizonAccount: any = await (await fetch(`${HORIZON_URL}/accounts/${deployer}`)).json()
  const native = horizonAccount.balances?.find((b: any) => b.asset_type === 'native')?.balance
  if (!native) throw new Error(`deployer ${deployer} not found on mainnet`)
  const balance = BigInt(Math.round(Number(native) * 1e7))
  log('DEPLOYER', `${deployer}  ${native} XLM on ${NETWORK}`)

  // 3. What mainnet already holds.
  const latest = (await server.getLatestLedger()).sequence
  const maxTtl = Number(
    ((await server.getNetwork()) as unknown as { maxEntryTtl?: number }).maxEntryTtl ?? 3_110_400
  )
  const extendTo = maxTtl - TTL_MARGIN
  const interpreter = contractIdFor(deployer, INTERPRETER_SALT)
  const present: Record<string, number | null> = {}
  for (const [name, a] of Object.entries(ARTIFACTS))
    present[name] = await liveUntil(codeKey(a.sha256))
  const ozLive = await liveUntil(codeKey(OZ_ACCOUNT_WASM))
  const interpreterLive = await liveUntil(instanceKey(interpreter))
  log(NETWORK.toUpperCase(), `ledger ${latest}, max entry TTL ${maxTtl}`)
  for (const [name, l] of Object.entries(present))
    log(
      NETWORK.toUpperCase(),
      `${name.padEnd(18)} code ${l ? `present, live until ${l}` : 'absent'}`
    )
  log(
    NETWORK.toUpperCase(),
    `OZ account code     ${ozLive ? `present, live until ${ozLive}` : 'ABSENT'}`
  )
  log(
    NETWORK.toUpperCase(),
    `interpreter         ${interpreter} ${interpreterLive ? `exists, live until ${interpreterLive}` : 'not created yet'}`
  )
  if (!ozLive)
    throw new Error(
      `the OZ account code is missing on ${NETWORK}; Prime accounts cannot be created`
    )

  if (interpreterLive) {
    const r = await server.getLedgerEntries(instanceKey(interpreter))
    const onChain = r.entries[0].val
      .contractData()
      .val()
      .instance()
      .executable()
      .wasmHash()
      .toString('hex')
    if (onChain !== ARTIFACTS['policy-interpreter'].sha256) {
      throw new Error(
        `interpreter ${interpreter} already exists with code ${onChain}; refusing to continue`
      )
    }
  }

  // 4. The plan.
  const steps: Step[] = []
  for (const [name] of Object.entries(ARTIFACTS)) {
    if (!present[name])
      steps.push({
        label: `upload ${name}`,
        op: () => Operation.uploadContractWasm({ wasm: wasm[name] }),
      })
  }
  if (!interpreterLive) {
    steps.push({
      label: 'create interpreter instance',
      op: () =>
        Operation.createCustomContract({
          address: Address.fromString(deployer),
          wasmHash: Buffer.from(ARTIFACTS['policy-interpreter'].sha256, 'hex'),
          salt: INTERPRETER_SALT,
        }),
      dependsOnEarlier: !present['policy-interpreter'],
    })
  }
  // One entry per transaction: rent for several large entries in one
  // transaction can pass the 32-bit fee field, and the cap is checked per step.
  const extendKeys: [string, xdr.LedgerKey][] = [
    ...Object.entries(ARTIFACTS).map(
      ([n, a]) => [`${n} code`, codeKey(a.sha256)] as [string, xdr.LedgerKey]
    ),
    ['OZ account code', codeKey(OZ_ACCOUNT_WASM)],
    ['interpreter instance', instanceKey(interpreter)],
  ]
  if (has('extend')) {
    const earlier = steps.length > 0
    for (const [name, key] of extendKeys) {
      steps.push({
        label: `extend ${name} to ~${extendTo} ledgers ahead`,
        op: () => Operation.extendFootprintTtl({ extendTo }),
        readOnly: [key],
        dependsOnEarlier: earlier,
      })
    }
  }

  // 5. Simulate what can be simulated now.
  let estimate = 0n
  const source = new Account(deployer, horizonAccount.sequence)
  console.log('')
  for (const step of steps) {
    if (step.dependsOnEarlier && !execute) {
      log('PLAN', `${step.label}: simulated during --execute, after the steps before it land`)
      continue
    }
    if (execute) break
    const tx = await build(source, step)
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim))
      throw new Error(`${step.label}: simulation failed: ${sim.error}`)
    const resourceFee = BigInt(sim.minResourceFee)
    estimate += resourceFee + BigInt(INCLUSION_BID)
    log(
      'PLAN',
      `${step.label}: resource fee ${xlm(resourceFee)} XLM (+ up to ${xlm(BigInt(INCLUSION_BID))} inclusion)`
    )
  }

  if (!execute) {
    console.log('')
    log(
      'DRY RUN',
      `simulated so far: up to ${xlm(estimate)} XLM; deployer holds ${xlm(balance)} XLM`
    )
    log('DRY RUN', 'nothing signed or sent. Re-run with --execute --fee-cap-xlm <XLM> to deploy.')
    return
  }

  // 6. Execute, one transaction at a time, re-reading the account each time.
  let spent = 0n
  const record: Record<string, unknown> = {}
  for (const step of steps) {
    const account = await server.getAccount(deployer)
    const prepared = await server.prepareTransaction(await build(account, step))
    const fee = BigInt(prepared.fee)
    if (spent + fee > capStroops) {
      throw new Error(
        `${step.label}: fee ${xlm(fee)} XLM would pass the cap (${xlm(spent)} spent of ${capXlm}); stopping`
      )
    }
    prepared.sign(kp)
    const sent = await server.sendTransaction(prepared)
    if (sent.status === 'ERROR')
      throw new Error(`${step.label}: ${sent.errorResult?.toXDR('base64')}`)
    const got = await server.pollTransaction(sent.hash, { attempts: 60 })
    if (got.status !== 'SUCCESS') throw new Error(`${step.label}: ${sent.hash} ${got.status}`)
    const charged = BigInt(
      (got as rpc.Api.GetSuccessfulTransactionResponse).resultXdr.feeCharged().toString()
    )
    spent += charged
    record[step.label] = sent.hash
    log('SENT', `${step.label}: ${sent.hash}  charged ${xlm(charged)} XLM (total ${xlm(spent)})`)
  }

  // 7. Read everything back.
  for (const [name, a] of Object.entries(ARTIFACTS)) {
    if (!(await liveUntil(codeKey(a.sha256))))
      throw new Error(`${name} code not found after deploy`)
  }
  const r = await server.getLedgerEntries(instanceKey(interpreter))
  const onChain = r.entries[0]?.val
    .contractData()
    .val()
    .instance()
    .executable()
    .wasmHash()
    .toString('hex')
  if (onChain !== ARTIFACTS['policy-interpreter'].sha256)
    throw new Error(`interpreter code ${onChain} != pin`)
  const probe = new TransactionBuilder(await server.getAccount(deployer), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(interpreter).call('grammar_version'))
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`grammar_version: ${sim.error}`)
  const grammar = Number(scValToNative(sim.result!.retval))
  if (grammar !== 6) throw new Error(`interpreter reports grammar ${grammar}, expected 6`)
  log('VERIFY', `interpreter ${interpreter}: grammar 6, code ${onChain}`)

  const out = {
    network: NETWORK,
    recorded: new Date().toISOString(),
    deployer,
    interpreter,
    interpreterSaltText: 'untangled.policy-interpreter.grammar6',
    wasmSha256: Object.fromEntries(Object.entries(ARTIFACTS).map(([k, a]) => [k, a.sha256])),
    sizes: Object.fromEntries(Object.entries(wasm).map(([k, v]) => [k, v.length])),
    transactions: record,
    feesChargedXlm: xlm(spent),
    note: 'Linux builds through each build-wasm.sh, rebuilt by CI. The Prime app pins the gate and adapter hashes and this interpreter instance for mainnet.',
  }
  const recordFile =
    NETWORK === 'testnet'
      ? 'deployments/prime-testnet-rehearsal.json'
      : 'deployments/prime-mainnet.json'
  writeFileSync(join(HOME, recordFile), `${JSON.stringify(out, null, 2)}\n`)
  log('DONE', `recorded ${recordFile}; fees ${xlm(spent)} XLM`)
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exit(1)
})
