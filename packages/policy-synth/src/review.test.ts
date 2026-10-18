// The owner-side review (P0-3): real unsigned builds from testnet (recorded), read back from their
// bytes, then the same bytes changed the ways an agent or an RPC could change them.

import { afterAll, describe, expect, it } from 'bun:test'
import {
  Address,
  Asset,
  Keypair,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { PASSPHRASE, SPENDING_LIMIT, thresholdAddress } from './config.ts'
import { type Built, buildInstall, buildRevoke, type RuleDraft, ruleArgs } from './install.ts'
import { callExpr } from './intent.ts'
import { reviewUnsigned } from './review.ts'
import { run } from './tools.ts'
import { encode, hashOf, toScVal } from './wire.ts'

const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const OTHER = account(2)
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const INTERP = interpreterFor('testnet')
const expr = callExpr({
  contract: XLM,
  fn: 'transfer',
  where: [{ constraint: 'cap', at: [2], max: '500' }],
})
const encoded = encode(expr)
const draft = (o: Partial<RuleDraft> = {}): RuleDraft => ({
  scope: { kind: 'call_contract', contract: XLM },
  name: 'review-1',
  validUntil: null,
  signers: [SIGNER],
  admins: [SIGNER],
  predicate: { encoded, hash: hashOf(encoded) },
  nonce: 1,
  ...o,
})

const net = recorded('review')
afterAll(() => net.stop())
const server = connect(net.endpoint)
const args = { server, network: 'testnet' as const, smartAccount: ACCOUNT, sourceAccount: SIGNER }

let built: Built | undefined
const install = async () => {
  built ??= await buildInstall(args, draft(), INTERP)
  return built
}

/** The same envelope with one edit. */
const edit = (b64: string, f: (env: xdr.TransactionEnvelope) => void): string => {
  const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64')
  f(env)
  return env.toXDR('base64')
}
const opOf = (env: xdr.TransactionEnvelope) =>
  env.v1().tx().operations()[0]?.body().invokeHostFunctionOp() as xdr.InvokeHostFunctionOp
const callArgs = (env: xdr.TransactionEnvelope) => opOf(env).hostFunction().invokeContract()
const accountEntry = (env: xdr.TransactionEnvelope) =>
  opOf(env)
    .auth()
    .find(
      (e) => e.credentials().switch().name === 'sorobanCredentialsAddress'
    ) as xdr.SorobanAuthorizationEntry
const review = (x: string, o: { smartAccount?: string; network?: 'testnet' | 'mainnet' } = {}) =>
  reviewUnsigned({ network: 'testnet', xdr: x, ...o })
const transfer = new xdr.SorobanAuthorizedInvocation({
  function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(XLM).toScAddress(),
      functionName: 'transfer',
      args: [
        new Address(ACCOUNT).toScVal(),
        new Address(OTHER).toScVal(),
        nativeToScVal(10n ** 12n, { type: 'i128' }),
      ],
    })
  ),
  subInvocations: [],
})

describe('reviewUnsigned: an honest build, read back from its bytes', () => {
  it('an install: nothing to stop a signature, and the authority and the predicate as built', async () => {
    const b = await install()
    const r = review(b.unsignedXdr, { smartAccount: ACCOUNT })
    expect(r.problems).toEqual([])
    expect(r.signable).toBe(true)
    expect(r.call).toEqual({
      contract: ACCOUNT,
      fn: 'add_context_rule',
      args: ruleArgs(draft(), INTERP),
    })
    expect(r.sourceAccount).toBe(SIGNER)
    expect(r.fee).toEqual({ total: b.fee.total, resource: b.fee.resource })
    expect(r.validBefore).toBe(b.validBefore)
    expect(r.auth).toEqual({
      nonce: b.authNonce,
      validUntilLedger: b.authValidUntilLedger,
      contextRuleIds: [0],
    })
    expect(r.authority).toMatchObject({
      signers: [SIGNER],
      admins: [SIGNER],
      validUntil: null,
      total: null,
      interpreter: INTERP,
    })
    expect(r.rule).toEqual({
      scope: ['CallContract', XLM],
      name: 'review-1',
      predicateHash: hashOf(encoded),
      predicate: expr,
    })
    expect(r.review[0]).toBe('Transaction')
    expect(r.review).toContain('Authority')
    const text = r.review.join('\n')
    expect(text).toContain('calls:  CASJ5G…GMGM5P ([smart account])  add_context_rule')
    expect(text).toContain('expires:  never expires')
    expect(text).toContain('total:  no total limit')
    expect(text).toMatch(/authorisation: {2}by rule 0, valid through ledger \d+/)
    expect(text).toContain('must be at most  500')
  })

  it('every authority line is read from the bytes: a weighted threshold, a rolling total, an expiry, two admins', async () => {
    const weights = { [SIGNER]: 2, [OTHER]: 1 }
    const d = draft({
      name: 'review-2',
      signers: [SIGNER, OTHER],
      admins: [SIGNER, OTHER],
      validUntil: 9_000_000,
      cap: { address: SPENDING_LIMIT.testnet, amount: '5000', periodLedgers: 17280 },
      extra: [
        [
          thresholdAddress('testnet', true),
          {
            map: [
              [
                'signer_weights',
                { map: Object.entries(weights).map(([a, w]) => [['Delegated', a], w]) },
              ],
              ['threshold', 2],
            ],
          },
        ],
      ],
    })
    const b = await buildInstall(args, d, INTERP)
    const r = review(b.unsignedXdr)
    expect(r.problems).toEqual([])
    expect(r.authority).toMatchObject({
      signers: [SIGNER, OTHER],
      admins: [SIGNER, OTHER],
      validUntil: 9_000_000,
      total: { amount: '5000', periodLedgers: 17280 },
      threshold: { n: 2, weights },
    })
    const text = r.review.join('\n')
    expect(text).toContain('signers whose weights total at least 2 must approve')
    expect(text).toContain('valid through ledger 9000000')
    expect(text).toContain('in total per 17280 ledgers')
  })

  it('a removal: the rule it removes; rule 0 carries its warning, still signable', async () => {
    const b = await buildRevoke(args, 1)
    const r = review(b.unsignedXdr)
    expect(r.problems).toEqual([])
    expect(r.removes).toEqual({ ruleId: 1 })
    expect(r.review.join('\n')).toContain('rule:  1 of CASJ5G')
    const zero = edit(b.unsignedXdr, (env) => {
      // Rule 0 by hand: the review, not the build, is under test here.
      callArgs(env).args([nativeToScVal(0, { type: 'u32' })])
    })
    expect(review(zero).review.join('\n')).toContain("rule 0 is the account's first rule")
  })

  it('needs no RPC: the tool answers with every endpoint pointing nowhere', async () => {
    const b = await install()
    const before = process.env.POLICY_BUILDER_RPC_URL_TESTNET
    process.env.POLICY_BUILDER_RPC_URL_TESTNET = 'http://127.0.0.1:9'
    try {
      const r = await run('review_unsigned', { network: 'testnet', xdr: b.unsignedXdr })
      expect(r.ok).toBe(true)
      expect(r.ok && (r.data as { signable: boolean }).signable).toBe(true)
    } finally {
      if (before === undefined) delete process.env.POLICY_BUILDER_RPC_URL_TESTNET
      else process.env.POLICY_BUILDER_RPC_URL_TESTNET = before
    }
  })
})

describe('reviewUnsigned: the same bytes, changed', () => {
  const problemsOf = async (f: (env: xdr.TransactionEnvelope) => void, o = {}) =>
    review(edit((await install()).unsignedXdr, f), o).problems.join('\n')

  it.each([
    [
      'a transfer under the account’s authorisation',
      (env: xdr.TransactionEnvelope) => {
        const e = accountEntry(env)
        e.rootInvocation(
          new xdr.SorobanAuthorizedInvocation({
            function: e.rootInvocation().function(),
            subInvocations: [transfer],
          })
        )
      },
      /authorises 1 more call\(s\) under this one/,
    ],
    [
      'the account authorising the same function and arguments on another contract',
      (env: xdr.TransactionEnvelope) => {
        const e = accountEntry(env)
        const f = e.rootInvocation().function().contractFn()
        e.rootInvocation(
          new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(contract(7)).toScAddress(),
                functionName: f.functionName(),
                args: f.args(),
              })
            ),
            subInvocations: [],
          })
        )
      },
      /another call than the one the transaction makes/,
    ],
    [
      'a third authorisation entry',
      (env: xdr.TransactionEnvelope) => {
        opOf(env)
          .auth()
          .push(
            new xdr.SorobanAuthorizationEntry({
              credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
              rootInvocation: transfer,
            })
          )
      },
      /3 authorisation entries/,
    ],
    [
      'an entry for another address beside the two',
      (env: xdr.TransactionEnvelope) => {
        opOf(env)
          .auth()
          .push(
            new xdr.SorobanAuthorizationEntry({
              credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                new xdr.SorobanAddressCredentials({
                  address: new Address(OTHER).toScAddress(),
                  nonce: new xdr.Int64(1n),
                  signatureExpirationLedger: 1,
                  signature: xdr.ScVal.scvVoid(),
                })
              ),
              rootInvocation: transfer,
            })
          )
      },
      /3 authorisation entries \(1 for the account, 1 for the source account\)/,
    ],
    [
      'a later expiry on the account’s entry, the digest left as built',
      (env: xdr.TransactionEnvelope) => {
        const c = accountEntry(env).credentials().address()
        c.signatureExpirationLedger(c.signatureExpirationLedger() + 2_000_000)
      },
      /__check_auth does not match/,
    ],
    [
      'a predicate changed, its hash left as built',
      (env: xdr.TransactionEnvelope) => {
        const a = callArgs(env).args()
        const other = encode(
          callExpr({
            contract: XLM,
            fn: 'transfer',
            where: [{ constraint: 'cap', at: [2], max: '9' }],
          })
        )
        const policies = a[4]?.map() ?? []
        const p = policies[0]?.val().map() ?? []
        const pred = p.find((e) => e.key().sym().toString() === 'predicate')
        pred?.val(xdr.ScVal.scvBytes(Buffer.from(other, 'base64')))
      },
      /predicate hash does not match/,
    ],
    [
      'another interpreter',
      (env: xdr.TransactionEnvelope) => {
        const policies = callArgs(env).args()[4]?.map() ?? []
        policies[0]?.key(new Address(contract(3)).toScVal())
      },
      /is not the pinned testnet interpreter/,
    ],
    [
      'a policy the package does not know',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env)
          .args()[4]
          ?.map()
          ?.push(
            new xdr.ScMapEntry({
              key: new Address(contract(4)).toScVal(),
              val: toScVal({ map: [] }),
            })
          )
      },
      /does not know is attached/,
    ],
    [
      'a Default scope',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).args()[0] = toScVal(['Default'])
      },
      /scoped Default/,
    ],
    [
      'no time bound',
      (env: xdr.TransactionEnvelope) => {
        env.v1().tx().cond(xdr.Preconditions.precondNone())
      },
      /no time bound/,
    ],
    [
      'a time bound a year out',
      (env: xdr.TransactionEnvelope) => {
        const t = Math.floor(Date.now() / 1000) + 365 * 86400
        env
          .v1()
          .tx()
          .cond(
            xdr.Preconditions.precondTime(
              new xdr.TimeBounds({
                minTime: xdr.Uint64.fromString('0'),
                maxTime: xdr.Uint64.fromString(String(t)),
              })
            )
          )
      },
      /longer than the 1800 s window/,
    ],
    [
      'a 200 XLM resource fee',
      (env: xdr.TransactionEnvelope) => {
        const t = env.v1().tx()
        t.ext().sorobanData().resourceFee(new xdr.Int64(2_000_000_000n))
        t.fee(2_000_000_100)
      },
      /resource fee of 200 XLM, above the ceiling of 10 XLM/,
    ],
    [
      'a 2 XLM bid beside the resources',
      (env: xdr.TransactionEnvelope) => {
        const t = env.v1().tx()
        t.fee(Number(t.ext().sorobanData().resourceFee().toBigInt()) + 20_000_000)
      },
      /bids 2 XLM beside the resources, above the 1 XLM cap/,
    ],
    [
      'no interpreter on the rule',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).args()[4] = toScVal({ map: [] })
      },
      /no interpreter polices the rule/,
    ],
    [
      'an External signer',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).args()[3] = toScVal([['External', contract(6), { bytes: 'ab' }]])
      },
      /External signer/,
    ],
    [
      'another grammar',
      (env: xdr.TransactionEnvelope) => {
        const p = callArgs(env).args()[4]?.map()?.[0]?.val().map() ?? []
        p.find((e) => e.key().sym().toString() === 'grammar_version')?.val(xdr.ScVal.scvU32(6))
      },
      /asked for grammar 6, not 7/,
    ],
    [
      'a signer in the authorisation other than the source',
      (env: xdr.TransactionEnvelope) => {
        accountEntry(env)
          .credentials()
          .address()
          .signature(
            toScVal({
              map: [
                ['context_rule_ids', [0]],
                ['signers', { map: [[['Delegated', OTHER], { bytes: '' }]] }],
              ],
            })
          )
      },
      /names a signer other than the transaction source/,
    ],
    [
      'an operation with a source of its own',
      (env: xdr.TransactionEnvelope) => {
        env
          .v1()
          .tx()
          .operations()[0]
          ?.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(Keypair.random().rawPublicKey()))
      },
      /names a source account of its own/,
    ],
    [
      'another function on the account',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).functionName('upgrade')
      },
      /it calls upgrade/,
    ],
    [
      'a scope on a policy contract',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).args()[0] = toScVal(['CallContract', SPENDING_LIMIT.testnet])
      },
      /scoped to a policy contract or to the account itself/,
    ],
    [
      'a start time',
      (env: xdr.TransactionEnvelope) => {
        const t = env.v1().tx().cond().timeBounds()
        t.minTime(xdr.Uint64.fromString('1'))
      },
      /preconditions the builder never sets/,
    ],
    [
      'a memo',
      (env: xdr.TransactionEnvelope) => {
        env.v1().tx().memo(xdr.Memo.memoText('hi'))
      },
      /memo/,
    ],
  ] as const)('%s is a problem, and the review opens with it', async (_n, f, why) => {
    const text = await problemsOf(f)
    expect(text).toMatch(why)
    const r = review(edit((await install()).unsignedXdr, f))
    expect(r.signable).toBe(false)
    expect(r.review[0]).toMatch(/^Do not sign: \d+ problem\(s\)$/)
  })

  it('the same bytes reviewed for mainnet: the digest does not match there', async () => {
    const r = review((await install()).unsignedXdr, { network: 'mainnet' })
    expect(r.problems.join('\n')).toMatch(
      /__check_auth does not match the account's authorisation on mainnet/
    )
  })

  it('another account than the owner means', async () => {
    const r = review((await install()).unsignedXdr, { smartAccount: contract(5) })
    expect(r.problems.join('\n')).toMatch(/not the account under review/)
  })

  it('what the builder never makes is refused outright: garbage, a fee bump, two operations, a payment', async () => {
    expect(() => review('AAAA')).toThrow(/not a transaction envelope/)
    const b = await install()
    const inner = TransactionBuilder.fromXDR(b.unsignedXdr, PASSPHRASE.testnet)
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '200',
      inner as never,
      PASSPHRASE.testnet
    )
    expect(() => review(bump.toEnvelope().toXDR('base64'))).toThrow(/fee bump/)
    const two = edit(b.unsignedXdr, (env) => {
      const ops = env.v1().tx().operations()
      env
        .v1()
        .tx()
        .operations([...ops, ...ops])
    })
    expect(() => review(two)).toThrow(/2 operation\(s\)/)
    const pay = edit(b.unsignedXdr, (env) => {
      env
        .v1()
        .tx()
        .operations([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' })])
    })
    expect(() => review(pay)).toThrow(/not a transaction this package builds/)
  })
})
