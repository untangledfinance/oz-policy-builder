// Testnet ONLY. Generates disposable faucet-funded keys; never reads production keys.
// Run from repository root with STATE and BUILD overrides if desired.
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  nativeToScVal,
  hash,
  StrKey,
} from '@stellar/stellar-sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import assert from 'node:assert/strict'
import { encodePredicate } from '../packages/policy-synth/src/predicate/encode.ts'
import {
  buildExecutionBatchPolicy,
  projectExecutionRequest,
} from '../packages/policy-synth/src/install/execution-batch.ts'
import {
  accountEntry,
  authDigest,
  authPayload,
  delegatedSigner,
  delegatedSignerEntry,
  signaturePayload,
} from './execution-oz-auth.ts'

const PASS = Networks.TESTNET,
  RPC = 'https://soroban-testnet.stellar.org'
const server = new rpc.Server(RPC)
const STATE = process.env.PRIME_STATE ?? '/home/ubuntu/.local/state/prime-stateless-testnet.json'
const BUILD =
  process.env.PRIME_BUILD ?? '/home/ubuntu/work/prime-stateless-wasm/wasm32v1-none/release'
const EVIDENCE = 'docs/stateless-execution-testnet.json'
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
const AMOUNT = 1000000n,
  CAP = 2000000n,
  ALL = (1n << 127n) - 1n
const salt = hash(Buffer.from('prime.execution.adapter.v1'))
let state: any = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : {
      owner: Keypair.random().secret(),
      agent: Keypair.random().secret(),
      contracts: {},
      rules: {},
      hashes: {},
      uploaded: [],
      transactions: [],
      checks: [],
      bound: [],
    }
const owner = Keypair.fromSecret(state.owner),
  agent = Keypair.fromSecret(state.agent)
const addr = (a: string) => new Address(a).toScVal()
const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u32 = (n: number) => xdr.ScVal.scvU32(n)
const int = (n: bigint) => nativeToScVal(n, { type: 'i128' })
const vec = (a: xdr.ScVal[]) => xdr.ScVal.scvVec(a)
const map = (o: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(o)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: o[k]! }))
  )
const big = (v: xdr.ScVal) =>
  (BigInt(v.i128().hi().toString()) << 64n) + BigInt(v.i128().lo().toString())
const fields = (v: xdr.ScVal) =>
  new Map((v.map() ?? []).map((e) => [e.key().sym().toString(), e.val()]))
function save() {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 })
  chmodSync(STATE, 0o600)
  writeFileSync(
    EVIDENCE,
    JSON.stringify(
      {
        network: 'TESTNET',
        rpc: RPC,
        updatedAt: new Date().toISOString(),
        sourceCommit: '47df478',
        owner: owner.publicKey(),
        agent: agent.publicKey(),
        token: TOKEN,
        pool: POOL,
        contracts: state.contracts,
        wasmHashes: state.hashes,
        rules: state.rules,
        bound: state.bound,
        salt: salt.toString('hex'),
        transactions: state.transactions,
        checks: state.checks,
        final: state.final,
      },
      null,
      2
    ) + '\n'
  )
}
save()
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function faucet(k: Keypair) {
  try {
    await server.getAccount(k.publicKey())
    return
  } catch {}
  const r = await fetch('https://friendbot.stellar.org/?addr=' + k.publicKey())
  assert(r.ok, 'friendbot failed ' + r.status)
}
async function base(k: Keypair, op: any) {
  return new TransactionBuilder(await server.getAccount(k.publicKey()), {
    fee: '2000000',
    networkPassphrase: PASS,
  })
    .addOperation(op)
    .setTimeout(600)
    .build()
}
async function submit(tx: any, label: string, expected = 'SUCCESS') {
  const txHash = tx.hash().toString('hex')
  state.pending = { label, hash: txHash }
  save()
  const sent = await server.sendTransaction(tx)
  assert(sent.status !== 'ERROR', label + ' send error ' + sent.errorResult?.toXDR('base64'))
  for (let n = 0; n < 80; n++) {
    const r = await server.getTransaction(txHash)
    if (r.status === 'SUCCESS' || r.status === 'FAILED') {
      const entry = {
        label,
        hash: txHash,
        status: r.status,
        ledger: r.ledger,
        resultXdr: r.status === 'FAILED' ? r.resultXdr?.toXDR('base64') : undefined,
      }
      state.transactions.push(entry)
      delete state.pending
      save()
      console.log(JSON.stringify(entry))
      assert.equal(r.status, expected, label)
      return r as any
    }
    await pause(1500)
  }
  throw new Error(label + ' receipt timeout ' + txHash)
}
async function plain(k: Keypair, target: string, fn: string, args: xdr.ScVal[], label: string) {
  const tx = await server.prepareTransaction(await base(k, new Contract(target).call(fn, ...args)))
  tx.sign(k)
  return submit(tx, label)
}
async function view(target: string, fn: string, args: xdr.ScVal[] = []) {
  const sim = await server.simulateTransaction(
    await base(agent, new Contract(target).call(fn, ...args))
  )
  assert(!rpc.Api.isSimulationError(sim), 'view ' + fn + ' ' + (sim as any).error)
  assert(sim.result, 'missing result')
  return sim.result.retval
}
async function upload(name: string, path: string) {
  const wasm = readFileSync(path),
    digest = hash(wasm).toString('hex')
  if (state.hashes[name]) assert.equal(state.hashes[name], digest, 'WASM changed; use fresh state')
  state.hashes[name] = digest
  save()
  if (!state.uploaded.includes(digest)) {
    const tx = await server.prepareTransaction(
      await base(owner, Operation.uploadContractWasm({ wasm }))
    )
    tx.sign(owner)
    await submit(tx, 'upload ' + name)
    state.uploaded.push(digest)
    save()
  }
  return digest
}
async function deploy(name: string, wasmHash: string, args: xdr.ScVal[]) {
  if (state.contracts[name]) return state.contracts[name]
  const tx = await server.prepareTransaction(
    await base(
      owner,
      Operation.createCustomContract({
        address: new Address(owner.publicKey()),
        wasmHash: Buffer.from(wasmHash, 'hex'),
        constructorArgs: args,
      })
    )
  )
  tx.sign(owner)
  const r = await submit(tx, 'deploy ' + name)
  state.contracts[name] = Address.fromScVal(r.returnValue).toString()
  save()
  return state.contracts[name]
}
function contexts(inv: xdr.SorobanAuthorizedInvocation): { target: string; method: string }[] {
  const f = inv.function()
  const row =
    f.switch().name === 'sorobanAuthorizedFunctionTypeContractFn'
      ? {
          target: Address.fromScAddress(f.contractFn().contractAddress()).toString(),
          method: f.contractFn().functionName().toString(),
        }
      : { target: '*', method: f.switch().name }
  return [row, ...inv.subInvocations().flatMap(contexts)]
}
async function authorize(
  k: Keypair,
  operation: (auth: xdr.SorobanAuthorizationEntry[]) => any,
  rules: Record<string, number>,
  adapterSigner = false,
  deny = false
) {
  const recording = await server.simulateTransaction(await base(k, operation([])))
  assert(!rpc.Api.isSimulationError(recording), 'recording ' + (recording as any).error)
  const original = recording.result?.auth?.find(
    (a) =>
      a.credentials().switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(a.credentials().address().address()).toString() ===
        state.contracts.prime
  )
  assert(original, 'Prime authorization missing')
  const seen = contexts(original.rootInvocation())
  const ids = seen.map((c) => {
    const id = rules[c.target] ?? rules['*']
    assert(id !== undefined, 'no rule ' + JSON.stringify(c))
    return id
  })
  const expiry = (await server.getLatestLedger()).sequence + 200
  const digest = authDigest(
    signaturePayload(
      PASS,
      original.credentials().address().nonce(),
      expiry,
      original.rootInvocation()
    ),
    ids
  )
  const signers = [k.publicKey(), ...(adapterSigner ? [state.contracts.adapter] : [])]
  const auth = [
    ...(recording.result?.auth ?? []).filter((a) => a !== original),
    accountEntry(original, expiry, authPayload(signers, ids)),
    delegatedSignerEntry(state.contracts.prime, digest),
  ]
  const tx = await base(k, operation(auth)),
    sim = await server.simulateTransaction(tx)
  if (deny) {
    assert(rpc.Api.isSimulationError(sim), 'attack was permitted')
    return { error: sim.error, contexts: seen } as any
  }
  assert(!rpc.Api.isSimulationError(sim), 'enforcing auth ' + (sim as any).error + ' ids=' + ids)
  const ready = rpc.assembleTransaction(tx, sim).build()
  ready.sign(k)
  return { tx: ready, contexts: seen }
}
const invoke =
  (target: string, fn: string, args: xdr.ScVal[]) => (auth: xdr.SorobanAuthorizationEntry[]) =>
    Operation.invokeContractFunction({ contract: target, function: fn, args, auth })
const call = (target: string, fn: string, args: xdr.ScVal[], auth: xdr.ScVal[] = []) =>
  map({
    target: addr(target),
    function_name: sym(fn),
    args: vec(args),
    executor_authorizations: vec(auth),
  })
const pull = (amount: bigint, to = state.contracts.adapter) =>
  call(TOKEN, 'transfer_from', [
    addr(state.contracts.prime),
    addr(owner.publicKey()),
    addr(to),
    int(amount),
  ])
function pool(amount: bigint, kind = 0, recipient = owner.publicKey()) {
  const auth = vec([
    sym('Contract'),
    map({
      context: map({
        contract: addr(TOKEN),
        fn_name: sym('transfer'),
        args: vec([addr(state.contracts.adapter), addr(POOL), int(amount)]),
      }),
      sub_invocations: vec([]),
    }),
  ])
  return call(
    POOL,
    'submit',
    [
      addr(state.contracts.prime),
      addr(state.contracts.adapter),
      addr(recipient),
      vec([map({ address: addr(TOKEN), amount: int(amount), request_type: u32(kind) })]),
    ],
    kind === 0 ? [auth] : []
  )
}
const act = (value: number) =>
  call(state.contracts.fixture, 'act', [addr(state.contracts.prime), u32(value)])
const request = (calls: xdr.ScVal[]) => [
  addr(state.contracts.prime),
  addr(state.contracts.interpreter),
  vec(calls),
  vec([]),
]
const literalA = (s: string) => ({ kind: 'literal_address', value: s })
const literalS = (s: string) => ({ kind: 'literal_symbol', value: s })
const literalI = (n: bigint) => ({ kind: 'literal_i128', value: n.toString() })
const arg = (index: number) => ({ kind: 'call_arg', index })
const eq = (left: any, right: any) => ({ op: 'eq', left, right })
const and = (...children: any[]) => ({ op: 'and', children })
function root(calls: xdr.ScVal[], variable = true) {
  const req = vec(request(calls)),
    projected = projectExecutionRequest(req)
  const slots = projected.flatMap((v, index) =>
    v.switch().name === 'scvI128' && big(v) === AMOUNT ? [index] : []
  )
  return buildExecutionBatchPolicy(
    req,
    variable && slots.length ? [{ slots, min: '1', maxExclusive: CAP.toString() }] : []
  )
}
async function install(name: string, target: string, signer: string, encoded: any) {
  if (state.rules[name] !== undefined) return state.rules[name]
  const params = map({
    grammar_version: u32(5),
    install_nonce: u32(1),
    predicate: xdr.ScVal.scvBytes(Buffer.from(encoded.encodedPredicate, 'base64')),
    predicate_hash: xdr.ScVal.scvBytes(Buffer.from(encoded.predicateHash, 'hex')),
    policy_admins: vec([delegatedSigner(owner.publicKey())]),
  })
  const args = [
    vec([sym('CallContract'), addr(target)]),
    xdr.ScVal.scvString(name),
    xdr.ScVal.scvVoid(),
    vec([delegatedSigner(signer)]),
    xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: addr(state.contracts.interpreter), val: params })]),
  ]
  const b = await authorize(owner, invoke(state.contracts.prime, 'add_context_rule', args), {
    '*': 0,
  })
  const r = await submit(b.tx, 'install ' + name),
    rule = fields(r.returnValue)
  state.rules[name] = rule.get('id')!.u32()
  save()
  return state.rules[name]
}
async function bind(name: string) {
  if (state.bound.includes(name)) return
  const args = [
    vec([addr(state.contracts.prime), u32(state.rules[name])]),
    addr(state.contracts.adapter),
  ]
  const b = await authorize(owner, invoke(state.contracts.interpreter, 'bind_executor', args), {
    '*': 0,
  })
  await submit(b.tx, 'bind ' + name)
  state.bound.push(name)
  save()
}
function rules(rootName: string) {
  return {
    [state.contracts.adapter]: state.rules[rootName],
    [TOKEN]: state.rules.token,
    [POOL]: state.rules.pool,
    [state.contracts.fixture]: state.rules.action,
  }
}
async function execution(calls: xdr.ScVal[], name: string, deny = false) {
  return authorize(
    agent,
    invoke(state.contracts.adapter, 'execute', request(calls)),
    rules(name),
    true,
    deny
  )
}
async function snapshot() {
  const balance = async (a: string) => big(await view(TOKEN, 'balance', [addr(a)])).toString()
  const pos = fields(await view(POOL, 'get_positions', [addr(state.contracts.prime)]))
  return {
    wallet: await balance(owner.publicKey()),
    prime: await balance(state.contracts.prime),
    adapter: await balance(state.contracts.adapter),
    primeAllowance: big(
      await view(TOKEN, 'allowance', [addr(owner.publicKey()), addr(state.contracts.prime)])
    ).toString(),
    adapterAllowance: big(
      await view(TOKEN, 'allowance', [addr(owner.publicKey()), addr(state.contracts.adapter)])
    ).toString(),
    supplyShares: (pos.get('supply')?.map() ?? [])
      .reduce((n, e) => n + big(e.val()), 0n)
      .toString(),
    action: (await view(state.contracts.fixture, 'get')).u32(),
  }
}
async function check(name: string, fn: () => Promise<any>) {
  if (state.checks.some((c: any) => c.name === name)) return
  const result = await fn()
  state.checks.push({ name, result })
  save()
  console.log('PASS', name, JSON.stringify(result))
}
async function deny(name: string, calls: xdr.ScVal[], rootName = 'supply') {
  await check(name, async () => {
    const before = await snapshot(),
      result = await execution(calls, rootName, true)
    assert(/Error\((Auth|Contract),/.test(result.error), 'unexpected failure ' + result.error)
    assert.deepEqual(await snapshot(), before)
    return { stage: 'enforcing RPC simulation', error: result.error, unchanged: true }
  })
}

await faucet(owner)
await faucet(agent)
await deploy(
  'prime',
  await upload(
    'oz-account',
    'contracts/policy-interpreter/tests/fixtures/multisig_account_example.wasm'
  ),
  [vec([delegatedSigner(owner.publicKey())]), map({})]
)
await deploy('interpreter', await upload('interpreter', BUILD + '/policy_interpreter.wasm'), [])
const adapterHash = await upload('adapter', BUILD + '/execution_adapter.wasm')
const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
  new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(PASS)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: new Address(state.contracts.prime).toScAddress(),
        salt,
      })
    ),
  })
)
const predicted = StrKey.encodeContract(hash(preimage.toXDR()))
if (!state.contracts.adapter) {
  const create = (auth: xdr.SorobanAuthorizationEntry[]) =>
    Operation.createCustomContract({
      address: new Address(state.contracts.prime),
      salt,
      wasmHash: Buffer.from(adapterHash, 'hex'),
      constructorArgs: [],
      auth,
    })
  const b = await authorize(owner, create, { '*': 0 }),
    r = await submit(b.tx, 'activate stateless adapter')
  assert.equal(Address.fromScVal(r.returnValue).toString(), predicted)
  state.contracts.adapter = predicted
  save()
}
assert.equal(state.contracts.adapter, predicted)
await deploy('fixture', await upload('fixture', BUILD + '/execution_test_venue.wasm'), [
  addr(owner.publicKey()),
])
assert.equal((await view(state.contracts.interpreter, 'grammar_version')).u32(), 5)

// Bind child rules BEFORE installing any agent root. This avoids a live unbound child window.
const positive = (a: any) => [
  { op: 'gt', left: a, right: literalI(0n) },
  { op: 'lt', left: a, right: literalI(CAP) },
]
await install(
  'token',
  TOKEN,
  state.contracts.adapter,
  encodePredicate(
    and(
      eq({ kind: 'call_fn' }, literalS('transfer_from')),
      eq(arg(0), literalA(state.contracts.prime)),
      eq(arg(1), literalA(owner.publicKey())),
      eq(arg(2), literalA(state.contracts.adapter)),
      ...positive(arg(3))
    ) as any
  )
)
await bind('token')
const field = (name: string) => ({ kind: 'call_arg_field', index: 3, element: 0, field: name })
await install(
  'pool',
  POOL,
  state.contracts.adapter,
  encodePredicate(
    and(
      eq({ kind: 'call_fn' }, literalS('submit')),
      eq(arg(0), literalA(state.contracts.prime)),
      eq(arg(1), literalA(state.contracts.adapter)),
      eq(arg(2), literalA(owner.publicKey())),
      eq({ kind: 'call_arg_len', index: 3 }, { kind: 'literal_u32', value: 1 }),
      eq(field('address'), literalA(TOKEN)),
      {
        op: 'or',
        children: [
          and(
            eq(field('request_type'), { kind: 'literal_u32', value: 0 }),
            ...positive(field('amount'))
          ),
          and(
            eq(field('request_type'), { kind: 'literal_u32', value: 1 }),
            eq(field('amount'), literalI(ALL))
          ),
        ],
      }
    ) as any
  )
)
await bind('pool')
await install(
  'action',
  state.contracts.fixture,
  state.contracts.adapter,
  encodePredicate(
    and(
      eq({ kind: 'call_fn' }, literalS('act')),
      eq(arg(0), literalA(state.contracts.prime))
    ) as any
  )
)
await bind('action')
for (const [name, calls] of [
  ['supply', [pull(AMOUNT), pool(AMOUNT)]],
  ['withdraw', [pool(ALL, 1)]],
  ['claim', [act(7)]],
  ['rollback', [pull(AMOUNT), act(8)]],
] as [string, xdr.ScVal[]][]) {
  await install(name, state.contracts.adapter, agent.publicKey(), root(calls))
  await bind(name)
}
await check('approve Prime only', async () => {
  await plain(
    owner,
    TOKEN,
    'approve',
    [
      addr(owner.publicKey()),
      addr(state.contracts.prime),
      int(4n * AMOUNT),
      u32((await server.getLatestLedger()).sequence + 1000),
    ],
    'approve Prime allowance'
  )
  const s = await snapshot()
  assert.equal(s.primeAllowance, (4n * AMOUNT).toString())
  assert.equal(s.adapterAllowance, '0')
  return s
})
await deny('incomplete pull-only batch rejected', [pull(AMOUNT)])
await deny('unequal funding and supply rejected', [pull(AMOUNT), pool(AMOUNT / 2n)])
await deny('over-cap rejected', [pull(CAP), pool(CAP)])
await check('real Blend supply with Prime-only allowance', async () => {
  const before = await snapshot(),
    b = await execution([pull(AMOUNT), pool(AMOUNT)], 'supply')
  const r = await submit(b.tx, 'agent Blend supply'),
    after = await snapshot()
  assert.equal(BigInt(before.wallet) - BigInt(after.wallet), AMOUNT)
  assert.equal(BigInt(before.primeAllowance) - BigInt(after.primeAllowance), AMOUNT)
  assert(BigInt(after.supplyShares) > BigInt(before.supplyShares))
  assert.equal(after.prime, '0')
  assert.equal(after.adapter, '0')
  assert.equal(after.adapterAllowance, '0')
  return { before, after, hash: r.txHash, contexts: b.contexts }
})
await deny('wrong recipient rejected', [pool(ALL, 1, agent.publicKey())], 'withdraw')
await check('no-funding action', async () => {
  const before = await snapshot(),
    b = await execution([act(7)], 'claim')
  await submit(b.tx, 'agent no-funding action')
  const after = await snapshot()
  assert.equal(after.action, 7)
  assert.equal(after.wallet, before.wallet)
  assert.equal(after.primeAllowance, before.primeAllowance)
  return { before, after }
})
await check('late failure rolls back wallet pull', async () => {
  const before = await snapshot(),
    b = await execution([pull(AMOUNT), act(8)], 'rollback')
  await plain(
    owner,
    state.contracts.fixture,
    'set_fail',
    [xdr.ScVal.scvBool(true)],
    'enable deliberate failure'
  )
  const fundedBefore = await snapshot()
  await submit(b.tx, 'failed batch rolls back', 'FAILED')
  const after = await snapshot()
  assert.deepEqual(after, fundedBefore)
  await plain(
    owner,
    state.contracts.fixture,
    'set_fail',
    [xdr.ScVal.scvBool(false)],
    'disable deliberate failure'
  )
  return { beforeSetup: before, beforeExecution: fundedBefore, after, rolledBack: true }
})
await check('real Blend withdraw directly to wallet', async () => {
  const before = await snapshot(),
    b = await execution([pool(ALL, 1)], 'withdraw')
  await submit(b.tx, 'agent Blend withdraw all')
  const after = await snapshot()
  assert.equal(after.supplyShares, '0')
  assert(BigInt(after.wallet) > BigInt(before.wallet))
  assert.equal(after.prime, '0')
  assert.equal(after.adapter, '0')
  assert.equal(after.primeAllowance, before.primeAllowance)
  return { before, after }
})
await check('direct venue cannot impersonate adapter', async () => {
  const result = await authorize(
    agent,
    invoke(state.contracts.fixture, 'act', [addr(state.contracts.prime), u32(7)]),
    { [state.contracts.fixture]: state.rules.action },
    true,
    true
  )
  assert(/Error\((Auth|Contract),/.test(result.error))
  return { stage: 'enforcing RPC simulation', error: result.error }
})
await check('different Prime rejected', async () => {
  const sim = await server.simulateTransaction(
    await base(
      agent,
      new Contract(state.contracts.adapter).call(
        'execute',
        addr(agent.publicKey()),
        addr(state.contracts.interpreter),
        vec([act(7)]),
        vec([])
      )
    )
  )
  assert(rpc.Api.isSimulationError(sim))
  return { error: sim.error }
})
await check('revoke remaining test allowance', async () => {
  await plain(
    owner,
    TOKEN,
    'approve',
    [
      addr(owner.publicKey()),
      addr(state.contracts.prime),
      int(0n),
      u32((await server.getLatestLedger()).sequence + 100),
    ],
    'revoke test allowance'
  )
  const s = await snapshot()
  assert.equal(s.primeAllowance, '0')
  assert.equal(s.adapterAllowance, '0')
  assert.equal(s.supplyShares, '0')
  return s
})
await check('deployed code and stateless instance verified', async () => {
  const observed: any = {}
  for (const name of ['prime', 'interpreter', 'adapter']) {
    const id = state.contracts[name]
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(id).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    )
    const entries = await server.getLedgerEntries(key)
    assert.equal(entries.entries.length, 1, 'missing contract instance')
    const instance = entries.entries[0]!.val.contractData().val().instance()
    const wasmHash = instance.executable().wasmHash().toString('hex')
    assert.equal(wasmHash, state.hashes[name === 'prime' ? 'oz-account' : name])
    const storageEntries = instance.storage()?.length ?? 0
    if (name === 'adapter') assert.equal(storageEntries, 0, 'adapter must store no configuration')
    observed[name] = { address: id, wasmHash, storageEntries, observedLedger: entries.latestLedger }
  }
  return observed
})
state.final = await snapshot()
save()
console.log(
  'TESTNET VERIFIED',
  JSON.stringify({ contracts: state.contracts, checks: state.checks.length, final: state.final })
)
