// Every tool: the input it refuses, the answer it gives, the envelope around both.
// Network answers replay a live testnet run (OPB_LIVE=1 bun test src/tools.test.ts
// records it again), through the real SDK against a local JSON-RPC server.

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import {
  Account,
  Address,
  Networks,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { z } from 'zod'
import { account, contract, recording } from '../test/fixtures.ts'
import { pointAt, recorded } from '../test/rpc.ts'
import { callExpr } from './intent.ts'
import { run, TOOLS } from './tools.ts'
import { encode, hashOf } from './wire.ts'

const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const INSTALL_TX = '7ee0d68b9b1dd58ad0af7752f2f5e673424c57b03dd1f4f071ee2df28b5e4e0b'
const TOKEN = contract(7)
setDefaultTimeout(30_000) // a live run makes dozens of calls
const net = recorded('tools')
afterAll(() => net.stop())

type Out = { ok: boolean; data?: any; error?: any }
const call = (name: string, input: object = {}, _live = true) =>
  run(name, { network: 'testnet', ...input }) as Promise<Out>
const failing = async (name: string, input: object, code: string, text?: RegExp) => {
  const r = await call(name, input)
  expect(r.ok).toBe(false)
  expect(r.error.code).toBe(code)
  expect(r.error.severity).toBe('error')
  expect(typeof r.error.retryable).toBe('boolean')
  if (text) expect(r.error.message).toMatch(text)
  return r
}

// A SEP-41 transfer, as an envelope: what a recording of a payment looks like.
const transferXdr = (amount = 5_000_000n) =>
  new TransactionBuilder(new Account(account(1), '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(TOKEN).toScAddress(),
            functionName: 'transfer',
            args: [
              new Address(account(1)).toScVal(),
              new Address(account(2)).toScVal(),
              nativeToScVal(amount, { type: 'i128' }),
            ],
          })
        ),
        auth: [],
      })
    )
    .setTimeout(0)
    .build()
    .toEnvelope()
    .toXDR('base64')

describe('the table', () => {
  it('has the seven tools, each with a name, a description and a shape', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'record_transaction',
      'synthesize_policy',
      'simulate_policy',
      'verify_policy',
      'install_policy',
      'revoke_policy',
      'get_interpreter_info',
    ])
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(40)
  })

  it('input nested deeper than the parser can follow is an envelope too, not an exception', async () => {
    let deep: unknown = 1
    for (let n = 0; n < 50_000; n++) deep = [deep]
    const r = (await run('synthesize_policy', {
      intent: {
        calls: [{ contract: TOKEN, fn: 'f', where: [{ rule: 'pin', at: [0], to: deep }] }],
      },
    })) as Out
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('INVALID_INPUT')
  })

  it('an unknown tool and an unknown key are refused in the envelope, never thrown', async () => {
    expect(((await run('nope', {})) as Out).error.code).toBe('INVALID_INPUT')
    await failing(
      'revoke_policy',
      { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 1, extra: 1 },
      'INVALID_INPUT',
      /extra/
    )
  })
})

describe('record_transaction', () => {
  it('decodes an envelope offline', async () => {
    const r = await call('record_transaction', { xdr: transferXdr() }, false)
    expect(r.ok).toBe(true)
    expect(r.data.contexts).toEqual([
      { contract: TOKEN, fn: 'transfer', args: [account(1), account(2), { i128: '5000000' }] },
    ])
  })

  it('fetches a transaction by hash', async () => {
    const r = await call('record_transaction', { hash: INSTALL_TX })
    expect(r.data.contexts[0]).toMatchObject({ contract: ACCOUNT, fn: 'add_context_rule' })
    expect(r.data.source).toBe(SIGNER)
  })

  it('a hash that is not on the network is reported, retryable (it may be too new)', async () => {
    const r = await failing(
      'record_transaction',
      { hash: 'ab'.repeat(32) },
      'RECORDING_FAILED',
      /not found/
    )
    expect(r.error.retryable).toBe(true)
  })

  it.each<[string, object]>([
    ['neither', {}],
    ['both', { hash: INSTALL_TX, xdr: 'AAAA' }],
    ['a short hash', { hash: 'abc' }],
    ['an unknown network', { hash: INSTALL_TX, network: 'devnet' }],
    // An endpoint is the operator's, never the request's: a tool that took one could be pointed anywhere.
    ['an endpoint of its own', { hash: INSTALL_TX, rpcUrl: 'https://rpc.example.com' }],
    ['permission for it', { hash: INSTALL_TX, allowUnpinnedRpcUrl: true }],
  ])('refuses %s', (_n, input) =>
    failing(
      'record_transaction',
      {
        ...input,
        ...((input as { network?: string }).network
          ? { network: (input as { network: string }).network }
          : {}),
      },
      'INVALID_INPUT'
    )
  )

  it("the endpoint is the operator's: configured in the environment, https unless it is loopback", async () => {
    const restore = pointAt('testnet', 'http://example.com')
    try {
      const r = (await call('record_transaction', { hash: INSTALL_TX })) as Out
      expect(r.error.code).toBe('INVALID_INPUT')
      expect(r.error.message).toMatch(/must be https/)
    } finally {
      restore()
    }
  })

  it('refuses what is not a transaction that calls a contract', async () => {
    await failing('record_transaction', { xdr: 'AAAA' }, 'RECORDING_FAILED')
  })
})

describe('synthesize_policy: template parameters are typed', () => {
  const venue = { pool: TOKEN, token: contract(2), account: account(1), max: '100' }
  const batch = { adapter: TOKEN, targets: [contract(2)] }
  const bad = (name: string, params: object, text: RegExp) =>
    failing('synthesize_policy', { template: { name, params } }, 'INVALID_INPUT', text)

  it('refuses what a template cannot mean, naming the parameter', async () => {
    await bad('blend_venue', {}, /pool/)
    await bad('blend_venue', { ...venue, maxType: 4 }, /maxType/) // 4 is borrow
    await bad('blend_venue', { ...venue, maxType: -1 }, /maxType/)
    await bad('blend_venue', { ...venue, account: 'me' }, /account/)
    await bad('blend_venue', { ...venue, token: 'usdc' }, /token/)
    await bad('blend_venue', { ...venue, max: '0' }, /max/)
    await bad('blend_venue', { ...venue, extra: 1 }, /extra/)
    await bad('adapter_batch', {}, /adapter/)
    await bad('adapter_batch', { ...batch, targets: [] }, /targets/)
    await bad('adapter_batch', { ...batch, targets: [account(1)] }, /targets/)
    await bad('adapter_batch', { ...batch, functions: ['a b'] }, /functions/)
    await bad('adapter_batch', { ...batch, maxCalls: 0 }, /maxCalls/)
    await bad('adapter_batch', { ...batch, maxCalls: 1.5 }, /maxCalls/)
    await bad('nothing', {}, /name/)
  })

  it('and builds from what it can mean', async () => {
    for (const template of [
      { name: 'blend_venue', params: { ...venue, maxType: 0 } },
      { name: 'blend_venue', params: venue },
      { name: 'adapter_batch', params: { ...batch, functions: ['supply'], maxCalls: 4 } },
    ])
      expect((await call('synthesize_policy', { template })).ok).toBe(true)
  })
})

describe('synthesize_policy', () => {
  it('a payment: who is pinned, the amount is a question, and the review says so', async () => {
    const r = await call('synthesize_policy', { xdr: transferXdr() }, false)
    expect(r.ok).toBe(true)
    expect(r.data.ambiguities.map((a: { code: string }) => a.code)).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    const [rule] = r.data.rules
    expect(rule.contract).toBe(TOKEN)
    expect(rule.review).toEqual([
      `the contract must be ${TOKEN}`,
      'the function must be transfer',
      `argument 0 must be ${account(1)}`,
      `argument 1 must be ${account(2)}`,
    ])
    expect(rule.predicateHash).toBe(hashOf(rule.encodedPredicate))
    expect(rule.encodedPredicate).toBe(encode(rule.predicate))
  })

  it('answered with a limit, the cap is in the rule', async () => {
    const r = await call('synthesize_policy', { xdr: transferXdr(), limit: '9000000' }, false)
    expect(r.data.ambiguities).toEqual([])
    expect(r.data.rules[0].review.at(-1)).toBe('argument 2 must be at most 9000000')
  })

  it('an intent, a template and a recording are other ways in', async () => {
    const intent = {
      calls: [{ contract: TOKEN, fn: 'pay', where: [{ rule: 'cap', at: [0], max: '5' }] }],
    }
    expect((await call('synthesize_policy', { intent }, false)).data.rules[0].review.at(-1)).toBe(
      'argument 0 must be at most 5'
    )
    const template = {
      name: 'adapter_batch',
      params: { adapter: TOKEN, targets: [contract(2)], functions: ['supply'] },
    }
    expect(
      (await call('synthesize_policy', { template }, false)).data.rules[0].review.join('\n')
    ).toContain('For every item in argument 0:')
    const r = await call('synthesize_policy', { recording: recording('sep41'), limit: '1' }, false)
    expect(r.data.rules).toHaveLength(1)
  })

  it('refuses: no source, two sources, a malformed intent, a cap of zero, a rule the contract would not decode', async () => {
    await failing('synthesize_policy', {}, 'INVALID_INPUT', /exactly one/)
    await failing(
      'synthesize_policy',
      { xdr: transferXdr(), intent: { calls: [] } },
      'INVALID_INPUT'
    )
    await failing(
      'synthesize_policy',
      { intent: { calls: [{ contract: 'nope', fn: 'x' }] } },
      'INVALID_INPUT'
    )
    await failing(
      'synthesize_policy',
      {
        intent: {
          calls: [{ contract: TOKEN, fn: 'x', where: [{ rule: 'cap', at: [0], max: '0' }] }],
        },
      },
      'INVALID_INPUT'
    )
    await failing(
      'synthesize_policy',
      { intent: { calls: [{ contract: TOKEN, fn: 'x', where: [{ rule: 'bogus', at: [0] }] }] } },
      'INVALID_INPUT'
    )
    const wide = {
      name: 'adapter_batch',
      params: { adapter: TOKEN, targets: [1, 2, 3, 4, 5, 6].map(contract), functions: ['a'] },
    }
    await failing('synthesize_policy', { template: wide }, 'MALFORMED_PREDICATE', /leaves/)
  })
})

const rule = callExpr({
  contract: TOKEN,
  fn: 'transfer',
  where: [
    { rule: 'pin', at: [0], to: account(1) },
    { rule: 'pin', at: [1], to: account(2) },
    { rule: 'cap', at: [2], max: '9000000' },
  ],
})
const encodedRule = encode(rule)

describe('simulate_policy', () => {
  it('says permit or the deny code, per call, from the recorded transaction', async () => {
    const r = await call('simulate_policy', { encodedPredicate: encodedRule, xdr: transferXdr() })
    expect(r.data.results).toHaveLength(1)
    expect(r.data.results[0]).toMatchObject({ permitted: true, code: 0, reason: 'PERMIT' })
    expect(r.data.predicateHash).toBe(hashOf(encodedRule))
  })

  it('a call over the cap is denied with 100', async () => {
    const over = {
      contract: TOKEN,
      fn: 'transfer',
      args: [account(1), account(2), { i128: '9000001' }],
    }
    const r = await call('simulate_policy', { expr: rule, calls: [over] })
    expect(r.data.results[0]).toMatchObject({ permitted: false, code: 100, reason: 'ARG_MISMATCH' })
  })

  it('builds the predicate itself from a source when none is given', async () => {
    const r = await call('simulate_policy', { xdr: transferXdr(), limit: '9000000' })
    expect(r.data.results[0].permitted).toBe(true)
  })

  it.each<[string, object, RegExp]>([
    ['nothing to check', { expr: rule }, /no call to check/],
    [
      'no predicate and no source',
      { calls: [{ contract: TOKEN, fn: 'x', args: [] }] },
      /predicate/,
    ],
    [
      'both forms of a predicate',
      {
        expr: rule,
        encodedPredicate: encodedRule,
        calls: [{ contract: TOKEN, fn: 'x', args: [] }],
      },
      /exactly one/,
    ],
    [
      'a predicate the contract would refuse',
      { expr: ['bogus'], calls: [{ contract: TOKEN, fn: 'x', args: [] }] },
      /operator/,
    ],
    [
      'an encoding that is not canonical',
      {
        encodedPredicate: `${encodedRule.slice(0, -4)}AAA=`,
        calls: [{ contract: TOKEN, fn: 'x', args: [] }],
      },
      /./,
    ],
  ])('refuses %s', (_n, input, text) =>
    failing(
      'simulate_policy',
      input,
      ['nothing to check'].includes(_n)
        ? 'INVALID_INPUT'
        : _n.startsWith('a pred') || _n.startsWith('an enc')
          ? 'MALFORMED_PREDICATE'
          : 'INVALID_INPUT',
      text
    )
  )
})

describe('verify_policy', () => {
  it('a tight rule verifies: permit, every deny case refused, every conjunct needed', async () => {
    const r = await call('verify_policy', {
      expr: rule,
      call: { contract: TOKEN, fn: 'transfer', args: [account(1), account(2), { i128: '100' }] },
    })
    expect(r.data).toMatchObject({ ok: true, minimal: true, checks: 1 + 10 })
    expect(r.data.cases).toHaveLength(5)
  })

  it('takes the permit case from a recording, and says when it has none', async () => {
    const ok = await call('verify_policy', { expr: rule, xdr: transferXdr() })
    expect(ok.data.ok).toBe(true)
    await failing('verify_policy', { expr: rule }, 'INVALID_INPUT', /must be permitted/)
  })

  it('a rule that does not permit its own call is not ok', async () => {
    const r = await call('verify_policy', {
      expr: rule,
      call: {
        contract: TOKEN,
        fn: 'transfer',
        args: [account(1), account(2), { i128: '9000001' }],
      },
    })
    expect(r.data).toMatchObject({ ok: false, permit: { permitted: false, code: 100 } })
  })
})

describe('install_policy', () => {
  const base = {
    smartAccount: ACCOUNT,
    sourceAccount: SIGNER,
    signers: [SIGNER],
    xdr: transferXdr(),
    limit: '9000000',
  }

  it("REFUSES by default: the account's Default rule has no policy, so a shared signer would name it and skip the new rule", async () => {
    const r = await failing(
      'install_policy',
      base,
      'INSTALL_BUILD_FAILED',
      /refused: rule 0: has no policy/
    )
    expect(r.error.message).toContain('allowOverlap')
  })

  it("has no way to supply the account's rules: the scan always reads the chain", async () => {
    // `existingRules: []` used to skip the overlap refusal and report a complete, clean scan.
    await failing(
      'install_policy',
      { ...base, existingRules: [] },
      'INVALID_INPUT',
      /existingRules/
    )
    expect(TOOLS.find((t) => t.name === 'install_policy')?.shape).not.toHaveProperty(
      'existingRules'
    )
  })

  it('allowOverlap installs anyway and still reports the overlap; the bytes say what they call', async () => {
    const r = await call('install_policy', { ...base, allowOverlap: true, name: 'pay-9m' })
    expect(r.ok).toBe(true)
    expect(r.data.describes).toMatchObject({ contract: ACCOUNT, fn: 'add_context_rule' })
    expect(r.data.describes.args[1]).toEqual({ string: 'pay-9m' })
    expect(
      r.data.authorityScan.overlaps.map((o: { ruleId: number; why: string }) => [o.ruleId, o.why])
    ).toEqual([
      [0, 'unpoliced'],
      [1, 'unreadable'],
      [2, 'other'],
    ])
    expect(r.data.interpreter.matches).toBe(true)
    expect(r.data.rule.review).toContain('argument 2 must be at most 9000000')
    expect(r.data.unsignedXdrLength).toBe(r.data.unsignedXdr.length)
  })

  it('a signer the account does not share is a clean install', async () => {
    const r = await call('install_policy', { ...base, signers: [account(5)] })
    expect(r.ok).toBe(true)
    expect(r.data.authorityScan).toEqual({ complete: true, overlaps: [] })
  })

  it('an unanswered cap is refused, unless asked for', async () => {
    const open = { ...base, limit: undefined, allowOverlap: true }
    await failing('install_policy', open, 'INSTALL_BUILD_FAILED', /Answer with `limit`/)
    expect((await call('install_policy', { ...open, allowUnboundedAmount: true })).ok).toBe(true)
  })

  it('a rolling total rides on the same rule', async () => {
    const r = await call('install_policy', {
      ...base,
      spendingLimit: { amount: '100000000', periodLedgers: 17280 },
      allowOverlap: true,
    })
    expect(r.data.describes.args[4].map).toHaveLength(2)
  })

  it('takes no outPath or endpoint: what it builds is returned, and written nowhere', async () => {
    for (const extra of [{ outPath: '/tmp/x.xdr' }, { rpcUrl: 'https://rpc.example.com' }])
      await failing('install_policy', { ...base, ...extra }, 'INVALID_INPUT', /Unrecognized key/)
  })

  it('refuses a scope that exposes an admin surface, before any build', async () => {
    const toAccount = {
      ...base,
      intent: { calls: [{ contract: ACCOUNT, fn: 'add_context_rule' }] },
      xdr: undefined,
      limit: undefined,
    }
    await failing('install_policy', toAccount, 'INSTALL_BUILD_FAILED', /admin calls/)
  })

  it('an interpreter that is not the pinned one is refused; so is one with no pin to check', async () => {
    await failing(
      'install_policy',
      {
        ...base,
        interpreterAddress: 'CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ',
      },
      'INTERPRETER_MISMATCH',
      /not the pinned/
    )
    await failing(
      'install_policy',
      { ...base, network: 'mainnet' },
      'INTERPRETER_MISMATCH',
      /no grammar-7 interpreter is pinned for mainnet/
    )
  })

  it('and the input boundary: signers, names, nonces', async () => {
    await failing('install_policy', { ...base, signers: [] }, 'INVALID_INPUT')
    await failing('install_policy', { ...base, signers: ['nope'] }, 'INVALID_INPUT')
    await failing('install_policy', { ...base, name: 'x'.repeat(21) }, 'INVALID_INPUT')
    await failing('install_policy', { ...base, smartAccount: SIGNER }, 'INVALID_INPUT')
    await failing('install_policy', { ...base, installNonce: 0 }, 'INVALID_INPUT')
  })

  it('an intent or a template is asked about the amount too, and an encoding must be the canonical one', async () => {
    const open = { ...base, xdr: undefined, limit: undefined, allowOverlap: true }
    await failing(
      'install_policy',
      { ...open, intent: { calls: [{ contract: TOKEN, fn: 'transfer' }] } },
      'INSTALL_BUILD_FAILED',
      /most `amount` may be/
    )
    const capped = {
      calls: [{ contract: TOKEN, fn: 'transfer', where: [{ rule: 'cap', at: [2], max: '5' }] }],
    }
    expect((await call('install_policy', { ...open, intent: capped })).ok).toBe(true)
    // A map written with its keys the wrong way round is another predicate, not another spelling.
    const wrongWay = xdr.ScVal.fromXDR(
      encode([
        'and',
        [
          ['eq', ['call_contract'], TOKEN],
          [
            'eq',
            ['call_arg', 0],
            [
              'lit',
              {
                map: [
                  ['a', 1],
                  ['b', 2],
                ],
              },
            ],
          ],
        ],
      ]),
      'base64'
    )
    const entries = wrongWay.vec()?.[1]?.vec()?.[1]?.vec()?.[2]?.vec()?.[1]?.map()
    expect(entries).toHaveLength(2)
    entries?.reverse()
    await failing(
      'install_policy',
      { ...open, encodedPredicate: wrongWay.toXDR('base64'), signers: [account(5)] },
      'MALFORMED_PREDICATE',
      /not canonical/
    )
  })

  it('an encoded predicate is installed as given, scoped to the one contract it pins', async () => {
    const r = await call('install_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      signers: [account(5)],
      encodedPredicate: encodedRule,
    })
    expect(r.ok).toBe(true)
    expect(r.data.rule).toMatchObject({ contract: TOKEN, predicateHash: hashOf(encodedRule) })
    await failing(
      'install_policy',
      {
        smartAccount: ACCOUNT,
        sourceAccount: SIGNER,
        signers: [account(5)],
        encodedPredicate: encode(['eq', ['call_arg', 0], 1]),
      },
      'INSTALL_BUILD_FAILED',
      /name it with `contract`/
    )
  })
})

describe('install_policy: the input boundary, to the unit', () => {
  const schema = z
    .object(TOOLS.find((t) => t.name === 'install_policy')?.shape as z.ZodRawShape)
    .strict()
  const base = { smartAccount: ACCOUNT, sourceAccount: SIGNER, signers: [SIGNER], xdr: 'AAAA' }
  const ok = (o: object) => schema.safeParse({ ...base, ...o }).success
  const many = (n: number) => Array.from({ length: n }, (_, i) => account(i + 1))

  it.each<[string, object, boolean]>([
    ['fifteen signers', { signers: many(15) }, true],
    ['sixteen signers', { signers: many(16) }, false],
    ['one admin', { admins: many(1) }, true],
    ['fifteen admins', { admins: many(15) }, true],
    ['sixteen admins', { admins: many(16) }, false],
    ['no admin', { admins: [] }, false],
    ['a one-character name', { name: 'x' }, true],
    ['a twenty-character name', { name: 'x'.repeat(20) }, true],
    ['an empty name', { name: '' }, false],
    ['a ledger of the maximum', { validUntilLedger: 0xffffffff }, true],
    ['a ledger past it', { validUntilLedger: 0x100000000 }, false],
  ])('%s', (_n, o, want) => expect(ok(o)).toBe(want))
})

describe('revoke_policy', () => {
  it('builds the removal of a rule the account has', async () => {
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 1,
    })
    expect(r.data.describes).toEqual({ contract: ACCOUNT, fn: 'remove_context_rule', args: [1] })
  })
  it('the account refuses one it does not have', async () => {
    await failing(
      'revoke_policy',
      { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 99 },
      'INSTALL_BUILD_FAILED'.replace('INSTALL', 'REVOKE'),
      /#3000/
    )
  })
  it.each([{ ruleId: -1 }, { ruleId: 1.5 }, { smartAccount: SIGNER }, { sourceAccount: ACCOUNT }])(
    'refuses %j',
    (bad) =>
      failing(
        'revoke_policy',
        { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 1, ...bad },
        'INVALID_INPUT'
      )
  )
})

describe('get_interpreter_info', () => {
  it('the pin, without a network call', async () => {
    const r = await call('get_interpreter_info', {}, false)
    expect(r.data).toMatchObject({
      network: 'testnet',
      pinned: true,
      grammarVersion: 7,
      address: 'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV',
    })
    expect(r.data.wasmSha256).toBe(
      'a975353d1c3fe5bb096c4c2bf90c7c96932df10b95c9bcfa0adbb1d2146773f1'
    )
    expect(r.data.live).toBeUndefined()
  })
  it('verifyLive reads what is deployed and compares it to the pin', async () => {
    const r = await call('get_interpreter_info', { verifyLive: true })
    expect(r.data.live).toEqual({
      address: r.data.address,
      grammarVersion: 7,
      wasmSha256: r.data.wasmSha256,
      matches: true,
    })
  })
  it('mainnet has no pin yet, and says so rather than guess', async () => {
    await failing(
      'get_interpreter_info',
      { network: 'mainnet' },
      'INTERPRETER_MISMATCH',
      /no grammar-7 interpreter is pinned/
    )
  })
})
