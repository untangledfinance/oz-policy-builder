// What the Prime's owners can do with the gate's destination list, against the
// execution adapter, on Stellar TESTNET with throwaway friendbot accounts.
//
//   bun scripts/verify-gate-list-testnet.ts
//
// The Prime app's gate wizard lists the Prime account on the gate, because a
// batch that names an address the gate does not list is refused. The gate has
// one list, so the same entry also lets `pull` pay the Prime. This script stands
// up a fresh Prime, a gate that lists the adapter, custody, the asset's contract
// and the Prime, and an adapter bound to it, then runs the owners' rule 0 (no
// predicate) through three steps:
//
//   (a) pull to a stranger, who is not listed: refused, `#2` from the adapter's
//       address rule (the gate's own list is the same list);
//   (b) pull to the Prime, who is listed: paid, out of custody's allowance;
//   (c) the Prime sends what it now holds to the stranger with its own rule,
//       which names no wait and no list.
//
// It builds on whatever `build-wasm.sh` last produced under contracts/. Nothing
// is mocked and nothing touches mainnet. Keys are generated here, funded by
// friendbot and never printed.

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

const MIN_WAIT = 0
const WINDOW = 100
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
const txOf = (got: any) => String(got?.txHash ?? got?.hash ?? '')

let fails = 0
const row = (ok: boolean, label: string, got: string, tx = '') => {
  if (!ok) fails++
  console.log(
    `${ok ? C.dim('ok  ') : '\x1b[31mMISMATCH\x1b[0m'} ${label.padEnd(52)} ${got.padEnd(30)} ${tx}`
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

// The native asset contract's balance of a contract address, read from its ledger entry.
async function sacBalance(holder: string): Promise<bigint> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(sac).toScAddress(),
      key: vec([xdr.ScVal.scvSymbol('Balance'), addr(holder)]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
  const got = await server.getLedgerEntries(key)
  const entry = got.entries[0]
  if (!entry) return 0n
  const map = entry.val.contractData().val().map()!
  const amount = map
    .find((m) => m.key().sym().toString() === 'amount')!
    .val()
    .i128()
  return (BigInt(amount.hi().toString()) << 64n) | BigInt(amount.lo().toString())
}

const gateWasm = readFileSync(wasmPath('custody-gate', 'custody_gate'))
const adapWasm = readFileSync(wasmPath('execution-adapter', 'execution_adapter'))
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

const gateSalt = hash(Buffer.from(`gate.list.${Date.now()}`))
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

console.log(C.bold(`\nadapter build  ${AW.toString('hex')}  ${adapWasm.length}B`))
console.log(C.bold('prime   ') + prime)
console.log(C.bold('gate    ') + gate + C.dim('   lists: adapter, custody, native asset, prime'))
console.log(C.bold('adapter ') + adapter)
console.log(C.bold('stranger') + ' ' + STRANGER + C.dim('   not on the gate'))
console.log('')

const pullTo = (to: string) => ({
  calls: vec([call(gate, 'pull', [addr(sac), addr(to), i128v(AMOUNT)])]),
  grants: vec([]),
})
const executeOp =
  (b: { calls: xdr.ScVal; grants: xdr.ScVal }) => (auth: xdr.SorobanAuthorizationEntry[]) =>
    invokeOp(adapter, 'execute', [b.calls, b.grants, u32v(0)], auth)

console.log(C.bold("── the owners' rule 0, which carries no predicate ──"))
const refused = await asPrime({
  kp: K.admin,
  prime,
  ruleIds: [0],
  label: 'pull to a stranger',
  submit: true,
  makeOp: executeOp(pullTo(STRANGER)),
})
row(
  refused.denied,
  'pull to a stranger (unlisted)',
  refused.denied ? `refused, contract error #${codeOf(refused.reason)}` : 'permitted',
  txOf(refused.got)
)

const before = await sacBalance(prime)
const toPrime = await asPrime({
  kp: K.admin,
  prime,
  ruleIds: [0],
  label: 'pull to the Prime',
  submit: true,
  makeOp: executeOp(pullTo(prime)),
})
const afterPull = await sacBalance(prime)
row(
  !toPrime.denied && afterPull - before === AMOUNT,
  'pull to the Prime (listed)',
  toPrime.denied ? `refused, ${toPrime.reason}` : `permitted, Prime +${afterPull - before} stroops`,
  txOf(toPrime.got)
)

const xlm = async (a: string) =>
  Number(
    (await horizon.loadAccount(a)).balances.find((b: any) => b.asset_type === 'native')!.balance
  )
const strangerBefore = await xlm(STRANGER)
const onward = await asPrime({
  kp: K.admin,
  prime,
  ruleIds: [0],
  label: 'the Prime pays the stranger',
  submit: true,
  makeOp: (auth) => invokeOp(sac, 'transfer', [addr(prime), addr(STRANGER), i128v(AMOUNT)], auth),
})
const afterOnward = await sacBalance(prime)
const strangerAfter = await xlm(STRANGER)
row(
  !onward.denied && afterPull - afterOnward === AMOUNT && strangerAfter > strangerBefore,
  'the Prime sends it to the stranger, no wait, no list',
  onward.denied
    ? `refused, ${onward.reason}`
    : `permitted, stranger ${strangerBefore} -> ${strangerAfter} XLM`,
  txOf(onward.got)
)

console.log(
  C.bold(
    `\n${fails === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${fails} MISMATCH(es)\x1b[0m`}`
  )
)
if (fails > 0) process.exit(1)
