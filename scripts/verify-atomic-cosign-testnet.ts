// Testnet ONLY. Generates disposable faucet-funded keys; never reads production keys.
// This proof uses production SDK discovery and app continuation modules.
// PRIME_PROOF_PHASE=provision|prove|cap-negative|cleanup; only disposable TESTNET keys are used.

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
const STATE =
  process.env.PRIME_STATE ?? '/home/ubuntu/.local/state/prime-atomic-cosign-testnet.json'
const EVIDENCE = 'docs/atomic-cosign-testnet.json'
const THRESHOLD = 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6'
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
const AMOUNT = 1000000n,
  CAP = 2000000n,
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
        proof: 'atomic SDK + production app continuation; local signer, not browser wallet',
        owner: owner.publicKey(),
        agent: agent.publicKey(),
        cosigner: cosigner.publicKey(),
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
    vec([delegatedSigner(signer), ...(threshold ? [delegatedSigner(cosigner.publicKey())] : [])]),
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
  const canonical = statelessBlendPolicies(
    {
      prime: state.contracts.prime,
      executor: state.contracts.adapter,
      interpreter: state.contracts.interpreter,
      custody: owner.publicKey(),
      token: TOKEN,
      pool: POOL,
      maxAmountBaseUnits: CAP.toString(),
    },
    'supply'
  )
  if (!state.canonicalVersion && Object.keys(state.rules).length) {
    // Remove the operator root before replacing child rules on this disposable fixture.
    for (const name of ['supply', 'token', 'pool']) {
      if (state.rules[name] === undefined) continue
      const b = await authorize(
        owner,
        invoke(state.contracts.prime, 'remove_context_rule', [u32(state.rules[name])]),
        { '*': 0 }
      )
      await submit(b.tx, `replace noncanonical fixture ${name}`)
      delete state.rules[name]
      state.bound = state.bound.filter((n: string) => n !== name)
      save()
    }
  }
  await install('token', TOKEN, state.contracts.adapter, canonical.children[0])
  await bind('token')
  await install('pool', POOL, state.contracts.adapter, canonical.children[1])
  await bind('pool')
  await install('supply', state.contracts.adapter, agent.publicKey(), canonical.root, true)
  await bind('supply')
  state.canonicalVersion = 1
  save()
  await check('approve Prime only', async () => {
    await await plain(
      owner,
      TOKEN,
      'approve',
      [
        addr(owner.publicKey()),
        addr(state.contracts.prime),
        int(4n * AMOUNT),
        u32((await server.getLatestLedger()).sequence + 20000),
      ],
      'approve disposable Prime allowance'
    )
    const s = await snapshot()
    assert.equal(s.primeAllowance, (4n * AMOUNT).toString())
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
  assert.equal(
    process.env.VITE_STELLAR_NETWORK,
    'testnet',
    'App must explicitly select TESTNET before importing modules'
  )
  const sdkRoot = process.env.PRIME_SDK_ROOT ?? '/home/ubuntu/work/prime-sdk-scoped'
  const appRoot = process.env.PRIME_APP_ROOT ?? '/home/ubuntu/work/octopos-scoped-execution'
  const { connectExecutionLane } = await import(`${sdkRoot}/src/agent/atomic-agent.ts`)
  const { localKeySigner } = await import(`${sdkRoot}/src/agent/signer.ts`)
  const { agent: runtime, lane } = await connectExecutionLane({
    rpcUrl: RPC,
    networkPassphrase: PASS,
    primeAccount: state.contracts.prime,
    signer: localKeySigner(state.agent),
    primeAppUrl: 'https://prime.untangled.finance',
  })
  assert.equal(lane.executionAdapter, state.contracts.adapter)
  assert.equal(lane.custodyWallet, owner.publicKey())
  assert.equal(lane.token, TOKEN)
  assert.equal(lane.venue.pool, POOL)
  assert.equal(lane.requiredSignatures, 2)
  assert.deepEqual(new Set(lane.operatorKeys), new Set([agent.publicKey(), cosigner.publicKey()]))
  await check('two-input live discovery', async () =>
    JSON.parse(JSON.stringify(lane, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  )
  const before = await snapshot()
  const sequenceBefore = (await server.getAccount(agent.publicKey())).sequenceNumber()
  const result = await runtime.supply(AMOUNT)
  assert.equal(result.kind, 'needs_signatures')
  assert.deepEqual(result.signed, [agent.publicKey()])
  assert.deepEqual(result.missing, [cosigner.publicKey()])
  assert.deepEqual(await snapshot(), before)
  assert.equal((await server.getAccount(agent.publicKey())).sequenceNumber(), sequenceBefore)
  state.link = result.url
  state.payload = result.payload
  save()
  await check('SDK returns self-contained link without broadcast', async () => ({
    signed: result.signed,
    missing: result.missing,
    validUntil: result.validUntil,
    urlOrigin: new URL(result.url).origin,
    payloadBytes: Buffer.byteLength(JSON.stringify(result.payload)),
    stateUnchanged: true,
    sourceSequenceUnchanged: true,
  }))
  const partial = TransactionBuilder.fromXDR(result.payload.txXdr, PASS)
  const sim = await server.simulateTransaction(partial)
  assert(rpc.Api.isSimulationError(sim), 'single approval unexpectedly executable')
  await check('one of two cannot execute', async () => ({
    stage: 'enforcing RPC simulation',
    error: sim.error.split('\n')[0],
  }))
  await assert.rejects(() => runtime.supply(CAP))
  await check('SDK over-cap denied without link', async () => ({
    amount: CAP.toString(),
    capExclusive: CAP.toString(),
    denied: true,
  }))
  const { loadCosignRequest } = await import(
    `${appRoot}/apps/web/ui/octopos/cosign-continue-load.ts`
  )
  const { continueCosign } = await import(
    `${appRoot}/apps/web/ui/octopos/smart-account-cosign-continue.ts`
  )
  const { readContextRules, readPolicyThreshold } = await import(
    `${appRoot}/apps/web/ui/octopos/smart-account-rules.ts`
  )
  const { encodeCosignPayload } = await import(
    `${appRoot}/apps/web/ui/octopos/smart-account-cosign-payload.ts`
  )
  const { verifyExecutionCosign } = await import(
    `${appRoot}/apps/web/ui/octopos/execution-cosign.ts`
  )
  const reads = {
    readRules: readContextRules,
    readThreshold: readPolicyThreshold,
    readLatestLedger: async () => (await server.getLatestLedger()).sequence,
  }
  const raw = new URL(result.url).hash.replace(/^#\/cosign\/p\//, '')
  const loaded = await loadCosignRequest({ raw, ...reads })
  assert.equal(loaded.kind, 'ready', JSON.stringify(loaded))
  assert.equal(loaded.threshold, 2)
  const verified = await verifyExecutionCosign(loaded.payload)
  assert(verified)
  await check('production app loads and verifies real per-context signatures', async () => ({
    threshold: loaded.threshold,
    ruleId: loaded.rule.id,
    verified: true,
    authEntryCount: xdr.TransactionEnvelope.fromXDR(result.payload.txXdr, 'base64')
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .auth().length,
  }))
  let authCalls = 0,
    txCalls = 0
  const signer = {
    kind: 'agent',
    chain: 'stellar',
    address: cosigner.publicKey(),
    label: 'Disposable local testnet cosigner',
    supportsAuthEntry: async () => true,
    getNetwork: async () => 'testnet',
    signAuthEntry: async (preimage: string) => {
      authCalls++
      return cosigner.sign(hash(Buffer.from(preimage, 'base64'))).toString('base64')
    },
    signXDR: async (raw: string) => {
      txCalls++
      const tx = TransactionBuilder.fromXDR(raw, PASS)
      tx.sign(cosigner)
      return tx.toXDR()
    },
  }
  for (const [name, payload] of [
    ['wrong-network', { ...loaded.payload, network: 'mainnet' }],
    ['expired', { ...loaded.payload, validUntil: (await server.getLatestLedger()).sequence }],
    [
      'claimed signature tampering',
      { ...loaded.payload, signed: [agent.publicKey(), owner.publicKey()] },
    ],
  ] as const) {
    const badLoad = await loadCosignRequest({ raw: encodeCosignPayload(payload), ...reads })
    assert.equal(badLoad.kind, 'error', name)
    const bad = await continueCosign({
      payload,
      smartAccount: state.contracts.prime,
      rule: loaded.rule,
      signer,
      rpcServer: server,
      threshold: 2,
    })
    assert.equal(bad.kind, 'rejected', name)
    assert.equal(authCalls, 0)
    assert.equal(txCalls, 0)
    await check(`${name} rejected before signer callback`, async () => ({
      loadError: badLoad.message,
      continueError: bad.reason,
      signerCallbacks: 0,
    }))
  }
  await tamperedSignatureNegative()
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
  assert.equal(BigInt(before.wallet) - BigInt(after.wallet), AMOUNT)
  assert.equal(BigInt(before.primeAllowance) - BigInt(after.primeAllowance), AMOUNT)
  assert(BigInt(after.supplyShares) > BigInt(before.supplyShares))
  assert.equal(after.prime, '0')
  assert.equal(after.adapter, '0')
  assert.equal(after.adapterAllowance, '0')
  state.transactions.push({ label: 'production app cosigner atomic Blend supply', ...completed })
  save()
  await check('production app continuation completes real atomic Blend supply', async () => ({
    before,
    after,
    result: completed,
    authCallbacks: authCalls,
    transactionCallbacks: txCalls,
    browserWalletProof: false,
  }))
  await cleanup()
}
async function signedCapNegative() {
  await await plain(
    owner,
    TOKEN,
    'approve',
    [
      addr(owner.publicKey()),
      addr(state.contracts.prime),
      int(2n * CAP),
      u32((await server.getLatestLedger()).sequence + 300),
    ],
    'temporary disposable allowance for full-auth cap simulation'
  )
  try {
    const before = await snapshot()
    const operation = invoke(state.contracts.adapter, 'execute', request([pull(CAP), pool(CAP)]))
    const recording = await server.simulateTransaction(
      await base(agent, operation([])),
      undefined,
      'record'
    )
    assert(!rpc.Api.isSimulationError(recording), `recording failed ${(recording as any).error}`)
    const original = recording.result!.auth![0]!,
      ids = [state.rules.supply, state.rules.token, state.rules.pool]
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
    const entries = [
      accountEntry(
        original,
        expiry,
        authPayload([agent.publicKey(), cosigner.publicKey(), state.contracts.adapter], ids)
      ),
    ]
    let nonce = BigInt(Date.now())
    for (const key of [agent, cosigner])
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
    assert(rpc.Api.isSimulationError(sim), 'fully approved overcap unexpectedly permitted')
    assert(sim.error.includes('Error(Contract, #100)'), `wrong denial cause ${sim.error}`)
    assert(sim.error.includes(state.contracts.interpreter), 'interpreter denial not found')
    assert.deepEqual(await snapshot(), before)
    await check('fully signed over-cap rejected by interpreter predicate', async () => ({
      stage: 'enforcing RPC simulation',
      amount: CAP.toString(),
      signatureEntries: 6,
      contextRuleIds: ids,
      policyError: 'ArgMismatch #100',
      unchanged: true,
    }))
  } finally {
    await cleanup()
  }
}
async function tamperedSignatureNegative() {
  assert.equal(process.env.VITE_STELLAR_NETWORK, 'testnet')
  const appRoot = process.env.PRIME_APP_ROOT ?? '/home/ubuntu/work/octopos-scoped-execution'
  const { loadCosignRequest } = await import(
    `${appRoot}/apps/web/ui/octopos/cosign-continue-load.ts`
  )
  const { continueCosign } = await import(
    `${appRoot}/apps/web/ui/octopos/smart-account-cosign-continue.ts`
  )
  const { readContextRules, readPolicyThreshold } = await import(
    `${appRoot}/apps/web/ui/octopos/smart-account-rules.ts`
  )
  const { encodeCosignPayload } = await import(
    `${appRoot}/apps/web/ui/octopos/smart-account-cosign-payload.ts`
  )
  const envelope = xdr.TransactionEnvelope.fromXDR(state.payload.txXdr, 'base64')
  const signed = envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth()[1]!
  const signature = signed
    .credentials()
    .address()
    .signature()
    .vec()![0]!
    .map()!
    .find((e) => e.key().sym().toString() === 'signature')!
    .val()
    .bytes()
  signature[0] = signature[0]! ^ 1
  const payload = { ...state.payload, txXdr: envelope.toXDR('base64') }
  const rules = await readContextRules(state.contracts.prime),
    rule = rules.find((r: any) => r.id === state.rules.supply)
  assert(rule)
  const loaded = await loadCosignRequest({
    raw: encodeCosignPayload(payload),
    readRules: readContextRules,
    readThreshold: readPolicyThreshold,
    readLatestLedger: async () => (await server.getLatestLedger()).sequence,
  })
  assert.equal(loaded.kind, 'error')
  assert.match(loaded.message, /invalid prior cryptographic approval/i)
  let callbacks = 0
  const result = await continueCosign({
    payload,
    smartAccount: state.contracts.prime,
    rule,
    threshold: 2,
    rpcServer: server,
    signer: {
      kind: 'agent',
      chain: 'stellar',
      address: cosigner.publicKey(),
      label: 'disposable',
      supportsAuthEntry: async () => true,
      signAuthEntry: async () => {
        callbacks++
        throw Error('must not sign')
      },
      signXDR: async () => {
        callbacks++
        throw Error('must not sign')
      },
    },
  })
  assert.equal(result.kind, 'rejected')
  assert.match(result.reason, /invalid prior cryptographic approval/i)
  assert.equal(callbacks, 0)
  await check('tampered signature bytes rejected before signer callback', async () => ({
    loadError: loaded.message,
    continueError: result.reason,
    signerCallbacks: callbacks,
  }))
}
async function verifyFinal() {
  const final = await snapshot()
  assert.equal(final.supplyShares, '0')
  assert.equal(final.primeAllowance, '0')
  assert.equal(final.adapterAllowance, '0')
  assert.equal(final.prime, '0')
  assert.equal(final.adapter, '0')
  state.final = final
  const tx = state.transactions.find(
    (t: any) => t.label === 'production app cosigner atomic Blend supply'
  )
  assert(tx)
  const receipt = await server.getTransaction(tx.hash)
  assert.equal(receipt.status, 'SUCCESS')
  tx.status = receipt.status
  tx.ledger = receipt.ledger
  for (const c of state.checks)
    if (c.name === 'one of two cannot execute') c.result.error = c.result.error.split('\n')[0]
  save()
  console.log('PASS live final-state and positive transaction receipt')
}
const phase = process.env.PRIME_PROOF_PHASE ?? 'provision'
if (phase === 'provision') await provision()
else if (phase === 'cleanup') await cleanup()
else if (phase === 'prove') await prove()
else if (phase === 'tamper-negative') await tamperedSignatureNegative()
else if (phase === 'verify') await verifyFinal()
else if (phase === 'cap-negative') await signedCapNegative()
else throw new Error('Unknown proof phase')
