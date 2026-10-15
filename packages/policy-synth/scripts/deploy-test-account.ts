// Deploys an OpenZeppelin smart account on TESTNET for the live install tests:
// one rule (id 0, Default, no policy) with one delegated signer, the deployer.
//
//   bun scripts/deploy-test-account.ts <identity>      (a `stellar keys` identity)
//
// The secret is read from the stellar CLI and never printed.
import { execFileSync } from 'node:child_process'
import {
  Address,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { RPC_URL } from '../src/config.ts'
import { toScVal } from '../src/wire.ts'

const WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9' // OZ account, uploaded on testnet
const identity = process.argv[2]
if (!identity) throw new Error('usage: deploy-test-account.ts <stellar identity>')
const kp = Keypair.fromSecret(execFileSync('stellar', ['keys', 'show', identity]).toString().trim())
const server = new rpc.Server(RPC_URL.testnet)
const source = await server.getAccount(kp.publicKey())
const op = Operation.createCustomContract({
  address: new Address(kp.publicKey()),
  wasmHash: Buffer.from(WASM_HASH, 'hex'),
  salt: Buffer.from(process.argv[3] ?? '00'.repeat(32), 'hex'),
  constructorArgs: [toScVal([['Delegated', kp.publicKey()]]), xdr.ScVal.scvMap([])],
})
const tx = new TransactionBuilder(source, { fee: '1000000', networkPassphrase: Networks.TESTNET })
  .addOperation(op)
  .setTimeout(60)
  .build()
const prepared = await server.prepareTransaction(tx)
prepared.sign(kp)
const sent = await server.sendTransaction(prepared)
if (sent.status === 'ERROR') throw new Error(JSON.stringify(sent.errorResult))
const done = await server.pollTransaction(sent.hash, { attempts: 30 })
console.log(done.status, sent.hash)
if (done.status === 'SUCCESS' && done.returnValue)
  console.log(Address.fromScVal(done.returnValue).toString())
