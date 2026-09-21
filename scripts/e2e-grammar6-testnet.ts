// Grammar 6 + simplified adapter + custody gate, end to end on live TESTNET.
//
// What this proves, with submitted transactions rather than a local host:
//
//   1. Prime holds NO allowance. The gate holds it and is the only route out
//      of the custody account.
//   2. The adapter no longer flattens the request. The root predicate reaches
//      `calls[n].args[i]` itself, through grammar 6's `call_path`.
//   3. A CROSS-CALL constraint - what was pulled is what was returned - is
//      stated in the predicate and enforced on chain. Under grammar 5 that
//      needed the projection the adapter has now shed.
//   4. The root rule needs no executor binding; the child rule does.
//
// Batch: [ gate.pull(SAC, prime, N),  SAC.transfer(prime, custody, N) ]
// A round trip, so a permitted run leaves custody whole and spends exactly N
// of the gate's allowance.

import {
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { readFileSync } from 'node:fs'

const W = `${process.env.HOME}/.cache/oz-adapter-target/wasm32v1-none/release`
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const PASSPHRASE = Networks.TESTNET
const FEE = '6000000'
const server = new rpc.Server('https://soroban-testnet.stellar.org')

const log = (t: string, m: string) => console.log(`[${t}] ${m}`)
const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u32v = (n: number) => xdr.ScVal.scvU32(n)
const addr = (a: string) => Address.fromString(a).toScVal()
const i128v = (v: bigint) => nativeToScVal(v, { type: 'i128' })
const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items)
const kv = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v })

async function friendbot(pk: string) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`)
}

async function settle(sent: any, label: string) {
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: send ERROR ${JSON.stringify(sent.errorResult?.toXDR('base64'))}`)
  }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got: any = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') throw new Error(`${label}: tx ${sent.hash} FAILED`)
  }
  throw new Error(`${label}: tx ${sent.hash} did not confirm`)
}

async function send(kp: Keypair, op: xdr.Operation, label: string) {
  const src = await server.getAccount(kp.publicKey())
  const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build()
  const prepared = await server.prepareTransaction(tx)
  prepared.sign(kp)
  return settle(await server.sendTransaction(prepared), label)
}

function invokeOp(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[] = [],
) {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    auth,
  })
}

// ---------------------------------------------------------------- OZ auth ---

const delegatedSigner = (a: string) => vec([sym('Delegated'), addr(a)])

const signaturePayload = (nonce: xdr.Int64, exp: number, inv: xdr.SorobanAuthorizedInvocation) =>
  hash(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(PASSPHRASE)),
        nonce,
        signatureExpirationLedger: exp,
        invocation: inv,
      }),
    ).toXDR(),
  )

const authDigest = (payload: Buffer, ruleIds: number[]) =>
  hash(Buffer.concat([payload, vec(ruleIds.map(u32v)).toXDR()]))

type Res = { denied: boolean; reason?: string; got?: any }

/**
 * Run `makeOp` under the Prime account's authority, carried by one delegated
 * signer through the OZ `AuthPayload` its `__check_auth` expects.
 *
 * `makeOp` is called twice: once bare to let the host record what Prime must
 * authorise, then again with the entries built from that recording. It takes
 * the operation rather than a contract call so the same path covers deploying
 * the adapter, which Prime authorises as a CreateContractV2 host function.
 */
async function asAccount(opts: {
  kp: Keypair
  prime: string
  makeOp: (auth: xdr.SorobanAuthorizationEntry[]) => xdr.Operation
  ruleIds: number[]
  label: string
  /** Every signer the named rules need. A rule whose signer is missing from
   *  this map reaches the interpreter with no authenticated signers at all
   *  and denies #210, so the adapter has to appear here for its child rule
   *  even though it signs nothing: OZ authenticates a contract signer by
   *  calling it, not by checking bytes. */
  signers?: string[]
  expectFailure?: boolean
  showCost?: boolean
}): Promise<Res> {
  const { kp, prime, makeOp, ruleIds, label } = opts
  const signerList = opts.signers ?? [kp.publicKey()]
  const probe = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(makeOp([]))
    .setTimeout(120)
    .build()

  const sim = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) {
    if (opts.expectFailure) return { denied: true, reason: sim.error }
    throw new Error(`${label}: simulation failed ${sim.error}`)
  }
  const recorded: xdr.SorobanAuthorizationEntry[] = (sim as any).result?.auth ?? []
  const own = recorded.find(
    (e) =>
      e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(e.credentials().address().address()).toString() === prime,
  )
  if (!own) throw new Error(`${label}: no address-credential entry for Prime`)

  const exp = (await server.getLatestLedger()).sequence + 100
  const payload = signaturePayload(own.credentials().address().nonce(), exp, own.rootInvocation())
  const digest = authDigest(payload, ruleIds)

  const accountEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(prime).toScAddress(),
        nonce: own.credentials().address().nonce(),
        signatureExpirationLedger: exp,
        signature: xdr.ScVal.scvMap([
          kv('context_rule_ids', vec(ruleIds.map(u32v))),
          kv(
            'signers',
            xdr.ScVal.scvMap(
              signerList
                .map((a) => ({ a, k: delegatedSigner(a) }))
                .sort((x, y) => Buffer.compare(x.k.toXDR(), y.k.toXDR()))
                .map(({ k }) => new xdr.ScMapEntry({ key: k, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) })),
            ),
          ),
        ]),
      }),
    ),
    rootInvocation: own.rootInvocation(),
  })

  // The delegated signer authenticates through its own entry against
  // `prime.__check_auth(digest)`, carried by source-account credentials
  // because that signer IS the transaction source.
  const signerEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(prime).toScAddress(),
          functionName: '__check_auth',
          args: [xdr.ScVal.scvBytes(digest)],
        }),
      ),
      subInvocations: [],
    }),
  })

  // Anything else the host recorded stays. `bind_executor`, for instance,
  // needs the policy admin's OWN authorization beside Prime's: that key is
  // the transaction source, so its entry becomes source-account credentials.
  const others = recorded
    .filter((e) => e !== own)
    .map((e) => {
      const isSource =
        e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
        Address.fromScAddress(e.credentials().address().address()).toString() === kp.publicKey()
      return isSource
        ? new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
            rootInvocation: e.rootInvocation(),
          })
        : e
    })

  const authed = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(makeOp([accountEntry, signerEntry, ...others]))
    .setTimeout(120)
    .build()

  const sim2 = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2)) {
    if (opts.expectFailure) return { denied: true, reason: sim2.error }
    throw new Error(`${label}: authorised simulation failed ${sim2.error}`)
  }
  const prepared = rpc.assembleTransaction(authed, sim2).build()
  prepared.sign(kp)
  try {
    const r = (prepared as any).toEnvelope().v1().tx().ext().sorobanData()?.resources()
    if (r && opts.showCost) {
      log(
        'COST',
        `${label}: instructions ${r.instructions()}  readBytes ${r.diskReadBytes()}  writeBytes ${r.writeBytes()}`,
      )
    }
    return { denied: false, got: await settle(await server.sendTransaction(prepared), label) }
  } catch (err) {
    if (opts.expectFailure) return { denied: true, reason: String(err) }
    throw err
  }
}

// ------------------------------------------------------------- predicates ---

const path = (steps: xdr.ScVal[]) => vec([sym('call_path'), ...steps])
const eq = (a: xdr.ScVal, b: xdr.ScVal) => vec([sym('eq'), a, b])
const cmp = (op: string, a: xdr.ScVal, b: xdr.ScVal) => vec([sym(op), a, b])
const and = (xs: xdr.ScVal[]) => vec([sym('and'), vec(xs)])
const selector = (s: string) => vec([sym(s)])
const callArg = (i: number) => vec([sym('call_arg'), u32v(i)])
const callArgLen = (i: number) => vec([sym('call_arg_len'), u32v(i)])

/** `PolicyInstallParams`. ScMap keys must be sorted. */
function installParams(predicate: xdr.ScVal, adminPk: string) {
  const bytes = predicate.toXDR()
  return xdr.ScVal.scvMap([
    kv('grammar_version', u32v(6)),
    kv('install_nonce', u32v(1)),
    kv('policy_admins', vec([delegatedSigner(adminPk)])),
    kv('predicate', xdr.ScVal.scvBytes(bytes)),
    kv('predicate_hash', xdr.ScVal.scvBytes(hash(bytes))),
  ])
}

function addRuleArgs(opts: {
  scope: string
  name: string
  signer: string
  interpreter: string
  predicate: xdr.ScVal
  adminPk: string
}) {
  return [
    vec([sym('CallContract'), addr(opts.scope)]),
    xdr.ScVal.scvString(opts.name),
    xdr.ScVal.scvVoid(),
    vec([delegatedSigner(opts.signer)]),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: addr(opts.interpreter),
        val: installParams(opts.predicate, opts.adminPk),
      }),
    ]),
  ]
}

async function readI128(contract: string, fn: string, args: xdr.ScVal[], src: Keypair) {
  const tx = new TransactionBuilder(await server.getAccount(src.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(invokeOp(contract, fn, args))
    .setTimeout(60)
    .build()
  const sim: any = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`read ${fn}: ${sim.error}`)
  return scValToNative(sim.result.retval) as bigint
}

// ------------------------------------------------------------------ main ---

async function main() {
  console.log('=== grammar 6 + simplified adapter + custody gate: live testnet ===\n')
  const results: boolean[] = []
  const verdict = (name: string, ok: boolean, detail = '') => {
    console.log(`\n  ${ok ? 'PASS' : '** UNEXPECTED **'}  ${name}${detail ? `\n        ${detail}` : ''}`)
    results.push(ok)
  }

  const admin = Keypair.random()
  const agent = Keypair.random()
  const custody = Keypair.random()
  log('KEYS', `admin   ${admin.publicKey()}  (rule 0)`)
  log('KEYS', `agent   ${agent.publicKey()}  (policed)`)
  log('KEYS', `custody ${custody.publicKey()}  (holds the funds)`)
  await Promise.all([
    friendbot(admin.publicKey()),
    friendbot(agent.publicKey()),
    friendbot(custody.publicKey()),
  ])

  const wasms = {
    interpreter: readFileSync(`${W}/policy_interpreter.wasm`),
    adapter: readFileSync(`${W}/execution_adapter.wasm`),
    gate: readFileSync(`${W}/custody_gate.wasm`),
    venue: readFileSync(
      `${process.env.HOME}/.cache/t-venue/wasm32v1-none/release/execution_test_venue.wasm`,
    ),
  }
  for (const [name, w] of Object.entries(wasms)) {
    await send(admin, Operation.uploadContractWasm({ wasm: w }), `upload ${name}`)
    log('UPLOAD', `${name.padEnd(11)} ${String(w.length).padStart(6)} bytes  ${hash(w).toString('hex').slice(0, 16)}…`)
  }

  const interpRes = await send(
    admin,
    Operation.createCustomContract({
      address: Address.fromString(admin.publicKey()),
      wasmHash: hash(wasms.interpreter),
      salt: hash(Buffer.from(`i-${Date.now()}-${Math.random()}`)),
    }),
    'create interpreter',
  )
  const interpreter = Address.fromScVal(interpRes.returnValue!).toString()
  const gvTx = new TransactionBuilder(await server.getAccount(admin.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(interpreter).call('grammar_version'))
    .setTimeout(60)
    .build()
  const gvSim: any = await server.simulateTransaction(gvTx)
  const grammar = scValToNative(gvSim.result.retval)
  log('DEPLOY', `interpreter ${interpreter}`)
  verdict('interpreter reports grammar 6', grammar === 6, `grammar_version() = ${grammar}`)

  const primeRes = await send(
    admin,
    Operation.createCustomContract({
      address: Address.fromString(admin.publicKey()),
      wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec([delegatedSigner(admin.publicKey())]), xdr.ScVal.scvMap([])],
    }),
    'create prime',
  )
  const prime = Address.fromScVal(primeRes.returnValue!).toString()
  log('DEPLOY', `prime       ${prime}`)

  // ---- the adapter, deployed BY Prime at its derived address
  const salt = hash(Buffer.from('prime.execution.adapter.v1'))
  const deployAdapter = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      Operation.createCustomContract({
        address: Address.fromString(prime),
        wasmHash: hash(wasms.adapter),
        salt,
        auth,
      } as any),
    ruleIds: [0],
    label: 'deploy adapter',
  })
  const adapter = Address.fromScVal(deployAdapter.got!.returnValue!).toString()
  log('DEPLOY', `adapter     ${adapter}`)

  // ---- the gate: the institution's contract, holding their allowance
  const gateRes = await send(
    admin,
    Operation.createCustomContract({
      address: Address.fromString(admin.publicKey()),
      wasmHash: hash(wasms.gate),
      salt: hash(Buffer.from(`g-${Date.now()}-${Math.random()}`)),
      constructorArgs: [
        xdr.ScVal.scvMap([
          kv('allowed', vec([addr(prime)])),
          kv('caller', addr(adapter)),
          kv('custody', addr(custody.publicKey())),
        ]),
      ],
    }),
    'create gate',
  )
  const gate = Address.fromScVal(gateRes.returnValue!).toString()
  log('DEPLOY', `gate        ${gate}`)

  const venueRes = await send(
    admin,
    Operation.createCustomContract({
      address: Address.fromString(admin.publicKey()),
      wasmHash: hash(wasms.venue),
      salt: hash(Buffer.from(`v-${Date.now()}-${Math.random()}`)),
      constructorArgs: [addr(admin.publicKey())],
    }),
    'create venue',
  )
  const venue = Address.fromScVal(venueRes.returnValue!).toString()
  log('DEPLOY', `venue       ${venue}`)

  // ---- custody grants the allowance to the GATE, never to Prime
  const sac = Asset.native().contractId(PASSPHRASE)
  const expLedger = (await server.getLatestLedger()).sequence + 6000
  const CAP = 1_000_000n
  await send(
    custody,
    invokeOp(sac, 'approve', [
      addr(custody.publicKey()),
      addr(gate),
      i128v(5_000_000n),
      u32v(expLedger),
    ]),
    'approve gate',
  )
  const primeAllowance = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(prime)], admin)
  verdict('Prime holds no allowance on custody', primeAllowance === 0n, `allowance(custody → prime) = ${primeAllowance}`)

  // ---- root rule: the batch's shape, stated with grammar 6
  const AMOUNT = 300_000n
  const rootPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(2)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(gate)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('pull')),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(1)]), addr(prime)),
    cmp('gt', path([u32v(0), u32v(0), sym('args'), u32v(2)]), i128v(0n)),
    cmp('lt', path([u32v(0), u32v(0), sym('args'), u32v(2)]), i128v(CAP)),
    eq(path([u32v(0), u32v(1), sym('target')]), addr(sac)),
    eq(path([u32v(0), u32v(1), sym('function_name')]), sym('transfer')),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(0)]), addr(prime)),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(1)]), addr(custody.publicKey())),
    // The cross-call constraint. Grammar 5 could not write this without the
    // adapter first flattening both calls into one argument list.
    eq(
      path([u32v(0), u32v(0), sym('args'), u32v(2)]),
      path([u32v(0), u32v(1), sym('args'), u32v(2)]),
    ),
  ])

  const rootRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: adapter,
          name: 'root',
          signer: agent.publicKey(),
          interpreter,
          predicate: rootPredicate,
          adminPk: admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install root rule',
  })
  const rootId = Number(scValToNative(rootRes.got!.returnValue!).id)
  log('RULE', `root  id=${rootId}  scope=adapter  signer=agent  NOT bound to an executor`)

  // ---- child rule: the SAC transfer Prime makes on the way back
  const childPredicate = and([
    eq(selector('call_fn'), sym('transfer')),
    eq(callArg(0), addr(prime)),
    eq(callArg(1), addr(custody.publicKey())),
  ])
  const childRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: sac,
          name: 'child',
          signer: adapter,
          interpreter,
          predicate: childPredicate,
          adminPk: admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install child rule',
  })
  const childId = Number(scValToNative(childRes.got!.returnValue!).id)
  log('RULE', `child id=${childId}  scope=SAC      signer=adapter`)

  await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        interpreter,
        'bind_executor',
        [vec([addr(prime), u32v(childId)]), addr(adapter)],
        auth,
      ),
    ruleIds: [0],
    label: 'bind child executor',
  })
  log('RULE', `child bound to executor=adapter`)

  // ---- the batch
  const call = (target: string, fn: string, args: xdr.ScVal[]) =>
    xdr.ScVal.scvMap([
      kv('args', vec(args)),
      kv('executor_authorizations', vec([])),
      kv('function_name', sym(fn)),
      kv('target', addr(target)),
    ])

  const batch = (pull: bigint, back: bigint) =>
    vec([
      call(gate, 'pull', [addr(sac), addr(prime), i128v(pull)]),
      call(sac, 'transfer', [addr(prime), addr(custody.publicKey()), i128v(back)]),
    ])

  const runBatch = (pull: bigint, back: bigint, label: string, expectFailure = false) =>
    asAccount({
      kp: agent,
      prime,
      makeOp: (auth) =>
        invokeOp(
          adapter,
          'execute',
          [addr(prime), addr(interpreter), sym('enforce'), batch(pull, back), vec([])],
          auth,
        ),
      ruleIds: [rootId, childId],
      signers: [agent.publicKey(), adapter],
      label,
      expectFailure,
      showCost: !expectFailure,
    })

  const before = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate)], admin)

  console.log('\n--- PERMIT: pull N, return N ---')
  const ok = await runBatch(AMOUNT, AMOUNT, 'permitted batch')
  if (!ok.denied) log('TX', `permitted batch ${ok.got.txHash ?? ''}`)
  const after = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate)], admin)
  verdict(
    'batch executes and spends exactly N of the gate allowance',
    !ok.denied && before - after === AMOUNT,
    `allowance ${before} → ${after}   (Δ ${before - after}, expected ${AMOUNT})`,
  )

  // A denial is only evidence if it is the INTERPRETER denying. #100 is
  // ArgMismatch - the predicate refused the call. Any other failure would
  // mean the negative case passed for an unrelated reason.
  const denialCode = (r?: string) => (r ?? '').match(/Error\(Contract, #(\d+)\)/)?.[1] ?? 'none'

  console.log('\n--- DENY: pull N, return less (cross-call equality) ---')
  const unequal = await runBatch(AMOUNT, AMOUNT - 1n, 'unequal batch', true)
  verdict(
    'unequal legs are refused by the interpreter, #100 ArgMismatch',
    unequal.denied && denialCode(unequal.reason) === '100',
    `interpreter code ${denialCode(unequal.reason)}`,
  )

  console.log('\n--- DENY: amount at the cap ---')
  const over = await runBatch(CAP, CAP, 'over-cap batch', true)
  verdict(
    'an amount at the cap is refused by the interpreter, #100 ArgMismatch',
    over.denied && denialCode(over.reason) === '100',
    `interpreter code ${denialCode(over.reason)}`,
  )

  // The gate is the only way out: Prime has no allowance, so a direct pull
  // by Prime cannot even be built.
  const primeStillZero = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(prime)], admin)
  verdict('Prime still holds no allowance after a successful run', primeStillZero === 0n, `allowance(custody → prime) = ${primeStillZero}`)

  // ---------------------------------------------------------------- //
  // prime_contexts: a venue that calls a token on Prime's behalf, so the
  // transfer is a NESTED requirement rather than a call in the batch. This
  // is the adapter path nothing else here exercises.
  // ---------------------------------------------------------------- //
  console.log('\n--- prime_contexts: a nested Prime requirement ---')
  const relayPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(2)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(gate)),
    eq(path([u32v(0), u32v(1), sym('target')]), addr(venue)),
    eq(path([u32v(0), u32v(1), sym('function_name')]), sym('relay')),
    // the nested context the venue will raise, pinned from the root
    eq(callArgLen(1), u32v(1)),
    eq(path([u32v(1), u32v(0), sym('contract')]), addr(sac)),
    eq(path([u32v(1), u32v(0), sym('fn_name')]), sym('transfer')),
    eq(path([u32v(1), u32v(0), sym('args'), u32v(1)]), addr(custody.publicKey())),
    // and the same cross-call equality, now spanning a call and a context
    eq(
      path([u32v(0), u32v(0), sym('args'), u32v(2)]),
      path([u32v(1), u32v(0), sym('args'), u32v(2)]),
    ),
  ])
  const relayRootRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: adapter,
          name: 'relay-root',
          signer: agent.publicKey(),
          interpreter,
          predicate: relayPredicate,
          adminPk: admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install relay root rule',
  })
  const relayRootId = Number(scValToNative(relayRootRes.got!.returnValue!).id)
  log('RULE', `relay-root id=${relayRootId}`)

  const N2 = 120_000n
  const relayCtx = xdr.ScVal.scvMap([
    kv('args', vec([addr(prime), addr(custody.publicKey()), i128v(N2)])),
    kv('contract', addr(sac)),
    kv('fn_name', sym('transfer')),
  ])
  const beforeRelay = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate)], admin)
  const relayRun = await asAccount({
    kp: agent,
    prime,
    makeOp: (auth) =>
      invokeOp(
        adapter,
        'execute',
        [
          addr(prime),
          addr(interpreter),
          sym('enforce'),
          vec([
            call(gate, 'pull', [addr(sac), addr(prime), i128v(N2)]),
            call(venue, 'relay', [
              addr(sac),
              addr(prime),
              addr(custody.publicKey()),
              i128v(N2),
            ]),
          ]),
          vec([relayCtx]),
        ],
        auth,
      ),
    ruleIds: [relayRootId, childId],
    signers: [agent.publicKey(), adapter],
    label: 'relay batch',
  })
  const afterRelay = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate)], admin)
  verdict(
    'a nested Prime requirement travels as prime_contexts and is enforced',
    !relayRun.denied && beforeRelay - afterRelay === N2,
    `allowance ${beforeRelay} → ${afterRelay}   (Δ ${beforeRelay - afterRelay}, expected ${N2})`,
  )

  // ---------------------------------------------------------------- //
  // executor_authorizations: the adapter authorising a sub-invocation made
  // on ITS OWN behalf. Local tests cover this; nothing had run it against a
  // live network. A second gate is needed because the first one only lets
  // funds reach Prime.
  // ---------------------------------------------------------------- //
  console.log('\n--- executor_authorizations: the adapter as the spender ---')
  const gate2Res = await send(
    admin,
    Operation.createCustomContract({
      address: Address.fromString(admin.publicKey()),
      wasmHash: hash(wasms.gate),
      salt: hash(Buffer.from(`g2-${Date.now()}-${Math.random()}`)),
      constructorArgs: [
        xdr.ScVal.scvMap([
          kv('allowed', vec([addr(adapter)])),
          kv('caller', addr(adapter)),
          kv('custody', addr(custody.publicKey())),
        ]),
      ],
    }),
    'create gate2',
  )
  const gate2 = Address.fromScVal(gate2Res.returnValue!).toString()
  await send(
    custody,
    invokeOp(sac, 'approve', [
      addr(custody.publicKey()),
      addr(gate2),
      i128v(1_000_000n),
      u32v(expLedger),
    ]),
    'approve gate2',
  )
  log('DEPLOY', `gate2       ${gate2}  (allowed: adapter)`)

  const N3 = 90_000n
  const execAuth = vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv(
        'context',
        xdr.ScVal.scvMap([
          kv('args', vec([addr(adapter), addr(custody.publicKey()), i128v(N3)])),
          kv('contract', addr(sac)),
          kv('fn_name', sym('transfer')),
        ]),
      ),
      kv('sub_invocations', vec([])),
    ]),
  ])
  const callWithAuth = (target: string, fn: string, args: xdr.ScVal[], auths: xdr.ScVal[]) =>
    xdr.ScVal.scvMap([
      kv('args', vec(args)),
      kv('executor_authorizations', vec(auths)),
      kv('function_name', sym(fn)),
      kv('target', addr(target)),
    ])

  const execPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(2)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(gate2)),
    eq(path([u32v(0), u32v(1), sym('target')]), addr(venue)),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(1)]), addr(adapter)),
    // the authorization the adapter grants, pinned from the root - the
    // appended-entry case the Len step exists for
    eq(path([u32v(0), u32v(1), sym("executor_authorizations"), xdr.ScVal.scvBool(true)]), u32v(1)),
    eq(
      path([
        u32v(0),
        u32v(1),
        sym('executor_authorizations'),
        u32v(0),
        u32v(1),
        sym('context'),
        sym('contract'),
      ]),
      addr(sac),
    ),
  ])
  const execRootRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: adapter,
          name: 'exec-root',
          signer: agent.publicKey(),
          interpreter,
          predicate: execPredicate,
          adminPk: admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install exec root rule',
  })
  const execRootId = Number(scValToNative(execRootRes.got!.returnValue!).id)
  const beforeExec = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate2)], admin)
  const execRun = await asAccount({
    kp: agent,
    prime,
    makeOp: (auth) =>
      invokeOp(
        adapter,
        'execute',
        [
          addr(prime),
          addr(interpreter),
          sym('enforce'),
          vec([
            call(gate2, 'pull', [addr(sac), addr(adapter), i128v(N3)]),
            callWithAuth(
              venue,
              'relay',
              [addr(sac), addr(adapter), addr(custody.publicKey()), i128v(N3)],
              [execAuth],
            ),
          ]),
          vec([]),
        ],
        auth,
      ),
    ruleIds: [execRootId],
    signers: [agent.publicKey()],
    label: 'executor-auth batch',
  })
  const afterExec = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate2)], admin)
  verdict(
    'the adapter authorises its own sub-invocation and the path pins it',
    !execRun.denied && beforeExec - afterExec === N3,
    `allowance ${beforeExec} → ${afterExec}   (Δ ${beforeExec - afterExec}, expected ${N3})`,
  )

  // ---------------------------------------------------------------- //
  // MAX_PATH_STEPS is a contract constant; confirm the chain enforces it.
  // ---------------------------------------------------------------- //
  console.log('\n--- install-time bound: a path longer than the cap ---')
  const tooDeep = and([
    eq(selector('call_fn'), sym('execute')),
    eq(path(Array.from({ length: 9 }, () => u32v(0))), u32v(1)),
  ])
  const deepRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: adapter,
          name: 'too-deep',
          signer: agent.publicKey(),
          interpreter,
          predicate: tooDeep,
          adminPk: admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install over-deep predicate',
    expectFailure: true,
  })
  verdict(
    'a 9-step path is refused at install, #201 MalformedPredicate',
    deepRes.denied && denialCode(deepRes.reason) === '201',
    `interpreter code ${denialCode(deepRes.reason)}`,
  )

  const custodyEnd = await readI128(sac, 'balance', [addr(custody.publicKey())], admin)
  log('STATE', `custody balance at end: ${custodyEnd}`)

  console.log(`\n=== ${results.filter(Boolean).length}/${results.length} as predicted ===`)
  console.log(`prime       https://stellar.expert/explorer/testnet/contract/${prime}`)
  console.log(`adapter     https://stellar.expert/explorer/testnet/contract/${adapter}`)
  console.log(`gate        https://stellar.expert/explorer/testnet/contract/${gate}`)
  console.log(`interpreter https://stellar.expert/explorer/testnet/contract/${interpreter}`)
  console.log(`venue       https://stellar.expert/explorer/testnet/contract/${venue}`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
