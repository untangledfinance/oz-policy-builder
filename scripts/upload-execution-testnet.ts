// Upload the custody gate and execution adapter builds to testnet, and record
// them in deployments/execution-testnet.json.
//
//   contracts/stellar/custody-gate/build-wasm.sh && contracts/stellar/execution-adapter/build-wasm.sh
//   bun scripts/upload-execution-testnet.ts [custody-gate] [execution-adapter] [--why "<text>"]
//
// UPLOAD ONLY. Neither contract is a shared instance: the custody account
// deploys its own gate and the Prime its own adapter, both from these hashes.
// What has to exist is the code, and what the app pins is its hash - so the
// record is what the app's pinned builds and CI's rebuild are compared with.
// It names no commit: CI rebuilding the tree and matching these hashes is what
// ties them to the source.
//
// With no name, both builds are uploaded. Naming one uploads only that build
// and keeps the other's entry as recorded. When an upload replaces a recorded
// hash, the replaced build moves to `superseded` with the reason given in
// --why (required then), so the record says which build each network ran.
//
// Build on Linux first (the build scripts say why): a macOS build uploads a
// hash nobody else can rebuild.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hash, Keypair, Operation, xdr } from '@stellar/stellar-sdk'
import { send, server, wasmPath } from './lib/chain.ts'

const BUILDS = {
  'custody-gate': 'custody_gate',
  'execution-adapter': 'execution_adapter',
} as const
type Name = keyof typeof BUILDS
const isName = (a: string): a is Name => Object.hasOwn(BUILDS, a)

const args = process.argv.slice(2)
const whyAt = args.indexOf('--why')
const why = whyAt >= 0 ? (args[whyAt + 1] ?? '').trim() : ''
const named = args.filter((a, i) => !a.startsWith('--') && (whyAt < 0 || i !== whyAt + 1))
for (const a of named)
  if (!isName(a)) throw new Error(`unknown build "${a}": custody-gate or execution-adapter`)
const names: Name[] = named.length ? (named as Name[]) : (Object.keys(BUILDS) as Name[])

const RECORD = new URL('../deployments/execution-testnet.json', import.meta.url)
const rec = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {}
const artifacts = Object.fromEntries(
  names.map((n) => [n, readFileSync(wasmPath(n, BUILDS[n]))])
) as Record<Name, Buffer>
const replaced = names.filter(
  (n) => rec.wasmSha256?.[n] && rec.wasmSha256[n] !== hash(artifacts[n]).toString('hex')
)
if (replaced.length && (!why || why.startsWith('--')))
  throw new Error(`--why "<text>": say why the recorded ${replaced.join(', ')} build is replaced`)

const kp = Keypair.random()
await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)
await new Promise((r) => setTimeout(r, 6000))

// A record from before per-build uploaders named one uploader for every build.
const uploaderOf = (n: Name): string | undefined =>
  typeof rec.uploader === 'string' ? rec.uploader : rec.uploader?.[n]
const next = {
  network: 'testnet',
  recorded: new Date().toISOString(),
  uploader: Object.fromEntries(
    (Object.keys(BUILDS) as Name[]).flatMap((n) =>
      names.includes(n) ? [[n, kp.publicKey()]] : uploaderOf(n) ? [[n, uploaderOf(n)]] : []
    )
  ),
  wasmSha256: { ...rec.wasmSha256 } as Record<string, string>,
  uploadTx: { ...rec.uploadTx } as Record<string, string>,
  sizes: { ...rec.sizes } as Record<string, number>,
  note:
    rec.note ??
    "Linux builds through each crate's build-wasm.sh, so the hashes can be rebuilt from source; CI does. The Prime app pins these: new gates are created from the custody-gate hash and name the execution-adapter hash as their caller's code.",
  ...(rec.interimBuilds ? { interimBuilds: rec.interimBuilds } : {}),
  superseded: { ...rec.superseded } as Record<string, unknown[]>,
}

for (const name of names) {
  const wasm = artifacts[name]
  const sha = hash(wasm).toString('hex')
  const got = await send(kp, Operation.uploadContractWasm({ wasm }), `upload ${name}`)
  // The upload returns the hash the network stored the code under; the code entry must exist.
  const stored = got.returnValue?.bytes().toString('hex')
  if (stored !== sha) throw new Error(`${name}: the network stored ${stored}, the build is ${sha}`)
  const code = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(sha, 'hex') })
  )
  if (!(await server.getLedgerEntries(code)).entries.length)
    throw new Error(`${name}: no code entry for ${sha} after the upload`)
  if (replaced.includes(name))
    next.superseded[name] = [
      {
        wasmSha256: rec.wasmSha256[name],
        uploadTx: rec.uploadTx?.[name],
        size: rec.sizes?.[name],
        uploader: uploaderOf(name),
        why,
      },
      ...(rec.superseded?.[name] ?? []),
    ]
  next.wasmSha256[name] = sha
  next.uploadTx[name] = got.txHash
  next.sizes[name] = wasm.length
  console.log(`${name.padEnd(18)} ${sha}  ${wasm.length}B  ${got.txHash}  (code entry on chain)`)
}
if (!Object.keys(next.superseded).length) Reflect.deleteProperty(next, 'superseded')

writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`)
console.log('recorded deployments/execution-testnet.json')
