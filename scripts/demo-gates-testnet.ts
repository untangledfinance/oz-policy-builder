// A step-by-step demonstration of the four gates, on Stellar testnet.
//
// Each gate from docs/custody-explained.md gets its own scenario. Every
// scenario prints the on-chain state it depends on BEFORE it runs, then
// attempts the thing, then reports which layer refused it. Three different
// layers do the refusing and they are visible at different stages:
//
//   Gates 1 and 2   the token contract and the gatekeeper, which actually
//                   execute during the recording simulation
//   Gate 3          stellar-core, which rejects insufficient signature
//                   weight synchronously at submit
//   Gate 4          the policy interpreter, inside __check_auth during the
//                   authorised simulation
//
// Usage:
//   bun scripts/demo-gates-testnet.ts setup           # once, ~2 min
//   bun scripts/demo-gates-testnet.ts state           # what is on chain now
//   bun scripts/demo-gates-testnet.ts all             # every scenario
//   bun scripts/demo-gates-testnet.ts g3              # one gate
//   bun scripts/demo-gates-testnet.ts g4-exit         # one scenario
//   bun scripts/demo-gates-testnet.ts all --dry-run   # touch nothing
//   bun scripts/demo-gates-testnet.ts permit --submit # land it on chain
//   bun scripts/demo-gates-testnet.ts resupply        # re-open a position
//
// Secrets live in scripts/.env, which .gitignore covers; `setup` writes one if
// it is missing. Contract addresses land in scripts/.demo-state.json, also
// ignored. Neither ever holds anything but throwaway testnet keys.
//
// TIMING. Every scenario in `all` finishes in under 5 seconds, because a
// refusal needs no ledger: Gates 1, 2 and 4 are settled by simulation against
// the real contracts, and Gate 3 is rejected synchronously by core. Measured
// on testnet, the slowest was 3.7s. Three commands DO submit and so wait for a
// ledger to close - `setup`, `resupply`, and `permit --submit`. Each says so,
// and the runner prints the elapsed time of every step either way.
//
// `permit --submit` withdraws the position, so the two withdraw scenarios have
// nothing to aim at afterwards. They then SKIP rather than pass, because a
// refusal with no position open proves nothing about the destination pin.
// `resupply` puts one back.

import {
  Address,
  Asset,
  BASE_FEE,
  Horizon,
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PASSPHRASE = Networks.TESTNET
const FEE = '6000000'
const server = new rpc.Server('https://soroban-testnet.stellar.org')
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

const ENV_PATH = 'scripts/.env'
const STATE_PATH = 'scripts/.demo-state.json'

/** The numbers the demo runs on. Small, and deliberately far apart so a
 *  refusal can only come from the bound it is meant to test. */
const LIMIT = 20_000_000n // what custody approves to the gate
const MOVE = 2_000_000n // one supply
const CEILING = 3_000_000n // the mandate's per-move ceiling
const OVER_LIMIT = 25_000_000n // past Gate 1

// ---------------------------------------------------------------- plumbing ---

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u32v = (n: number) => xdr.ScVal.scvU32(n)
const addr = (a: string) => Address.fromString(a).toScVal()
const i128v = (v: bigint) => nativeToScVal(v, { type: 'i128' })
const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items)
const kv = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v })

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

const flag = (n: string) => process.argv.includes(`--${n}`)
const DRY = flag('dry-run')
const SUBMIT = flag('submit')

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

// ------------------------------------------------------------------- .env ---

type Secrets = { custody: Keypair; cosign: Keypair; agent: Keypair; admin: Keypair }

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2]
  }
  return out
}

const KEYS = ['DEMO_CUSTODY_SECRET', 'DEMO_COSIGN_SECRET', 'DEMO_AGENT_SECRET', 'DEMO_ADMIN_SECRET'] as const

function loadSecrets(): Secrets {
  const env = { ...readEnv(), ...process.env }
  const missing = KEYS.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(', ')} in ${ENV_PATH}\nRun:  bun scripts/demo-gates-testnet.ts setup`,
    )
  }
  return {
    custody: Keypair.fromSecret(env.DEMO_CUSTODY_SECRET!),
    cosign: Keypair.fromSecret(env.DEMO_COSIGN_SECRET!),
    agent: Keypair.fromSecret(env.DEMO_AGENT_SECRET!),
    admin: Keypair.fromSecret(env.DEMO_ADMIN_SECRET!),
  }
}

function writeEnv(s: Secrets) {
  writeFileSync(
    ENV_PATH,
    [
      '# Testnet demo keys. Throwaway, funded by friendbot, no real value.',
      '# .gitignore covers this file. Do not put a mainnet secret here.',
      `DEMO_CUSTODY_SECRET=${s.custody.secret()}`,
      `DEMO_COSIGN_SECRET=${s.cosign.secret()}`,
      `DEMO_AGENT_SECRET=${s.agent.secret()}`,
      `DEMO_ADMIN_SECRET=${s.admin.secret()}`,
      '',
    ].join('\n'),
  )
}

type State = {
  network: string
  created: string
  sac: string
  interpreter: string
  prime: string
  adapter: string
  gate: string
  stranger: string
  rootRuleId: number
  childRuleId: number
  withdrawRuleId: number
  allowanceExpiryLedger: number
}

const loadState = (): State => {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`no ${STATE_PATH}\nRun:  bun scripts/demo-gates-testnet.ts setup`)
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
}

// ------------------------------------------------------------ chain access ---

async function settle(sent: any, label: string) {
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: ${JSON.stringify(sent.errorResult?.toXDR('base64'))}`)
  }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got: any = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') throw new Error(`${label}: tx ${sent.hash} FAILED`)
  }
  throw new Error(`${label}: ${sent.hash} did not confirm`)
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

/** Read-only contract call. One round trip, no signature, nothing submitted. */
async function readCall(contract: string, fn: string, args: xdr.ScVal[], sourcePk: string) {
  const tx = new TransactionBuilder(await server.getAccount(sourcePk), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(invokeOp(contract, fn, args))
    .setTimeout(60)
    .build()
  const sim: any = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) return undefined
  return scValToNative(sim.result.retval)
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

type Res = { denied: boolean; stage?: 'execution' | 'policy' | 'submit'; reason?: string; got?: any }

/**
 * Run `makeOp` under Prime's authority.
 *
 * Two simulations happen, and which one refuses tells you which layer said no.
 * The first records what Prime must authorise; auth is RECORDED there, not
 * enforced, so the policy does not run and anything that refuses is a contract
 * actually executing - the token's allowance check, the gatekeeper's
 * destination list. The second carries real auth entries, so __check_auth runs
 * and the policy interpreter gets its say.
 */
async function asPrime(opts: {
  kp: Keypair
  prime: string
  makeOp: (auth: xdr.SorobanAuthorizationEntry[]) => xdr.Operation
  ruleIds: number[]
  signers?: string[]
  label: string
  submit?: boolean
}): Promise<Res> {
  const { kp, prime, makeOp, ruleIds, label } = opts
  const signerList = opts.signers ?? [kp.publicKey()]

  // Three round trips that do not depend on each other. Fetching them in
  // series put the heaviest scenario over the 5s budget on its own.
  const [acct, latest] = await Promise.all([
    server.getAccount(kp.publicKey()),
    server.getLatestLedger(),
  ])

  const probe = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(makeOp([]))
    .setTimeout(120)
    .build()

  const sim: any = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) return { denied: true, stage: 'execution', reason: sim.error }

  const recorded: xdr.SorobanAuthorizationEntry[] = sim.result?.auth ?? []
  const own = recorded.find(
    (e) =>
      e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(e.credentials().address().address()).toString() === prime,
  )
  if (!own) throw new Error(`${label}: no address-credential entry for Prime`)

  const exp = latest.sequence + 100
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

  // Reuse the account read above: simulation does not consume the sequence,
  // and a submit re-reads it below.
  const authed = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(makeOp([accountEntry, signerEntry, ...others]))
    .setTimeout(120)
    .build()

  const sim2: any = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2)) return { denied: true, stage: 'policy', reason: sim2.error }

  if (!opts.submit) return { denied: false }

  const fresh = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(makeOp([accountEntry, signerEntry, ...others]))
    .setTimeout(120)
    .build()
  const prepared = rpc.assembleTransaction(fresh, sim2).build()
  prepared.sign(kp)
  return { denied: false, got: await settle(await server.sendTransaction(prepared), label) }
}

const codeOf = (r?: string) => (r ?? '').match(/Error\(Contract, #(\d+)\)/)?.[1]

// ------------------------------------------------------------- predicates ---

const path = (steps: xdr.ScVal[]) => vec([sym('call_path'), ...steps])
const eq = (a: xdr.ScVal, b: xdr.ScVal) => vec([sym('eq'), a, b])
const cmp = (op: string, a: xdr.ScVal, b: xdr.ScVal) => vec([sym(op), a, b])
const and = (xs: xdr.ScVal[]) => vec([sym('and'), vec(xs)])
const selector = (s: string) => vec([sym(s)])
const callArg = (i: number) => vec([sym('call_arg'), u32v(i)])
const callArgLen = (i: number) => vec([sym('call_arg_len'), u32v(i)])

/** `PolicyInstallParams` from contracts/policy-interpreter/src/types.rs.
 *  ScMap keys must be sorted, and every field must be present. */
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

// ------------------------------------------------------ call / grant codec ---

const call = (target: string, fn: string, args: xdr.ScVal[], execAuth: xdr.ScVal[] = []) =>
  xdr.ScVal.scvMap([
    kv('args', vec(args)),
    kv('executor_authorizations', vec(execAuth)),
    kv('function_name', sym(fn)),
    kv('target', addr(target)),
  ])

const ctxVal = (contract: string, fn: string, args: xdr.ScVal[]) =>
  vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv('args', vec(args)),
      kv('contract', addr(contract)),
      kv('fn_name', sym(fn)),
    ]),
  ])

/** Prime's require_auth for a venue call resolves through the interpreter's
 *  `enforce`, so the grant names that, not the venue. */
const grant = (s: State, target: string, fn: string, args: xdr.ScVal[]) =>
  vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv(
        'context',
        xdr.ScVal.scvMap([
          kv('args', vec([addr(s.prime), ctxVal(target, fn, args)])),
          kv('contract', addr(s.interpreter)),
          kv('fn_name', sym('enforce')),
        ]),
      ),
      kv('sub_invocations', vec([])),
    ]),
  ])

function addRuleArgs(o: {
  scope: string
  name: string
  signer: string
  interpreter: string
  predicate: xdr.ScVal
  adminPk: string
}) {
  return [
    vec([sym('CallContract'), addr(o.scope)]),
    xdr.ScVal.scvString(o.name),
    xdr.ScVal.scvVoid(),
    vec([delegatedSigner(o.signer)]),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: addr(o.interpreter), val: installParams(o.predicate, o.adminPk) }),
    ]),
  ]
}

// ------------------------------------------------------------------ state ---

type Shown = Record<string, string>

async function readState(s: State, want: string[]): Promise<Shown> {
  const out: Shown = {}
  const jobs: Promise<void>[] = []
  const admin = loadSecrets().admin.publicKey()

  if (want.includes('allowance')) {
    jobs.push(
      readCall(s.sac, 'allowance', [addr(custodyPk()), addr(s.gate)], admin).then((v) => {
        out['your spending limit, remaining'] = `${v ?? 0}`
      }),
    )
  }
  if (want.includes('custody')) {
    jobs.push(
      readCall(s.sac, 'balance', [addr(custodyPk())], admin).then((v) => {
        out['your account balance'] = `${v ?? 0}`
      }),
    )
  }
  if (want.includes('position')) {
    jobs.push(
      readCall(POOL, 'get_positions', [addr(s.prime)], admin).then((v: any) => {
        const supply = v?.supply
        const shares = supply ? Object.values(supply)[0] : undefined
        out['position held in our name'] = shares ? `${shares} shares` : 'none'
      }),
    )
  }
  if (want.includes('ledger')) {
    jobs.push(
      server.getLatestLedger().then((l) => {
        out['ledger now'] = `${l.sequence}`
        out['your limit expires at ledger'] =
          `${s.allowanceExpiryLedger} (${s.allowanceExpiryLedger - l.sequence} to go)`
      }),
    )
  }
  if (want.includes('thresholds')) {
    jobs.push(
      horizon.loadAccount(custodyPk()).then((a: any) => {
        out['your account thresholds'] =
          `low ${a.thresholds.low_threshold} / med ${a.thresholds.med_threshold} / high ${a.thresholds.high_threshold}`
        out['signers'] = a.signers.map((x: any) => `${x.key.slice(0, 6)}… weight ${x.weight}`).join(', ')
      }),
    )
  }
  await Promise.all(jobs)
  return out
}

let _secrets: Secrets | undefined
const secrets = () => (_secrets ??= loadSecrets())
const custodyPk = () => secrets().custody.publicKey()

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

const SCENARIOS: Scenario[] = [
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

async function cmdSetup() {
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
  _secrets = s
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

function banner(sc: Scenario) {
  console.log(`\n${C.bold(`── ${sc.title}`)}`)
  console.log(`   ${C.dim('attempt')}  ${sc.attempt}`)
  console.log(`   ${C.dim('expect')}   ${sc.expect}`)
}

async function runScenario(sc: Scenario, s: State): Promise<boolean> {
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

async function cmdState() {
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

async function main() {
  const cmd = process.argv[2] ?? 'all'

  if (cmd === 'setup') return cmdSetup()
  if (cmd === 'state') return cmdState()

  const s = loadState()
  // `resupply` submits a transaction and takes about ten seconds, so it is
  // opt-in by name rather than part of a run.
  const chosen =
    cmd === 'all'
      ? SCENARIOS.filter((x) => x.id !== 'resupply')
      : SCENARIOS.filter((x) => x.id === cmd || (`g${x.gate}` === cmd && x.id !== 'resupply'))
  if (!chosen.length) {
    console.error(`unknown step "${cmd}". Known: setup, state, all, g1, g2, g3, g4, ${SCENARIOS.map((x) => x.id).join(', ')}`)
    process.exit(2)
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

main().catch((e) => {
  console.error('\nFATAL', e?.message ?? e)
  process.exit(1)
})
