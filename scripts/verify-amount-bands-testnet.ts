// Testnet ONLY. Generates disposable faucet-funded keys; never reads production keys.
// This proof uses production SDK discovery and app continuation modules.
// PRIME_PROOF_PHASE=provision|prove|negative|cleanup|verify; disposable TESTNET keys only.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  Address,
  authorizeEntry,
  Contract,
  hash,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
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
const STATE = process.env.PRIME_STATE ?? '/home/ubuntu/.local/state/prime-amount-bands-testnet.json'
const EVIDENCE = 'docs/amount-bands-testnet.json'
const THRESHOLD = 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6'
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
const AMOUNT = 1000000n,
  CAP = 20000000n,
  HIGH = 21000000n,
  HIGH_MIN = 20000001n,
  I128_LIMIT = 1n << 127n,
  ALL = (1n << 127n) - 1n
const salt = hash(Buffer.from('prime.execution.adapter.v1'))
const state: any = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : {
      owner: Keypair.random().secret(),
      agent: Keypair.random().secret(),
      cosigner: Keypair.random().secret(),
      contracts: {},
      rules: {},
      hashes: {},
      uploaded: [],
      transactions: [],
      checks: [],
      bound: [],
    }
const owner = Keypair.fromSecret(state.owner),
  agent = Keypair.fromSecret(state.agent),
  cosigner = Keypair.fromSecret(state.cosigner)
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
    `${JSON.stringify(
      {
        network: 'TESTNET',
        rpc: RPC,
        updatedAt: new Date().toISOString(),
        proof:
          'disjoint amount bands: SDK + production app continuation; local owner signer, not browser wallet',
        amountBands: {
          low: { min: '1', maxExclusive: CAP.toString(), threshold: 1 },
          high: { min: HIGH_MIN.toString(), maxExclusive: I128_LIMIT.toString(), threshold: 2 },
        },
        owner: owner.publicKey(),
        agent: agent.publicKey(),
        cosigner: cosigner.publicKey(),
        token: TOKEN,
        pool: POOL,
        contracts: state.contracts,
        wasmHashes: state.hashes,
        rules: state.rules,
        canonicalPredicateHashes: state.canonical,
        bound: state.bound,
        salt: salt.toString('hex'),
        transactions: state.transactions,
        checks: state.checks,
        final: state.final,
      },
      null,
      2
    )}\n`
  )
}
save()
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function faucet(k: Keypair) {
  try {
    await server.getAccount(k.publicKey())
    return
  } catch {}
  const r = await fetch(`https://friendbot.stellar.org/?addr=${k.publicKey()}`)
  assert(r.ok, `friendbot failed ${r.status}`)
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
  assert(sent.status !== 'ERROR', `${label} send error ${sent.errorResult?.toXDR('base64')}`)
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
  throw new Error(`${label} receipt timeout ${txHash}`)
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
  assert(!rpc.Api.isSimulationError(sim), `view ${fn} ${(sim as any).error}`)
  assert(sim.result, 'missing result')
  return sim.result.retval
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
  const r = await submit(tx, `deploy ${name}`)
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
  assert(!rpc.Api.isSimulationError(recording), `recording ${(recording as any).error}`)
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
    assert(id !== undefined, `no rule ${JSON.stringify(c)}`)
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
  assert(!rpc.Api.isSimulationError(sim), `enforcing auth ${(sim as any).error} ids=${ids}`)
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
const request = (calls: xdr.ScVal[]) => [
  addr(state.contracts.prime),
  addr(state.contracts.interpreter),
  vec(calls),
  vec([]),
]
async function install(
  name: string,
  target: string,
  signer: string,
  encoded: any,
  threshold = false
) {
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
    vec([delegatedSigner(signer), ...(threshold ? [delegatedSigner(owner.publicKey())] : [])]),
    xdr.ScVal.scvMap(
      [
        new xdr.ScMapEntry({ key: addr(state.contracts.interpreter), val: params }),
        ...(threshold
          ? [new xdr.ScMapEntry({ key: addr(THRESHOLD), val: map({ threshold: u32(2) }) })]
          : []),
      ].sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()))
    ),
  ]
  const b = await authorize(owner, invoke(state.contracts.prime, 'add_context_rule', args), {
    '*': 0,
  })
  const r = await submit(b.tx, `install ${name}`),
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
  await submit(b.tx, `bind ${name}`)
  state.bound.push(name)
  save()
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
  }
}
async function check(name: string, fn: () => Promise<any>) {
  if (state.checks.some((c: any) => c.name === name)) return
  const result = await fn()
  state.checks.push({ name, result })
  save()
  console.log('PASS', name)
}
async function provision() {
  await faucet(owner)
  await faucet(agent)
  await faucet(cosigner)
  await deploy('prime', '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9', [
    vec([delegatedSigner(owner.publicKey())]),
    map({}),
  ])
  state.contracts.interpreter = 'CBIQGAHIGCIAC6JJBYQQBTDFNNWQCGPECWRI7NO2PHIYDQV6QDLG6I2W'
  state.hashes = {
    interpreter: 'cc05ac55747d2472f6da1fc229a2f9f8083607ba8c08bf5eaeac7cd73ef6fb66',
    adapter: '57bf132b9537f0d35b9de4327e047f920938eac655e7d140c108e84da3b03474',
    account: '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9',
    threshold: '01c0be09eb6fb288cab2e878b4e890f7a38f75afab99aeb197861f44e2e2dfe6',
  }
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
        wasmHash: Buffer.from(state.hashes.adapter, 'hex'),
        constructorArgs: [],
        auth,
      })
    const b = await authorize(owner, create, { '*': 0 }),
      r = await submit(b.tx, 'activate deterministic stateless adapter')
    assert.equal(Address.fromScVal(r.returnValue).toString(), predicted)
    state.contracts.adapter = predicted
    save()
  }
  assert.equal(state.contracts.adapter, predicted)
  assert.equal((await view(state.contracts.interpreter, 'grammar_version')).u32(), 5)
  // Use the shipped canonical template; its byte identity is part of discovery.
  const { statelessBlendPolicies } = await import(
    (process.env.PRIME_SDK_ROOT ?? '/home/ubuntu/work/prime-sdk-scoped') +
      '/src/execution-adapter/stateless-discover.ts'
  )
  for (const [band, min, max] of [
    ['low', 1n, CAP],
    ['high', HIGH_MIN, I128_LIMIT],
  ] as const) {
    const canonical = statelessBlendPolicies(
      {
        prime: state.contracts.prime,
        executor: state.contracts.adapter,
        interpreter: state.contracts.interpreter,
        custody: owner.publicKey(),
        token: TOKEN,
        pool: POOL,
        minAmountBaseUnits: min.toString(),
        maxAmountBaseUnits: max.toString(),
      },
      'supply'
    )
    await install(`${band}-token`, TOKEN, state.contracts.adapter, canonical.children[0])
    await bind(`${band}-token`)
    await install(`${band}-pool`, POOL, state.contracts.adapter, canonical.children[1])
    await bind(`${band}-pool`)
    await install(
      `${band}-supply`,
      state.contracts.adapter,
      agent.publicKey(),
      canonical.root,
      band === 'high'
    )
    await bind(`${band}-supply`)
    state.canonical ??= {}
    state.canonical[band] = {
      root: canonical.root.predicateHash,
      children: canonical.children.map((c: any) => c.predicateHash),
    }
    save()
  }
  await check('approve Prime only', async () => {
    await await plain(
      owner,
      TOKEN,
      'approve',
      [
        addr(owner.publicKey()),
        addr(state.contracts.prime),
        int(100000000n),
        u32((await server.getLatestLedger()).sequence + 20000),
      ],
      'approve disposable Prime allowance'
    )
    const s = await snapshot()
    assert.equal(s.primeAllowance, '100000000')
    assert.equal(s.adapterAllowance, '0')
    return s
  })
  console.log(
    JSON.stringify({
      phase: 'provisioned',
      owner: owner.publicKey(),
      agent: agent.publicKey(),
      cosigner: cosigner.publicKey(),
      ...state.contracts,
      rules: state.rules,
    })
  )
}
async function cleanup() {
  if (BigInt((await snapshot()).supplyShares) > 0n) {
    const args = [
      addr(state.contracts.prime),
      addr(state.contracts.prime),
      addr(owner.publicKey()),
      vec([map({ address: addr(TOKEN), amount: int(ALL), request_type: u32(1) })]),
    ]
    const b = await authorize(owner, invoke(POOL, 'submit', args), { '*': 0 })
    await submit(b.tx, 'owner withdraw all Blend supply')
  }
  await await plain(
    owner,
    TOKEN,
    'approve',
    [addr(owner.publicKey()), addr(state.contracts.prime), int(0n), u32(0)],
    'revoke remaining disposable allowance'
  )
  state.final = await snapshot()
  assert.equal(state.final.supplyShares, '0')
  assert.equal(state.final.primeAllowance, '0')
  assert.equal(state.final.prime, '0')
  assert.equal(state.final.adapter, '0')
  save()
}
async function prove() {
  assert.equal(process.env.VITE_STELLAR_NETWORK, 'testnet')
  const sdkRoot = process.env.PRIME_SDK_ROOT ?? '/home/ubuntu/work/prime-sdk-scoped'
  const appRoot = process.env.PRIME_APP_ROOT ?? '/home/ubuntu/work/octopos-scoped-execution'
  const { connectExecutionLane } = await import(`${sdkRoot}/src/agent/atomic-agent.ts`)
  const { localKeySigner } = await import(`${sdkRoot}/src/agent/signer.ts`)
  const connect = (amount?: bigint) =>
    connectExecutionLane({
      rpcUrl: RPC,
      networkPassphrase: PASS,
      primeAccount: state.contracts.prime,
      signer: localKeySigner(state.agent),
      primeAppUrl: 'https://prime.untangled.finance',
      amount,
    })
  const { agent: runtime, lane } = await connect()
  assert.equal(lane.executionAdapter, state.contracts.adapter)
  assert.equal(lane.custodyWallet, owner.publicKey())
  assert.equal(lane.token, TOKEN)
  assert.equal(lane.venue.pool, POOL)
  assert.equal(lane.requiredSignatures, 1)
  assert.equal(lane.minAmountBaseUnits, 1n)
  assert.equal(lane.perTxCap, CAP)
  assert.deepEqual(lane.operatorKeys, [agent.publicKey()])
  await check('two-input discovery defaults to low band', async () =>
    JSON.parse(JSON.stringify(lane, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  )
  const highLane = (await connect(HIGH)).lane
  assert.equal(highLane.requiredSignatures, 2)
  assert.equal(highLane.minAmountBaseUnits, HIGH_MIN)
  assert.equal(highLane.perTxCap, I128_LIMIT)
  assert.deepEqual(new Set(highLane.operatorKeys), new Set([agent.publicKey(), owner.publicKey()]))
  await check('amount-aware discovery selects high band', async () =>
    JSON.parse(JSON.stringify(highLane, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  )
  await check('SDK low-band agent alone executes 0.1 XLM', async () => {
    const before = await snapshot()
    const result = await runtime.supply(AMOUNT)
    assert.equal(result.kind, 'success', JSON.stringify(result))
    const after = await snapshot()
    assert.equal(BigInt(before.wallet) - BigInt(after.wallet), AMOUNT)
    assert.equal(BigInt(before.primeAllowance) - BigInt(after.primeAllowance), AMOUNT)
    assert(BigInt(after.supplyShares) > BigInt(before.supplyShares))
    assert.equal(after.prime, '0')
    assert.equal(after.adapter, '0')
    state.transactions.push({
      label: 'SDK agent-alone low-band Blend supply',
      hash: result.txHash,
      ledger: result.ledger,
      status: 'SUCCESS',
    })
    return { amount: AMOUNT.toString(), before, after, result }
  })
  await check('SDK exactly 2 XLM gap denied without broadcast', async () => {
    const before = await snapshot(),
      seq = (await server.getAccount(agent.publicKey())).sequenceNumber()
    await assert.rejects(() => runtime.supply(CAP))
    assert.deepEqual(await snapshot(), before)
    assert.equal((await server.getAccount(agent.publicKey())).sequenceNumber(), seq)
    return { amount: CAP.toString(), stateUnchanged: true, sourceSequenceUnchanged: true }
  })
  await signedBoundsNegatives()
  await check('SDK high-band 2.1 XLM completed through production app', async () => {
    const before = await snapshot(),
      seq = (await server.getAccount(agent.publicKey())).sequenceNumber()
    const result = await runtime.supply(HIGH)
    assert.equal(result.kind, 'needs_signatures', JSON.stringify(result))
    assert.deepEqual(result.signed, [agent.publicKey()])
    assert.deepEqual(result.missing, [owner.publicKey()])
    assert.equal(result.payload.ruleId, state.rules['high-supply'])
    assert.deepEqual(await snapshot(), before)
    assert.equal((await server.getAccount(agent.publicKey())).sequenceNumber(), seq)
    state.payload = result.payload
    state.link = result.url
    save()
    const partial = TransactionBuilder.fromXDR(result.payload.txXdr, PASS)
    const sim = await server.simulateTransaction(partial)
    assert(rpc.Api.isSimulationError(sim), 'single high-band approval unexpectedly executable')
    const { loadCosignRequest } = await import(
      `${appRoot}/apps/web/ui/octopos/cosign-continue-load.ts`
    )
    const { continueCosign } = await import(
      `${appRoot}/apps/web/ui/octopos/smart-account-cosign-continue.ts`
    )
    const { readContextRules, readPolicyThreshold } = await import(
      `${appRoot}/apps/web/ui/octopos/smart-account-rules.ts`
    )
    const { verifyExecutionCosign } = await import(
      `${appRoot}/apps/web/ui/octopos/execution-cosign.ts`
    )
    const raw = new URL(result.url).hash.replace(/^#\/cosign\/p\//, '')
    const loaded = await loadCosignRequest({
      raw,
      readRules: readContextRules,
      readThreshold: readPolicyThreshold,
      readLatestLedger: async () => (await server.getLatestLedger()).sequence,
    })
    assert.equal(loaded.kind, 'ready', JSON.stringify(loaded))
    assert.equal(loaded.threshold, 2)
    assert(await verifyExecutionCosign(loaded.payload))
    let authCalls = 0,
      txCalls = 0
    const signer = {
      kind: 'agent',
      chain: 'stellar',
      address: owner.publicKey(),
      label: 'Disposable local testnet owner',
      supportsAuthEntry: async () => true,
      getNetwork: async () => 'testnet',
      signAuthEntry: async (preimage: string) => {
        authCalls++
        return owner.sign(hash(Buffer.from(preimage, 'base64'))).toString('base64')
      },
      signXDR: async (raw: string) => {
        txCalls++
        const tx = TransactionBuilder.fromXDR(raw, PASS)
        tx.sign(owner)
        return tx.toXDR()
      },
    }
    const completed = await continueCosign({
      payload: loaded.payload,
      smartAccount: state.contracts.prime,
      rule: loaded.rule,
      signer,
      rpcServer: server,
      threshold: loaded.threshold,
    })
    assert.equal(completed.kind, 'broadcast', JSON.stringify(completed))
    const after = await snapshot()
    // Owner pays the final co-sign transaction fee as well as providing custody funds.
    assert(BigInt(before.wallet) - BigInt(after.wallet) >= HIGH)
    assert.equal(BigInt(before.primeAllowance) - BigInt(after.primeAllowance), HIGH)
    assert(BigInt(after.supplyShares) > BigInt(before.supplyShares))
    assert.equal(after.prime, '0')
    assert.equal(after.adapter, '0')
    assert.equal(after.adapterAllowance, '0')
    const receipt = await server.getTransaction(completed.hash)
    assert.equal(receipt.status, 'SUCCESS')
    state.transactions.push({
      label: 'production app owner co-sign high-band Blend supply',
      ...completed,
      status: receipt.status,
      ledger: receipt.ledger,
    })
    return {
      amount: HIGH.toString(),
      before,
      after,
      signed: result.signed,
      missing: result.missing,
      noBroadcastBeforeCosign: true,
      partialEnforcingDenied: true,
      result: completed,
      authCallbacks: authCalls,
      transactionCallbacks: txCalls,
      browserWalletProof: false,
    }
  })
  await cleanup()
}
async function signedBoundsNegatives() {
  for (const [name, band, amount] of [
    ['fully signed low-band over-cap denied', 'low', HIGH],
    ['fully signed exactly 2 XLM through low root denied', 'low', CAP],
    ['fully signed exactly 2 XLM through high root denied', 'high', CAP],
    ['fully signed below high minimum denied', 'high', AMOUNT],
  ] as const)
    await check(name, async () => {
      const before = await snapshot(),
        seq = (await server.getAccount(agent.publicKey())).sequenceNumber()
      const operation = invoke(
        state.contracts.adapter,
        'execute',
        request([pull(amount), pool(amount)])
      )
      const recording = await server.simulateTransaction(
        await base(agent, operation([])),
        undefined,
        'record'
      )
      assert(!rpc.Api.isSimulationError(recording), `recording failed ${(recording as any).error}`)
      const original = recording.result!.auth!.find(
        (a: any) =>
          a.credentials().switch().name === 'sorobanCredentialsAddress' &&
          Address.fromScAddress(a.credentials().address().address()).toString() ===
            state.contracts.prime
      )!
      assert(original)
      const ids = [
        state.rules[`${band}-supply`],
        state.rules[`${band}-token`],
        state.rules[`${band}-pool`],
      ]
      const expiry = (await server.getLatestLedger()).sequence + 100
      const digest = authDigest(
        signaturePayload(
          PASS,
          original.credentials().address().nonce(),
          expiry,
          original.rootInvocation()
        ),
        ids
      )
      const keys = band === 'high' ? [agent, owner] : [agent]
      const entries = [
        accountEntry(
          original,
          expiry,
          authPayload([...keys.map((key) => key.publicKey()), state.contracts.adapter], ids)
        ),
      ]
      let nonce = BigInt(Date.now())
      for (const key of keys)
        for (const _id of ids) {
          const unsigned = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
              new xdr.SorobanAddressCredentials({
                address: new Address(key.publicKey()).toScAddress(),
                nonce: xdr.Int64.fromString((nonce++).toString()),
                signatureExpirationLedger: expiry,
                signature: xdr.ScVal.scvVoid(),
              })
            ),
            rootInvocation: delegatedSignerEntry(state.contracts.prime, digest).rootInvocation(),
          })
          entries.push(await authorizeEntry(unsigned, key, expiry, PASS))
        }
      const sim = await server.simulateTransaction(await base(agent, operation(entries)))
      assert(
        rpc.Api.isSimulationError(sim),
        'fully approved out-of-band amount unexpectedly permitted'
      )
      assert(sim.error.includes('Error(Contract, #100)'), `wrong denial cause ${sim.error}`)
      assert(sim.error.includes(state.contracts.interpreter), 'interpreter denial not found')
      assert.deepEqual(await snapshot(), before)
      assert.equal((await server.getAccount(agent.publicKey())).sequenceNumber(), seq)
      return {
        stage: 'enforcing RPC simulation',
        band,
        amount: amount.toString(),
        signatureEntries: keys.length * ids.length,
        contextRuleIds: ids,
        policyError: 'ArgMismatch #100',
        stateUnchanged: true,
        sourceSequenceUnchanged: true,
      }
    })
}
async function verifyFinal() {
  const final = await snapshot()
  for (const key of ['supplyShares', 'primeAllowance', 'adapterAllowance', 'prime', 'adapter'])
    assert.equal(final[key], '0', key)
  for (const label of [
    'SDK agent-alone low-band Blend supply',
    'production app owner co-sign high-band Blend supply',
  ]) {
    const tx = state.transactions.find((t: any) => t.label === label)
    assert(tx)
    const receipt = await server.getTransaction(tx.hash)
    assert.equal(receipt.status, 'SUCCESS')
    tx.status = receipt.status
    tx.ledger = receipt.ledger
  }
  state.final = final
  save()
  console.log('PASS both positive receipts and cleaned final state')
}
const phase = process.env.PRIME_PROOF_PHASE ?? 'provision'
if (phase === 'provision') await provision()
else if (phase === 'cleanup') await cleanup()
else if (phase === 'prove') await prove()
else if (phase === 'negative') await signedBoundsNegatives()
else if (phase === 'verify') await verifyFinal()
else throw new Error('Unknown proof phase')
