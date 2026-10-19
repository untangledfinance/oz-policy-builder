// The owner-side review (P0-3): real unsigned builds from testnet (recorded), read back from their
// bytes, then the same bytes changed the ways an agent or an RPC could change them.

import { afterAll, afterEach, describe, expect, it, setSystemTime } from 'bun:test'
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
import {
  type Built,
  buildInstall,
  buildRevoke,
  digest,
  type RuleDraft,
  ruleArgs,
} from './install.ts'
import { callExpr } from './intent.ts'
import { reviewUnsigned } from './review.ts'
import { run } from './tools.ts'
import { encode, fromScVal, hashOf, toScVal, type Val } from './wire.ts'

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
const install = Object.assign(
  async () => {
    built ??= await buildInstall(args, draft(), INTERP)
    return built
  },
  { done: undefined as string | undefined }
)

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
/** The owner names the account they mean to change, as the Prime app does. */
const review = (
  x: string,
  o: { smartAccount?: string | undefined; network?: 'testnet' | 'mainnet' } = {}
) => reviewUnsigned({ network: 'testnet', xdr: x, smartAccount: ACCOUNT, ...o })
/** The interpreter's install parameters inside the call's policies map. */
const interpreterParams = (env: xdr.TransactionEnvelope) =>
  callArgs(env).args()[4]?.map()?.[0]?.val().map() ?? []
const param = (env: xdr.TransactionEnvelope, key: string) =>
  interpreterParams(env).find((e) => e.key().sym().toString() === key)
/** An agent's consistent edit: the account's entry follows the call, and the digest is recomputed. */
const resign = (env: xdr.TransactionEnvelope, ids = [0]) => {
  const [acct, check] = opOf(env).auth()
  if (!acct || !check) throw new Error('no entries')
  acct.rootInvocation().function().contractFn().args(callArgs(env).args())
  const c = acct.credentials().address()
  check
    .rootInvocation()
    .function()
    .contractFn()
    .args([
      xdr.ScVal.scvBytes(
        digest('testnet', c.nonce(), c.signatureExpirationLedger(), acct.rootInvocation(), ids)
      ),
    ])
}
const withTime = (env: xdr.TransactionEnvelope, max: bigint | number, min = 0) =>
  env
    .v1()
    .tx()
    .cond(
      xdr.Preconditions.precondTime(
        new xdr.TimeBounds({
          minTime: xdr.Uint64.fromString(String(min)),
          maxTime: xdr.Uint64.fromString(String(max)),
        })
      )
    )
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
    const two = edit(b.unsignedXdr, (env) => {
      callArgs(env).args([nativeToScVal(1, { type: 'u32' }), nativeToScVal(2, { type: 'u32' })])
    })
    expect(review(two).problems.join('\n')).toMatch(/takes one rule id/)
  })

  describe("the owner's clock is not the builder's", () => {
    afterEach(() => setSystemTime())
    const at = (shift: number) => setSystemTime(new Date(Date.now() + shift * 1000))

    it('an owner clock up to 120 s behind the builder still reads an untouched build as signable', async () => {
      const b = await install()
      at(-115)
      expect(review(b.unsignedXdr).problems).toEqual([])
    })

    it('an owner clock more than 120 s behind reads the bound as longer than the window', async () => {
      const b = await install()
      at(-130)
      expect(review(b.unsignedXdr).problems.join('\n')).toMatch(
        /stays valid for 19\d\d s, longer than the 1800 s window and the 120 s allowed for clocks/
      )
    })

    it('an owner clock ahead reads the build as signable until the bound passes, then as passed', async () => {
      const b = await install()
      at(1_700)
      expect(review(b.unsignedXdr).signable).toBe(true)
      setSystemTime()
      at(1_900)
      expect(review(b.unsignedXdr).problems.join('\n')).toMatch(/time bound has passed/)
    })
  })

  it('an envelope that already carries a signature is a problem: the review is of unsigned bytes', async () => {
    const b = await install()
    const tx = TransactionBuilder.fromXDR(b.unsignedXdr, PASSPHRASE.testnet)
    tx.sign(Keypair.random())
    const r = review(tx.toEnvelope().toXDR('base64'))
    expect(r.signable).toBe(false)
    expect(r.problems.join('\n')).toMatch(/already carries 1 signature/)
    const sealed = edit(b.unsignedXdr, (env) => {
      accountEntry(env)
        .credentials()
        .address()
        .signature(
          toScVal({
            map: [
              ['context_rule_ids', [0]],
              ['signers', { map: [[['Delegated', SIGNER], { bytes: 'ab'.repeat(64) }]] }],
            ],
          })
        )
      resign(env)
    })
    expect(review(sealed).problems.join('\n')).toMatch(/already carries a signature for/)
  })

  describe('a contract signer: what it runs is not in the bytes', () => {
    const NULL_ADAPTER = contract(21)
    const asSigner = (who: string) =>
      edit(install.done as string, (env) => {
        callArgs(env).args()[3] = toScVal([['Delegated', who]])
        resign(env)
      })

    it('without what the chain says of it, a contract signer is a problem', async () => {
      install.done = (await install()).unsignedXdr
      const r = review(asSigner(NULL_ADAPTER))
      expect(r.signable).toBe(false)
      expect(r.problems.join('\n')).toMatch(
        new RegExp(`signer ${NULL_ADAPTER} is a contract, and what it runs is not in the bytes`)
      )
    })

    it.each([
      ['null-gate adapter', /execution adapter bound to no gate/],
      ['absent', /is not deployed/],
    ] as const)('a contract the chain shows as %s is a problem', async (kind, why) => {
      install.done = (await install()).unsignedXdr
      const r = reviewUnsigned({
        network: 'testnet',
        xdr: asSigner(NULL_ADAPTER),
        smartAccount: ACCOUNT,
        contracts: { [NULL_ADAPTER]: kind },
      })
      expect(r.signable).toBe(false)
      expect(r.problems.join('\n')).toMatch(why)
    })

    it('every contract signer is judged, and one missing from the facts is a problem', async () => {
      install.done = (await install()).unsignedXdr
      const OK = contract(22)
      const both = (list: string[]) =>
        edit(install.done as string, (env) => {
          callArgs(env).args()[3] = toScVal(list.map((w) => ['Delegated', w]))
          resign(env)
        })
      for (const list of [
        [OK, NULL_ADAPTER],
        [NULL_ADAPTER, OK],
      ]) {
        const xdr = both(list)
        const r = reviewUnsigned({
          network: 'testnet',
          xdr,
          smartAccount: ACCOUNT,
          contracts: { [OK]: 'contract', [NULL_ADAPTER]: 'null-gate adapter' },
        })
        expect(r.problems.join('\n')).toMatch(/bound to no gate/)
        const partial = reviewUnsigned({
          network: 'testnet',
          xdr,
          smartAccount: ACCOUNT,
          contracts: { [OK]: 'contract' },
        })
        expect(partial.problems.join('\n')).toMatch(
          new RegExp(`signer ${NULL_ADAPTER} is a contract, and what it runs is not in the bytes`)
        )
      }
    })

    it('an execution adapter signing a rule scoped to itself is a problem unless every branch pins run (review-opb28 L1)', async () => {
      install.done = (await install()).unsignedXdr
      const GATED = contract(23)
      const selfRule = (fn: string) =>
        edit(install.done as string, (env) => {
          const args = callArgs(env).args()
          args[0] = toScVal(['CallContract', GATED])
          args[3] = toScVal([['Delegated', GATED]])
          const enc = encode(callExpr({ contract: GATED, fn }))
          const policies = fromScVal(args[4]) as { map: [Val, { map: [string, Val][] }][] }
          for (const [, p] of policies.map)
            for (const kv of p.map ?? []) {
              if (kv[0] === 'predicate')
                kv[1] = { bytes: Buffer.from(enc, 'base64').toString('hex') }
              if (kv[0] === 'predicate_hash') kv[1] = { bytes: hashOf(enc) }
            }
          args[4] = toScVal(policies)
          resign(env)
        })
      const facts = { [GATED]: 'gated adapter' as const }
      const execute = reviewUnsigned({
        network: 'testnet',
        xdr: selfRule('execute'),
        smartAccount: ACCOUNT,
        contracts: facts,
      })
      expect(execute.signable).toBe(false)
      expect(execute.problems.join('\n')).toMatch(
        new RegExp(`${GATED} is an execution adapter, and this rule is scoped to it`)
      )
      const runOnly = reviewUnsigned({
        network: 'testnet',
        xdr: selfRule('run'),
        smartAccount: ACCOUNT,
        contracts: facts,
      })
      expect(runOnly.problems).toEqual([])
      // With no interpreter there is no predicate, so nothing pins run.
      const bare = edit(selfRule('run'), (env) => {
        callArgs(env).args()[4] = toScVal({ map: [] })
        resign(env)
      })
      expect(
        reviewUnsigned({
          network: 'testnet',
          xdr: bare,
          smartAccount: ACCOUNT,
          contracts: facts,
        }).problems.join('\n')
      ).toMatch(new RegExp(`${GATED} is an execution adapter, and this rule is scoped to it`))
      // A band rule the adapter signs, scoped to a token, is its ordinary job.
      const band = edit(install.done as string, (env) => {
        callArgs(env).args()[3] = toScVal([['Delegated', GATED]])
        resign(env)
      })
      expect(
        reviewUnsigned({ network: 'testnet', xdr: band, smartAccount: ACCOUNT, contracts: facts })
          .problems
      ).toEqual([])
      // Offline, the contract signer is already a problem: what it runs is not in the bytes.
      expect(
        reviewUnsigned({
          network: 'testnet',
          xdr: selfRule('execute'),
          smartAccount: ACCOUNT,
        }).problems.join('\n')
      ).toMatch(new RegExp(`signer ${GATED} is a contract, and what it runs is not in the bytes`))
    })

    it('a contract the chain shows as anything else is no problem; a G signer needs no facts', async () => {
      install.done = (await install()).unsignedXdr
      const r = reviewUnsigned({
        network: 'testnet',
        xdr: asSigner(NULL_ADAPTER),
        smartAccount: ACCOUNT,
        contracts: { [NULL_ADAPTER]: 'contract' },
      })
      expect(r.problems).toEqual([])
      expect(review(asSigner(OTHER)).problems).toEqual([])
    })
  })

  it('with no account named, nothing is called the smart account and the review is not signable', async () => {
    const b = await install()
    const r = review(b.unsignedXdr, { smartAccount: undefined })
    expect(r.signable).toBe(false)
    expect(r.problems.join('\n')).toMatch(/no smartAccount was given/)
    expect(r.review.join('\n')).not.toContain('[smart account]')
    expect(r.review.join('\n')).toContain('[called account]')
  })

  it('needs no RPC: the tool answers with every endpoint pointing nowhere', async () => {
    const b = await install()
    const before = process.env.POLICY_BUILDER_RPC_URL_TESTNET
    process.env.POLICY_BUILDER_RPC_URL_TESTNET = 'http://127.0.0.1:9'
    try {
      const r = await run('review_unsigned', {
        network: 'testnet',
        xdr: b.unsignedXdr,
        smartAccount: ACCOUNT,
      })
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
      'a time bound already passed',
      (env: xdr.TransactionEnvelope) => withTime(env, Math.floor(Date.now() / 1000) - 10),
      /time bound has passed/,
    ],
    [
      'ledger bounds',
      (env: xdr.TransactionEnvelope) => {
        const t = env.v1().tx().cond().timeBounds()
        env
          .v1()
          .tx()
          .cond(
            xdr.Preconditions.precondV2(
              new xdr.PreconditionsV2({
                timeBounds: t,
                ledgerBounds: new xdr.LedgerBounds({ minLedger: 0, maxLedger: 99_999_999 }),
                minSeqNum: null,
                minSeqAge: xdr.Uint64.fromString('0'),
                minSeqLedgerGap: 0,
                extraSigners: [],
              })
            )
          )
      },
      /preconditions the builder never sets/,
    ],
    [
      'a negative resource fee',
      (env: xdr.TransactionEnvelope) => {
        env.v1().tx().ext().sorobanData().resourceFee(new xdr.Int64(-1n))
      },
      /negative resource fee/,
    ],
    [
      'no Soroban resources',
      (env: xdr.TransactionEnvelope) => {
        env.v1().tx().ext(new xdr.TransactionExt(0))
      },
      /no Soroban resources/,
    ],
    [
      'a rule id list that names no rule',
      (env: xdr.TransactionEnvelope) => {
        accountEntry(env)
          .credentials()
          .address()
          .signature(
            toScVal({
              map: [
                ['context_rule_ids', []],
                ['signers', { map: [[['Delegated', SIGNER], { bytes: '' }]] }],
              ],
            })
          )
      },
      /names no context rule/,
    ],
    [
      'the authorisation by rule 1, made consistent',
      (env: xdr.TransactionEnvelope) => {
        accountEntry(env)
          .credentials()
          .address()
          .signature(
            toScVal({
              map: [
                ['context_rule_ids', [1]],
                ['signers', { map: [[['Delegated', SIGNER], { bytes: '' }]] }],
              ],
            })
          )
        resign(env, [1])
      },
      /by rule 1, not rule 0/,
    ],
    [
      '__check_auth on another contract',
      (env: xdr.TransactionEnvelope) => {
        opOf(env)
          .auth()[1]
          ?.rootInvocation()
          .function()
          .contractFn()
          .contractAddress(new Address(contract(8)).toScAddress())
      },
      /__check_auth does not match/,
    ],
    [
      'another function in place of __check_auth',
      (env: xdr.TransactionEnvelope) => {
        opOf(env).auth()[1]?.rootInvocation().function().contractFn().functionName('upgrade')
      },
      /__check_auth does not match/,
    ],
    [
      'a call under __check_auth',
      (env: xdr.TransactionEnvelope) => {
        const e = opOf(env).auth()[1] as xdr.SorobanAuthorizationEntry
        e.rootInvocation(
          new xdr.SorobanAuthorizedInvocation({
            function: e.rootInvocation().function(),
            subInvocations: [transfer],
          })
        )
      },
      /__check_auth does not match/,
    ],
    [
      'a predicate the interpreter would not read, with its hash',
      (env: xdr.TransactionEnvelope) => {
        const bad = encode(['bogus', 1])
        param(env, 'predicate')?.val(xdr.ScVal.scvBytes(Buffer.from(bad, 'base64')))
        param(env, 'predicate_hash')?.val(xdr.ScVal.scvBytes(Buffer.from(hashOf(bad), 'hex')))
        resign(env)
      },
      /not one the interpreter reads/,
    ],
    [
      'no predicate',
      (env: xdr.TransactionEnvelope) => {
        const p = interpreterParams(env)
        p.splice(
          p.findIndex((e) => e.key().sym().toString() === 'predicate'),
          1
        )
        resign(env)
      },
      /given no predicate/,
    ],
    [
      'a sixth argument',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).args([...callArgs(env).args(), xdr.ScVal.scvU32(1)])
        resign(env)
      },
      /five arguments of a rule/,
    ],
    [
      'an External admin, made consistent',
      (env: xdr.TransactionEnvelope) => {
        param(env, 'policy_admins')?.val(toScVal([['External', contract(6), { bytes: 'ab' }]]))
        resign(env)
      },
      /admin is not a Delegated address/,
    ],
    [
      'a threshold policy with no threshold',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env)
          .args()[4]
          ?.map()
          ?.push(
            new xdr.ScMapEntry({
              key: new Address(thresholdAddress('testnet', false)).toScVal(),
              val: toScVal({ map: [] }),
            })
          )
        resign(env)
      },
      /threshold policy carries no threshold/,
    ],
    [
      'a threshold weight on an External key',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env)
          .args()[4]
          ?.map()
          ?.push(
            new xdr.ScMapEntry({
              key: new Address(thresholdAddress('testnet', true)).toScVal(),
              val: toScVal({
                map: [
                  ['signer_weights', { map: [[['External', contract(6), { bytes: 'ab' }], 1]] }],
                  ['threshold', 1],
                ],
              }),
            })
          )
        resign(env)
      },
      /threshold weight is given to a key that is not a Delegated address/,
    ],
    [
      'a time bound past the year 275,760',
      (env: xdr.TransactionEnvelope) => withTime(env, 10n ** 15n),
      /time bound is out of range/,
    ],
    [
      'an argument of a kind the builder never writes',
      (env: xdr.TransactionEnvelope) => {
        callArgs(env).args()[1] = xdr.ScVal.scvError(xdr.ScError.sceContract(1))
        resign(env)
      },
      /argument the builder never writes/,
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
