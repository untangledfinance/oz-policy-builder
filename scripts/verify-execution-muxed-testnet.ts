// A muxed address as a transfer recipient, against the execution adapter, on
// Stellar TESTNET with throwaway friendbot accounts.
//
//   ADAPTER_WASM=<path> GATE_WASM=<path> EXPECT=old|new bun scripts/verify-execution-muxed-testnet.ts
//
// It stands up a fresh Prime, a custody gate that lists only the adapter, custody, the
// asset's contract and the Prime, and an adapter bound to that gate. Then it
// runs one batch shape three ways and reports what the pair did:
//
//   pull from the gate, then `transfer(adapter -> recipient)` on the native
//   asset's contract, where the recipient is (a) custody, (b) a stranger as a
//   plain address, (c) the same stranger written as a muxed address.
//
// EXPECT=old is the control: an adapter built before the muxed-address fix pays
// the stranger on (c), now and as a stored move. EXPECT=new is the fix: (c) is
// refused with Uncheckable, and the refused batch is also put on chain as a
// failed transaction so the refusal has a hash.
//
// Nothing is mocked and nothing touches mainnet. Keys are generated here, funded
// by friendbot and never printed.

import { readFileSync } from 'node:fs'
import { Address, Asset, hash, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-sdk'
import {
  ACCOUNT_WASM_HASH,
  addr,
  asPrime,
  C,
  call,
  codeOf,
  delegatedSigner,
  horizon,
  i128v,
  invokeOp,
  kv,
  LIMIT,
  PASSPHRASE,
  send,
  server,
  u32v,
  vec,
  wasmPath,
} from './lib/chain.ts'

const EXPECT = process.env.EXPECT
if (EXPECT !== 'old' && EXPECT !== 'new') throw new Error('set EXPECT=old or EXPECT=new')
const MIN_WAIT = 0
const WINDOW = 100
const STORED_WAIT = 720
const AMOUNT = 1_000_000n // 0.1 XLM, in stroops
const DOMAIN = 'prime.execution.adapter.v4'

const adapterSalt = (gate: string) =>
  hash(
    Buffer.concat([
      Buffer.from(DOMAIN),
      addr(gate).toXDR(),
      u32v(MIN_WAIT).toXDR(),
      u32v(WINDOW).toXDR(),
    ])
  )
const contractId = (deployer: string, salt: Buffer) =>
  StrKey.encodeContract(
    hash(
      xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
          networkId: hash(Buffer.from(PASSPHRASE, 'utf8')),
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: Address.fromString(deployer).toScAddress(),
              salt,
            })
          ),
        })
      ).toXDR()
    )
  )
const muxedOf = (g: string, id: string) =>
  xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeMuxedAccount(
      new xdr.MuxedEd25519Account({
        id: xdr.Uint64.fromString(id),
        ed25519: Buffer.from(StrKey.decodeEd25519PublicKey(g)),
      })
    )
  )
const txOf = (got: any) => String(got?.txHash ?? got?.hash ?? '')

let fails = 0
const row = (ok: boolean, label: string, got: string, tx = '') => {
  if (!ok) fails++
  console.log(
    `${ok ? C.dim('ok  ') : '\x1b[31mMISMATCH\x1b[0m'} ${label.padEnd(46)} ${got.padEnd(34)} ${tx}`
  )
}

const K = { admin: Keypair.random(), custody: Keypair.random(), stranger: Keypair.random() }
await Promise.all(
  Object.values(K).map((k) => fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`))
)
await new Promise((r) => setTimeout(r, 6000))
const CUSTODY = K.custody.publicKey()
const STRANGER = K.stranger.publicKey()
const sac = Asset.native().contractId(PASSPHRASE)

const gateWasm = readFileSync(process.env.GATE_WASM ?? wasmPath('custody-gate', 'custody_gate'))
const adapWasm = readFileSync(
  process.env.ADAPTER_WASM ?? wasmPath('execution-adapter', 'execution_adapter')
)
const AW = hash(adapWasm)
const GW = hash(gateWasm)
for (const w of [gateWasm, adapWasm]) {
  try {
    await send(K.admin, Operation.uploadContractWasm({ wasm: w }), 'upload')
  } catch {
    /* already uploaded */
  }
}

const prime = Address.fromScVal(
  (
    await send(
      K.admin,
      Operation.createCustomContract({
        address: Address.fromString(K.admin.publicKey()),
        wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
        constructorArgs: [vec([delegatedSigner(K.admin.publicKey())]), xdr.ScVal.scvMap([])],
      }),
      'create prime'
    )
  ).returnValue!
).toString()

const gateSalt = hash(Buffer.from(`muxed.gate.${Date.now()}`))
const gate = contractId(CUSTODY, gateSalt)
const adapter = contractId(prime, adapterSalt(gate))
await send(
  K.custody,
  Operation.createCustomContract({
    address: Address.fromString(CUSTODY),
    wasmHash: GW,
    salt: gateSalt,
    constructorArgs: [
      xdr.ScVal.scvMap([
        kv('allowed', vec([adapter, CUSTODY, sac, prime].map(addr))),
        kv('caller', addr(adapter)),
        kv('caller_code', xdr.ScVal.scvBytes(AW)),
        kv('custody', addr(CUSTODY)),
      ]),
    ],
  }),
  'deploy gate'
)
await send(
  K.custody,
  invokeOp(sac, 'approve', [
    addr(CUSTODY),
    addr(gate),
    i128v(LIMIT),
    u32v((await server.getLatestLedger()).sequence + 6000),
  ]),
  'approve limit'
)
const deployed = await asPrime({
  kp: K.admin,
  prime,
  ruleIds: [0],
  label: 'deploy adapter',
  submit: true,
  makeOp: (auth) =>
    Operation.createCustomContract({
      address: Address.fromString(prime),
      wasmHash: AW,
      salt: adapterSalt(gate),
      constructorArgs: [addr(prime), addr(gate), u32v(MIN_WAIT), u32v(WINDOW)],
      auth,
    } as any),
})
if (deployed.denied) throw new Error(`deploy adapter: ${deployed.reason}`)

console.log(C.bold(`\nadapter build  ${EXPECT}  ${AW.toString('hex')}  ${adapWasm.length}B`))
console.log(C.bold('prime   ') + prime)
console.log(C.bold('gate    ') + gate + C.dim('   lists: adapter, custody, native asset, prime'))
console.log(C.bold('adapter ') + adapter)
console.log(C.bold('stranger') + ' ' + STRANGER + C.dim('   not on the gate'))
console.log('')

const pull = call(gate, 'pull', [addr(sac), addr(adapter), i128v(AMOUNT)])
const payTo = (to: xdr.ScVal) => ({
  calls: vec([pull, call(sac, 'transfer', [addr(adapter), to, i128v(AMOUNT)])]),
  grants: vec([]),
})
const executeOp =
  (b: { calls: xdr.ScVal; grants: xdr.ScVal }, wait: number) =>
  (auth: xdr.SorobanAuthorizationEntry[]) =>
    invokeOp(adapter, 'execute', [b.calls, b.grants, u32v(wait)], auth)

const balance = async (a: string) =>
  Number(
    (await horizon.loadAccount(a)).balances.find((b: any) => b.asset_type === 'native')!.balance
  )

async function run(
  label: string,
  b: { calls: xdr.ScVal; grants: xdr.ScVal },
  wait: number,
  expect: 'PERMIT' | 'REFUSE',
  want?: string
) {
  const r = await asPrime({
    kp: K.admin,
    prime,
    ruleIds: [0],
    label,
    submit: true,
    makeOp: executeOp(b, wait),
  })
  const code = codeOf(r.reason)
  const got = r.denied ? 'REFUSE' : 'PERMIT'
  const named = r.denied ? `refused, contract error #${code}` : 'permitted'
  row(got === expect && (want === undefined || code === want), label, named, txOf(r.got))
  return r
}

const stranger0 = await balance(STRANGER)
const muxed = payTo(muxedOf(STRANGER, '7'))
const legit = payTo(addr(CUSTODY))

console.log(C.bold('── the same batch, three recipients ──'))
await run('pay custody (listed)', legit, 0, 'PERMIT')
await run('pay stranger, plain address', payTo(addr(STRANGER)), 0, 'REFUSE', '2')
const stranger1 = await balance(STRANGER)
row(stranger1 === stranger0, 'stranger balance after the plain attempt', `${stranger1} XLM`)

console.log(C.bold('\n── the stranger as a muxed address ──'))
if (EXPECT === 'old') {
  await run('pay stranger, muxed, immediately', muxed, 0, 'PERMIT')
  const paid = await balance(STRANGER)
  row(paid > stranger1, 'stranger balance after the muxed batch', `${stranger1} -> ${paid} XLM`)
  // A stored move: the same batch with a wait is accepted and kept.
  const stored = await run(
    `pay stranger, muxed, stored (wait ${STORED_WAIT})`,
    muxed,
    STORED_WAIT,
    'PERMIT'
  )
  console.log(C.dim(`      stored move accepted: ${txOf(stored.got)}`))
} else {
  await run('pay stranger, muxed, immediately', muxed, 0, 'REFUSE', '3')
  await run(`pay stranger, muxed, stored (wait ${STORED_WAIT})`, muxed, STORED_WAIT, 'REFUSE', '3')
  // Put the refused batch on chain, so the refusal has a transaction.
  const forced = await asPrime({
    kp: K.admin,
    prime,
    ruleIds: [0],
    label: 'forged muxed batch',
    submit: true,
    makeOp: executeOp(muxed, 0),
    forge: {
      sibling: executeOp(legit, 0),
      rootInvocation: (own) =>
        new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(adapter).toScAddress(),
              functionName: 'execute',
              args: [muxed.calls, muxed.grants, u32v(0)],
            })
          ),
          subInvocations: own.subInvocations(),
        }),
    },
  })
  const failedOnChain = forced.denied && forced.got?.status === 'FAILED'
  row(
    failedOnChain && codeOf(forced.reason) === '3',
    'muxed batch submitted on chain',
    `${forced.got?.status ?? 'not sent'}, ${forced.reason ?? 'no error'}`,
    txOf(forced.got)
  )
  const after = await balance(STRANGER)
  row(after === stranger1, 'stranger balance after the muxed batch', `${after} XLM`)
}

console.log(
  C.bold(
    `\n${fails === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${fails} MISMATCH(es)\x1b[0m`}`
  )
)
if (fails > 0) process.exit(1)
