// End-to-end check of the v3 execution pair against a REAL Prime smart account
// and live venues on testnet.
//
// It stands up a fresh Prime, a custody gate and the adapter bound to it, then
// runs the legitimate flows and every refusal the pair is supposed to produce.
// Nothing here is mocked: Blend and Aquarius are the live testnet contracts.
//
//   bun scripts/verify-execution-v3-testnet.ts
//
// Requires scripts/.env (throwaway testnet keys) only for the shared grammar-6
// interpreter address in scripts/.demo-state.json; every account it uses is
// created and funded fresh.
import {
  Address, Keypair, Operation, StrKey, TransactionBuilder, XdrLargeInt, hash, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk'
import { readFileSync } from 'node:fs'
import {
  ACCOUNT_WASM_HASH, C, FEE, LIMIT, MOVE, PASSPHRASE, POOL, addRuleArgs, addr, and, asPrime, call,
  callArg, codeOf, delegatedSigner, eq, grant, horizon, i128v, invokeOp, kv, loadState, selector,
  send, server, settle, sym, u32v, vec, wasmPath,
} from './prime/chain.ts'

/** Live Aquarius XLM/USDT pool, and the token it pays out in. */
const AQUA = 'CCMNSENXDBNJSY72BDIPH5CCXLLHBKZ4LXTRKDLKZN4UI2NJFQLWTLD6'
const OUT = 'CDPXNHHVSLX3HFAHV7XOISM23MZH36WSXTO45RNDOBIDFZBGTSOVD4OY'
/** The salt domain custody uses to find the adapter before it is deployed. */
const DOMAIN = 'prime.execution.adapter.v3'
const NAMES: Record<string, string> = { '1': 'PrimeTarget', '2': 'AddressNotAllowed', '3': 'Uncheckable' }

const u128 = (v: bigint) => new XdrLargeInt('u128', v.toString()).toScVal()
const contractId = (deployer: string, salt: Buffer) =>
  StrKey.encodeContract(hash(xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(PASSPHRASE, 'utf8')),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt })),
  })).toXDR()))

let fails = 0
const interpreter = loadState().interpreter
const sac = loadState().sac

const K = { admin: Keypair.random(), agent: Keypair.random(), custody: Keypair.random(), stranger: Keypair.random() }
await Promise.all(Object.values(K).map((k) => fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`)))
await new Promise((r) => setTimeout(r, 6000))
const CUSTODY = K.custody.publicKey()
const STRANGER = K.stranger.publicKey()

const prime = Address.fromScVal((await send(K.admin, Operation.createCustomContract({
  address: Address.fromString(K.admin.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
  constructorArgs: [vec([delegatedSigner(K.admin.publicKey())]), xdr.ScVal.scvMap([])],
}), 'create prime')).returnValue!).toString()

const gateWasm = readFileSync(wasmPath('custody-gate-v3', 'custody_gate_v3'))
const adapWasm = readFileSync(wasmPath('execution-adapter-v3', 'execution_adapter_v3'))
const GW = hash(gateWasm)
const AW = hash(adapWasm)
for (const w of [gateWasm, adapWasm]) {
  try { await send(K.admin, Operation.uploadContractWasm({ wasm: w }), 'upload') } catch { /* already uploaded */ }
}

// Custody picks its salt first, which fixes both addresses before either
// contract exists - so the two parties can deploy in any order.
const gateSalt = hash(Buffer.from(`v3.gate.${Date.now()}`))
const secondSalt = hash(Buffer.from(`v3.gate2.${Date.now()}`))
const gate = contractId(CUSTODY, gateSalt)
const gate2 = contractId(CUSTODY, secondSalt)
const adapter = contractId(prime, hash(Buffer.concat([Buffer.from(DOMAIN), addr(gate).toXDR()])))

const cfg = (caller: string, allowed: string[]) => xdr.ScVal.scvMap([
  kv('allowed', vec(allowed.map(addr))), kv('caller', addr(caller)),
  kv('caller_code', xdr.ScVal.scvBytes(AW)), kv('custody', addr(CUSTODY)),
])
// A second gate, answering to someone else, listed on ours on purpose: it is
// the test that a foreign gate refuses us on its own account.
await send(K.custody, Operation.createCustomContract({ address: Address.fromString(CUSTODY), wasmHash: GW,
  salt: secondSalt, constructorArgs: [cfg(K.agent.publicKey(), [CUSTODY, sac])] }), 'deploy second gate')
await send(K.custody, Operation.createCustomContract({ address: Address.fromString(CUSTODY), wasmHash: GW,
  salt: gateSalt, constructorArgs: [cfg(adapter, [adapter, CUSTODY, sac, POOL, AQUA, OUT, prime, interpreter, gate2])] }), 'deploy gate')
for (const g of [gate, gate2]) {
  await send(K.custody, invokeOp(sac, 'approve',
    [addr(CUSTODY), addr(g), i128v(LIMIT), u32v((await server.getLatestLedger()).sequence + 6000)]), 'approve limit')
}

const must = (r: any, what: string) => { if (r.denied) throw new Error(`${what}: ${String(r.reason).slice(0, 150)}`); return r.got }
must(await asPrime({ kp: K.admin, prime, ruleIds: [0], label: 'deploy adapter', submit: true,
  makeOp: (auth) => Operation.createCustomContract({ address: Address.fromString(prime), wasmHash: AW,
    salt: hash(Buffer.concat([Buffer.from(DOMAIN), addr(gate).toXDR()])), constructorArgs: [addr(prime), addr(gate)], auth } as any),
}), 'deploy adapter')

// Blend's `submit` resolves the Prime's authorization through the interpreter,
// so the pool needs its own rule with the adapter bound as executor.
let poolRule = 0
for (let i = 0; i < 5 && poolRule === 0; i++) {
  const r = await asPrime({ kp: K.admin, prime, ruleIds: [0], label: 'install pool rule', submit: true,
    makeOp: (auth) => invokeOp(prime, 'add_context_rule', addRuleArgs({
      scope: POOL, name: `v3-pool-${i}`, signer: adapter, interpreter, adminPk: K.admin.publicKey(),
      predicate: and([eq(selector('call_fn'), sym('submit')), eq(callArg(0), addr(prime)), eq(callArg(1), addr(adapter))]),
    }), auth) })
  if (!r.denied) poolRule = Number(scValToNative(r.got!.returnValue!).id)
  else await new Promise((x) => setTimeout(x, 4000))
}
must(await asPrime({ kp: K.admin, prime, ruleIds: [0], label: 'bind executor', submit: true,
  makeOp: (auth) => invokeOp(interpreter, 'bind_executor', [vec([addr(prime), u32v(poolRule)]), addr(adapter)], auth) }), 'bind executor')

console.log(C.bold('\nprime   ') + prime)
console.log(C.bold('gate    ') + gate)
console.log(C.bold('adapter ') + adapter + C.dim(`   ${adapWasm.length}B adapter, ${gateWasm.length}B gate`))

const tokenAuth = (token: string, from: string, to: string, amount: bigint) => vec([sym('Contract'), xdr.ScVal.scvMap([
  kv('context', xdr.ScVal.scvMap([kv('args', vec([addr(from), addr(to), i128v(amount)])),
    kv('contract', addr(token)), kv('fn_name', sym('transfer'))])), kv('sub_invocations', vec([]))])])
const request = (amount: bigint, kind: 0 | 1) => vec([xdr.ScVal.scvMap([
  kv('address', addr(sac)), kv('amount', i128v(amount)), kv('request_type', u32v(kind))])])
const entry = (contract: string, args: xdr.ScVal[], subs: xdr.ScVal[] = []) => vec([sym('Contract'), xdr.ScVal.scvMap([
  kv('context', xdr.ScVal.scvMap([kv('args', vec(args)), kv('contract', addr(contract)), kv('fn_name', sym('transfer'))])),
  kv('sub_invocations', vec(subs))])])
const pay = (v: xdr.ScVal) => ({ calls: vec([call(sac, 'transfer', [addr(adapter), addr(CUSTODY), v])]), grants: vec([]) })
const payloadOf = (a: string) => Buffer.from(a.startsWith('C') ? StrKey.decodeContract(a) : StrKey.decodeEd25519PublicKey(a))
const nest = (n: number, leaf: xdr.ScVal): xdr.ScVal => (n === 0 ? leaf : vec([nest(n - 1, leaf)]))

/** PERMIT: allowed through. REFUSE: the pair said no. PASSES: the walk allowed
 *  it and something downstream - a venue, the host - refused instead. */
async function go(label: string, batch: any, expect: 'PERMIT' | 'REFUSE' | 'PASSES', rules = [0], submit = false, raw = false) {
  const r = await asPrime({ kp: K.admin, prime, label, submit, ruleIds: rules,
    signers: rules.length > 1 ? [K.admin.publicKey(), adapter] : [K.admin.publicKey()],
    makeOp: (auth) => invokeOp(adapter, 'execute', [batch.calls, batch.grants], auth) })
  const code = codeOf(r.reason)
  const got = !r.denied ? 'PERMIT' : code ? 'REFUSE' : 'PASSES'
  const why = r.denied
    ? (code && !raw ? `#${code} ${NAMES[code] ?? ''}` : String(r.reason).split('\n')[0].replace('HostError: ', '').slice(0, 46))
    : (submit ? String(r.got?.status ?? '') : '')
  if (got !== expect) fails++
  console.log(`${got === expect ? C.dim('ok  ') : '\x1b[31mMISMATCH\x1b[0m'} ${label.padEnd(50)} ${got.padEnd(7)} ${why}`)
}
async function land(label: string, kp: Keypair, op: xdr.Operation, expect: 'LANDS' | 'REJECTED') {
  let got = 'LANDS'
  let why = 'ok'
  try {
    const tx = new TransactionBuilder(await server.getAccount(kp.publicKey()), { fee: FEE, networkPassphrase: PASSPHRASE })
      .addOperation(op).setTimeout(120).build()
    const p = await server.prepareTransaction(tx)
    p.sign(kp)
    await settle(await server.sendTransaction(p), label)
  } catch (e) {
    got = 'REJECTED'
    why = String(e).match(/Error\([A-Za-z]+, [#A-Za-z0-9]+\)/)?.[0] ?? 'refused'
  }
  if (got !== expect) fails++
  console.log(`${got === expect ? C.dim('ok  ') : '\x1b[31mMISMATCH\x1b[0m'} ${label.padEnd(50)} ${got.padEnd(7)} ${why}`)
}

const supplyArgs = [addr(prime), addr(adapter), addr(CUSTODY), request(MOVE, 0)]
const supply = {
  calls: vec([call(gate, 'pull', [addr(sac), addr(adapter), i128v(MOVE)]),
    call(POOL, 'submit', supplyArgs, [tokenAuth(sac, adapter, POOL, MOVE)])]),
  grants: vec([grant({ prime, interpreter } as any, POOL, 'submit', supplyArgs)]),
}
console.log(C.bold('\n── real venues ──'))
await go('Blend supply', supply, 'PERMIT', [0, poolRule], true)
const wArgs = [addr(prime), addr(adapter), addr(CUSTODY), request(MOVE / 2n, 1)]
await go('Blend withdraw to custody', { calls: vec([call(POOL, 'submit', wArgs)]),
  grants: vec([grant({ prime, interpreter } as any, POOL, 'submit', wArgs)]) }, 'PERMIT', [0, poolRule], true)
await go('Aquarius swap, proceeds home', { calls: vec([
  call(gate, 'pull', [addr(sac), addr(adapter), i128v(1000000n)]),
  call(AQUA, 'swap', [addr(adapter), u32v(0), u32v(1), u128(1000000n), u128(1n)], [tokenAuth(sac, adapter, AQUA, 1000000n)]),
  call(OUT, 'transfer', [addr(adapter), addr(CUSTODY), i128v(100000n)])]), grants: vec([]) }, 'PERMIT', [0], true)
{
  const tx = new TransactionBuilder(await server.getAccount(K.admin.publicKey()), { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(invokeOp(adapter, 'execute', [supply.calls, supply.grants])).setTimeout(60).build()
  const s: any = await server.simulateTransaction(tx)
  console.log(C.bold('  cost  ') + (rpc.Api.isSimulationError(s) ? 'n/a' : `${s.transactionData.build().resources().instructions()} instructions`))
}

console.log(C.bold('\n── the adapter and the Prime as targets ──'))
await go('a batch calling the adapter back', { calls: vec([call(adapter, 'execute', [vec([]), vec([])])]), grants: vec([]) }, 'PASSES', [0], false, true)
await go('a batch adding a signer to the Prime', { calls: vec([call(prime, 'add_signer', [u32v(0), delegatedSigner(CUSTODY)])]), grants: vec([]) }, 'REFUSE')
await go('a batch driving the Prime own execute', { calls: vec([call(prime, 'execute',
  [addr(sac), sym('transfer'), vec([addr(prime), addr(CUSTODY), i128v(1n)])])]), grants: vec([]) }, 'REFUSE')

console.log(C.bold('\n── destinations ──'))
await go('drain to a stranger', { calls: vec([call(gate, 'pull', [addr(sac), addr(adapter), i128v(MOVE)]),
  call(sac, 'transfer', [addr(adapter), addr(STRANGER), i128v(MOVE)])]), grants: vec([]) }, 'REFUSE')
const sArgs = [addr(prime), addr(adapter), addr(STRANGER), request(MOVE / 2n, 1)]
await go('Blend proceeds to a stranger', { calls: vec([call(POOL, 'submit', sArgs)]),
  grants: vec([grant({ prime, interpreter } as any, POOL, 'submit', sArgs)]) }, 'REFUSE', [0, poolRule])
await go('a stranger only in an auth entry', { calls: vec([call(gate, 'pull', [addr(sac), addr(adapter), i128v(MOVE)]),
  call(AQUA, 'swap', [addr(adapter), u32v(0), u32v(1), u128(MOVE), u128(1n)], [tokenAuth(sac, adapter, STRANGER, MOVE)])]), grants: vec([]) }, 'REFUSE')

console.log(C.bold('\n── the gate ──'))
await go('pull from a foreign gate listed on ours', { calls: vec([call(gate2, 'pull', [addr(sac), addr(adapter), i128v(MOVE)])]), grants: vec([]) }, 'PASSES')
await go('our own gate still works', { calls: vec([call(gate, 'pull', [addr(sac), addr(adapter), i128v(1n)]),
  call(sac, 'transfer', [addr(adapter), addr(CUSTODY), i128v(1n)])]), grants: vec([]) }, 'PERMIT')
await go('draw a token custody never approved', { calls: vec([call(gate, 'pull', [addr(OUT), addr(adapter), i128v(1n)])]), grants: vec([]) }, 'REFUSE', [0], false, true)
await go('pull with the gate itself as the destination', { calls: vec([call(gate, 'pull', [addr(sac), addr(gate), i128v(1n)])]), grants: vec([]) }, 'REFUSE', [0], false, true)

console.log(C.bold('\n── data that can denote an address ──'))
await go('an allowed account as a strkey', pay(xdr.ScVal.scvString(CUSTODY)), 'PASSES')
await go('an allowed contract as its 32-byte id', pay(xdr.ScVal.scvBytes(payloadOf(POOL))), 'PASSES')
await go('a stranger as a strkey', pay(xdr.ScVal.scvString(STRANGER)), 'REFUSE')
await go('a stranger as its 32-byte key', pay(xdr.ScVal.scvBytes(payloadOf(STRANGER))), 'REFUSE')
await go('a 64-byte signature', pay(xdr.ScVal.scvBytes(Buffer.alloc(64, 7))), 'PASSES')
await go('a short memo', pay(xdr.ScVal.scvString('settlement 42')), 'PASSES')

console.log(C.bold('\n── inside an authorization ──'))
const UNLISTED = loadState().adapter
await go('an auth entry naming an unlisted contract', { calls: vec([call(sac, 'transfer',
  [addr(adapter), addr(CUSTODY), i128v(1n)], [entry(UNLISTED, [addr(adapter)])])]), grants: vec([]) }, 'REFUSE')
await go('a stranger nested one sub-invocation down', { calls: vec([call(sac, 'transfer',
  [addr(adapter), addr(CUSTODY), i128v(1n)], [entry(sac, [addr(adapter)], [entry(sac, [addr(STRANGER)])])])]), grants: vec([]) }, 'REFUSE')
const deployAuth = (salt: string) => vec([sym('CreateContractWithCtorHostFn'), xdr.ScVal.scvMap([
  kv('constructor_args', vec([addr(CUSTODY)])), kv('executable', vec([sym('Wasm'), xdr.ScVal.scvBytes(AW)])),
  kv('salt', xdr.ScVal.scvBytes(hash(Buffer.from(salt))))])])
await go('a deploy authorization in a grant', { calls: vec([call(sac, 'transfer', [addr(adapter), addr(CUSTODY), i128v(1n)])]), grants: vec([deployAuth('a')]) }, 'REFUSE')
await go('a deploy authorization nested one down', { calls: vec([call(sac, 'transfer',
  [addr(adapter), addr(CUSTODY), i128v(1n)], [entry(sac, [addr(adapter)], [deployAuth('b')])])]), grants: vec([]) }, 'REFUSE')

console.log(C.bold('\n── size and depth are bounded by the host, not by a guess ──'))
await go('twenty calls', { calls: vec(Array.from({ length: 20 }, () => call(sac, 'allowance', [addr(CUSTODY), addr(gate)]))), grants: vec([]) }, 'PERMIT')
await go('a stranger buried 50 deep', pay(nest(50, addr(STRANGER))), 'REFUSE')
await go('a legitimate value nested 30 deep', { calls: vec([call(sac, 'allowance', [addr(CUSTODY), addr(gate)],
  [entry(sac, [nest(30, addr(CUSTODY))])])]), grants: vec([]) }, 'PERMIT')

console.log(C.bold('\n── everything at once ──'))
const bulk = (last: xdr.ScVal) => ({ calls: vec([
  ...Array.from({ length: 12 }, () => call(sac, 'allowance', [addr(CUSTODY), addr(gate)],
    [entry(sac, [nest(12, addr(CUSTODY)), xdr.ScVal.scvBytes(payloadOf(POOL))])])),
  call(sac, 'allowance', [addr(CUSTODY), addr(gate)], [entry(sac, [addr(adapter)], [entry(sac, [vec([vec([last])])])])])]), grants: vec([]) })
await go('13 calls, nested data and auth, all listed', bulk(xdr.ScVal.scvString(CUSTODY)), 'PERMIT')
await go('the same with a stranger in the last one', bulk(xdr.ScVal.scvString(STRANGER)), 'REFUSE')
await go('the same with a stranger as raw 32 bytes', bulk(xdr.ScVal.scvBytes(payloadOf(STRANGER))), 'REFUSE')

console.log(C.bold('\n── the custody handover ──'))
await land('the Prime admin tries to rebind', K.admin, invokeOp(adapter, 'rebind', [addr(gate2)]), 'REJECTED')
await land('custody rebinds', K.custody, invokeOp(adapter, 'rebind', [addr(gate2)]), 'LANDS')
{
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(adapter).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent() }))
  const slot = (((await server.getLedgerEntries(key)).entries[0]!.val as any).contractData().val().instance().storage() ?? [])
    .find((x: any) => String(scValToNative(x.key())) === 'gate')
  const bound = slot ? String(scValToNative(slot.val())) : 'none'
  if (bound !== gate2) fails++
  console.log(`${bound === gate2 ? C.dim('ok  ') : '\x1b[31mMISMATCH\x1b[0m'} ${'the binding on the ledger reads the successor'.padEnd(50)} ${bound === gate2 ? 'yes' : bound}`)
}
await go('the old gate is no longer reachable', { calls: vec([call(gate, 'pull', [addr(sac), addr(adapter), i128v(1n)])]), grants: vec([]) }, 'REFUSE')

const balance = async (a: string) => (await horizon.loadAccount(a)).balances.find((b: any) => b.asset_type === 'native')?.balance
console.log(C.bold(`\n${fails === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${fails} MISMATCH(es)\x1b[0m`}`))
console.log(C.bold('custody ') + (await balance(CUSTODY)) + C.bold('   stranger ') + (await balance(STRANGER)))
if (fails > 0) process.exit(1)
