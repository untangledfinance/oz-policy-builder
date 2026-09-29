// Shared testnet plumbing for the verification scripts: chain access, the OZ
// auth dance, and the encoders for calls, grants and predicates. Nothing here
// is specific to a scenario.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  Address,
  Horizon,
  hash,
  type Keypair,
  Networks,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

export const PASSPHRASE = Networks.TESTNET
export const FEE = '6000000'
export const server = new rpc.Server('https://soroban-testnet.stellar.org')
export const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
export const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
export const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'

/** The repository root, so paths hold from any working directory. */
export const HOME = join(import.meta.dir, '../..')

/** The numbers the verifier runs on. Small, and deliberately far apart so a
 *  refusal can only come from the bound it is meant to test. */
export const LIMIT = 20_000_000n // what custody approves to the gate
export const MOVE = 2_000_000n // one supply

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

export function wasmPath(crate: string, file: string): string {
  const override = process.env.PRIME_WASM_DIR
  const candidate = override
    ? join(override, `${file}.wasm`)
    : join(HOME, `contracts/${crate}/target/wasm32v1-none/release/${file}.wasm`)
  if (!existsSync(candidate)) {
    throw new Error(
      `missing ${file}.wasm at ${candidate}\n` +
        `Build it:  cargo build --release --target wasm32v1-none --manifest-path contracts/${crate}/Cargo.toml\n` +
        'or set PRIME_WASM_DIR to a directory holding the built artifacts.'
    )
  }
  return candidate
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
  // Awaited here, not just returned: an async function that RETURNS a promise
  // is typed `Promise<Promise<T>>` by the lint's inference, so every caller's
  // correct `await send(...)` was reported as a floating promise.
  return await settle(await server.sendTransaction(prepared), label)
}

export function invokeOp(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[] = []
) {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    auth,
  })
}

// ---------------------------------------------------------------- OZ auth ---

export const delegatedSigner = (a: string) => vec([sym('Delegated'), addr(a)])

export const signaturePayload = (
  nonce: xdr.Int64,
  exp: number,
  inv: xdr.SorobanAuthorizedInvocation
) =>
  hash(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(PASSPHRASE)),
        nonce,
        signatureExpirationLedger: exp,
        invocation: inv,
      })
    ).toXDR()
  )

export const authDigest = (payload: Buffer, ruleIds: number[]) =>
  hash(Buffer.concat([payload, vec(ruleIds.map(u32v)).toXDR()]))

export type Res = {
  denied: boolean
  stage?: 'execution' | 'policy' | 'submit'
  reason?: string
  got?: any
}

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
      Address.fromScAddress(e.credentials().address().address()).toString() === prime
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
                .map(
                  ({ k }) =>
                    new xdr.ScMapEntry({ key: k, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) })
                )
            )
          ),
        ]),
      })
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
        })
      ),
      subInvocations: [],
    }),
  })

  // Only a submitter that IS one of the signers vouches for the digest. A
  // keeper running a stored batch is not: the rule it runs under is signed by
  // a contract, so the keeper has nothing to vouch for.
  const vouches = signerList.includes(kp.publicKey()) ? [signerEntry] : []

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
    .addOperation(makeOp([accountEntry, ...vouches, ...others]))
    .setTimeout(120)
    .build()

  const sim2: any = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2)) return { denied: true, stage: 'policy', reason: sim2.error }

  if (!opts.submit) return { denied: false }

  const fresh = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(makeOp([accountEntry, ...vouches, ...others]))
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
export const and = (xs: xdr.ScVal[]) => vec([sym('and'), vec(xs)])
export const selector = (s: string) => vec([sym(s)])
export const callArg = (i: number) => vec([sym('call_arg'), u32v(i)])

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
export const grant = (
  s: { prime: string; interpreter: string },
  target: string,
  fn: string,
  args: xdr.ScVal[]
) =>
  vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv(
        'context',
        xdr.ScVal.scvMap([
          kv('args', vec([addr(s.prime), ctxVal(target, fn, args)])),
          kv('contract', addr(s.interpreter)),
          kv('fn_name', sym('enforce')),
        ])
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
