// The four-gate demo: one scenario per gate, each printing the on-chain state
// it depends on before it runs.

import { Address, Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, hash, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  ACCOUNT_WASM_HASH, C, CEILING, ENV_PATH, FEE, LIMIT, MOVE, OVER_LIMIT, PASSPHRASE, POOL,
  STATE_PATH, type Res, type State, addRuleArgs, addr, and, asPrime, callArg, callArgLen,
  cmp, codeOf, custodyPk, delegatedSigner, eq, grant, horizon, i128v, installParams,
  invokeOp, kv, loadSecrets, loadState, path, readCall, readState, secrets, selector,
  call, send, server, setSecrets, sym, u32v, vec, wasmPath, writeEnv, type Secrets,
} from './chain.ts'

const DRY = process.argv.includes('--dry-run')
const SUBMIT = process.argv.includes('--submit')

// -------------------------------------------------------------- scenarios ---

type Outcome = { ok: boolean; line: string }

/** Shares Prime holds in the pool. The withdraw scenarios are only evidence
 *  while a real position is open: with none, the recording simulation fails
 *  inside the pool and the refusal says nothing about the destination pin. */
async function positionShares(s: State): Promise<bigint> {
  const v: any = await readCall(POOL, 'get_positions', [addr(s.prime)], secrets().admin.publicKey())
  const supply = v?.supply
  const first = supply ? Object.values(supply)[0] : undefined
  return first === undefined ? 0n : BigInt(first as any)
}

const DUST_SHARES = 1_000n
const NEEDS_POSITION =
  'a withdraw scenario needs an open position. Run:  bun scripts/demo-gates-testnet.ts resupply'

type Scenario = {
  id: string
  gate: 1 | 2 | 3 | 4
  title: string
  attempt: string
  expect: string
  needs: string[]
  /** Returns a reason when the chain is not in a state where this scenario
   *  would prove anything. */
  guard?: (s: State) => Promise<string | undefined>
  run: (s: State) => Promise<Outcome>
}

/** A batch: pull from the gate, then supply into the pool. */
const supplyBatch = (s: State, pull: bigint, supply: bigint) => {
  const request = (amount: bigint) =>
    vec([
      xdr.ScVal.scvMap([
        kv('address', addr(s.sac)),
        kv('amount', i128v(amount)),
        kv('request_type', u32v(0)),
      ]),
    ])
  const submitArgs = [addr(s.prime), addr(s.adapter), addr(custodyPk()), request(supply)]
  const transferAuth = vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv(
        'context',
        xdr.ScVal.scvMap([
          kv('args', vec([addr(s.adapter), addr(POOL), i128v(supply)])),
          kv('contract', addr(s.sac)),
          kv('fn_name', sym('transfer')),
        ]),
      ),
      kv('sub_invocations', vec([])),
    ]),
  ])
  return {
    calls: vec([
      call(s.gate, 'pull', [addr(s.sac), addr(s.adapter), i128v(pull)]),
      call(POOL, 'submit', submitArgs, [transferAuth]),
    ]),
    grants: vec([grant(s, POOL, 'submit', submitArgs)]),
  }
}

const withdrawBatch = (s: State, to: string, amount: bigint) => {
  const args = [
    addr(s.prime),
    addr(s.adapter),
    addr(to),
    vec([
      xdr.ScVal.scvMap([
        kv('address', addr(s.sac)),
        kv('amount', i128v(amount)),
        kv('request_type', u32v(1)),
      ]),
    ]),
  ]
  return { calls: vec([call(POOL, 'submit', args)]), grants: vec([grant(s, POOL, 'submit', args)]) }
}

const runBatch = (s: State, b: { calls: xdr.ScVal; grants: xdr.ScVal }, ruleIds: number[], label: string, submit = false) =>
  asPrime({
    kp: secrets().agent,
    prime: s.prime,
    makeOp: (auth) =>
      invokeOp(s.adapter, 'execute', [addr(s.prime), addr(s.interpreter), b.calls, b.grants], auth),
    ruleIds,
    signers: [secrets().agent.publicKey(), s.adapter],
    label,
    submit,
  })

async function classicRefusal(op: xdr.Operation, signers: Keypair[]): Promise<Outcome> {
  const acct = await horizon.loadAccount(custodyPk())
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build()
  for (const k of signers) tx.sign(k)
  try {
    await horizon.submitTransaction(tx)
    return { ok: false, line: 'UNEXPECTED: the network accepted it' }
  } catch (e: any) {
    const rc = e?.response?.data?.extras?.result_codes
    const good = rc?.operations?.includes('op_bad_auth') || rc?.transaction === 'tx_bad_auth'
    return {
      ok: good,
      line: good
        ? `refused by stellar-core, signature weight too low  (${rc.transaction} / ${rc.operations ?? '-'})`
        : `refused, but for another reason: ${JSON.stringify(rc)}`,
    }
  }
}

function batchOutcome(r: Res, expectLayer: 'execution' | 'policy', expectCode?: string): Outcome {
  if (!r.denied) return { ok: false, line: 'UNEXPECTED: it was permitted' }
  const code = codeOf(r.reason)
  const where =
    r.stage === 'execution'
      ? 'refused while executing, by a contract you own'
      : `refused by our rulebook before anything moved${code ? `, #${code}` : ''}`
  if (r.stage !== expectLayer) {
    return { ok: false, line: `refused at the WRONG layer (${r.stage}): ${(r.reason ?? '').slice(0, 160)}` }
  }
  if (expectCode && code !== expectCode) {
    return { ok: false, line: `refused with #${code}, expected #${expectCode}` }
  }
  return { ok: true, line: where }
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'g1-over',
    gate: 1,
    title: 'Gate 1 — spend more than your limit',
    attempt: `draw ${OVER_LIMIT} when the limit is ${LIMIT}`,
    expect: 'the token contract refuses; the limit is a hard ceiling',
    needs: ['allowance'],
    run: async (s) =>
      batchOutcome(
        await runBatch(s, supplyBatch(s, OVER_LIMIT, OVER_LIMIT), [s.rootRuleId, s.childRuleId], 'g1-over'),
        'execution',
      ),
  },
  {
    id: 'g1-expiry',
    gate: 1,
    title: 'Gate 1 — the limit runs out on its own',
    attempt: 'read the expiry ledger the limit carries',
    expect: 'after that ledger nothing can be drawn until you grant again',
    needs: ['ledger', 'allowance'],
    run: async (s) => {
      const now = (await server.getLatestLedger()).sequence
      const left = s.allowanceExpiryLedger - now
      return {
        ok: left > 0,
        line:
          left > 0
            ? `the limit stops itself in ${left} ledgers, about ${Math.round((left * 5) / 60)} minutes, with no action from anyone`
            : 'the limit has already expired; nothing can be drawn',
      }
    },
  },
  {
    id: 'g2-stranger',
    gate: 2,
    title: 'Gate 2 — send to an address not on your list',
    attempt: 'pull from the gatekeeper straight to a stranger',
    expect: 'your gatekeeper refuses; only the adapter is on its list',
    needs: ['allowance'],
    run: async (s) => {
      const calls = vec([call(s.gate, 'pull', [addr(s.sac), addr(s.stranger), i128v(MOVE)])])
      return batchOutcome(
        await runBatch(s, { calls, grants: vec([]) }, [s.rootRuleId], 'g2-stranger'),
        'execution',
      )
    },
  },
  {
    id: 'g3-payment',
    gate: 3,
    title: 'Gate 3 — move money out with one key',
    attempt: 'pay a stranger from custody, signed by the treasury key alone',
    expect: 'refused: one key is weight 10, medium threshold is 20',
    needs: ['thresholds'],
    run: async (s) =>
      classicRefusal(
        Operation.payment({ destination: s.stranger, asset: Asset.native(), amount: '1' }),
        [secrets().custody],
      ),
  },
  {
    id: 'g3-settings',
    gate: 3,
    title: 'Gate 3 — weaken the account settings with one key',
    attempt: 'lower medium and high thresholds to 10',
    expect: 'refused: changing thresholds needs the high threshold, 20',
    needs: ['thresholds'],
    run: async () =>
      classicRefusal(Operation.setOptions({ medThreshold: 10, highThreshold: 10 }), [secrets().custody]),
  },
  {
    id: 'g3-merge',
    gate: 3,
    title: 'Gate 3 — close the account and take the balance',
    attempt: 'merge the custody account into a stranger',
    expect: 'refused: account merge needs the high threshold, 20',
    needs: ['thresholds', 'custody'],
    run: async (s) =>
      classicRefusal(Operation.accountMerge({ destination: s.stranger }), [secrets().custody]),
  },
  {
    id: 'g4-ceiling',
    gate: 4,
    title: 'Gate 4 — move more than the mandate allows',
    attempt: `supply ${CEILING}, the mandate ceiling`,
    expect: 'our rulebook refuses, #100, before any money moves',
    needs: ['allowance'],
    run: async (s) =>
      batchOutcome(
        await runBatch(s, supplyBatch(s, CEILING, CEILING), [s.rootRuleId, s.childRuleId], 'g4-ceiling'),
        'policy',
        '100',
      ),
  },
  {
    id: 'g4-mismatch',
    gate: 4,
    title: 'Gate 4 — take more than you put to work',
    attempt: `draw ${MOVE} and supply one unit less`,
    expect: 'our rulebook refuses, #100; the two amounts must match',
    needs: ['allowance'],
    run: async (s) =>
      batchOutcome(
        await runBatch(s, supplyBatch(s, MOVE, MOVE - 1n), [s.rootRuleId, s.childRuleId], 'g4-mismatch'),
        'policy',
        '100',
      ),
  },
  {
    id: 'resupply',
    gate: 4,
    title: 'Re-open a position (submits, so slower than 5s)',
    attempt: `supply ${MOVE} into the pool again`,
    expect: 'permitted and landed, so the withdraw scenarios have something to aim at',
    needs: ['allowance', 'position'],
    run: async (s) => {
      const r = await runBatch(s, supplyBatch(s, MOVE, MOVE), [s.rootRuleId, s.childRuleId], 'resupply', true)
      if (r.denied) return { ok: false, line: `UNEXPECTED refusal: ${(r.reason ?? '').slice(0, 160)}` }
      const pos = await positionShares(s)
      return { ok: true, line: `supplied. the position is now ${pos} shares` }
    },
  },
  {
    id: 'g4-exit',
    gate: 4,
    guard: async (s: State) => ((await positionShares(s)) > DUST_SHARES ? undefined : NEEDS_POSITION),
    title: 'Gate 4 — withdraw to somewhere that is not your account',
    attempt: 'withdraw the position to a funded stranger',
    expect: 'our rulebook refuses, #100; the exit is pinned to your account',
    needs: ['position', 'custody'],
    run: async (s) =>
      batchOutcome(
        await runBatch(s, withdrawBatch(s, s.stranger, MOVE), [s.withdrawRuleId, s.childRuleId], 'g4-exit'),
        'policy',
        '100',
      ),
  },
  {
    id: 'permit',
    gate: 4,
    guard: async (s: State) => ((await positionShares(s)) > DUST_SHARES ? undefined : NEEDS_POSITION),
    title: 'The move that IS allowed — bring the position home',
    attempt: `withdraw ${MOVE} back to your own account`,
    expect: 'permitted; add --submit to land it on chain',
    needs: ['position', 'custody'],
    run: async (s) => {
      const r = await runBatch(
        s,
        withdrawBatch(s, custodyPk(), MOVE),
        [s.withdrawRuleId, s.childRuleId],
        'permit',
        SUBMIT,
      )
      if (r.denied) return { ok: false, line: `UNEXPECTED refusal: ${(r.reason ?? '').slice(0, 160)}` }
      if (!SUBMIT) return { ok: true, line: 'permitted by every gate (simulated, nothing submitted)' }
      const after = await readCall(s.sac, 'balance', [addr(custodyPk())], secrets().admin.publicKey())
      return { ok: true, line: `submitted and confirmed. your account balance is now ${after}` }
    },
  },
]

// ------------------------------------------------------------------ setup ---

/** A setup step must succeed. Surface the network's reason if it does not. */
function must(r: Res, what: string) {
  if (r.denied) throw new Error(`${what} was refused at the ${r.stage} stage:\n  ${r.reason}`)
  if (!r.got) throw new Error(`${what} returned no transaction result`)
  return r.got
}

const friendbot = async (pk: string) => {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`)
}

export async function demoSetup() {
  if (DRY) {
    console.log(C.bold('\nDRY RUN: setup would'))
    for (const l of [
      'create four keypairs and write them to ' + ENV_PATH,
      'fund them from friendbot',
      `approve a ${LIMIT} spending limit from custody to the gatekeeper`,
      'upload and deploy the interpreter, Prime, the adapter and the gatekeeper',
      'install the supply rule, the pool rule and the withdraw rule',
      `supply ${MOVE} into the Blend pool so a position is open`,
      'raise the custody thresholds to low 10 / med 20 / high 20',
      'write ' + STATE_PATH,
    ]) console.log(`  · ${l}`)
    return
  }

  console.log(C.bold('\nSetup'))
  console.log(C.amber('  this submits about a dozen transactions and takes a couple of minutes'))

  const s: Secrets = existsSync(ENV_PATH)
    ? loadSecrets()
    : { custody: Keypair.random(), cosign: Keypair.random(), agent: Keypair.random(), admin: Keypair.random() }
  if (!existsSync(ENV_PATH)) {
    writeEnv(s)
    console.log(`  wrote ${ENV_PATH} with four fresh testnet keys`)
  } else {
    console.log(`  reusing the keys already in ${ENV_PATH}`)
  }
  setSecrets(s)
  const stranger = Keypair.random()

  await Promise.all(
    [s.custody, s.cosign, s.agent, s.admin, stranger].map((k) => friendbot(k.publicKey())),
  )
  console.log('  funded by friendbot')

  const wasms = {
    interpreter: readFileSync(wasmPath('policy-interpreter', 'policy_interpreter')),
    adapter: readFileSync(wasmPath('execution-adapter', 'execution_adapter')),
    gate: readFileSync(wasmPath('custody-gate', 'custody_gate')),
  }
  for (const [name, w] of Object.entries(wasms)) {
    await send(s.admin, Operation.uploadContractWasm({ wasm: w }), `upload ${name}`)
    console.log(`  uploaded ${name.padEnd(11)} ${String(w.length).padStart(6)} bytes`)
  }

  const interpRes = await send(
    s.admin,
    Operation.createCustomContract({
      address: Address.fromString(s.admin.publicKey()),
      wasmHash: hash(wasms.interpreter),
      salt: hash(Buffer.from(`demo-i-${Date.now()}-${Math.random()}`)),
    }),
    'create interpreter',
  )
  const interpreter = Address.fromScVal(interpRes.returnValue!).toString()
  const grammar = await readCall(interpreter, 'grammar_version', [], s.admin.publicKey())
  if (Number(grammar) !== 6) throw new Error(`interpreter reports grammar ${grammar}, expected 6`)
  console.log(`  interpreter ${interpreter}  grammar ${grammar}`)

  const primeRes = await send(
    s.admin,
    Operation.createCustomContract({
      address: Address.fromString(s.admin.publicKey()),
      wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec([delegatedSigner(s.admin.publicKey())]), xdr.ScVal.scvMap([])],
    }),
    'create prime',
  )
  const prime = Address.fromScVal(primeRes.returnValue!).toString()
  console.log(`  prime       ${prime}`)

  const deployAdapter = await asPrime({
    kp: s.admin,
    prime,
    makeOp: (auth) =>
      Operation.createCustomContract({
        address: Address.fromString(prime),
        wasmHash: hash(wasms.adapter),
        salt: hash(Buffer.from('prime.execution.adapter.v2')),
        auth,
      } as any),
    ruleIds: [0],
    label: 'deploy adapter',
    submit: true,
  })
  const adapter = Address.fromScVal(must(deployAdapter, 'deploy adapter').returnValue!).toString()
  console.log(`  adapter     ${adapter}`)

  const gateRes = await send(
    s.admin,
    Operation.createCustomContract({
      address: Address.fromString(s.admin.publicKey()),
      wasmHash: hash(wasms.gate),
      salt: hash(Buffer.from(`demo-g-${Date.now()}-${Math.random()}`)),
      constructorArgs: [
        xdr.ScVal.scvMap([
          kv('allowed', vec([addr(adapter)])),
          kv('caller', addr(adapter)),
          kv('custody', addr(s.custody.publicKey())),
        ]),
      ],
    }),
    'create gate',
  )
  const gate = Address.fromScVal(gateRes.returnValue!).toString()
  console.log(`  gatekeeper  ${gate}  (allowed: the adapter, and nothing else)`)

  // The limit is granted while custody still has default thresholds, then the
  // thresholds go up at the end. Granting under the raised thresholds needs a
  // CAP-46-11 multi-signature entry, which verify-mpc-threshold-testnet.ts
  // already covers; g3-payment here proves the raised thresholds bite.
  const sac = Asset.native().contractId(PASSPHRASE)
  const allowanceExpiryLedger = (await server.getLatestLedger()).sequence + 6000
  await send(
    s.custody,
    invokeOp(sac, 'approve', [
      addr(s.custody.publicKey()),
      addr(gate),
      i128v(LIMIT),
      u32v(allowanceExpiryLedger),
    ]),
    'approve gate',
  )
  console.log(`  limit       ${LIMIT} to the gatekeeper, expiring at ledger ${allowanceExpiryLedger}`)

  const st: State = {
    network: 'testnet',
    created: new Date().toISOString(),
    sac,
    interpreter,
    prime,
    adapter,
    gate,
    stranger: stranger.publicKey(),
    rootRuleId: 0,
    childRuleId: 0,
    withdrawRuleId: 0,
    allowanceExpiryLedger,
  }

  const P_PULL = [u32v(0), u32v(0), sym('args'), u32v(2)]
  const P_SUPPLY = [u32v(0), u32v(1), sym('args'), u32v(3), u32v(0), sym('amount')]
  const rootPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(2)),
    eq(callArgLen(1), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(gate)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('pull')),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(1)]), addr(adapter)),
    cmp('gt', path(P_PULL), i128v(0n)),
    cmp('lt', path(P_PULL), i128v(CEILING)),
    eq(path([u32v(0), u32v(1), sym('target')]), addr(POOL)),
    eq(path([u32v(0), u32v(1), sym('function_name')]), sym('submit')),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(0)]), addr(prime)),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(2)]), addr(s.custody.publicKey())),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(3), xdr.ScVal.scvBool(true)]), u32v(1)),
    eq(path([...P_SUPPLY.slice(0, 5), sym('address')]), addr(sac)),
    eq(path([...P_SUPPLY.slice(0, 5), sym('request_type')]), u32v(0)),
    eq(path(P_PULL), path(P_SUPPLY)),
  ])
  const rootRes = await asPrime({
    kp: s.admin,
    prime,
    makeOp: (auth) =>
      invokeOp(prime, 'add_context_rule', addRuleArgs({
        scope: adapter, name: 'demo-supply', signer: s.agent.publicKey(),
        interpreter, predicate: rootPredicate, adminPk: s.admin.publicKey(),
      }), auth),
    ruleIds: [0], label: 'install supply rule', submit: true,
  })
  st.rootRuleId = Number(scValToNative(must(rootRes, 'install supply rule').returnValue!).id)

  const childPredicate = and([
    eq(selector('call_fn'), sym('submit')),
    eq(callArg(0), addr(prime)),
    eq(callArg(1), addr(adapter)),
  ])
  const childRes = await asPrime({
    kp: s.admin,
    prime,
    makeOp: (auth) =>
      invokeOp(prime, 'add_context_rule', addRuleArgs({
        scope: POOL, name: 'demo-pool', signer: adapter,
        interpreter, predicate: childPredicate, adminPk: s.admin.publicKey(),
      }), auth),
    ruleIds: [0], label: 'install pool rule', submit: true,
  })
  st.childRuleId = Number(scValToNative(must(childRes, 'install pool rule').returnValue!).id)
  must(await asPrime({
    kp: s.admin,
    prime,
    makeOp: (auth) =>
      invokeOp(interpreter, 'bind_executor', [vec([addr(prime), u32v(st.childRuleId)]), addr(adapter)], auth),
    ruleIds: [0], label: 'bind pool executor', submit: true,
  }), 'bind pool executor')

  const wPredicate = and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(1)),
    eq(callArgLen(1), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(POOL)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('submit')),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(2)]), addr(s.custody.publicKey())),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(3), u32v(0), sym('request_type')]), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('executor_authorizations'), xdr.ScVal.scvBool(true)]), u32v(0)),
  ])
  const wRes = await asPrime({
    kp: s.admin,
    prime,
    makeOp: (auth) =>
      invokeOp(prime, 'add_context_rule', addRuleArgs({
        scope: adapter, name: 'demo-withdraw', signer: s.agent.publicKey(),
        interpreter, predicate: wPredicate, adminPk: s.admin.publicKey(),
      }), auth),
    ruleIds: [0], label: 'install withdraw rule', submit: true,
  })
  st.withdrawRuleId = Number(scValToNative(must(wRes, 'install withdraw rule').returnValue!).id)
  console.log(`  rules       supply=${st.rootRuleId} pool=${st.childRuleId} withdraw=${st.withdrawRuleId}`)

  // A real supply, so the withdraw scenarios have a position to aim at. Without
  // one the recording simulation fails inside the pool and the refusal proves
  // nothing about the destination pin.
  const r = await runBatch(st, supplyBatch(st, MOVE, MOVE), [st.rootRuleId, st.childRuleId], 'demo supply', true)
  if (r.denied) throw new Error(`setup supply was refused: ${r.reason}`)
  console.log(`  supplied    ${MOVE} into the Blend pool; a position is now open`)

  const acct = await horizon.loadAccount(s.custody.publicKey())
  const raise = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.setOptions({
      masterWeight: 10, lowThreshold: 10, medThreshold: 20, highThreshold: 20,
      signer: { ed25519PublicKey: s.cosign.publicKey(), weight: 10 },
    }))
    .setTimeout(60).build()
  raise.sign(s.custody)
  await horizon.submitTransaction(raise)
  console.log('  thresholds  low 10 / med 20 / high 20, two signers at weight 10')

  writeFileSync(STATE_PATH, `${JSON.stringify(st, null, 2)}\n`)
  console.log(C.green(`\nReady. ${STATE_PATH} written.`))
  console.log('Run:  bun scripts/demo-gates-testnet.ts all')
}

// ------------------------------------------------------------------ driver ---

export function banner(sc: Scenario) {
  console.log(`\n${C.bold(`── ${sc.title}`)}`)
  console.log(`   ${C.dim('attempt')}  ${sc.attempt}`)
  console.log(`   ${C.dim('expect')}   ${sc.expect}`)
}

export async function runScenario(sc: Scenario, s: State): Promise<boolean> {
  banner(sc)
  const before = await readState(s, sc.needs)
  console.log(`   ${C.dim('state before')}`)
  for (const [k, v] of Object.entries(before)) console.log(`     ${C.dim(k.padEnd(30, '.'))} ${v}`)

  if (DRY) {
    console.log(`   ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return true
  }
  const blocked = await sc.guard?.(s)
  if (blocked) {
    console.log(`   ${C.amber('SKIPPED')}  ${blocked}`)
    return true
  }
  const t = performance.now()
  const out = await sc.run(s)
  const took = Math.round(performance.now() - t)
  const mark = out.ok ? C.green('AS EXPECTED') : C.red('** UNEXPECTED **')
  console.log(`   ${mark}  ${out.line}   ${C.dim(`${took}ms`)}`)
  if (took > 5000) console.log(`   ${C.amber(`note: took ${took}ms, over the 5s budget`)}`)
  return out.ok
}

async function _unusedCmdState() {
  const s = loadState()
  console.log(C.bold('\nOn chain right now'))
  const shown = await readState(s, ['allowance', 'custody', 'position', 'ledger', 'thresholds'])
  for (const [k, v] of Object.entries(shown)) console.log(`  ${C.dim(k.padEnd(30, '.'))} ${v}`)
  console.log(C.bold('\nContracts'))
  for (const k of ['prime', 'adapter', 'gate', 'interpreter', 'sac'] as const) {
    console.log(`  ${C.dim(k.padEnd(30, '.'))} ${s[k]}`)
  }
  console.log(`  ${C.dim('pool'.padEnd(30, '.'))} ${POOL}`)
}


export async function runDemo(args: string[]): Promise<void> {
  const which = args.find((a) => !a.startsWith('--')) ?? 'all'
  const s = loadState()

  // `resupply` submits and takes about ten seconds, so it stays opt-in.
  const chosen =
    which === 'all'
      ? SCENARIOS.filter((x) => x.id !== 'resupply')
      : SCENARIOS.filter((x) => x.id === which || (`g${x.gate}` === which && x.id !== 'resupply'))
  if (!chosen.length) {
    throw new Error(
      `unknown step "${which}". Known: all, g1, g2, g3, g4, ${SCENARIOS.map((x) => x.id).join(', ')}`,
    )
  }

  console.log(C.bold(`\nFour gates, on Stellar testnet${DRY ? '  (DRY RUN)' : ''}`))
  console.log(C.dim(`  custody ${custodyPk()}`))
  console.log(C.dim(`  prime   ${s.prime}`))

  const results: boolean[] = []
  const t0 = performance.now()
  for (const sc of chosen) results.push(await runScenario(sc, s))
  const total = Math.round(performance.now() - t0)

  const pass = results.filter(Boolean).length
  console.log(
    `\n${C.bold(`${pass}/${results.length} as expected`)}   ${C.dim(`${total}ms total, ${Math.round(total / results.length)}ms average`)}`,
  )
  if (pass !== results.length) process.exit(1)
}
