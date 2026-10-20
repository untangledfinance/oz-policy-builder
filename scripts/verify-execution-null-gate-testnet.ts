// End-to-end check of the execution adapter created with NO gate, on testnet,
// for a Prime that is a G account and for one that is an OZ smart account.
//
// What it proves, beyond the unit tests:
//   - X bundles its own calls: [Y.hello, USDC.transfer(X, M), XLM.transfer(X, N)]
//     runs whole, with ONE authorization by X covering the nested transfers;
//   - when hello fails on chain, nothing moves; a failed bundle's signed entry
//     stays usable until its expiry ledger, and is refused after it;
//   - the Prime is still refused as a call target, the adapter hands out no
//     authorization as itself, and it can never be bound to a gate;
//   - an agent on an OZ Prime is checked per call context by grammar-7
//     interpreter rules and refused over its cap, even with the adapter named
//     as a co-signer;
//   - a null adapter stores nothing (any wait is refused, and so is a null
//     adapter with a minimum wait); only the Prime cancels;
//   - a gated adapter cannot be rebound to "no gate", and custody's gate
//     refuses a pull from a null adapter;
//   - the cost of 1, 3 and 10 calls: null and gated on this build, and gated
//     on the deployed v4 build.
//
//   contracts/stellar/execution-adapter/build-wasm.sh && contracts/stellar/custody-gate/build-wasm.sh
//   bun scripts/verify-execution-null-gate-testnet.ts
//
// "hello" is the OZ account Z's `get_signer_id(Delegated(H))`: it answers while
// H is one of Z's signers and fails once Z's owner removes H, so the test can
// make it fail between signing and submitting. Every account is created and
// funded fresh; the policy interpreter comes from deployments/interpreter-testnet.json.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  Address,
  Asset,
  hash,
  Keypair,
  Operation,
  rpc,
  StrKey,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { ruleArgs } from '../packages/policy-synth/src/install.ts'
import { type Constraint, callExpr } from '../packages/policy-synth/src/intent.ts'
import { encode, hashOf, toScVal } from '../packages/policy-synth/src/wire.ts'
import {
  ACCOUNT_WASM_HASH,
  addr,
  call,
  delegatedSigner,
  i128v,
  kv,
  PASSPHRASE,
  server,
  signaturePayload,
  sym,
  u32v,
  vec,
  wasmPath,
} from './lib/chain.ts'

const V4_ADAPTER = '3dd675c06a1f9b27b336347d7c7745d20845b6c1f35acfe4cd2ca93ab1db49c3'
const WINDOW = 60
const U = 10_000_000n // one unit of a 7-decimal asset
const INTERP: string = JSON.parse(
  readFileSync(new URL('../deployments/interpreter-testnet.json', import.meta.url), 'utf8')
).interpreter
const XLM = Asset.native().contractId(PASSPHRASE)
const NAMES: Record<string, string> = {
  '1': 'PrimeTarget',
  '2': 'AddressNotAllowed',
  '3': 'Uncheckable',
  '4': 'WaitTooShort',
  '5': 'NotScheduled',
  '6': 'NotRunnable',
  '7': 'NotACanceller',
  '8': 'NotWhereAgreed',
  '9': 'NoGate',
  '10': 'NoWait',
}

// ---------------------------------------------------------------- plumbing ---

type Res = {
  ok: boolean
  hash?: string
  error?: string
  fee?: number
  resourceFee?: number
  cpu?: number
  ret?: xdr.ScVal
  tx?: ReturnType<TransactionBuilder['build']>
}
let fails = 0
const rows: string[] = []
const report = (ok: boolean, label: string, detail: string) => {
  if (!ok) fails++
  const line = `${ok ? 'PASS' : 'FAIL'} ${label} | ${detail}`
  rows.push(line)
  console.log(line)
}
const short = (e?: string) =>
  [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') ||
  (e ?? '').slice(0, 160)
const codeOf = (e?: string) => (e ?? '').match(/Error\(Contract, #(\d+)\)/)?.[1]
const named = (e?: string) => {
  const c = codeOf(e)
  return c ? `#${c} ${NAMES[c] ?? ''}`.trim() : short(e)
}
const landed = (label: string, r: Res) =>
  report(r.ok, label, r.ok ? `tx ${r.hash} fee ${r.fee}` : `refused ${short(r.error)}`)
const refused = (label: string, r: Res, code?: string) =>
  report(
    !r.ok && (code === undefined || codeOf(r.error) === code),
    label,
    r.ok ? `PERMITTED ${r.hash ?? ''}` : `refused ${named(r.error)}${r.hash ? ` tx ${r.hash}` : ''}`
  )
const latest = async () => (await server.getLatestLedger()).sequence
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function untilLedger(seq: number) {
  while ((await latest()) < seq) await sleep(2000)
}

async function submitTx(tx: Res['tx'], extra: Partial<Res> = {}): Promise<Res> {
  const sent = await server.sendTransaction(tx!)
  if (sent.status === 'ERROR') return { ok: false, error: 'send refused', ...extra }
  for (let i = 0; i < 60; i++) {
    const r = await server.getTransaction(sent.hash)
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      const fee = Number(r.resultXdr.feeCharged().toString())
      return r.status === rpc.Api.GetTransactionStatus.SUCCESS
        ? { ok: true, hash: sent.hash, fee, ret: r.returnValue, ...extra }
        : { ok: false, hash: sent.hash, fee, error: `FAILED on chain ${r.status}`, ...extra }
    }
    await sleep(1000)
  }
  return { ok: false, hash: sent.hash, error: 'did not confirm', ...extra }
}
/** Simulate (recording auth unless the op carries entries), assemble and sign. */
async function prepare(op: xdr.Operation, src: Keypair): Promise<Res> {
  const tx = new TransactionBuilder(await server.getAccount(src.publicKey()), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(300)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error }
  const ready = rpc.assembleTransaction(tx, sim).build()
  ready.sign(src)
  return {
    ok: true,
    tx: ready,
    cpu: Number(sim.transactionData.build().resources().instructions()),
    resourceFee: Number(sim.minResourceFee),
  }
}
async function send(op: xdr.Operation, src: Keypair): Promise<Res> {
  const p = await prepare(op, src)
  return p.ok ? submitTx(p.tx, { cpu: p.cpu, resourceFee: p.resourceFee }) : p
}
async function classic(src: Keypair, ops: xdr.Operation[], signers: Keypair[] = []) {
  const b = new TransactionBuilder(await server.getAccount(src.publicKey()), {
    fee: '1000',
    networkPassphrase: PASSPHRASE,
  }).setTimeout(120)
  for (const o of ops) b.addOperation(o)
  const tx = b.build()
  tx.sign(src, ...signers)
  return submitTx(tx)
}
const invoke = (contract: string, fn: string, args: xdr.ScVal[]) =>
  Operation.invokeContractFunction({ contract, function: fn, args })
const create = (deployer: string, wasm: Buffer, salt: Buffer, args: xdr.ScVal[]) =>
  Operation.createCustomContract({
    address: Address.fromString(deployer),
    wasmHash: wasm,
    salt,
    constructorArgs: args,
  })
const contractId = (deployer: string, salt: Buffer) =>
  StrKey.encodeContract(
    hash(
      xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
          networkId: hash(Buffer.from(PASSPHRASE)),
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
const gateArg = (gate: string | null) => (gate ? addr(gate) : xdr.ScVal.scvVoid())
/** Where an adapter for `prime` lives: v5 hashes the XDR of the tuple
 *  (gate, min_wait, run_window), "no gate" being a void; v4 hashed the XDR of
 *  each part in turn. */
const adapterSalt = (gate: string | null, minWait: number, window: number, version = 'v5') =>
  hash(
    Buffer.concat([
      Buffer.from(`prime.execution.adapter.${version}`),
      ...(version === 'v5'
        ? [vec([gateArg(gate), u32v(minWait), u32v(window)]).toXDR()]
        : [gateArg(gate).toXDR(), u32v(minWait).toXDR(), u32v(window).toXDR()]),
    ])
  )
const execute = (adapter: string, calls: xdr.ScVal[], wait = 0, grants: xdr.ScVal[] = []) =>
  invoke(adapter, 'execute', [vec(calls), vec(grants), u32v(wait)])
const xfer = (token: string, from: string, to: string, amount: bigint) =>
  call(token, 'transfer', [addr(from), addr(to), i128v(amount)])

// --------------------------------------------------------------- signing ---

const countCtx = (i: xdr.SorobanAuthorizedInvocation): number =>
  1 + i.subInvocations().reduce((t, s) => t + countCtx(s), 0)
const nonce = () => new xdr.Int64(BigInt(`0x${randomBytes(8).toString('hex')}`) >> 1n)
const gSig = (k: Keypair, payload: Buffer) =>
  vec([
    xdr.ScVal.scvMap([
      kv('public_key', xdr.ScVal.scvBytes(k.rawPublicKey())),
      kv('signature', xdr.ScVal.scvBytes(k.sign(payload))),
    ]),
  ])
const entry = (
  who: string,
  n: xdr.Int64,
  exp: number,
  signature: xdr.ScVal,
  root: xdr.SorobanAuthorizedInvocation
) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(who).toScAddress(),
        nonce: n,
        signatureExpirationLedger: exp,
        signature,
      })
    ),
    rootInvocation: root,
  })

type Sign = {
  src: Keypair
  /** G accounts that sign their own entry. */
  gs?: Keypair[]
  /** An OZ account, its G signers, and its contract signers (no key signs those). */
  account?: string
  signers?: Keypair[]
  contractSigners?: string[]
  ruleIds?: number[]
  ttl?: number
}
/** Record `op`'s authorizations, then sign them. Returns the op with entries. */
async function signAuth(
  op: xdr.Operation,
  o: Sign
): Promise<{ op?: xdr.Operation; error?: string; entries?: xdr.SorobanAuthorizationEntry[] }> {
  const probe = new TransactionBuilder(await server.getAccount(o.src.publicKey()), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(300)
    .build()
  const sim = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error }
  const exp = (await latest()) + (o.ttl ?? 100)
  const entries: xdr.SorobanAuthorizationEntry[] = []
  for (const e of sim.result?.auth ?? []) {
    const c = e.credentials()
    if (c.switch().name !== 'sorobanCredentialsAddress') {
      entries.push(e)
      continue
    }
    const who = Address.fromScAddress(c.address().address()).toString()
    const n = c.address().nonce()
    const payload = signaturePayload(n, exp, e.rootInvocation())
    const g = o.gs?.find((k) => k.publicKey() === who)
    if (g) {
      entries.push(entry(who, n, exp, gSig(g, payload), e.rootInvocation()))
      continue
    }
    if (who !== o.account) {
      entries.push(e)
      continue
    }
    const given = o.ruleIds ?? [0]
    const ids = given.length === 1 ? new Array(countCtx(e.rootInvocation())).fill(given[0]) : given
    const digest = hash(Buffer.concat([payload, vec(ids.map(u32v)).toXDR()]))
    const keys = [...(o.signers ?? []).map((k) => k.publicKey()), ...(o.contractSigners ?? [])]
    const signers = xdr.ScVal.scvMap(
      keys
        .map(
          (a) =>
            new xdr.ScMapEntry({
              key: delegatedSigner(a),
              val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
            })
        )
        .sort((l, r) => Buffer.compare(l.key().toXDR(), r.key().toXDR()))
    )
    const sig = xdr.ScVal.scvMap([
      kv('context_rule_ids', vec(ids.map(u32v))),
      kv('signers', signers),
    ])
    entries.push(entry(who, n, exp, sig, e.rootInvocation()))
    for (const k of o.signers ?? []) {
      const nn = nonce()
      const root = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(who).toScAddress(),
            functionName: '__check_auth',
            args: [xdr.ScVal.scvBytes(digest)],
          })
        ),
        subInvocations: [],
      })
      entries.push(entry(k.publicKey(), nn, exp, gSig(k, signaturePayload(nn, exp, root)), root))
    }
  }
  const func = op.body().invokeHostFunctionOp().hostFunction()
  return { op: Operation.invokeHostFunction({ func, auth: entries }), entries }
}
async function sendSigned(op: xdr.Operation, o: Sign): Promise<Res> {
  const s = await signAuth(op, o)
  return s.op ? send(s.op, o.src) : { ok: false, error: s.error }
}
function tree(inv: xdr.SorobanAuthorizedInvocation, depth = 0): string {
  const f = inv.function()
  const head =
    f.switch().name === 'sorobanAuthorizedFunctionTypeContractFn'
      ? `${Address.fromScAddress(f.contractFn().contractAddress()).toString().slice(0, 8)}.${f.contractFn().functionName().toString()}`
      : 'create_contract'
  return `${'  '.repeat(depth)}${head}\n${inv
    .subInvocations()
    .map((s) => tree(s, depth + 1))
    .join('')}`
}
const describe = (entries: xdr.SorobanAuthorizationEntry[]) =>
  entries
    .map((e) => {
      const c = e.credentials()
      const who =
        c.switch().name === 'sorobanCredentialsAddress'
          ? Address.fromScAddress(c.address().address()).toString().slice(0, 8)
          : 'source'
      return `  entry ${who}\n${tree(e.rootInvocation(), 2)}`
    })
    .join('')

/** A read-only call, simulated. */
async function view(contract: string, fn: string, args: xdr.ScVal[]) {
  const tx = new TransactionBuilder(await server.getAccount(K.payer.publicKey()), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(invoke(contract, fn, args))
    .setTimeout(30)
    .build()
  const s = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(s) || !s.result) throw new Error('view failed')
  return scValToNative(s.result.retval)
}
const balance = async (token: string, who: string): Promise<bigint> =>
  BigInt(await view(token, 'balance', [addr(who)]))

/** A grammar-7 interpreter rule on the OZ account `prime`, installed through rule 0. */
async function addRule(
  prime: string,
  owner: Keypair,
  scope: string,
  signers: string[],
  name: string,
  where: Constraint[] = [],
  fn = 'execute'
) {
  const enc = encode(callExpr({ contract: scope, fn, where }))
  const args = ruleArgs(
    {
      scope: { kind: 'call_contract', contract: scope },
      name,
      validUntil: null,
      signers,
      admins: [owner.publicKey()],
      predicate: { encoded: enc, hash: hashOf(enc) },
      nonce: 1,
    },
    INTERP
  ).map((v) => xdr.ScVal.fromXDR(toScVal(v).toXDR('base64'), 'base64'))
  const r = await sendSigned(invoke(prime, 'add_context_rule', args), {
    src: owner,
    account: prime,
    signers: [owner],
  })
  if (!r.ok) throw new Error(`install ${name}: ${short(r.error)}`)
  return { id: Number(scValToNative(r.ret!).id), tx: r.hash }
}

// ------------------------------------------------------------------ setup ---

const K = {
  payer: Keypair.random(),
  issuer: Keypair.random(),
  owner: Keypair.random(),
  agent: Keypair.random(),
  xg: Keypair.random(),
  m: Keypair.random(),
  n: Keypair.random(),
  h: Keypair.random(),
  custody: Keypair.random(),
  stranger: Keypair.random(),
}
for (const k of Object.values(K)) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`)
  if (!r.ok) throw new Error(`friendbot ${r.status}`)
}
const X = K.xg.publicKey()
const M = K.m.publicKey()
const N = K.n.publicKey()
const USDC_ASSET = new Asset('USDC', K.issuer.publicKey())
const USDC = USDC_ASSET.contractId(PASSPHRASE)
const trust = (k: Keypair) => Operation.changeTrust({ asset: USDC_ASSET, source: k.publicKey() })
landed(
  'setup: USDC trustlines for X and M',
  await classic(K.payer, [trust(K.xg), trust(K.m)], [K.xg, K.m])
)
landed(
  'setup: issue 1000 USDC to X',
  await classic(K.issuer, [
    Operation.payment({ destination: X, asset: USDC_ASSET, amount: '1000' }),
  ])
)
landed(
  'setup: USDC asset contract',
  await send(Operation.createStellarAssetContract({ asset: USDC_ASSET }), K.payer)
)

const adapWasm = readFileSync(wasmPath('execution-adapter', 'execution_adapter'))
const gateWasm = readFileSync(wasmPath('custody-gate', 'custody_gate'))
const AW = hash(adapWasm)
const GW = hash(gateWasm)
for (const [name, w] of [
  ['adapter', adapWasm],
  ['gate', gateWasm],
] as const) {
  const r = await send(Operation.uploadContractWasm({ wasm: w }), K.payer)
  console.log(
    `upload ${name} ${hash(w).toString('hex')} ${r.ok ? `tx ${r.hash}` : `(${short(r.error)})`}`
  )
}
console.log(`adapter build ${AW.toString('hex')} (${adapWasm.length} B), interpreter ${INTERP}`)

// Z, whose get_signer_id(Delegated(H)) is "hello": on while H signs for Z.
const ozAccount = async (owner: Keypair, label: string) => {
  const r = await send(
    create(
      owner.publicKey(),
      Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      Keypair.random().rawPublicKey(),
      [vec([delegatedSigner(owner.publicKey())]), xdr.ScVal.scvMap([])]
    ),
    owner
  )
  if (!r.ok) throw new Error(`${label}: ${short(r.error)}`)
  return { id: Address.fromScVal(r.ret!).toString(), tx: r.hash }
}
const Z = (await ozAccount(K.owner, 'Z')).id
const helloOn = () =>
  sendSigned(invoke(Z, 'add_signer', [u32v(0), delegatedSigner(K.h.publicKey())]), {
    src: K.owner,
    account: Z,
    signers: [K.owner],
  })
async function helloOff() {
  const sid = await view(Z, 'get_signer_id', [delegatedSigner(K.h.publicKey())])
  return sendSigned(invoke(Z, 'remove_signer', [u32v(0), u32v(Number(sid))]), {
    src: K.owner,
    account: Z,
    signers: [K.owner, K.h],
  })
}
const hello = call(Z, 'get_signer_id', [delegatedSigner(K.h.publicKey())])
landed(`setup: Z ${Z.slice(0, 8)} lists H, so hello answers`, await helloOn())

const bal = async (who: string) => ({
  usdcX: await balance(USDC, who),
  xlmX: await balance(XLM, who),
  usdcM: await balance(USDC, M),
  xlmN: await balance(XLM, N),
})
const show = (b: Record<string, bigint>) =>
  Object.entries(b)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
const same = (a: Record<string, bigint>, b: Record<string, bigint>) =>
  Object.keys(a).every((k) => a[k] === b[k])

// ----------------------------------------------------- G account as Prime ---

console.log('\n-- X is a G account')
const nullG = contractId(X, adapterSalt(null, 0, WINDOW))
refused(
  "G0a. a third party creates X's null adapter from its own address",
  await send(
    create(K.payer.publicKey(), AW, adapterSalt(null, 0, WINDOW), [
      addr(X),
      gateArg(null),
      u32v(0),
      u32v(WINDOW),
    ]),
    K.payer
  ),
  '8'
)
const g0 = await send(
  create(X, AW, adapterSalt(null, 0, WINDOW), [addr(X), gateArg(null), u32v(0), u32v(WINDOW)]),
  K.xg
)
landed(`G0b. X creates its null adapter as transaction source ${nullG}`, g0)
report(
  g0.ok && Address.fromScVal(g0.ret!).toString() === nullG,
  'G0c. at the address derived with "no gate" = void',
  nullG
)

const bundleG = (usdc = 10n * U, xlm = U) =>
  execute(nullG, [hello, xfer(USDC, X, M, usdc), xfer(XLM, X, N, xlm)])
{
  const s = await signAuth(bundleG(), { src: K.payer, gs: [K.xg] })
  console.log(`G1 authorizations:\n${describe(s.entries ?? [])}`)
  const b0 = await bal(X)
  const r = s.op ? await send(s.op, K.payer) : { ok: false, error: s.error }
  const b1 = await bal(X)
  landed(
    'G1. hello answers: [hello, USDC.transfer(X,M,10), XLM.transfer(X,N,1)], one entry signed by X',
    r
  )
  report(
    (s.entries ?? []).length === 1 && b1.usdcM - b0.usdcM === 10n * U && b1.xlmN - b0.xlmN === U,
    'G1b. one authorization covered both nested transfers, and both landed',
    `entries ${(s.entries ?? []).length}, M +${b1.usdcM - b0.usdcM}, N +${b1.xlmN - b0.xlmN}`
  )
}
{
  const s = await signAuth(bundleG(), { src: K.payer, gs: [K.xg], ttl: 120 })
  const p = s.op ? await prepare(s.op, K.payer) : { ok: false, error: s.error }
  report(p.ok, 'G2a. a second bundle is signed and simulated while hello answers', short(p.error))
  landed("G2b. Z's owners remove H, so hello now fails", await helloOff())
  const alone = await prepare(execute(nullG, [hello]), K.xg)
  refused('G2c. hello alone now fails', alone)
  const b0 = await bal(X)
  const r = await submitTx(p.tx)
  const b1 = await bal(X)
  refused('G2d. the bundle fails on chain at hello', r)
  report(same(b0, b1), 'G2e. nothing moved', show(b1))
  landed('G3a. H is added back, hello answers again', await helloOn())
  const again = await send(s.op!, K.payer)
  landed(
    'G3b. the SAME signed entry, resubmitted before its expiry ledger, now runs (it is a bearer instrument until then)',
    again
  )
  const s2 = await signAuth(bundleG(1n, 1n), { src: K.payer, gs: [K.xg], ttl: 1 })
  const exp = (await latest()) + 2
  await untilLedger(exp + 1)
  refused(
    'G4. an entry signed with a short expiry is refused once that ledger has passed',
    await send(s2.op!, K.payer)
  )
}
refused(
  'G5. the Prime itself as a call target',
  await prepare(execute(nullG, [call(X, 'hello', [])]), K.xg),
  '1'
)
const authAsAdapter = vec([
  sym('Contract'),
  xdr.ScVal.scvMap([
    kv(
      'context',
      xdr.ScVal.scvMap([
        kv('args', vec([])),
        kv('contract', addr(USDC)),
        kv('fn_name', sym('transfer')),
      ])
    ),
    kv('sub_invocations', vec([])),
  ]),
])
refused(
  'G6. a grant the adapter would hand out as itself',
  await prepare(execute(nullG, [hello], 0, [authAsAdapter]), K.xg),
  '3'
)
refused(
  'G7. rebind on a null adapter, even by the Prime',
  await prepare(invoke(nullG, 'rebind', [addr(Z)]), K.xg),
  '9'
)
{
  const s = await prepare(execute(nullG, [xfer(USDC, X, M, 2n * U)], 2), K.xg)
  refused('G8. X asks the null adapter to store a batch (wait 2)', s, '10')
  refused(
    'G9a. a stranger cancels on the null adapter',
    await prepare(invoke(nullG, 'cancel', [u32v(1), addr(K.stranger.publicKey())]), K.stranger),
    '7'
  )
  landed(
    'G9b. X cancels (there is nothing stored to drop)',
    await send(invoke(nullG, 'cancel', [u32v(1), addr(X)]), K.xg)
  )
  refused('G9c. there is nothing to run', await prepare(invoke(nullG, 'run', [u32v(1)]), K.xg), '5')
}

// -------------------------------------------------- OZ account as Prime ---

console.log('\n-- X is an OZ smart account (wasm 91a2cd56)')
const xc = await ozAccount(K.owner, 'X_C')
const XC = xc.id
landed(`C0a. X_C ${XC}, rule 0: Delegated(owner)`, { ok: true, hash: xc.tx })
landed(
  'C0b. fund X_C with 20 XLM',
  await send(
    invoke(XLM, 'transfer', [addr(K.payer.publicKey()), addr(XC), i128v(20n * U)]),
    K.payer
  )
)
landed(
  'C0c. fund X_C with 500 USDC',
  await send(
    invoke(USDC, 'transfer', [addr(K.issuer.publicKey()), addr(XC), i128v(500n * U)]),
    K.issuer
  )
)
const nullC = contractId(XC, adapterSalt(null, 0, WINDOW))
landed(
  `C1. X_C creates its null adapter through rule 0 ${nullC}`,
  await sendSigned(
    create(XC, AW, adapterSalt(null, 0, WINDOW), [addr(XC), gateArg(null), u32v(0), u32v(WINDOW)]),
    {
      src: K.owner,
      account: XC,
      signers: [K.owner],
    }
  )
)
const bundleC = (usdc: bigint, xlm: bigint) =>
  execute(nullC, [hello, xfer(USDC, XC, M, usdc), xfer(XLM, XC, N, xlm)])
{
  const b0 = await bal(XC)
  const r = await sendSigned(bundleC(10n * U, U), {
    src: K.owner,
    account: XC,
    signers: [K.owner],
    ruleIds: [0],
  })
  const b1 = await bal(XC)
  landed(
    'C2. owners: [hello, USDC.transfer, XLM.transfer], one owner signature, rule 0 for each of the 3 contexts',
    r
  )
  report(
    b1.usdcM - b0.usdcM === 10n * U && b1.xlmN - b0.xlmN === U,
    'C2b. both transfers landed',
    `M +${b1.usdcM - b0.usdcM}, N +${b1.xlmN - b0.xlmN}`
  )
}
const CAP = 20n * U
const agentA = await addRule(XC, K.owner, nullC, [K.agent.publicKey()], 'agent-execute')
const agentU = await addRule(
  XC,
  K.owner,
  USDC,
  [K.agent.publicKey()],
  'agent-usdc',
  [{ constraint: 'cap', at: [2], max: String(CAP) }],
  'transfer'
)
const agentL = await addRule(
  XC,
  K.owner,
  XLM,
  [K.agent.publicKey()],
  'agent-xlm',
  [{ constraint: 'cap', at: [2], max: String(2n * U) }],
  'transfer'
)
report(
  true,
  'C3. agent rules on the grammar-7 interpreter: execute on the adapter, transfer <= 20 USDC, transfer <= 2 XLM',
  `rules ${agentA.id} ${agentU.id} ${agentL.id}, txs ${agentA.tx} ${agentU.tx} ${agentL.tx}`
)
function asAgent(ids: number[]): Sign {
  return { src: K.agent, account: XC, signers: [K.agent], ruleIds: ids }
}
{
  const b0 = await bal(XC)
  const r = await sendSigned(bundleC(CAP, U), asAgent([agentA.id, agentU.id, agentL.id]))
  const b1 = await bal(XC)
  landed('C4. the agent alone: the bundle at its USDC cap, one rule per context', r)
  report(
    b1.usdcM - b0.usdcM === CAP && b1.xlmN - b0.xlmN === U,
    'C4b. both transfers landed',
    `M +${b1.usdcM - b0.usdcM}, N +${b1.xlmN - b0.xlmN}`
  )
}
refused(
  'C5. the agent one stroop over its USDC cap',
  await sendSigned(bundleC(CAP + 1n, U), asAgent([agentA.id, agentU.id, agentL.id]))
)
refused(
  'C5b. the same, with the adapter named as a co-signer: no rule lists it',
  await sendSigned(bundleC(CAP + 1n, U), {
    ...asAgent([agentA.id, agentU.id, agentL.id]),
    contractSigners: [nullC],
  })
)
refused(
  'C6. the agent names its adapter rule for the transfer contexts',
  await sendSigned(bundleC(U, U), asAgent([agentA.id, agentA.id, agentA.id]))
)
refused(
  'C7. the Prime itself as a call target',
  await prepare(execute(nullC, [call(XC, 'get_context_rules_count', [])]), K.owner),
  '1'
)
refused(
  'C8a. the owners ask the null adapter to store a batch (wait 5)',
  await sendSigned(execute(nullC, [xfer(USDC, XC, M, U)], 5), {
    src: K.owner,
    account: XC,
    signers: [K.owner],
  }),
  '10'
)
refused(
  'C8b. the agent asks the same (wait 5)',
  await sendSigned(execute(nullC, [xfer(USDC, XC, M, U)], 5), asAgent([agentA.id])),
  '10'
)
refused(
  'C8c. a stranger cancels on the null adapter',
  await prepare(invoke(nullC, 'cancel', [u32v(1), addr(K.stranger.publicKey())]), K.stranger),
  '7'
)
refused(
  'C8d. the agent cancels as the Prime: its rule permits execute only',
  await sendSigned(invoke(nullC, 'cancel', [u32v(1), addr(XC)]), asAgent([agentA.id]))
)
landed(
  'C8e. the owners cancel (nothing is stored to drop)',
  await sendSigned(invoke(nullC, 'cancel', [u32v(1), addr(XC)]), {
    src: K.owner,
    account: XC,
    signers: [K.owner],
  })
)
refused(
  'C8f. a null adapter with a minimum wait cannot be created',
  await sendSigned(
    create(XC, AW, adapterSalt(null, 5, WINDOW), [addr(XC), gateArg(null), u32v(5), u32v(WINDOW)]),
    { src: K.owner, account: XC, signers: [K.owner] }
  ),
  '10'
)
refused(
  'C9. rebind on a null adapter',
  await prepare(invoke(nullC, 'rebind', [addr(Z)]), K.owner),
  '9'
)

// --------------------------------------------- the binding and custody ---

console.log("\n-- a gated adapter on this build, and custody's gate")
const gSalt = Buffer.from(Keypair.random().rawPublicKey())
const R = contractId(K.custody.publicKey(), gSalt)
const gatedC = contractId(XC, adapterSalt(R, 0, WINDOW))
const gateCfg = (custody: string, caller: string, code: Buffer, allowed: string[]) =>
  xdr.ScVal.scvMap([
    kv('allowed', vec(allowed.map(addr))),
    kv('caller', addr(caller)),
    kv('caller_code', xdr.ScVal.scvBytes(code)),
    kv('custody', addr(custody)),
  ])
landed(
  `B0a. custody's gate R ${R.slice(0, 8)} names the gated adapter ${gatedC.slice(0, 8)} and this build`,
  await send(
    create(K.custody.publicKey(), GW, gSalt, [
      gateCfg(K.custody.publicKey(), gatedC, AW, [XLM, USDC, XC, M, N, K.custody.publicKey()]),
    ]),
    K.custody
  )
)
landed(
  'B0b. custody approves R for 5 XLM',
  await send(
    invoke(XLM, 'approve', [
      addr(K.custody.publicKey()),
      addr(R),
      i128v(5n * U),
      u32v((await latest()) + 5000),
    ]),
    K.custody
  )
)
landed(
  'B0c. X_C creates the gated adapter through rule 0',
  await sendSigned(
    create(XC, AW, adapterSalt(R, 0, WINDOW), [addr(XC), gateArg(R), u32v(0), u32v(WINDOW)]),
    { src: K.owner, account: XC, signers: [K.owner] }
  )
)
const pull = (amount: bigint) => call(R, 'pull', [addr(XLM), addr(XC), i128v(amount)])
landed(
  'B1. the gated adapter pulls 1 XLM from custody to X_C (control)',
  await sendSigned(execute(gatedC, [pull(U)]), { src: K.owner, account: XC, signers: [K.owner] })
)
{
  const c0 = await balance(XLM, K.custody.publicKey())
  refused(
    "B2. the null adapter pulls through custody's gate R",
    await sendSigned(execute(nullC, [pull(U)]), { src: K.owner, account: XC, signers: [K.owner] })
  )
  report(
    (await balance(XLM, K.custody.publicKey())) === c0,
    "B2b. custody's balance is unchanged",
    String(c0)
  )
}
{
  const r = await prepare(invoke(gatedC, 'rebind', [xdr.ScVal.scvVoid()]), K.custody)
  refused('B3. custody rebinds the gated adapter to "no gate"', r)
  const st = await server.getContractData(gatedC, xdr.ScVal.scvLedgerKeyContractInstance())
  const storage = st.val.contractData().val().instance().storage() ?? []
  const g = storage.find(
    (e) => e.key().switch().name === 'scvSymbol' && e.key().sym().toString() === 'gate'
  )
  report(!!g && Address.fromScVal(g.val()).toString() === R, 'B3b. it is still bound to R', R)
}

// -------------------------------------------------------------- cost ---

console.log('\n-- cost: k USDC transfers of 1 stroop from X (G, source) to M')
const adapters: [string, string][] = [['v5 null', nullG]]
for (const version of ['v5', 'v4'] as const) {
  const code = version === 'v5' ? AW : Buffer.from(V4_ADAPTER, 'hex')
  const salt = Buffer.from(Keypair.random().rawPublicKey())
  const gate = contractId(K.payer.publicKey(), salt)
  const adapter = contractId(X, adapterSalt(gate, 0, WINDOW, version))
  const r = await send(
    create(K.payer.publicKey(), GW, salt, [gateCfg(X, adapter, code, [USDC, M, X])]),
    K.payer
  )
  if (!r.ok) throw new Error(`allow-list gate: ${short(r.error)}`)
  const d = await send(
    create(X, code, adapterSalt(gate, 0, WINDOW, version), [
      addr(X),
      addr(gate),
      u32v(0),
      u32v(WINDOW),
    ]),
    K.xg
  )
  landed(`cost setup: ${version} gated adapter ${adapter.slice(0, 8)} on an allow-list gate`, d)
  adapters.push([`${version} gated`, adapter])
}
const table: string[] = [
  '| Adapter | Calls | CPU instructions | Min resource fee | Charged | Transaction |',
  '|---|---|---|---|---|---|',
]
for (const [label, adapter] of adapters) {
  await send(execute(adapter, [xfer(USDC, X, M, 1n)]), K.xg) // first use extends the instance
  for (const k of [1, 3, 10]) {
    const r = await send(
      execute(
        adapter,
        Array.from({ length: k }, () => xfer(USDC, X, M, 1n))
      ),
      K.xg
    )
    landed(`cost ${label}, ${k} calls`, r)
    table.push(
      `| ${label} | ${k} | ${r.cpu?.toLocaleString('en')} | ${r.resourceFee?.toLocaleString('en')} | ${r.fee?.toLocaleString('en')} | \`${r.hash}\` |`
    )
  }
}
console.log('\n-- cost: k USDC transfers of 1 stroop from X_C (OZ account, rule 0) to M')
for (const [label, adapter] of [
  ['v5 null', nullC],
  ['v5 gated', gatedC],
] as const) {
  for (const k of [1, 3, 10]) {
    const r = await sendSigned(
      execute(
        adapter,
        Array.from({ length: k }, () => xfer(USDC, XC, M, 1n))
      ),
      { src: K.owner, account: XC, signers: [K.owner] }
    )
    landed(`cost OZ ${label}, ${k} calls`, r)
    table.push(
      `| OZ ${label} | ${k} | ${r.cpu?.toLocaleString('en')} | ${r.resourceFee?.toLocaleString('en')} | ${r.fee?.toLocaleString('en')} | \`${r.hash}\` |`
    )
  }
}
console.log(`\n${table.join('\n')}`)
console.log(
  `\naccounts: X ${X}, X_C ${XC}, Z ${Z}, M ${M}, N ${N}, custody ${K.custody.publicKey()}, USDC ${USDC}`
)
console.log(`\n${fails === 0 ? 'all checks passed' : `${fails} FAILED`} (${rows.length} rows)`)
if (fails > 0) process.exit(1)
