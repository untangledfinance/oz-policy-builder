// Shared plumbing for the `prime` demo CLI: config, chain access, the OZ auth
// dance, and the encoders for calls, grants and predicates.
//
// Extracted verbatim from the four-gate demo once the CLI needed the same
// machinery. Nothing here is specific to a scenario.

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
import { dirname, join } from 'node:path'

export const PASSPHRASE = Networks.TESTNET
export const FEE = '6000000'
export const server = new rpc.Server('https://soroban-testnet.stellar.org')
export const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
export const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
export const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

/** Where the repo lives, so the compiled binary works from any directory.
 *  PRIME_HOME wins; otherwise walk up from the working directory looking for
 *  the repo's own shape; otherwise fall back to the directory holding the
 *  executable, which is where `prime` is built. */
function findHome(): string {
  const explicit = process.env.PRIME_HOME
  if (explicit) return explicit
  const looksRight = (d: string) =>
    existsSync(join(d, 'scripts')) && existsSync(join(d, 'contracts'))
  for (const start of [process.cwd(), dirname(process.execPath)]) {
    let d = start
    for (let i = 0; i < 6; i++) {
      if (looksRight(d)) return d
      const up = dirname(d)
      if (up === d) break
      d = up
    }
  }
  return process.cwd()
}

export const HOME = findHome()
export const ENV_PATH = join(HOME, 'scripts/.env')
export const STATE_PATH = join(HOME, 'scripts/.demo-state.json')

/** The numbers the demo runs on. Small, and deliberately far apart so a
 *  refusal can only come from the bound it is meant to test. */
export const LIMIT = 20_000_000n // what custody approves to the gate
export const MOVE = 2_000_000n // one supply
export const CEILING = 3_000_000n // the mandate's per-move ceiling
export const OVER_LIMIT = 25_000_000n // past Gate 1

// ---------------------------------------------------------------- plumbing ---

export const sym = (s: string) => xdr.ScVal.scvSymbol(s)
export const u32v = (n: number) => xdr.ScVal.scvU32(n)
export const addr = (a: string) => Address.fromString(a).toScVal()
export const i128v = (v: bigint) => nativeToScVal(v, { type: 'i128' })
export const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items)
export const kv = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v })

export const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

export const flag = (n: string) => process.argv.includes(`--${n}`)
const DRY = flag('dry-run')
const SUBMIT = flag('submit')

export function wasmPath(crate: string, file: string): string {
  const override = process.env.PRIME_WASM_DIR
  const candidate = override
    ? join(override, `${file}.wasm`)
    : join(HOME, `contracts/${crate}/target/wasm32v1-none/release/${file}.wasm`)
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

export type Secrets = { custody: Keypair; cosign: Keypair; agent: Keypair; admin: Keypair }

export function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2]
  }
  return out
}

const KEYS = ['DEMO_CUSTODY_SECRET', 'DEMO_COSIGN_SECRET', 'DEMO_AGENT_SECRET', 'DEMO_ADMIN_SECRET'] as const

export function loadSecrets(): Secrets {
  const env = { ...readEnv(), ...process.env }
  const missing = KEYS.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(', ')} in ${ENV_PATH}\nRun:  prime up   (or set PRIME_HOME to the repo root)`,
    )
  }
  return {
    custody: Keypair.fromSecret(env.DEMO_CUSTODY_SECRET!),
    cosign: Keypair.fromSecret(env.DEMO_COSIGN_SECRET!),
    agent: Keypair.fromSecret(env.DEMO_AGENT_SECRET!),
    admin: Keypair.fromSecret(env.DEMO_ADMIN_SECRET!),
  }
}

export function writeEnv(s: Secrets) {
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

export type State = {
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

export const loadState = (): State => {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`no ${STATE_PATH}\nRun:  prime up   (or set PRIME_HOME to the repo root)`)
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
}

// ------------------------------------------------------------ chain access ---

export async function settle(sent: any, label: string) {
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

export async function send(kp: Keypair, op: xdr.Operation, label: string) {
  const src = await server.getAccount(kp.publicKey())
  const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build()
  const prepared = await server.prepareTransaction(tx)
  prepared.sign(kp)
  return settle(await server.sendTransaction(prepared), label)
}

export function invokeOp(
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
export async function readCall(contract: string, fn: string, args: xdr.ScVal[], sourcePk: string) {
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

export const delegatedSigner = (a: string) => vec([sym('Delegated'), addr(a)])

export const signaturePayload = (nonce: xdr.Int64, exp: number, inv: xdr.SorobanAuthorizedInvocation) =>
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

export const authDigest = (payload: Buffer, ruleIds: number[]) =>
  hash(Buffer.concat([payload, vec(ruleIds.map(u32v)).toXDR()]))

export type Res = { denied: boolean; stage?: 'execution' | 'policy' | 'submit'; reason?: string; got?: any }

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
export async function asPrime(opts: {
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

export const codeOf = (r?: string) => (r ?? '').match(/Error\(Contract, #(\d+)\)/)?.[1]

// ------------------------------------------------------------- predicates ---

export const path = (steps: xdr.ScVal[]) => vec([sym('call_path'), ...steps])
export const eq = (a: xdr.ScVal, b: xdr.ScVal) => vec([sym('eq'), a, b])
export const cmp = (op: string, a: xdr.ScVal, b: xdr.ScVal) => vec([sym(op), a, b])
export const and = (xs: xdr.ScVal[]) => vec([sym('and'), vec(xs)])
export const selector = (s: string) => vec([sym(s)])
export const callArg = (i: number) => vec([sym('call_arg'), u32v(i)])
export const callArgLen = (i: number) => vec([sym('call_arg_len'), u32v(i)])

/** `PolicyInstallParams` from contracts/policy-interpreter/src/types.rs.
 *  ScMap keys must be sorted, and every field must be present. */
export function installParams(predicate: xdr.ScVal, adminPk: string) {
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

export const call = (target: string, fn: string, args: xdr.ScVal[], execAuth: xdr.ScVal[] = []) =>
  xdr.ScVal.scvMap([
    kv('args', vec(args)),
    kv('executor_authorizations', vec(execAuth)),
    kv('function_name', sym(fn)),
    kv('target', addr(target)),
  ])

export const ctxVal = (contract: string, fn: string, args: xdr.ScVal[]) =>
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
export const grant = (s: State, target: string, fn: string, args: xdr.ScVal[]) =>
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

export function addRuleArgs(o: {
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

export type Shown = Record<string, string>

export async function readState(s: State, want: string[]): Promise<Shown> {
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

export let _secrets: Secrets | undefined
export const secrets = () => (_secrets ??= loadSecrets())
export const custodyPk = () => secrets().custody.publicKey()


export const setSecrets = (s: Secrets) => {
  _secrets = s
}
