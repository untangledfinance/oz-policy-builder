/**
 * PUBLIC deployment of the reviewed scoped execution artifacts.
 * Default is read-only. See docs/scoped-mainnet-deployment.md before --execute.
 * CLI signs via the existing mainnet_deployer identity; no secret enters JS.
 */
import {
  Address, Contract, Keypair, Networks, Operation, StrKey, TransactionBuilder,
  hash, rpc, scValToNative, xdr, type Transaction,
} from '@stellar/stellar-sdk'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const RPC = 'https://mainnet.sorobanrpc.com'
const HORIZON = 'https://horizon.stellar.org'
const IDENTITY = 'mainnet_deployer'
const SOURCE = 'GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN'
const INTERPRETER_HASH = '67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a'
const ADAPTER_HASH = '719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c'
const SALT_TEXT = `prime-policy-interpreter:v6:${INTERPRETER_HASH}`
const SALT = hash(Buffer.from(SALT_TEXT))
// PUBLIC fee statistics showed a 200-stroop inclusion market; keep a bounded margin.
const INCLUSION_FEE = 1000n
const args = process.argv.slice(2)
const execute = args.includes('--execute')
const value = (flag: string, fallback?: string) => {
  const i = args.indexOf(flag)
  if (i < 0) return fallback
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${flag} value`)
  return args[i + 1]
}
const allowed = new Set(['--execute', '--fee-cap-xlm', '--instance-budget-xlm', '--artifact-dir', '--receipt'])
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i]!)) throw new Error(`Unknown argument ${args[i]}`)
  if (args[i] !== '--execute') i++
}
function stroops(text: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(text)) throw new Error('XLM amounts need nonnegative decimal with <=7 decimals')
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
}
function xlm(n: bigint): string {
  return `${n / 10_000_000n}.${(n % 10_000_000n).toString().padStart(7, '0')}`
}
const capText = value('--fee-cap-xlm')
if (execute && !capText) throw new Error('--execute requires explicit --fee-cap-xlm')
const cap = stroops(capText ?? '120')
const instanceBudget = stroops(value('--instance-budget-xlm', '5')!)
if (cap <= 0n || instanceBudget <= 0n) throw new Error('Fee cap and instance budget must be positive')
const artifactDir = resolve(value('--artifact-dir', '/home/ubuntu/work/prime-scoped-target/wasm32v1-none/release')!)
const receiptPath = resolve(value('--receipt', 'docs/audit/evidence/scoped-mainnet-deployment.json')!)
const server = new rpc.Server(RPC)
const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
  networkId: hash(Buffer.from(Networks.PUBLIC)),
  contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({ address: new Address(SOURCE).toScAddress(), salt: SALT }),
  ),
}))
const interpreter = StrKey.encodeContract(hash(preimage.toXDR()))
const artifacts = [
  { name: 'interpreter', hash: INTERPRETER_HASH, file: 'policy_interpreter.wasm' },
  { name: 'adapter', hash: ADAPTER_HASH, file: 'execution_adapter.wasm' },
].map(a => {
  const wasm = readFileSync(resolve(artifactDir, a.file))
  if (hash(wasm).toString('hex') !== a.hash) throw new Error(`Artifact hash mismatch: ${a.file}`)
  return { ...a, wasm }
})
const cliAddress = spawnSync('stellar', ['keys', 'address', IDENTITY], { encoding: 'utf8' })
if (cliAddress.status !== 0 || cliAddress.stdout.trim() !== SOURCE) throw new Error('Stellar CLI deployment identity does not match pinned public key')
const network = await server.getNetwork()
if (network.passphrase !== Networks.PUBLIC) throw new Error('RPC is not PUBLIC')
let spent = 0n
const receipt: any = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : {
  networkPassphrase: Networks.PUBLIC, rpc: RPC, deployer: SOURCE, interpreter,
  interpreterWasmHash: INTERPRETER_HASH, adapterWasmHash: ADAPTER_HASH,
  saltText: SALT_TEXT, saltHex: SALT.toString('hex'), transactions: [],
}
if (receipt.networkPassphrase !== Networks.PUBLIC || receipt.deployer !== SOURCE ||
    receipt.interpreter !== interpreter || receipt.interpreterWasmHash !== INTERPRETER_HASH ||
    receipt.adapterWasmHash !== ADAPTER_HASH) throw new Error('Receipt belongs to a different deployment')
function save() {
  mkdirSync(dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
}
async function json(url: string): Promise<any> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Public Horizon read failed: ${r.status}`)
  return r.json()
}
async function funds() {
  const [a, ledgers] = await Promise.all([
    json(`${HORIZON}/accounts/${SOURCE}`), json(`${HORIZON}/ledgers?order=desc&limit=1`),
  ])
  const b = a.balances.find((v: any) => v.asset_type === 'native')
  const reserve = BigInt(ledgers._embedded.records[0].base_reserve_in_stroops) *
    BigInt(2 + a.subentry_count + a.num_sponsoring - a.num_sponsored)
  return { balance: stroops(b.balance), reserve, available: stroops(b.balance) - reserve - stroops(b.selling_liabilities) }
}
async function codePresent(wasmHash: string) {
  const r = await server.getLedgerEntries(xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'hex') }),
  ))
  return r.entries.length === 1
}
async function instancePresent() {
  const r = await server.getLedgerEntries(new Contract(interpreter).getFootprint())
  if (!r.entries.length) return false
  const executable = r.entries[0]!.val.contractData().val().instance().executable()
  if (executable.switch().name !== 'contractExecutableWasm' ||
      executable.wasmHash().toString('hex') !== INTERPRETER_HASH) throw new Error('Interpreter address contains different code')
  return true
}
async function simulate(op: xdr.Operation) {
  const raw = new TransactionBuilder(await server.getAccount(SOURCE), {
    fee: INCLUSION_FEE.toString(), networkPassphrase: Networks.PUBLIC,
  }).addOperation(op).setTimeout(180).build()
  const sim = await server.simulateTransaction(raw)
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`Simulation failed: ${'error' in sim ? sim.error : 'unexpected response'}`)
  if ('restorePreamble' in sim && sim.restorePreamble) throw new Error('Archived footprint requires separately reviewed restoration')
  const resourceFee = BigInt(sim.minResourceFee)
  if (BigInt(sim.transactionData.build().resourceFee().toString()) !== resourceFee) throw new Error('RPC resource fee fields differ')
  // stellar-base 14.1.0 adds sorobanData.resourceFee in build(). Pass inclusion ONLY.
  const builder = TransactionBuilder.cloneFrom(raw, {
    fee: INCLUSION_FEE.toString(), sorobanData: sim.transactionData.build(), networkPassphrase: Networks.PUBLIC,
  })
  const invoke = raw.operations[0]!
  if (invoke.type === 'invokeHostFunction') {
    builder.clearOperations().addOperation(Operation.invokeHostFunction({
      source: invoke.source, func: invoke.func, auth: invoke.auth?.length ? invoke.auth : (sim.result?.auth ?? []),
    }))
  }
  const tx = builder.build()
  if (BigInt(tx.fee) !== resourceFee + INCLUSION_FEE) throw new Error('Fee construction changed; refusing double resource fees')
  return { tx, fee: BigInt(tx.fee), ledger: sim.latestLedger }
}
async function waitFor(hashHex: string) {
  for (let i = 0; i < 45; i++) {
    const result = await server.getTransaction(hashHex)
    if (result.status === 'SUCCESS' || result.status === 'FAILED') return result
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`Transaction outcome pending: ${hashHex}; inspect this receipt before retrying`)
}
async function submit(label: string, prepared: Awaited<ReturnType<typeof simulate>>, itemBudget: bigint) {
  if (!execute) throw new Error('Submission requires --execute')
  if (prepared.fee > itemBudget || spent + prepared.fee > cap) throw new Error(`Fee cap rejected ${label}`)
  if ((await funds()).available < cap - spent) throw new Error('Insufficient reserve-adjusted funds for remaining full fee cap')
  const signer = spawnSync('stellar', [
    'tx', 'sign', '--sign-with-key', IDENTITY, '--rpc-url', RPC,
    '--network-passphrase', Networks.PUBLIC,
  ], { input: prepared.tx.toXDR(), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (signer.status !== 0) throw new Error('Stellar CLI signing failed; no transaction sent')
  const signed = TransactionBuilder.fromXDR(signer.stdout.trim(), Networks.PUBLIC) as Transaction
  if (!signed.hash().equals(prepared.tx.hash()) ||
      !signed.signatures.some(s => Keypair.fromPublicKey(SOURCE).verify(signed.hash(), s.signature()))) {
    throw new Error('CLI signed transaction does not match reviewed envelope/source')
  }
  const txHash = signed.hash().toString('hex')
  const item: any = { label, hash: txHash, declaredFeeStroops: prepared.fee.toString(), simulationLedger: prepared.ledger, status: 'READY', sourceSequence: prepared.tx.sequence, maxTime: prepared.tx.timeBounds?.maxTime, unsignedEnvelopeXdr: prepared.tx.toXDR(), createdAt: new Date().toISOString() }
  receipt.transactions.push(item)
  save() // Public hash persisted before broadcast; no signatures/private data stored.
  const sent = await server.sendTransaction(signed)
  item.status = sent.status
  save()
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') throw new Error(`RPC rejected ${label}: ${sent.status}; hash ${txHash}`)
  const result = await waitFor(txHash)
  item.status = result.status
  item.ledger = result.ledger
  if ('resultXdr' in result && result.resultXdr) item.chargedFeeStroops = result.resultXdr.feeCharged().toString()
  save()
  if (result.status !== 'SUCCESS') throw new Error(`Transaction failed: ${txHash}`)
  spent += prepared.fee
  console.log(JSON.stringify(item))
}
if (new Set(receipt.transactions.map((t: any) => t.hash)).size !== receipt.transactions.length) throw new Error('Duplicate receipt transaction hashes')
// A prior ambiguous broadcast must be resolved before any new transaction.
for (const prior of receipt.transactions) {
  if (['SUCCESS', 'FAILED', 'ERROR', 'EXPIRED'].includes(prior.status)) continue
  const result = await server.getTransaction(prior.hash)
  if (result.status !== 'SUCCESS' && result.status !== 'FAILED') throw new Error(`Unresolved prior receipt ${prior.hash}; inspect before retry`)
  prior.status = result.status
  prior.ledger = result.ledger
  if ('resultXdr' in result && result.resultXdr) prior.chargedFeeStroops = result.resultXdr.feeCharged().toString()
  if (execute) save()
}
// A resumed deployment retains its original cumulative cap. Declared fees
// conservatively cover both successful and included failed transactions.
spent = receipt.transactions.filter((t: any) => t.status === 'SUCCESS' || t.status === 'FAILED')
  .reduce((sum: bigint, t: any) => sum + BigInt(t.declaredFeeStroops), 0n)
if (spent > cap) throw new Error('Prior transactions already exceed this fee cap')
const missing = []
let uploadTotal = 0n
for (const artifact of artifacts) {
  if (await codePresent(artifact.hash)) continue
  const estimate = await simulate(Operation.uploadContractWasm({ wasm: artifact.wasm }))
  uploadTotal += estimate.fee
  missing.push({ artifact, fee: estimate.fee })
}
const hasInstance = await instancePresent()
const create = () => Operation.createCustomContract({
  address: new Address(SOURCE), wasmHash: Buffer.from(INTERPRETER_HASH, 'hex'), salt: SALT, constructorArgs: [],
})
let instanceEstimate: Awaited<ReturnType<typeof simulate>> | undefined
if (!hasInstance && !missing.some(a => a.artifact.name === 'interpreter')) instanceEstimate = await simulate(create())
if (instanceEstimate && instanceEstimate.fee > instanceBudget) throw new Error('Simulated instance fee exceeds instance budget')
const budget = uploadTotal + (hasInstance ? 0n : instanceBudget)
const balance = await funds()
console.log(JSON.stringify({
  mode: execute ? 'execute' : 'read-only', deployer: SOURCE, interpreter, interpreterDeployed: hasInstance,
  saltText: SALT_TEXT, saltHex: SALT.toString('hex'), missingWasmHashes: missing.map(a => a.artifact.hash),
  uploadFeesXlm: xlm(uploadTotal), instanceFeeXlm: instanceEstimate ? xlm(instanceEstimate.fee) : null,
  instanceBudgetXlm: hasInstance ? '0' : xlm(instanceBudget), requiredBudgetXlm: xlm(budget),
  feeCapXlm: xlm(cap), balanceXlm: xlm(balance.balance), reserveXlm: xlm(balance.reserve),
  availableXlm: xlm(balance.available), priorDeclaredFeesXlm: xlm(spent), remainingFeeCapXlm: xlm(cap - spent),
  executionFundingShortfallXlm: xlm(cap - spent > balance.available ? cap - spent - balance.available : 0n),
}, null, 2))
if (spent + budget > cap) throw new Error('Prior fees plus projected uploads and bounded instance budget exceed total fee cap')
if (!execute) process.exit(0)
if ((missing.length || !hasInstance) && balance.available < cap - spent) throw new Error('No writes: fund full fee cap above reserve before starting')
for (const { artifact } of missing) {
  if (await codePresent(artifact.hash)) continue
  const prepared = await simulate(Operation.uploadContractWasm({ wasm: artifact.wasm }))
  if (spent + prepared.fee + (hasInstance ? 0n : instanceBudget) > cap) throw new Error('Insufficient budget retained for interpreter instance')
  await submit(`upload ${artifact.name}`, prepared, cap - spent - (hasInstance ? 0n : instanceBudget))
  if (!(await codePresent(artifact.hash))) throw new Error('Uploaded WASM was not readable after success')
}
if (!(await instancePresent())) await submit('deploy interpreter v6', await simulate(create()), instanceBudget)
if (!(await instancePresent())) throw new Error('Interpreter deployment verification failed')
const versionSim = await server.simulateTransaction(
  new TransactionBuilder(await server.getAccount(SOURCE), { fee: '100', networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(interpreter).call('grammar_version')).setTimeout(60).build(),
)
if (!rpc.Api.isSimulationSuccess(versionSim) || !versionSim.result || scValToNative(versionSim.result.retval) !== 6) {
  throw new Error('Deployed interpreter did not report grammar version 6')
}
receipt.verifiedAt = new Date().toISOString()
receipt.grammarVersion = 6
receipt.adapterCodePresent = await codePresent(ADAPTER_HASH)
if (!receipt.adapterCodePresent) throw new Error('Adapter code verification failed')
save()
console.log(JSON.stringify({ verified: true, interpreter, interpreterWasmHash: INTERPRETER_HASH, adapterWasmHash: ADAPTER_HASH, receiptPath }))
