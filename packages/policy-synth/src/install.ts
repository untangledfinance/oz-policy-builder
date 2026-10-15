// The unsigned transaction that installs or removes a rule, and the OpenZeppelin
// authorisation it needs. Nothing here signs: the wallet's signature is the
// confirmation. `add_context_rule` carries the interpreter's install parameters,
// so one signed transaction installs the predicate.
//
// Both calls are the smart account calling itself, so each is built the same way:
// simulate once to learn the nonce and invocation OZ's auth payload binds, attach
// the account's own auth entries, simulate again for the footprint and fee, and
// assemble. The arguments are wire values (`toScVal`), the same codec as a predicate.

import { createHash } from 'node:crypto'
import {
  Account,
  Address,
  BASE_FEE,
  hash,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { reasonOf } from './chain.ts'
import { GRAMMAR_VERSION, type Network, PASSPHRASE } from './config.ts'
import { type ErrorCode, Refusal } from './envelope.ts'
import type { Scope } from './rules.ts'
import { fromScVal, toScVal, type Val } from './wire.ts'

export interface RuleDraft {
  scope: Scope
  name: string
  /** Ledger sequence after which the rule lapses (OZ `valid_until`). */
  validUntil: number | null
  /** Delegated signers (G... or C... accounts): the keys the rule governs. */
  signers: string[]
  /** The Policy Signer role: who may re-install, uninstall and rotate. */
  admins: string[]
  predicate: { encoded: string; hash: string }
  nonce: number
  /** A rolling total beside the predicate, as OZ's `spending_limit` on the same rule. */
  cap?: { address: string; amount: string; periodLedgers: number }
}

const MAX_SIGNERS = 15
const MAX_POLICIES = 5
const AUTH_LEDGERS = 300 // about 25 minutes

const delegated = (a: string): Val => ['Delegated', a]

/** The five arguments of OZ's `add_context_rule`, as wire values. */
export function ruleArgs(d: RuleDraft, interpreter: string): Val[] {
  const wasm = d.scope.kind === 'create_contract' ? d.scope.wasmHash : ''
  const scope: Val =
    d.scope.kind === 'call_contract'
      ? ['CallContract', d.scope.contract]
      : d.scope.kind === 'create_contract'
        ? ['CreateContract', { bytes: wasm }]
        : ['Default']
  if (d.signers.length === 0)
    throw new Refusal('INSTALL_BUILD_FAILED', 'the rule names no signer, so it would govern no key')
  if (d.signers.length > MAX_SIGNERS)
    throw new Refusal(
      'INSTALL_BUILD_FAILED',
      `${d.signers.length} signers; OpenZeppelin allows ${MAX_SIGNERS}`
    )
  if (d.admins.length === 0)
    throw new Refusal(
      'INSTALL_BUILD_FAILED',
      'the rule names no policy admin: the interpreter refuses an empty admin set'
    )
  const policies: [Val, Val][] = [
    [
      interpreter,
      {
        map: [
          ['grammar_version', GRAMMAR_VERSION],
          ['install_nonce', d.nonce],
          ['policy_admins', d.admins.map(delegated)],
          ['predicate', { bytes: Buffer.from(d.predicate.encoded, 'base64').toString('hex') }],
          ['predicate_hash', { bytes: d.predicate.hash }],
        ],
      },
    ],
  ]
  if (d.cap) {
    policies.push([
      d.cap.address,
      {
        map: [
          ['period_ledgers', d.cap.periodLedgers],
          ['spending_limit', { i128: d.cap.amount }],
        ],
      },
    ])
  }
  if (policies.length > MAX_POLICIES)
    throw new Refusal('INSTALL_BUILD_FAILED', 'too many policies on one rule')
  return [scope, { string: d.name }, d.validUntil, d.signers.map(delegated), { map: policies }]
}

export interface Built {
  unsignedXdr: string
  /** Length and sha256 of `unsignedXdr`: a truncated copy fails later as a malformed transaction. */
  unsignedXdrLength: number
  unsignedXdrSha256: string
  smartAccount: string
  sourceAccount: string
  /** What the built bytes call, decoded back out of them. */
  describes: { contract: string; fn: string; args: Val[] }
  authNonce: string
  authValidUntilLedger: number
}

export interface BuildArgs {
  server: rpc.Server
  network: Network
  smartAccount: string
  sourceAccount: string
  baseFee?: number | undefined
}

/** The OZ auth payload, per `stellar-contracts` smart_account: the digest the signer
 *  commits to is sha256(sha256(preimage) || context_rule_ids as XDR). */
const digest = (
  network: Network,
  nonce: xdr.Int64,
  until: number,
  inv: xdr.SorobanAuthorizedInvocation,
  ids: number[]
) =>
  hash(
    Buffer.concat([
      hash(
        xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId: hash(Buffer.from(PASSPHRASE[network])),
            nonce,
            signatureExpirationLedger: until,
            invocation: inv,
          })
        ).toXDR()
      ),
      toScVal(ids).toXDR(),
    ])
  )

const sym = (s: string) => xdr.ScVal.scvSymbol(s)

/** Build `smartAccount.<fn>(args)` as an unsigned transaction with the account's
 *  own auth entries attached, authorised by rule 0 (the deploy-time admin rule). */
export async function buildSelfCall(
  a: BuildArgs,
  fn: string,
  args: Val[],
  code: ErrorCode = 'INSTALL_BUILD_FAILED'
): Promise<Built> {
  const { server, network } = a
  const source = await server.getAccount(a.sourceAccount)
  const op = (auth: xdr.SorobanAuthorizationEntry[] = []) =>
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(a.smartAccount).toScAddress(),
          functionName: fn,
          args: args.map(toScVal),
        })
      ),
      auth,
    })
  const tx = (o: xdr.Operation) =>
    new TransactionBuilder(new Account(a.sourceAccount, source.sequenceNumber()), {
      fee: String(a.baseFee ?? BASE_FEE),
      networkPassphrase: PASSPHRASE[network],
    })
      .addOperation(o)
      .setTimeout(0)
      .build()
  const simulate = async (t: Transaction, what: string) => {
    const sim = await server.simulateTransaction(t)
    if (rpc.Api.isSimulationError(sim))
      throw new Refusal(code, `${fn}: ${what} simulation refused (${reasonOf(sim.error)})`)
    return sim
  }
  const recorded = await simulate(tx(op()), 'recording')
  const original = (recorded.result?.auth ?? []).find(
    (e) =>
      e.credentials().switch().name === 'sorobanCredentialsAddress' &&
      Address.fromScAddress(e.credentials().address().address()).toString() === a.smartAccount
  )
  if (!original)
    throw new Refusal(
      code,
      `${fn}: no auth entry for ${a.smartAccount}; the call does not route through the smart account`
    )
  const until = (await server.getLatestLedger()).sequence + AUTH_LEDGERS
  const creds = original.credentials().address()
  const ids = [0]
  const account = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: creds.address(),
        nonce: creds.nonce(),
        signatureExpirationLedger: until,
        // OZ AuthPayload { context_rule_ids, signers }: the source account signs, so its signature is empty here.
        signature: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: sym('context_rule_ids'), val: toScVal(ids) }),
          new xdr.ScMapEntry({
            key: sym('signers'),
            val: toScVal({ map: [[delegated(a.sourceAccount), { bytes: '' }]] }),
          }),
        ]),
      })
    ),
    rootInvocation: original.rootInvocation(),
  })
  // The smart account's `__check_auth` is itself authorised for the delegated signer.
  const checkAuth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(a.smartAccount).toScAddress(),
          functionName: '__check_auth',
          args: [
            xdr.ScVal.scvBytes(
              digest(network, creds.nonce(), until, original.rootInvocation(), ids)
            ),
          ],
        })
      ),
      subInvocations: [],
    }),
  })
  const withAuth = tx(op([account, checkAuth]))
  const final = rpc.assembleTransaction(withAuth, await simulate(withAuth, 'enforcing')).build()
  const unsignedXdr = final.toEnvelope().toXDR('base64')
  return {
    unsignedXdr,
    unsignedXdrLength: unsignedXdr.length,
    unsignedXdrSha256: createHash('sha256').update(unsignedXdr).digest('hex'),
    smartAccount: a.smartAccount,
    sourceAccount: a.sourceAccount,
    describes: describe(final),
    authNonce: creds.nonce().toString(),
    authValidUntilLedger: until,
  }
}

/** What the transaction calls, read back out of the bytes the wallet will sign. */
export function describe(tx: Transaction): Built['describes'] {
  const ops = tx.toEnvelope().v1().tx().operations()
  const host = ops.length === 1 ? ops[0]?.body().invokeHostFunctionOp().hostFunction() : undefined
  if (host?.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Refusal('INSTALL_BUILD_FAILED', 'the built transaction is not a single contract call')
  }
  const c = host.invokeContract()
  return {
    contract: Address.fromScAddress(c.contractAddress()).toString(),
    fn: c.functionName().toString(),
    args: c.args().map((x) => fromScVal(x)),
  }
}

export const buildInstall = (a: BuildArgs, d: RuleDraft, interpreter: string) =>
  buildSelfCall(a, 'add_context_rule', ruleArgs(d, interpreter))

export const buildRevoke = (a: BuildArgs, ruleId: number) =>
  buildSelfCall(a, 'remove_context_rule', [ruleId], 'REVOKE_BUILD_FAILED')
