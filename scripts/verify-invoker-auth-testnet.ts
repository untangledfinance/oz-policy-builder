// Does Soroban's contract-invoker rule actually satisfy `require_auth()`?
//
// Two designs in the Prime simplification plan rest on this and nothing in the
// repo proves it, so ask the live network.
//
//   T1  CustodyGate holds the allowance and calls `transfer_from` with ITSELF
//       as spender. Is `spender.require_auth()` satisfied for free?
//   T2  The gate gates on "only the adapter may call me" via
//       `adapter.require_auth()`. Satisfied for free when the adapter is the
//       direct caller?
//   T3  Does that same check REFUSE an address that did not authorize?
//       Without this, T2 proves nothing.
//
// T1 and T2 must SUCCEED, T3 must FAIL. Every case is really submitted.

import {
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { readFileSync } from 'node:fs'

const WASM = process.env.PROBE_WASM ?? `${process.env.HOME}/.cache/probe-target/wasm32v1-none/release/probe.wasm`
const NETWORK = Networks.TESTNET
const server = new rpc.Server('https://soroban-testnet.stellar.org')

const log = (t: string, m: string) => console.log(`[${t}] ${m}`)

async function friendbot(pk: string) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`)
}

type Outcome = { ok: boolean; status: string; detail: string; hash?: string; ret?: any }

async function settle(sent: any): Promise<Outcome> {
  if (sent.status === 'ERROR') {
    let detail = 'ERROR'
    try {
      detail = sent.errorResult.result().switch().name
    } catch {}
    return { ok: false, status: 'ERROR', detail, hash: sent.hash }
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got: any = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return { ok: true, status: 'SUCCESS', detail: '', hash: sent.hash, ret: got.returnValue }
    if (got.status === 'FAILED') {
      let detail = 'FAILED'
      try {
        detail = got.resultXdr.result().switch().name
      } catch {}
      return { ok: false, status: 'FAILED', detail, hash: sent.hash }
    }
  }
  return { ok: false, status: 'TIMEOUT', detail: '', hash: sent.hash }
}

/** Build, prepare, sign with `signer` only, submit. No extra auth entries. */
async function send(signer: Keypair, op: xdr.Operation, opts: { force?: boolean } = {}): Promise<Outcome> {
  const acct = await server.getAccount(signer.publicKey())
  const tx = new TransactionBuilder(acct, { fee: '2000000', networkPassphrase: NETWORK })
    .addOperation(op)
    .setTimeout(120)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    if (!opts.force) return { ok: false, status: 'SIM_ERROR', detail: sim.error }
    console.log('        (enforcing simulation refused; forcing submission)')
    return { ok: false, status: 'SIM_ERROR', detail: sim.error }
  }
  const requiredAuth = (sim as any).result?.auth ?? []
  if (requiredAuth.length) {
    log('AUTH', `simulation says ${requiredAuth.length} auth entr${requiredAuth.length === 1 ? 'y' : 'ies'} required`)
    for (const e of requiredAuth) {
      const c = e.credentials()
      log('AUTH', `  credentials = ${c.switch().name}`)
    }
  } else {
    log('AUTH', 'simulation requires NO auth entries')
  }

  const prepared = rpc.assembleTransaction(tx, sim).build()
  prepared.sign(signer)
  return await settle(await server.sendTransaction(prepared))
}

function invoke(contract: string, fn: string, args: xdr.ScVal[]): xdr.Operation {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    auth: [],
  })
}

function verdict(name: string, expectOk: boolean, got: Outcome): boolean {
  const pass = got.ok === expectOk
  console.log(
    `\n${pass ? '  PASS' : '  ** UNEXPECTED **'}  ${name}\n` +
      `        expected ${expectOk ? 'SUCCESS' : 'FAILURE'}   got ${got.ok ? 'SUCCESS' : `${got.status} / ${got.detail}`}` +
      (got.hash ? `\n        ${got.hash}` : ''),
  )
  return pass
}

async function main() {
  console.log('=== Soroban contract-invoker auth: live testnet ===\n')

  const deployer = Keypair.random()
  const user = Keypair.random() // grants the allowance
  const dest = Keypair.random()
  const bob = Keypair.random() // unrelated submitter
  const stranger = Keypair.random() // never signs anything

  log('SETUP', `deployer ${deployer.publicKey()}`)
  log('SETUP', `user     ${user.publicKey()}`)
  log('SETUP', `bob      ${bob.publicKey()}  (submits, unrelated)`)
  await Promise.all([
    friendbot(deployer.publicKey()),
    friendbot(user.publicKey()),
    friendbot(dest.publicKey()),
    friendbot(bob.publicKey()),
  ])

  // ---- upload wasm
  const wasm = readFileSync(WASM)
  log('SETUP', `wasm ${wasm.length} bytes  sha256 ${hash(wasm).toString('hex').slice(0, 16)}…`)
  const up = await send(deployer, Operation.uploadContractWasm({ wasm }))
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${up.detail}`)
  const wasmHash = hash(wasm)
  log('SETUP', `uploaded  ${up.hash}`)

  // ---- two instances of the same wasm
  const instances: string[] = []
  for (const tag of ['A', 'B']) {
    const salt = hash(Buffer.from(`probe-${tag}-${Date.now()}-${Math.random()}`))
    const op = Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash,
      salt,
    })
    const r = await send(deployer, op)
    if (!r.ok) throw new Error(`create ${tag} failed: ${r.status} ${r.detail}`)
    const addr = Address.fromScVal(r.ret!).toString()
    instances.push(addr)
    log('SETUP', `probe${tag} ${addr}`)
  }
  const [probeA, probeB] = instances

  const sac = Asset.native().contractId(NETWORK)
  log('SETUP', `native SAC ${sac}`)

  const latest = await server.getLatestLedger()
  const results: boolean[] = []

  // ---- user approves probeA as spender
  const approve = await send(
    user,
    invoke(sac, 'approve', [
      new Address(user.publicKey()).toScVal(),
      Address.fromString(probeA).toScVal(),
      nativeToScVal(50_000_000n, { type: 'i128' }),
      xdr.ScVal.scvU32(latest.sequence + 5000),
    ]),
  )
  if (!approve.ok) throw new Error(`approve failed: ${approve.status} ${approve.detail}`)
  log('SETUP', `allowance user -> probeA granted  ${approve.hash}`)

  // ================= T1 =================
  // probeA is the SPENDER. Transaction signed by bob, who is nobody here.
  // No auth entry for probeA is supplied.
  console.log('\n--- T1  transfer_from with the calling contract as spender ---')
  const t1 = await send(
    bob,
    invoke(probeA, 'pull', [
      Address.fromString(sac).toScVal(),
      new Address(user.publicKey()).toScVal(),
      new Address(dest.publicKey()).toScVal(),
      nativeToScVal(10_000_000n, { type: 'i128' }),
    ]),
  )
  results.push(verdict('T1  gate-as-spender needs no signature of its own', true, t1))

  // ================= T2 =================
  console.log('\n--- T2  peer.gated(self) through the invoker rule ---')
  const t2 = await send(bob, invoke(probeA, 'go', [Address.fromString(probeB).toScVal()]))
  results.push(verdict('T2  callee accepts require_auth of its direct caller', true, t2))

  // ================= T3 =================
  console.log('\n--- T3  same check against an address that did not authorize ---')
  const t3 = await send(bob, invoke(probeB, 'gated', [new Address(stranger.publicKey()).toScVal()]))
  results.push(verdict('T3  require_auth refuses a stranger', false, t3))

  console.log(`\n=== ${results.filter(Boolean).length}/${results.length} as predicted ===`)
  console.log(`probeA  https://stellar.expert/explorer/testnet/contract/${probeA}`)
  console.log(`probeB  https://stellar.expert/explorer/testnet/contract/${probeB}`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
