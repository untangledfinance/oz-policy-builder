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
// The venue is the REAL Blend pool on testnet, the same one the repo's own
// atomic co-sign evidence used:
//
//   CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
//
// Batch: [ gate.pull(XLM, adapter, N),
//          pool.submit(prime, adapter, custody, [{XLM, N, supply}]) ]
//
// One batch exercises every path at once: the gate holds the allowance, the
// pool raises a Prime requirement that needs a grant, the pool pulls from the
// ADAPTER so the transfer travels as an executor authorization, and the
// amount the predicate ties across the two calls sits six steps deep inside
// Blend's request vector - the depth grammar 5 could not reach.

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
import { existsSync, readFileSync } from 'node:fs'

const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
// Artifacts come from each crate's own build output, so a fresh clone can run
// this after `cargo build --release --target wasm32v1-none` in contracts/*.
// PRIME_WASM_DIR overrides with a single directory holding all of them.
function wasmPath(crate: string, file: string): string {
  const override = process.env.PRIME_WASM_DIR
  const candidate = override
    ? `${override}/${file}.wasm`
    : `contracts/${crate}/target/wasm32v1-none/release/${file}.wasm`
  if (!existsSync(candidate)) {
    throw new Error(
      `missing ${file}.wasm at ${candidate}\n` +
        `Build it:  cargo build --release --target wasm32v1-none --manifest-path contracts/${crate}/Cargo.toml\n` +
        'or set PRIME_WASM_DIR to a directory holding the built artifacts.',
    )
  }
  return candidate
}

const PASSPHRASE = Networks.TESTNET
const FEE = '6000000'
const server = new rpc.Server('https://soroban-testnet.stellar.org')
/// The Blend pool the repo's own atomic co-sign evidence used.
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'

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
  validUntil?: number
}) {
  return [
    vec([sym('CallContract'), addr(opts.scope)]),
    xdr.ScVal.scvString(opts.name),
    opts.validUntil === undefined ? xdr.ScVal.scvVoid() : u32v(opts.validUntil),
    vec([delegatedSigner(opts.signer)]),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: addr(opts.interpreter),
        val: installParams(opts.predicate, opts.adminPk),
      }),
    ]),
  ]
}

async function readNative(contract: string, fn: string, args: xdr.ScVal[], src: Keypair) {
  const tx = new TransactionBuilder(await server.getAccount(src.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(invokeOp(contract, fn, args))
    .setTimeout(60)
    .build()
  const sim: any = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`read ${fn}: ${sim.error}`)
  return scValToNative(sim.result.retval)
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
    interpreter: readFileSync(wasmPath('policy-interpreter', 'policy_interpreter')),
    adapter: readFileSync(wasmPath('execution-adapter', 'execution_adapter')),
    gate: readFileSync(wasmPath('custody-gate', 'custody_gate')),
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
  const salt = hash(Buffer.from('prime.execution.adapter.v2'))
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

  const sac = Asset.native().contractId(PASSPHRASE)
  const expLedger = (await server.getLatestLedger()).sequence + 6000
  const primeAllowance = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(prime)], admin)
  verdict('Prime holds no allowance on custody', primeAllowance === 0n, `allowance(custody → prime) = ${primeAllowance}`)

  // ---------------------------------------------------------------- //
  // One grant per context the policy will be asked about. The adapter no
  // longer derives these, which is why it needs to know neither the policy's
  // entrypoint nor its argument shape.
  // ---------------------------------------------------------------- //
  const ctxVal = (contract: string, fn: string, args: xdr.ScVal[]) =>
    vec([
      sym('Contract'),
      xdr.ScVal.scvMap([
        kv('args', vec(args)),
        kv('contract', addr(contract)),
        kv('fn_name', sym(fn)),
      ]),
    ])
  const grant = (contract: string, fn: string, args: xdr.ScVal[]) =>
    vec([
      sym('Contract'),
      xdr.ScVal.scvMap([
        kv(
          'context',
          xdr.ScVal.scvMap([
            kv('args', vec([addr(prime), ctxVal(contract, fn, args)])),
            kv('contract', addr(interpreter)),
            kv('fn_name', sym('enforce')),
          ]),
        ),
        kv('sub_invocations', vec([])),
      ]),
    ])
  const call = (
    target: string,
    fn: string,
    args: xdr.ScVal[],
    execAuths: xdr.ScVal[] = [],
  ) =>
    xdr.ScVal.scvMap([
      kv('args', vec(args)),
      kv('executor_authorizations', vec(execAuths)),
      kv('function_name', sym(fn)),
      kv('target', addr(target)),
    ])

  // ---- a gate that lets funds reach the adapter, which is what Blend spends
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
      i128v(20_000_000n),
      u32v(expLedger),
    ]),
    'approve gate2',
  )
  log('DEPLOY', `gate2       ${gate2}  (allowed: adapter)`)
  log('VENUE', `blend pool  ${POOL}  (real, testnet)`)

  const AMOUNT = 2_000_000n
  // Deliberately well under the allowance. If the cap sat at or above what
  // the custody account granted, the at-cap case would be refused by the SAC
  // for want of allowance and never reach the predicate - a denial for the
  // wrong reason, which is no evidence at all.
  const CAP = 3_000_000n
  const request = (amount: bigint) =>
    vec([
      xdr.ScVal.scvMap([
        kv('address', addr(sac)),
        kv('amount', i128v(amount)),
        kv('request_type', u32v(0)),
      ]),
    ])
  const submitArgs = (amount: bigint) => [
    addr(prime),
    addr(adapter),
    addr(custody.publicKey()),
    request(amount),
  ]
  const transferAuth = (amount: bigint) =>
    vec([
      sym('Contract'),
      xdr.ScVal.scvMap([
        kv(
          'context',
          xdr.ScVal.scvMap([
            kv('args', vec([addr(adapter), addr(POOL), i128v(amount)])),
            kv('contract', addr(sac)),
            kv('fn_name', sym('transfer')),
          ]),
        ),
        kv('sub_invocations', vec([])),
      ]),
    ])

  // ---- root rule
  const P_PULL_AMT = [u32v(0), u32v(0), sym('args'), u32v(2)]
  const P_SUPPLY_AMT = [
    u32v(0),
    u32v(1),
    sym('args'),
    u32v(3),
    u32v(0),
    sym('amount'),
  ]
  const rootPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(2)),
    eq(callArgLen(1), u32v(1)), // exactly one grant: the batch is exhaustive
    eq(path([u32v(0), u32v(0), sym('target')]), addr(gate2)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('pull')),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(1)]), addr(adapter)),
    cmp('gt', path(P_PULL_AMT), i128v(0n)),
    cmp('lt', path(P_PULL_AMT), i128v(CAP)),
    eq(path([u32v(0), u32v(1), sym('target')]), addr(POOL)),
    eq(path([u32v(0), u32v(1), sym('function_name')]), sym('submit')),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(0)]), addr(prime)),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(2)]), addr(custody.publicKey())),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(3), xdr.ScVal.scvBool(true)]), u32v(1)),
    eq(path([...P_SUPPLY_AMT.slice(0, 5), sym('address')]), addr(sac)),
    eq(path([...P_SUPPLY_AMT.slice(0, 5), sym('request_type')]), u32v(0)),
    // six steps deep, and tied to the amount pulled one call earlier
    eq(path(P_PULL_AMT), path(P_SUPPLY_AMT)),
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
  log('RULE', `root  id=${rootId}  scope=adapter  NOT bound to an executor`)

  // ---- child rule for the pool call
  const childPredicate = and([
    eq(selector('call_fn'), sym('submit')),
    eq(callArg(0), addr(prime)),
    eq(callArg(1), addr(adapter)),
  ])
  const childRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: POOL,
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
  await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(interpreter, 'bind_executor', [vec([addr(prime), u32v(childId)]), addr(adapter)], auth),
    ruleIds: [0],
    label: 'bind child executor',
  })
  log('RULE', `child id=${childId}  scope=blend pool  signer=adapter  bound`)

  const runBlend = (
    pull: bigint,
    supply: bigint,
    label: string,
    opts: { expectFailure?: boolean; extraGrant?: boolean } = {},
  ) =>
    asAccount({
      kp: agent,
      prime,
      makeOp: (auth) =>
        invokeOp(
          adapter,
          'execute',
          [
            addr(prime),
            addr(interpreter),
            vec([
              call(gate2, 'pull', [addr(sac), addr(adapter), i128v(pull)]),
              call(POOL, 'submit', submitArgs(supply), [transferAuth(supply)]),
            ]),
            vec(
              opts.extraGrant
                ? [
                    grant(POOL, 'submit', submitArgs(supply)),
                    grant(sac, 'transfer', [addr(prime), addr(agent.publicKey()), i128v(1n)]),
                  ]
                : [grant(POOL, 'submit', submitArgs(supply))],
            ),
          ],
          auth,
        ),
      ruleIds: [rootId, childId],
      signers: [agent.publicKey(), adapter],
      label,
      expectFailure: opts.expectFailure,
      showCost: !opts.expectFailure,
    })

  const denialCode = (r?: string) => (r ?? '').match(/Error\(Contract, #(\d+)\)/)?.[1] ?? 'none'
  const before = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate2)], admin)

  console.log('\n--- PERMIT: supply into the real Blend pool ---')
  const ok = await runBlend(AMOUNT, AMOUNT, 'blend supply')
  const after = await readI128(sac, 'allowance', [addr(custody.publicKey()), addr(gate2)], admin)
  verdict(
    'a real Blend supply executes and spends exactly N of the gate allowance',
    !ok.denied && before - after === AMOUNT,
    `allowance ${before} → ${after}   (Δ ${before - after}, expected ${AMOUNT})`,
  )

  // The allowance falling is not proof the money ARRIVED. Blend credits a
  // position to `from`, which is Prime; read it back.
  const pos: any = await readNative('get_positions', 'x', [], admin).catch(() => null)
  void pos
  const positions: any = await readNative(POOL, 'get_positions', [addr(prime)], admin)
  const supplied = Object.values(positions?.supply ?? {})[0]
  verdict(
    'the supply is credited to Prime as a real Blend position',
    supplied !== undefined && BigInt(supplied as any) > 0n,
    `get_positions(prime).supply = ${JSON.stringify(positions?.supply, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
  )

  // ---- and it can be taken back out, straight to custody
  console.log('\n--- PERMIT: withdraw the position back to custody ---')
  const withdrawArgs = (amount: bigint) => [
    addr(prime),
    addr(adapter),
    addr(custody.publicKey()),
    vec([
      xdr.ScVal.scvMap([
        kv('address', addr(sac)),
        kv('amount', i128v(amount)),
        kv('request_type', u32v(1)),
      ]),
    ]),
  ]
  const wPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(1)),
    eq(callArgLen(1), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(POOL)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('submit')),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(2)]), addr(custody.publicKey())),
    eq(
      path([u32v(0), u32v(0), sym('args'), u32v(3), u32v(0), sym('request_type')]),
      u32v(1),
    ),
    // nothing leaves the adapter on a withdraw
    eq(path([u32v(0), u32v(0), sym('executor_authorizations'), xdr.ScVal.scvBool(true)]), u32v(0)),
  ])
  const wRootRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: adapter,
          name: 'withdraw-root',
          signer: agent.publicKey(),
          interpreter,
          predicate: wPredicate,
          adminPk: admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install withdraw root rule',
  })
  const wRootId = Number(scValToNative(wRootRes.got!.returnValue!).id)
  const custodyBefore = await readI128(sac, 'balance', [addr(custody.publicKey())], admin)
  const wRun = await asAccount({
    kp: agent,
    prime,
    makeOp: (auth) =>
      invokeOp(
        adapter,
        'execute',
        [
          addr(prime),
          addr(interpreter),
          vec([call(POOL, 'submit', withdrawArgs(AMOUNT))]),
          vec([grant(POOL, 'submit', withdrawArgs(AMOUNT))]),
        ],
        auth,
      ),
    ruleIds: [wRootId, childId],
    signers: [agent.publicKey(), adapter],
    label: 'blend withdraw',
    showCost: true,
  })
  const custodyAfter = await readI128(sac, 'balance', [addr(custody.publicKey())], admin)
  verdict(
    'the withdrawal returns the funds to custody',
    !wRun.denied && custodyAfter > custodyBefore,
    `custody XLM ${custodyBefore} → ${custodyAfter}   (Δ +${custodyAfter - custodyBefore}, supplied ${AMOUNT})`,
  )

  console.log('\n--- DENY: pull N, supply less ---')
  const unequal = await runBlend(AMOUNT, AMOUNT - 1n, 'unequal blend batch', { expectFailure: true })
  verdict(
    'the six-step cross-call equality refuses it, #100',
    unequal.denied && denialCode(unequal.reason) === '100',
    `interpreter code ${denialCode(unequal.reason)}`,
  )

  console.log('\n--- DENY: amount at the cap ---')
  const over = await runBlend(CAP, CAP, 'over-cap blend batch', { expectFailure: true })
  verdict(
    'an amount at the cap is refused, #100',
    over.denied && denialCode(over.reason) === '100',
    `interpreter code ${denialCode(over.reason)}`,
  )

  console.log('\n--- DENY: an extra grant ---')
  const extra = await runBlend(AMOUNT, AMOUNT, 'extra-grant batch', {
    expectFailure: true,
    extraGrant: true,
  })
  verdict(
    'a grant the predicate did not count is refused, #100',
    extra.denied && denialCode(extra.reason) === '100',
    `interpreter code ${denialCode(extra.reason)}`,
  )

  // ---------------------------------------------------------------- //
  // How close can a legitimate mandate get to the CPU ceiling? The predicate
  // is walked per leaf, so the cost that matters is a full-size predicate of
  // deep paths, not a small one.
  // ---------------------------------------------------------------- //
  // ---------------------------------------------------------------- //
  // The other direction of exhaustiveness: too FEW grants, and too many
  // calls. Both are the adapter refusing, not the policy.
  // ---------------------------------------------------------------- //
  console.log('\n--- DENY: a missing grant, and an oversized batch ---')
  const noGrant = await asAccount({
    kp: agent,
    prime,
    makeOp: (auth) =>
      invokeOp(
        adapter,
        'execute',
        [
          addr(prime),
          addr(interpreter),
          vec([
            call(gate2, 'pull', [addr(sac), addr(adapter), i128v(AMOUNT)]),
            call(POOL, 'submit', submitArgs(AMOUNT), [transferAuth(AMOUNT)]),
          ]),
          vec([]),
        ],
        auth,
      ),
    ruleIds: [rootId, childId],
    signers: [agent.publicKey(), adapter],
    label: 'missing grant',
    expectFailure: true,
  })
  verdict(
    'a batch whose grant list is short cannot run',
    noGrant.denied,
    (noGrant.reason ?? '').slice(0, 80),
  )

  const big = await asAccount({
    kp: agent,
    prime,
    makeOp: (auth) =>
      invokeOp(
        adapter,
        'execute',
        [
          addr(prime),
          addr(interpreter),
          vec(
            Array.from({ length: 9 }, () =>
              call(gate2, 'pull', [addr(sac), addr(adapter), i128v(1n)]),
            ),
          ),
          vec([]),
        ],
        auth,
      ),
    ruleIds: [rootId],
    signers: [agent.publicKey(), adapter],
    label: 'oversized batch',
    expectFailure: true,
  })
  verdict('a batch of nine calls is refused by the adapter', big.denied, (big.reason ?? '').slice(0, 80))

  console.log('\n--- headroom: a predicate near the leaf cap ---')
  // calls[1] is the pool submit, the only call with a nested request vector.
  // Pointed at calls[0] this compares against nothing and every run denies,
  // which measures the cost of failing early rather than of evaluating.
  const deepPath = [u32v(0), u32v(1), sym('args'), u32v(3), u32v(0), sym('amount')]
  for (const pairs of [10, 45, 95]) {
    const bulk = and([
      eq(selector('call_fn'), sym('execute')),
      eq(callArgLen(0), u32v(2)),
      eq(callArgLen(1), u32v(1)),
      eq(path([u32v(0), u32v(0), sym('target')]), addr(gate2)),
      eq(path([u32v(0), u32v(1), sym('target')]), addr(POOL)),
      ...Array.from({ length: pairs }, () => eq(path(deepPath), i128v(AMOUNT))),
    ])
    const bytes = bulk.toXDR().length
    const r = await asAccount({
      kp: admin,
      prime,
      makeOp: (auth) =>
        invokeOp(
          prime,
          'add_context_rule',
          addRuleArgs({
            scope: adapter,
            name: `bulk-${pairs}`,
            signer: agent.publicKey(),
            interpreter,
            predicate: bulk,
            adminPk: admin.publicKey(),
          }),
          auth,
        ),
      ruleIds: [0],
      label: `install bulk-${pairs}`,
      expectFailure: true,
    })
    if (r.denied) {
      log('HEADROOM', `${String(pairs).padStart(3)} compares (${bytes} B): install REFUSED, code ${denialCode(r.reason)}`)
      continue
    }
    const id = Number(scValToNative(r.got!.returnValue!).id)
    const run = await asAccount({
      kp: agent,
      prime,
      makeOp: (auth) =>
        invokeOp(
          adapter,
          'execute',
          [
            addr(prime),
            addr(interpreter),
            vec([
              call(gate2, 'pull', [addr(sac), addr(adapter), i128v(AMOUNT)]),
              call(POOL, 'submit', submitArgs(AMOUNT), [transferAuth(AMOUNT)]),
            ]),
            vec([grant(POOL, 'submit', submitArgs(AMOUNT))]),
          ],
          auth,
        ),
      ruleIds: [id, childId],
      signers: [agent.publicKey(), adapter],
      label: `bulk-${pairs}`,
      showCost: true,
      expectFailure: true,
    })
    if (!run.denied) {
      // undo, so the next size starts from the same allowance
      await asAccount({
        kp: agent,
        prime,
        makeOp: (auth) =>
          invokeOp(
            adapter,
            'execute',
            [
              addr(prime),
              addr(interpreter),
              vec([call(POOL, 'submit', withdrawArgs(AMOUNT))]),
              vec([grant(POOL, 'submit', withdrawArgs(AMOUNT))]),
            ],
            auth,
          ),
        ruleIds: [wRootId, childId],
        signers: [agent.publicKey(), adapter],
        label: `bulk-${pairs} unwind`,
      })
    }
    log(
      'HEADROOM',
      `${String(pairs).padStart(3)} compares (${bytes} B): ${run.denied ? `DENIED ${denialCode(run.reason)}` : 'executed'}`,
    )
  }

  // ---------------------------------------------------------------- //
  // valid_until: the field the install path has always written as null.
  // ---------------------------------------------------------------- //
  console.log('\n--- rule expiry ---')
  const nowLedger = (await server.getLatestLedger()).sequence
  const expiredRes = await asAccount({
    kp: admin,
    prime,
    makeOp: (auth) =>
      invokeOp(
        prime,
        'add_context_rule',
        addRuleArgs({
          scope: adapter,
          name: 'already-expired',
          signer: agent.publicKey(),
          interpreter,
          predicate: rootPredicate,
          adminPk: admin.publicKey(),
          validUntil: nowLedger - 1,
        }),
        auth,
      ),
    ruleIds: [0],
    label: 'install an expired rule',
    expectFailure: true,
  })
  if (expiredRes.denied) {
    verdict(
      'a rule whose valid_until is already past is refused at install',
      true,
      `code ${denialCode(expiredRes.reason)}`,
    )
  } else {
    const expiredId = Number(scValToNative(expiredRes.got!.returnValue!).id)
    const useExpired = await asAccount({
      kp: agent,
      prime,
      makeOp: (auth) =>
        invokeOp(
          adapter,
          'execute',
          [
            addr(prime),
            addr(interpreter),
            vec([
              call(gate2, 'pull', [addr(sac), addr(adapter), i128v(AMOUNT)]),
              call(POOL, 'submit', submitArgs(AMOUNT), [transferAuth(AMOUNT)]),
            ]),
            vec([grant(POOL, 'submit', submitArgs(AMOUNT))]),
          ],
          auth,
        ),
      ruleIds: [expiredId, childId],
      signers: [agent.publicKey(), adapter],
      label: 'use an expired rule',
      expectFailure: true,
    })
    verdict(
      'an expired rule installs but cannot authorise',
      useExpired.denied,
      `rule ${expiredId} valid_until ${nowLedger - 1}, now ${nowLedger}; code ${denialCode(useExpired.reason)}`,
    )
  }

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
    'a 9-step path is refused at install, #201',
    deepRes.denied && denialCode(deepRes.reason) === '201',
    `interpreter code ${denialCode(deepRes.reason)}`,
  )

  const primeStillZero = await readI128(
    sac,
    'allowance',
    [addr(custody.publicKey()), addr(prime)],
    admin,
  )
  verdict('Prime never holds an allowance', primeStillZero === 0n, `allowance = ${primeStillZero}`)

  console.log(`\n=== ${results.filter(Boolean).length}/${results.length} as predicted ===`)
  console.log(`prime       https://stellar.expert/explorer/testnet/contract/${prime}`)
  console.log(`adapter     https://stellar.expert/explorer/testnet/contract/${adapter}`)
  console.log(`gate2       https://stellar.expert/explorer/testnet/contract/${gate2}`)
  console.log(`interpreter https://stellar.expert/explorer/testnet/contract/${interpreter}`)
  console.log(`blend pool  https://stellar.expert/explorer/testnet/contract/${POOL}`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
