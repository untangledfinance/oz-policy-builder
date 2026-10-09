// Upload the custody gate and execution adapter builds to testnet, and record
// them in deployments/execution-testnet.json.
//
//   contracts/prime/stellar/custody-gate/build-wasm.sh && contracts/prime/stellar/execution-adapter/build-wasm.sh
//   bun scripts/upload-execution-testnet.ts
//
// UPLOAD ONLY. Neither contract is a shared instance: the custody account
// deploys its own gate and the Prime its own adapter, both from these hashes.
// What has to exist is the code, and what the app pins is its hash - so the
// record is what the app's pinned builds and CI's rebuild are compared with.
// It names no commit: CI rebuilding the tree and matching these hashes is what
// ties them to the source.
//
// Build on Linux first (the build scripts say why): a macOS build uploads a
// hash nobody else can rebuild.

import { readFileSync, writeFileSync } from 'node:fs'
import { hash, Keypair, Operation } from '@stellar/stellar-sdk'
import { send, wasmPath } from './lib/chain.ts'

const kp = Keypair.random()
await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)
await new Promise((r) => setTimeout(r, 6000))

const artifacts = {
  'custody-gate': readFileSync(wasmPath('custody-gate', 'custody_gate')),
  'execution-adapter': readFileSync(wasmPath('execution-adapter', 'execution_adapter')),
}
const wasmSha256: Record<string, string> = {}
const uploadTx: Record<string, string> = {}
const sizes: Record<string, number> = {}
for (const [name, wasm] of Object.entries(artifacts)) {
  wasmSha256[name] = hash(wasm).toString('hex')
  sizes[name] = wasm.length
  const got = await send(kp, Operation.uploadContractWasm({ wasm }), `upload ${name}`)
  uploadTx[name] = got.txHash
  console.log(`${name.padEnd(18)} ${wasmSha256[name]}  ${wasm.length}B  ${got.txHash}`)
}

writeFileSync(
  new URL('../deployments/execution-testnet.json', import.meta.url),
  `${JSON.stringify(
    {
      network: 'testnet',
      recorded: new Date().toISOString(),
      uploader: kp.publicKey(),
      wasmSha256,
      uploadTx,
      sizes,
      note: "Linux builds through each crate's build-wasm.sh, so the hashes can be rebuilt from source; CI does. The Prime app pins these: new gates are created from the custody-gate hash and name the execution-adapter hash as their caller's code.",
    },
    null,
    2
  )}\n`
)
console.log('recorded deployments/execution-testnet.json')
