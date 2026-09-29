// End-to-end check of the v4 execution adapter - batching with an optional
// wait - against a REAL Prime smart account, the unchanged v3 custody gate and
// the live Blend pool on testnet.
//
// What it proves, beyond what the unit tests can:
//   - a batch run at once (wait 0) still works exactly as v3 did;
//   - a stored batch runs later with NO signature from the Prime: `run` asks
//     the Prime through the rule the adapter signs to run stored batches, and
//     Blend's own request mid-batch sits inside that approval;
//   - that run rule approves `run` and nothing else: not an immediate
//     `execute`, not a `cancel`;
//   - a wait-only recovery pull pays a listed trustee;
//   - a rule's interpreter predicate can demand a minimum wait of its own,
//     and an agent's rule cannot cancel;
//   - the Prime and custody can cancel, nobody else can;
//   - a batch lapses after its run window, and the adapter's floor binds
//     every caller;
//   - the Prime cannot create the adapter at the address custody named with
//     a lower floor or a different window than custody agreed to.
//
//   bun scripts/verify-execution-wait-testnet.ts
//
// Reads the shared grammar-6 interpreter from deployments/grammar6-testnet.json;
// every account it uses is created and funded fresh.

import { readFileSync } from 'node:fs'
import {
  Address,
  Asset,
  hash,
  Keypair,
  Operation,
  StrKey,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import {
  ACCOUNT_WASM_HASH,
  addRuleArgs,
  addr,
  and,
  asPrime,
  C,
  call,
  callArg,
  codeOf,
  delegatedSigner,
  eq,
  grant,
  horizon,
  i128v,
  invokeOp,
  kv,
  LIMIT,
  MOVE,
  PASSPHRASE,
  POOL,
  selector,
  send,
  server,
  sym,
  u32v,
  vec,
  wasmPath,
} from './lib/chain.ts'

/** The salt domain custody uses to find the adapter before it is deployed. */
const DOMAIN = 'prime.execution.adapter.v4'
const NAMES: Record<string, string> = {
  '1': 'PrimeTarget',
  '2': 'AddressNotAllowed',
  '3': 'Uncheckable',
  '4': 'WaitTooShort',
  '5': 'NotScheduled',
  '6': 'NotRunnable',
  '7': 'NotACanceller',
  '8': 'NotWhereAgreed',
}
/** Ledgers a stored batch may still run after its wait. Long enough for the
 *  checks between scheduling and running, short enough that the lapse check
 *  below finishes in a few minutes. */
const WINDOW = 40
/** The minimum wait the agent's own rule demands. */
const AGENT_MIN = 5

const gte = (a: xdr.ScVal, b: xdr.ScVal) => vec([sym('gte'), a, b])
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
/** Where custody expects the adapter: the salt commits to the gate and to
 *  both numbers, and the adapter's constructor refuses any other address. */
const adapterSalt = (gate: string, minWait: number, window: number) =>
  hash(
    Buffer.concat([
      Buffer.from(DOMAIN),
      addr(gate).toXDR(),
      u32v(minWait).toXDR(),
      u32v(window).toXDR(),
    ])
  )

let fails = 0
const report = (ok: boolean, label: string, got: string) => {
  if (!ok) fails++
  console.log(`${ok ? C.dim('ok  ') : '\x1b[31mMISMATCH\x1b[0m'} ${label.padEnd(56)} ${got}`)
}
const interpreter: string = JSON.parse(
  readFileSync(new URL('../deployments/grammar6-testnet.json', import.meta.url), 'utf8')
).interpreter
const sac = Asset.native().contractId(PASSPHRASE)

const K = {
  admin: Keypair.random(),
  agent: Keypair.random(),
  custody: Keypair.random(),
  trustee: Keypair.random(),
  keeper: Keypair.random(),
  stranger: Keypair.random(),
}
await Promise.all(
  Object.values(K).map((k) => fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`))
)
await new Promise((r) => setTimeout(r, 6000))
const CUSTODY = K.custody.publicKey()
const TRUSTEE = K.trustee.publicKey()

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

// THE GATE IS THE v3 CONTRACT, UNCHANGED. It pins its caller's address and
// code, so it takes the v4 adapter as it took v3 - only its configuration
// names the new code.
const gateWasm = readFileSync(wasmPath('custody-gate', 'custody_gate'))
const adapWasm = readFileSync(wasmPath('execution-adapter', 'execution_adapter'))
const GW = hash(gateWasm)
const AW = hash(adapWasm)
for (const w of [gateWasm, adapWasm]) {
  try {
    await send(K.admin, Operation.uploadContractWasm({ wasm: w }), 'upload')
  } catch {
    /* already uploaded */
  }
}

const must = (r: any, what: string) => {
  if (r.denied) throw new Error(`${what}: ${String(r.reason).slice(0, 200)}`)
  return r.got
}

/** A gate for this Prime and the adapter derived from it, deployed and funded.
 *  With `tamper`, the Prime first tries to create the adapter at the address
 *  custody named but with a minimum wait of 0, which must be refused. */
async function pair(tag: string, minWait: number, tamper = false) {
  const gateSalt = hash(Buffer.from(`v4.${tag}.${Date.now()}`))
  const gate = contractId(CUSTODY, gateSalt)
  const adapter = contractId(prime, adapterSalt(gate, minWait, WINDOW))
  await send(
    K.custody,
    Operation.createCustomContract({
      address: Address.fromString(CUSTODY),
      wasmHash: GW,
      salt: gateSalt,
      constructorArgs: [
        xdr.ScVal.scvMap([
          kv('allowed', vec([adapter, CUSTODY, TRUSTEE, sac, POOL, prime, interpreter].map(addr))),
          kv('caller', addr(adapter)),
          kv('caller_code', xdr.ScVal.scvBytes(AW)),
          kv('custody', addr(CUSTODY)),
        ]),
      ],
    }),
    `deploy ${tag} gate`
  )
  await send(
    K.custody,
    invokeOp(sac, 'approve', [
      addr(CUSTODY),
      addr(gate),
      i128v(LIMIT),
      u32v((await server.getLatestLedger()).sequence + 6000),
    ]),
    `approve ${tag} limit`
  )
  const create = (args: number[]) => (auth: xdr.SorobanAuthorizationEntry[]) =>
    Operation.createCustomContract({
      address: Address.fromString(prime),
      wasmHash: AW,
      salt: adapterSalt(gate, minWait, WINDOW),
      constructorArgs: [addr(prime), addr(gate), ...args.map(u32v)],
      auth,
    } as any)
  if (tamper) {
    for (const [label, args] of [
      ['the named address, with a minimum wait of 0', [0, WINDOW]],
      ['the named address, with a longer run window', [minWait, WINDOW * 1000]],
    ] as const) {
      const r = await asPrime({
        kp: K.admin,
        prime,
        ruleIds: [0],
        label,
        submit: false,
        makeOp: create([...args]),
      })
      const code = codeOf(r.reason)
      report(
        r.denied && code === '8',
        `created at ${label}`,
        r.denied ? `REFUSE  #${code} ${NAMES[code ?? ''] ?? ''}` : 'PERMIT'
      )
    }
  }
  must(
    await asPrime({
      kp: K.admin,
      prime,
      ruleIds: [0],
      label: `deploy ${tag} adapter`,
      submit: true,
      makeOp: create([minWait, WINDOW]),
    }),
    `deploy ${tag} adapter`
  )
  return { gate, adapter }
}

const { gate, adapter } = await pair('main', 0)

/** Install a rule on the Prime, retrying the interpreter's install as v3 does. */
async function addRule(o: { scope: string; signer: string; name: string; predicate: xdr.ScVal }) {
  for (let i = 0; i < 5; i++) {
    const r = await asPrime({
      kp: K.admin,
      prime,
      ruleIds: [0],
      label: `install ${o.name}`,
      submit: true,
      makeOp: (auth) =>
        invokeOp(
          prime,
          'add_context_rule',
          addRuleArgs({
            scope: o.scope,
            name: `${o.name}-${i}`,
            signer: o.signer,
            interpreter,
            adminPk: K.admin.publicKey(),
            predicate: o.predicate,
          }),
          auth
        ),
    })
    if (!r.denied) return Number(scValToNative(r.got!.returnValue!).id)
    await new Promise((x) => setTimeout(x, 4000))
  }
  throw new Error(`could not install ${o.name}`)
}

// Blend asks the Prime to authorise `submit`; the pool rule answers it, with
// the adapter as its signer and bound as the interpreter's executor.
const poolRule = await addRule({
  scope: POOL,
  signer: adapter,
  name: 'v4-pool',
  predicate: and([
    eq(selector('call_fn'), sym('submit')),
    eq(callArg(0), addr(prime)),
    eq(callArg(1), addr(adapter)),
  ]),
})
must(
  await asPrime({
    kp: K.admin,
    prime,
    ruleIds: [0],
    label: 'bind executor',
    submit: true,
    makeOp: (auth) =>
      invokeOp(
        interpreter,
        'bind_executor',
        [vec([addr(prime), u32v(poolRule)]), addr(adapter)],
        auth
      ),
  }),
  'bind executor'
)
// The run rule: the adapter signs, and its predicate permits `run` alone.
// Without the predicate anyone could have the adapter approve an immediate
// `execute` for the Prime through it - checked below.
const runRule = await addRule({
  scope: adapter,
  signer: adapter,
  name: 'v4-run',
  predicate: eq(selector('call_fn'), sym('run')),
})
// The agent's rule: only `execute`, and never with less than AGENT_MIN.
const agentRule = await addRule({
  scope: adapter,
  signer: K.agent.publicKey(),
  name: 'v4-agent',
  predicate: and([eq(selector('call_fn'), sym('execute')), gte(callArg(2), u32v(AGENT_MIN))]),
})

console.log(C.bold('\nprime   ') + prime)
console.log(C.bold('gate    ') + gate + C.dim('  (custody-gate, unchanged)'))
console.log(C.bold('adapter ') + adapter + C.dim(`  ${adapWasm.length}B, window ${WINDOW} ledgers`))
console.log(C.bold('rules   ') + `pool ${poolRule}, run ${runRule}, agent ${agentRule}`)

const request = (amount: bigint, kind: 0 | 1) =>
  vec([
    xdr.ScVal.scvMap([
      kv('address', addr(sac)),
      kv('amount', i128v(amount)),
      kv('request_type', u32v(kind)),
    ]),
  ])
const tokenAuth = (token: string, from: string, to: string, amount: bigint) =>
  vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv(
        'context',
        xdr.ScVal.scvMap([
          kv('args', vec([addr(from), addr(to), i128v(amount)])),
          kv('contract', addr(token)),
          kv('fn_name', sym('transfer')),
        ])
      ),
      kv('sub_invocations', vec([])),
    ]),
  ])
const supplyArgs = [addr(prime), addr(adapter), addr(CUSTODY), request(MOVE, 0)]
const supply = {
  calls: vec([
    call(gate, 'pull', [addr(sac), addr(adapter), i128v(MOVE)]),
    call(POOL, 'submit', supplyArgs, [tokenAuth(sac, adapter, POOL, MOVE)]),
  ]),
  grants: vec([grant({ prime, interpreter } as any, POOL, 'submit', supplyArgs)]),
}
const payHome = (amount: bigint) => ({
  calls: vec([
    call(gate, 'pull', [addr(sac), addr(adapter), i128v(amount)]),
    call(sac, 'transfer', [addr(adapter), addr(CUSTODY), i128v(amount)]),
  ]),
  grants: vec([]),
})
/** The recovery shape: the gate pays the trustee straight from custody. */
const RECOVER = 3_000_000n
const recover = {
  calls: vec([call(gate, 'pull', [addr(sac), addr(TRUSTEE), i128v(RECOVER)])]),
  grants: vec([]),
}

type Batch = { calls: xdr.ScVal; grants: xdr.ScVal }
/** `execute` under a rule; returns the stored batch's number, if any. */
async function execute(
  label: string,
  batch: Batch,
  wait: number,
  expect: 'PERMIT' | 'REFUSE',
  o: { kp?: Keypair; rules?: number[]; signers?: string[]; submit?: boolean; to?: string } = {}
): Promise<number | null> {
  const kp = o.kp ?? K.admin
  const r = await asPrime({
    kp,
    prime,
    label,
    submit: o.submit ?? expect === 'PERMIT',
    ruleIds: o.rules ?? [0],
    signers: o.signers ?? [kp.publicKey()],
    makeOp: (auth) =>
      invokeOp(o.to ?? adapter, 'execute', [batch.calls, batch.grants, u32v(wait)], auth),
  })
  const code = codeOf(r.reason)
  const got = r.denied ? 'REFUSE' : 'PERMIT'
  const id = r.got?.returnValue ? scValToNative(r.got.returnValue) : null
  report(
    got === expect,
    label,
    `${got.padEnd(7)} ${r.denied ? (code ? `#${code} ${NAMES[code] ?? ''}` : String(r.reason).split('\n')[0].slice(0, 50)) : id ? `batch ${id}` : ''}`
  )
  return id === null || id === undefined ? null : Number(id)
}

/** Submit `op` from `kp` directly; `want` is LANDS or the contract error. */
async function land(
  label: string,
  kp: Keypair,
  op: xdr.Operation,
  want: 'LANDS' | keyof typeof NAMES
) {
  let got = 'LANDS'
  try {
    await send(kp, op, label)
  } catch (e) {
    got =
      codeOf(String(e)) ?? String(e).match(/Error\([A-Za-z]+, [#A-Za-z0-9]+\)/)?.[0] ?? 'refused'
  }
  report(got === want, label, got === 'LANDS' ? 'LANDS' : `#${got} ${NAMES[got] ?? ''}`)
}

/** Run a stored batch as the keeper - someone with no role anywhere. The
 *  Prime's approval of `run` comes from the run rule, signed by the adapter
 *  alone; a venue that asks the Prime too adds its own rule after it. */
async function runStored(
  label: string,
  id: number,
  want: 'LANDS' | keyof typeof NAMES,
  venueRules: number[] = []
) {
  const r = await asPrime({
    kp: K.keeper,
    prime,
    label,
    submit: true,
    ruleIds: [runRule, ...venueRules],
    signers: [adapter],
    makeOp: (auth) => invokeOp(adapter, 'run', [u32v(id)], auth),
  })
  const code = codeOf(r.reason)
  const got = r.denied ? (code ?? 'refused') : 'LANDS'
  report(
    got === want,
    label,
    r.denied ? `#${code} ${NAMES[code ?? ''] ?? String(r.reason).slice(0, 60)}` : 'LANDS'
  )
}

const storedKey = (id: number) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(adapter).toScAddress(),
      key: u32v(id),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
/** A stored batch is `(calls, grants, run_at)`; it runs through run_at + WINDOW. */
async function stored(id: number) {
  const e = (await server.getLedgerEntries(storedKey(id))).entries[0]
  if (!e) return null
  const [, , runAt] = scValToNative((e.val as any).contractData().val()) as [
    unknown,
    unknown,
    number,
  ]
  return { run_at: Number(runAt), expires: Number(runAt) + WINDOW }
}
async function untilLedger(n: number) {
  for (;;) {
    const now = (await server.getLatestLedger()).sequence
    if (now >= n) return now
    await new Promise((r) => setTimeout(r, 2000))
  }
}
const balance = async (a: string) =>
  Number(
    (await horizon.loadAccount(a)).balances.find((b: any) => b.asset_type === 'native')?.balance
  )

console.log(C.bold('\n── a zero wait runs at once, as v3 did ──'))
await execute('Blend supply, wait 0', supply, 0, 'PERMIT', {
  rules: [0, poolRule],
  signers: [K.admin.publicKey(), adapter],
})
await execute(
  'drain to a stranger, wait 0',
  {
    calls: vec([
      call(gate, 'pull', [addr(sac), addr(adapter), i128v(MOVE)]),
      call(sac, 'transfer', [addr(adapter), addr(K.stranger.publicKey()), i128v(MOVE)]),
    ]),
    grants: vec([]),
  },
  0,
  'REFUSE'
)

console.log(C.bold('\n── storing batches ──'))
const W = 3
const idSupply = await execute('Blend supply, wait 3', supply, W, 'PERMIT')
const idRecover = await execute('recovery pull to the trustee, wait 3', recover, W, 'PERMIT')
const idCancelPrime = await execute(
  'pay home, to be cancelled by the Prime',
  payHome(1n),
  W,
  'PERMIT'
)
const idCancelCustody = await execute(
  'pay home, to be cancelled by custody',
  payHome(1n),
  W,
  'PERMIT'
)
const idLapse = await execute('pay home, left to lapse', payHome(1n), 1, 'PERMIT')
const idLong = await execute('pay home, wait 200', payHome(1n), 200, 'PERMIT')
await execute(
  'a stranger in a stored batch is refused before storing',
  {
    calls: vec([call(sac, 'transfer', [addr(adapter), addr(K.stranger.publicKey()), i128v(1n)])]),
    grants: vec([]),
  },
  W,
  'REFUSE'
)
{
  const s = idSupply ? await stored(idSupply) : null
  report(
    !!s && s.expires - s.run_at === WINDOW,
    'the stored batch is readable off the ledger',
    s ? `run_at ${s.run_at}, expires ${s.expires}` : 'missing'
  )
}

console.log(C.bold('\n── the agent: its rule demands a wait of its own ──'))
const agentOpts = { kp: K.agent, rules: [agentRule], signers: [K.agent.publicKey()] }
await execute('agent, wait 0', payHome(1n), 0, 'REFUSE', agentOpts)
await execute(`agent, wait ${AGENT_MIN - 1}`, payHome(1n), AGENT_MIN - 1, 'REFUSE', agentOpts)
const idAgent = await execute(
  `agent, wait ${AGENT_MIN}`,
  payHome(2n),
  AGENT_MIN,
  'PERMIT',
  agentOpts
)
{
  const r = await asPrime({
    kp: K.agent,
    prime,
    label: 'agent cancels',
    ruleIds: [agentRule],
    signers: [K.agent.publicKey()],
    makeOp: (auth) => invokeOp(adapter, 'cancel', [u32v(idAgent ?? 0), addr(prime)], auth),
  })
  report(r.denied, 'the agent cannot cancel, even its own', r.denied ? 'REFUSE' : 'PERMIT')
}

console.log(C.bold('\n── the run rule approves `run` and nothing else ──'))
await execute('a stranger executes at once through the run rule', payHome(1n), 0, 'REFUSE', {
  kp: K.stranger,
  rules: [runRule],
  signers: [adapter],
})
await execute('a stranger stores a batch through the run rule', payHome(1n), 3, 'REFUSE', {
  kp: K.stranger,
  rules: [runRule],
  signers: [adapter],
})
{
  const r = await asPrime({
    kp: K.stranger,
    prime,
    label: 'cancel through the run rule',
    ruleIds: [runRule],
    signers: [adapter],
    makeOp: (auth) => invokeOp(adapter, 'cancel', [u32v(idRecover!), addr(prime)], auth),
  })
  report(
    r.denied,
    'a stranger cancels as the Prime through the run rule',
    r.denied ? 'REFUSE' : 'PERMIT'
  )
}

console.log(C.bold('\n── cancelling ──'))
await runStored('running before the wait is over', idLong!, '6')
{
  const r = await asPrime({
    kp: K.admin,
    prime,
    label: 'cancel the long wait',
    submit: true,
    ruleIds: [0],
    makeOp: (auth) => invokeOp(adapter, 'cancel', [u32v(idLong!), addr(prime)], auth),
  })
  if (r.denied) throw new Error(`cancel the long wait: ${String(r.reason).slice(0, 120)}`)
}
await land(
  'a stranger cancels',
  K.stranger,
  invokeOp(adapter, 'cancel', [u32v(idRecover!), addr(K.stranger.publicKey())]),
  '7'
)
{
  const r = await asPrime({
    kp: K.admin,
    prime,
    label: 'the Prime cancels',
    submit: true,
    ruleIds: [0],
    makeOp: (auth) => invokeOp(adapter, 'cancel', [u32v(idCancelPrime!), addr(prime)], auth),
  })
  report(
    !r.denied,
    'the Prime cancels, at its own quorum',
    r.denied ? String(r.reason).slice(0, 60) : 'LANDS'
  )
}
await land(
  'custody cancels',
  K.custody,
  invokeOp(adapter, 'cancel', [u32v(idCancelCustody!), addr(CUSTODY)]),
  'LANDS'
)

console.log(C.bold('\n── running once the wait is over, by someone with no role ──'))
const ready = (await stored(idSupply!)).run_at as number
console.log(C.dim(`   waiting for ledger ${ready}…`))
await untilLedger(ready)
const trusteeBefore = await balance(TRUSTEE)
await runStored('the stored Blend supply runs, no Prime signature', idSupply!, 'LANDS', [poolRule])
await runStored('the stored recovery pays the trustee', idRecover!, 'LANDS')
{
  const gained = (await balance(TRUSTEE)) - trusteeBefore
  report(
    Math.abs(gained - Number(RECOVER) / 1e7) < 1e-9,
    'the trustee received the recovery',
    `+${gained} XLM`
  )
}
await runStored('a batch runs once', idSupply!, '5', [poolRule])
await runStored('a cancelled batch does not run', idCancelPrime!, '5')
report((await stored(idRecover!)) === null, 'a run batch is gone from the ledger', 'gone')
const agentReady = (await stored(idAgent!)).run_at as number
await untilLedger(agentReady)
await runStored("the agent's batch runs after its wait", idAgent!, 'LANDS')

console.log(C.bold('\n── the run window ──'))
const lapse = (await stored(idLapse!)).expires as number
console.log(C.dim(`   waiting for ledger ${lapse + 1}…`))
await untilLedger(lapse + 1)
await runStored('a batch past its window does not run', idLapse!, '6')
{
  const r = await asPrime({
    kp: K.admin,
    prime,
    label: 'tidy a lapsed batch',
    submit: true,
    ruleIds: [0],
    makeOp: (auth) => invokeOp(adapter, 'cancel', [u32v(idLapse!), addr(prime)], auth),
  })
  report(
    !r.denied,
    'a lapsed batch can be tidied away',
    r.denied ? String(r.reason).slice(0, 60) : 'LANDS'
  )
}

console.log(C.bold('\n── the adapter floor binds every caller ──'))
console.log(C.dim('   custody names the adapter for a minimum wait of 4'))
const floored = await pair('floor', 4, true)
const flooredBatch = {
  calls: vec([
    call(floored.gate, 'pull', [addr(sac), addr(floored.adapter), i128v(1n)]),
    call(sac, 'transfer', [addr(floored.adapter), addr(CUSTODY), i128v(1n)]),
  ]),
  grants: vec([]),
}
const toFloored = { to: floored.adapter, submit: false }
await execute('owners, wait 0, floor 4', flooredBatch, 0, 'REFUSE', toFloored)
await execute('owners, wait 3, floor 4', flooredBatch, 3, 'REFUSE', toFloored)
await execute('owners, wait 4, floor 4', flooredBatch, 4, 'PERMIT', toFloored)

console.log(
  C.bold(
    `\n${fails === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${fails} MISMATCH(es)\x1b[0m`}`
  )
)
if (fails > 0) process.exit(1)
