// Pin a grammar-6 deployment on TESTNET so the app and SDK have a stable
// address to reference, instead of the throwaway one the e2e deploys per run.
//
// Uploads the interpreter, the adapter and the gate, creates the interpreter,
// and reads its grammar back from the chain before recording anything. Writes
// docs/grammar6-testnet-deployment.json.
//
//   bun scripts/deploy-grammar6-testnet.ts [--secret S...]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

// Artifacts come from each crate's own build output, so a fresh clone can run
// this after `cargo build --release --target wasm32v1-none` in contracts/*.
// The interpreter is the exception: it is rebuilt here through build-wasm.sh,
// because a bare cargo build bakes machine paths into the wasm and CI could not
// check the deployed hash against the source. Deploy from Linux: macOS builds
// different bytes from the same source, and CI compares a Linux build.
// PRIME_WASM_DIR overrides with a single directory holding all of them.
function wasmPath(crate: string, file: string): string {
  const override = process.env.PRIME_WASM_DIR
  const candidate = override
    ? `${override}/${file}.wasm`
    : `contracts/${crate}/target/wasm32v1-none/release/${file}.wasm`
  if (!existsSync(candidate)) {
    throw new Error(
      `missing ${file}.wasm at ${candidate}\n` +
        `Build it:  cargo build --release --target wasm32v1-none --manifest-path contracts/${crate}/Cargo.toml\n` +
        'or set PRIME_WASM_DIR to a directory holding the built artifacts.'
    )
  }
  return candidate
}

const PASSPHRASE = Networks.TESTNET
const FEE = '6000000'
const server = new rpc.Server('https://soroban-testnet.stellar.org')
const log = (t: string, m: string) => console.log(`[${t}] ${m}`)

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function settle(sent: any, label: string) {
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: ${JSON.stringify(sent.errorResult?.toXDR('base64'))}`)
  }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got: any = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') throw new Error(`${label}: tx ${sent.hash} FAILED`)
  }
  throw new Error(`${label}: ${sent.hash} did not confirm`)
}

async function send(kp: Keypair, op: xdr.Operation, label: string) {
  const src = await server.getAccount(kp.publicKey())
  const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build()
  const prepared = await server.prepareTransaction(tx)
  prepared.sign(kp)
  return settle(await server.sendTransaction(prepared), label)
}

async function main() {
  const secret = arg('secret') ?? process.env.DEPLOY_SECRET
  const kp = secret ? Keypair.fromSecret(secret) : Keypair.random()
  if (!secret) {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)
    if (!r.ok && r.status !== 400) throw new Error('friendbot failed')
  }
  log('DEPLOY', `deployer ${kp.publicKey()}`)

  if (!process.env.PRIME_WASM_DIR) {
    execFileSync('contracts/policy-interpreter/build-wasm.sh', { stdio: 'inherit' })
  }
  const artifacts = {
    interpreter: readFileSync(wasmPath('policy-interpreter', 'policy_interpreter')),
    adapter: readFileSync(wasmPath('execution-adapter', 'execution_adapter')),
    gate: readFileSync(wasmPath('custody-gate', 'custody_gate')),
  }
  const hashes: Record<string, string> = {}
  const uploads: Record<string, string> = {}
  for (const [name, wasm] of Object.entries(artifacts)) {
    const h = hash(wasm).toString('hex')
    hashes[name] = h
    const r = await send(kp, Operation.uploadContractWasm({ wasm }), `upload ${name}`)
    uploads[name] = r.txHash
    log('UPLOAD', `${name.padEnd(11)} ${String(wasm.length).padStart(6)} B  ${h}`)
  }

  const created = await send(
    kp,
    Operation.createCustomContract({
      address: Address.fromString(kp.publicKey()),
      wasmHash: Buffer.from(hashes.interpreter, 'hex'),
      salt: hash(Buffer.from('untangled.policy-interpreter.grammar6')),
    }),
    'create interpreter'
  )
  const interpreter = Address.fromScVal(created.returnValue!).toString()

  // Read the grammar back off the chain before recording it.
  const probe = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(interpreter).call('grammar_version'))
    .setTimeout(60)
    .build()
  const sim: any = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`grammar_version: ${sim.error}`)
  const grammar = Number(scValToNative(sim.result.retval))
  if (grammar !== 6) throw new Error(`deployed interpreter reports grammar ${grammar}, expected 6`)
  log('VERIFY', `interpreter ${interpreter}  grammar_version() = ${grammar}`)

  // Confirm the on-chain code hash is the artifact we uploaded.
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(interpreter).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
  const entries = await server.getLedgerEntries(instanceKey)
  const onChain = entries.entries[0]?.val
    ?.contractData()
    ?.val()
    ?.instance()
    ?.executable()
    ?.wasmHash()
    ?.toString('hex')
  if (onChain !== hashes.interpreter) {
    throw new Error(`on-chain code hash ${onChain} != uploaded ${hashes.interpreter}`)
  }
  log('VERIFY', `on-chain code hash matches the uploaded artifact`)

  const record = {
    network: 'testnet',
    recorded: new Date().toISOString(),
    deployer: kp.publicKey(),
    grammar: 6,
    adapterSaltText: 'prime.execution.adapter.v2',
    interpreter,
    wasmHashes: hashes,
    uploadTx: uploads,
    createTx: created.txHash,
    sizes: Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, v.length])),
    note:
      'Grammar 6 and the grants-as-data adapter. The adapter salt is v2 because ' +
      'a Prime that already activated v1 has a contract at the v1 address and a ' +
      'different code hash cannot take its place.',
  }
  writeFileSync('docs/grammar6-testnet-deployment.json', `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\n${JSON.stringify(record, null, 2)}`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
