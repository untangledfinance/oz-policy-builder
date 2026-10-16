// Deploy a fresh grammar-7 interpreter on TESTNET with its deploy-time limits, read them back,
// and record it in deployments/grammar7-testnet.json. TESTNET only: the passphrase and the RPC
// are fixed here, and nothing else is deployed or touched.
//
//   bun scripts/deploy-grammar7-limits-testnet.ts <stellar identity> [--dry]
//
// The secret is read from the stellar CLI and never printed. The wasm is the reproducible
// `build-wasm.sh` output (build it on Linux: CI compares a Linux build). Before the real
// deployment it simulates two constructors that must fail (a limit of 0 and one above its
// ceiling) and requires `Error(Contract, #220)`: the ceilings are the contract's, not this script's.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  Address,
  Contract,
  hash,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { toScVal } from '../packages/policy-synth/src/wire.ts'

const LIMITS = {
  max_reads: 8,
  max_leaves: 400,
  max_predicate_bytes: 48 * 1024,
  max_elems: 32,
  max_in_operands: 32,
  max_depth: 5,
}
const RECORD = 'deployments/grammar7-testnet.json'
const identity = process.argv[2]
if (!identity)
  throw new Error('usage: deploy-grammar7-limits-testnet.ts <stellar identity> [--dry]')
const dry = process.argv.includes('--dry')
const kp = Keypair.fromSecret(execFileSync('stellar', ['keys', 'show', identity]).toString().trim())
const server = new rpc.Server(
  process.env.POLICY_BUILDER_RPC_URL_TESTNET ?? 'https://soroban-testnet.stellar.org'
)
const FEE = '6000000'

const limitsVal = (l: Record<string, number>) => toScVal({ map: Object.entries(l) })
const wasmFile = `${process.env.CARGO_TARGET_DIR ?? 'contracts/prime/stellar/policy-interpreter/target'}/wasm32v1-none/release/policy_interpreter.wasm`

async function settle(hashHex: string, label: string) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const got = await server.getTransaction(hashHex)
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return got
    if (got.status === rpc.Api.GetTransactionStatus.FAILED)
      throw new Error(`${label}: ${hashHex} FAILED`)
  }
  throw new Error(`${label}: ${hashHex} did not confirm`)
}
async function send(op: xdr.Operation, label: string) {
  const src = await server.getAccount(kp.publicKey())
  const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(120)
    .build()
  const prepared = await server.prepareTransaction(tx)
  prepared.sign(kp)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error(`${label}: ${sent.errorResult?.toXDR('base64')}`)
  return settle(sent.hash, label)
}

execFileSync('contracts/prime/stellar/policy-interpreter/build-wasm.sh', { stdio: 'inherit' })
const wasm = readFileSync(wasmFile)
const wasmSha = hash(wasm).toString('hex')
console.log(`wasm ${wasm.length} B sha256 ${wasmSha}`)

const salt = hash(Buffer.from('untangled.policy-interpreter.grammar7.limits'))
const create = (l: Record<string, number>) =>
  Operation.createCustomContract({
    address: Address.fromString(kp.publicKey()),
    wasmHash: Buffer.from(wasmSha, 'hex'),
    salt,
    constructorArgs: [limitsVal(l)],
  })

if (dry) {
  console.log('dry run: nothing is sent')
  process.exit(0)
}
const uploaded = await send(Operation.uploadContractWasm({ wasm }), 'upload')
console.log(`uploaded ${uploaded.txHash}`)

// The constructor refuses a limit of 0 and one above its ceiling, before anything is deployed.
for (const bad of [
  { ...LIMITS, max_reads: 0 },
  { ...LIMITS, max_reads: 9 },
  { ...LIMITS, max_predicate_bytes: 48 * 1024 + 1 },
]) {
  const tx = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(create(bad))
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (!rpc.Api.isSimulationError(sim) || !sim.error.includes('Error(Contract, #220)'))
    throw new Error(
      `a constructor with ${JSON.stringify(bad)} was not refused with #220: ${JSON.stringify(sim).slice(0, 300)}`
    )
  console.log(`refused as it must be: ${JSON.stringify(bad)}`)
}

const created = await send(create(LIMITS), 'create')
if (!created.returnValue) throw new Error('create: no contract address returned')
const interpreter = Address.fromScVal(created.returnValue).toString()
console.log(`created ${interpreter}`)

const ask = async (fn: string) => {
  const tx = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(interpreter).call(fn))
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error(`${fn}: no answer`)
  return scValToNative(sim.result.retval)
}
const [grammar, limits] = [await ask('grammar_version'), await ask('limits')]
if (grammar !== 7) throw new Error(`grammar_version() = ${grammar}`)
if (JSON.stringify(Object.entries(limits).sort()) !== JSON.stringify(Object.entries(LIMITS).sort()))
  throw new Error(`limits() = ${JSON.stringify(limits)}, deployed with ${JSON.stringify(LIMITS)}`)
const instance = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: Address.fromString(interpreter).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  })
)
const onChain = (await server.getLedgerEntries(instance)).entries[0]?.val
  .contractData()
  .val()
  .instance()
  .executable()
  .wasmHash()
  .toString('hex')
if (onChain !== wasmSha) throw new Error(`on-chain code ${onChain} != uploaded ${wasmSha}`)
console.log(
  `verified: grammar_version() = ${grammar}, limits() = ${JSON.stringify(limits)}, code ${onChain}`
)

const rec = JSON.parse(readFileSync(RECORD, 'utf8'))
const old = {
  interpreter: rec.interpreter,
  wasmSha256: rec.wasmHashes.interpreter,
  status: 'superseded',
  uploadTx: rec.uploadTx.interpreter,
  createTx: rec.createTx,
  commit: rec.interpreterSource.commit,
}
const next = {
  ...rec,
  recorded: new Date().toISOString(),
  interpreter,
  wasmHashes: { interpreter: wasmSha },
  interpreterSource: {
    ...rec.interpreterSource,
    commit: execFileSync('git', [
      'log',
      '-1',
      '--format=%h',
      '--',
      'contracts/prime/stellar/policy-interpreter/src',
      'contracts/prime/stellar/policy-interpreter/Cargo.toml',
      'contracts/prime/stellar/policy-interpreter/Cargo.lock',
      'contracts/prime/stellar/policy-interpreter/build-wasm.sh',
    ])
      .toString()
      .trim(),
    reproducibleWasmSha256: wasmSha,
  },
  limits,
  uploadTx: { interpreter: uploaded.txHash },
  createTx: created.txHash,
  sizes: { interpreter: wasm.length },
  superseded: [old, ...(rec.superseded ?? [])],
}
writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`)
console.log(`recorded in ${RECORD}`)
