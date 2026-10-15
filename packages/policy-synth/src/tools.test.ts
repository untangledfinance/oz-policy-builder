// Every tool: the input it refuses, the answer it gives, the envelope around both.
// Network answers replay a live testnet run (OPB_LIVE=1 bun test src/tools.test.ts
// records it again), through the real SDK against a local JSON-RPC server.

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { fakeInterpreter, instanceResult, pointAt, recorded } from '../test/rpc.ts'
import { callExpr } from './intent.ts'
import { describeRules, run, TOOLS } from './tools.ts'
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
        calls: [{ contract: TOKEN, fn: 'f', where: [{ constraint: 'pin', at: [0], to: deep }] }],
      },
    })) as Out
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('INVALID_INPUT')
  })

  it('an unknown tool and an unknown key are refused in the envelope, never thrown', async () => {
    const unknown = (await run('nope', {})) as Out
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', retryable: false, severity: 'error' },
    })
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

describe('record_transaction: the other network is asked only when neither endpoint is configured', () => {
  it('a hash that is not found does not go looking on a network the operator did not name', async () => {
    const [a, b] = [
      fakeInterpreter(contract(1), 'ab'.repeat(32)),
      fakeInterpreter(contract(2), 'ab'.repeat(32)),
    ]
    const undo = [
      pointAt('testnet', `http://127.0.0.1:${a.port}`),
      pointAt('mainnet', `http://127.0.0.1:${b.port}`),
    ]
    try {
      const r = (await call('record_transaction', { hash: INSTALL_TX })) as Out
      expect(r.ok).toBe(false)
      expect(a.asked).toContain('getTransaction')
      expect(b.asked).toEqual([])
    } finally {
      for (const u of undo) u()
      a.stop()
      b.stop()
    }
  })
})

/** The recorded network, except that what `answer` says is what the instance read of ACCOUNT gets. */
function accountBehind(answer: () => Response) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text()
      const body = JSON.parse(text) as { id: number; method: string; params: { keys?: string[] } }
      const key =
        body.params.keys?.length === 1
          ? xdr.LedgerKey.fromXDR(body.params.keys[0] as string, 'base64')
          : undefined
      if (
        body.method === 'getLedgerEntries' &&
        key?.switch().name === 'contractData' &&
        key.contractData().key().switch().name === 'scvLedgerKeyContractInstance' &&
        Address.fromScAddress(key.contractData().contract()).toString() === ACCOUNT
      )
        return answer()
      return fetch(net.endpoint.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
      })
    },
  })
  const undo = pointAt('testnet', `http://127.0.0.1:${server.port}`)
  return {
    stop() {
      undo()
      server.stop(true)
    },
  }
}

describe('explainAccount reads only an account that runs a known OpenZeppelin build', () => {
  it('a failure to read the account\'s code is a retryable read error, not "not a known build"', async () => {
    const through = accountBehind(() => new Response('no available server', { status: 503 }))
    try {
      const r = await failing(
        'get_interpreter_info',
        { explainAccount: ACCOUNT },
        'SIMULATION_ERROR',
        /could not read the account's code/
      )
      expect(r.error.retryable).toBe(true)
      expect(r.error.message).not.toMatch(/does not run/)
    } finally {
      through.stop()
    }
  })

  it('a contract that is not one answers with whatever rules it likes, so none is read', async () => {
    // The pinned interpreter standing in for an account: its code is not a smart account's.
    const pin = 'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV'
    const fake = fakeInterpreter(
      pin,
      'a975353d1c3fe5bb096c4c2bf90c7c96932df10b95c9bcfa0adbb1d2146773f1'
    )
    const undo = pointAt('testnet', `http://127.0.0.1:${fake.port}`)
    try {
      const r = await failing(
        'get_interpreter_info',
        { explainAccount: pin },
        'INVALID_INPUT',
        /known OpenZeppelin smart account build/
      )
      expect(r.error.message).toContain('a975353d')
      expect(fake.asked.filter((m) => m.startsWith('simulate get_context'))).toEqual([])
    } finally {
      undo()
      fake.stop()
    }
  })
})

/** The recorded network behind a spy: every request, in order, as `check`, `spec` (the instance of
 *  TOKEN, which is what the review reads first) or the method name. */
function spy() {
  const log: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text()
      const body = JSON.parse(text) as {
        method: string
        params: { keys?: string[]; transaction?: string }
      }
      let what = body.method
      if (body.method === 'getLedgerEntries' && body.params.keys?.length) {
        const k = xdr.LedgerKey.fromXDR(body.params.keys[0] as string, 'base64')
        if (
          k.switch().name === 'contractData' &&
          Address.fromScAddress(k.contractData().contract()).toString() === TOKEN
        )
          what = 'spec'
      }
      if (body.method === 'simulateTransaction') {
        const op = xdr.TransactionEnvelope.fromXDR(body.params.transaction as string, 'base64')
          .v1()
          .tx()
          .operations()[0]
        const fn = op?.body().invokeHostFunctionOp().hostFunction().invokeContract().functionName()
        if (fn?.toString() === 'check') what = 'check'
      }
      log.push(what)
      return fetch(net.endpoint.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
      })
    },
  })
  const undo = pointAt('testnet', `http://127.0.0.1:${server.port}`)
  return {
    log,
    stop() {
      undo()
      server.stop(true)
    },
  }
}

describe('the review is read for after the checks and after the refusals', () => {
  it('a refused install never reads the contract it would have named', async () => {
    const s = spy()
    try {
      const r = await call('install_policy', {
        smartAccount: ACCOUNT,
        sourceAccount: SIGNER,
        signers: [SIGNER],
        xdr: transferXdr(),
        limit: '9000000',
      })
      expect(r.ok).toBe(false)
      expect(s.log).not.toContain('spec')
    } finally {
      s.stop()
    }
  })
  it('simulate reads for names only once every verdict is in', async () => {
    const s = spy()
    try {
      const r = await call('simulate_policy', { encodedPredicate: encodedRule, xdr: transferXdr() })
      expect(r.ok).toBe(true)
      expect(s.log.filter((m) => m === 'check').length).toBeGreaterThan(0)
      expect(s.log.lastIndexOf('check')).toBeLessThan(s.log.indexOf('spec'))
    } finally {
      s.stop()
    }
  })
  it('verify too', async () => {
    const s = spy()
    try {
      const r = await call('verify_policy', { expr: rule, xdr: transferXdr() })
      expect(r.ok).toBe(true)
      expect(s.log.lastIndexOf('check')).toBeLessThan(s.log.indexOf('spec'))
    } finally {
      s.stop()
    }
  })
})

describe('get_interpreter_info explainAccount: only a trusted interpreter is read from', () => {
  it('an untrusted build named for a network with no pin is refused before any rule is read', async () => {
    const fake = fakeInterpreter(contract(3), 'cd'.repeat(32))
    const undo = fake.use()
    try {
      await failing(
        'get_interpreter_info',
        { network: 'mainnet', interpreterAddress: contract(3), explainAccount: ACCOUNT },
        'INTERPRETER_MISMATCH'
      )
      expect(fake.asked).not.toContain('simulate get_context_rules_count')
    } finally {
      undo()
      fake.stop()
    }
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
    const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`
    expect(rule.review).toEqual([
      short(TOKEN),
      '└─ transfer',
      `   ├─ argument 0:  must be  ${short(account(1))}`,
      `   └─ argument 1:  must be  ${short(account(2))}`,
    ])
    // The tree carries the wire leaves it was read from, and says nothing the predicate does not.
    expect(rule.reviewTree[0]).toMatchObject({ op: 'contract', value: TOKEN })
    expect(rule.reviewTree[0].raw).toEqual(['eq', ['call_contract'], TOKEN])
    expect(rule.reviewTree[0].children[0].children[1].raw).toEqual(rule.predicate[1][3])
    expect(rule.predicateHash).toBe(hashOf(rule.encodedPredicate))
    expect(rule.encodedPredicate).toBe(encode(rule.predicate))
  })

  it('answered with a limit, the cap is in the rule', async () => {
    const r = await call('synthesize_policy', { xdr: transferXdr(), limit: '9000000' }, false)
    expect(r.data.ambiguities).toEqual([])
    expect(r.data.rules[0].review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000')
  })

  it('raw: the wire index of every name, the whole address, the value as written', async () => {
    const r = await call('synthesize_policy', { xdr: transferXdr(), limit: '9000000', raw: true })
    expect(r.data.rules[0].review).toEqual([
      TOKEN,
      '└─ transfer',
      `   ├─ argument 0:  must be  ${account(1)}`,
      `   ├─ argument 1:  must be  ${account(2)}`,
      '   └─ argument 2:  must be at most  9000000 (i128)',
    ])
  })

  it('a name the request gives an address is a label on it', async () => {
    const r = await call('synthesize_policy', {
      xdr: transferXdr(),
      limit: '9000000',
      allow: { to: [account(2)] },
    })
    expect(r.data.rules[0].review.at(-2)).toContain('GABAEA…BAEJXA («to»)')
  })

  it('the first name an address is given stays; a numbered list is not a name', async () => {
    const r = await call('synthesize_policy', {
      xdr: transferXdr(),
      limit: '9000000',
      allow: { to: [account(2)], payee: [account(2)], '1': [account(1)] },
    })
    const text = r.data.rules[0].review.join('\n')
    expect(text).toContain('GABAEA…BAEJXA («to»)')
    expect(text).not.toContain('«payee»')
    expect(text).not.toContain('(1)')
  })

  it('an intent, a template and a recording are other ways in', async () => {
    const intent = {
      calls: [{ contract: TOKEN, fn: 'pay', where: [{ constraint: 'cap', at: [0], max: '5' }] }],
    }
    expect((await call('synthesize_policy', { intent }, false)).data.rules[0].review.at(-1)).toBe(
      '   └─ argument 0:  must be at most  5'
    )
    const template = {
      name: 'adapter_batch',
      params: { adapter: TOKEN, targets: [contract(2)], functions: ['supply'] },
    }
    expect(
      (await call('synthesize_policy', { template }, false)).data.rules[0].review.join('\n')
    ).toContain('every item of argument 0')
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
          calls: [{ contract: TOKEN, fn: 'x', where: [{ constraint: 'cap', at: [0], max: '0' }] }],
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
    { constraint: 'pin', at: [0], to: account(1) },
    { constraint: 'pin', at: [1], to: account(2) },
    { constraint: 'cap', at: [2], max: '9000000' },
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

  it('a predicate and no call is only explained: no check is made', async () => {
    const r = await call('simulate_policy', { expr: rule })
    expect(r.ok).toBe(true)
    expect(r.data.results).toEqual([])
    expect(r.data.predicateHash).toBe(hashOf(encodedRule))
    expect(r.data.review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000')
    expect(r.data.reviewTree[0].raw).toEqual(['eq', ['call_contract'], TOKEN])
    const same = await call('simulate_policy', { encodedPredicate: encodedRule, raw: true })
    expect(same.data.review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000 (i128)')
  })

  it('with calls it checks them and explains the rule too', async () => {
    const r = await call('simulate_policy', { encodedPredicate: encodedRule, xdr: transferXdr() })
    expect(r.data.results[0].permitted).toBe(true)
    expect(r.data.review[0]).toBe(`${TOKEN.slice(0, 6)}…${TOKEN.slice(-6)}`)
  })

  it('a source with no calls is refused, even beside a predicate (only a bare predicate is explained)', async () => {
    const intent = { calls: [{ contract: TOKEN, fn: 'pay' }] }
    await failing('simulate_policy', { expr: rule, intent }, 'INVALID_INPUT', /no call to check/)
  })

  it('explaining a predicate needs no interpreter: a network with none pinned is fine', async () => {
    const undo = pointAt('mainnet', 'http://127.0.0.1:9')
    try {
      const r = (await run('simulate_policy', { network: 'mainnet', expr: rule })) as Out
      expect(r.ok).toBe(true)
      expect(r.data.review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000')
    } finally {
      undo()
    }
  })

  it("names come from the predicate's own pins, never from a contract the request merely names", async () => {
    const bare = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '5' }],
      ],
    ]
    const r = await call('simulate_policy', { expr: bare, contract: TOKEN })
    expect(r.data.review).toEqual(['transfer', '└─ argument 2:  must be at most  5'])
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
    [
      'nothing to check',
      { intent: { calls: [{ contract: TOKEN, fn: 'pay' }] } },
      /no call to check/,
    ],
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
    expect(r.data.review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000')
    expect(r.data.reviewTree[0].raw).toEqual(['eq', ['call_contract'], TOKEN])
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
    expect(r.data.rule.review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000')
    expect(r.data.rule.reviewTree[0].raw).toEqual(['eq', ['call_contract'], TOKEN])
    expect(r.data.unsignedXdrLength).toBe(r.data.unsignedXdr.length)
  })

  it('the review names the accounts the request names', async () => {
    const r = await call('install_policy', {
      ...base,
      allowOverlap: true,
      admins: [account(2)],
      signers: [SIGNER, account(1)],
    })
    const text = r.data.rule.review.join('\n')
    expect(text).toContain('GAAQCA…AQDZ7H («signer»)')
    expect(text).toContain('GABAEA…BAEJXA («admin»)')
  })

  it('the source account is named in the review before the signer it also is', async () => {
    const pinned = encode(
      callExpr({
        contract: TOKEN,
        fn: 'transfer',
        where: [
          { constraint: 'pin', at: [0], to: SIGNER },
          { constraint: 'cap', at: [2], max: '9000000' },
        ],
      })
    )
    const r = await call('install_policy', {
      ...base,
      xdr: undefined,
      limit: undefined,
      encodedPredicate: pinned,
      contract: TOKEN,
      allowOverlap: true,
    })
    expect(r.data.rule.review.join('\n')).toContain('GAT7JH…CWBCSB («source account»)')
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

  describe("outFile: a name inside the operator's directory, never a path", () => {
    const clean = { ...base, signers: [account(5)] }
    const withDir = async <T>(f: (dir: string) => Promise<T>) => {
      const dir = mkdtempSync(join(tmpdir(), 'opb-'))
      const before = process.env.POLICY_BUILDER_OUT_DIR
      process.env.POLICY_BUILDER_OUT_DIR = dir
      try {
        return await f(dir)
      } finally {
        if (before === undefined) delete process.env.POLICY_BUILDER_OUT_DIR
        else process.env.POLICY_BUILDER_OUT_DIR = before
      }
    }

    it('writes the envelope into the configured directory, reads it back, and says where', async () => {
      await withDir(async (dir) => {
        const r = await call('install_policy', { ...clean, outFile: 'install.xdr' })
        expect(r.ok).toBe(true)
        expect(r.data.writtenTo).toBe(join(dir, 'install.xdr'))
        expect(readFileSync(join(dir, 'install.xdr'), 'utf8')).toBe(r.data.unsignedXdr)
        expect(readdirSync(dir)).toEqual(['install.xdr']) // no staging file left behind
      })
    })

    it('never overwrites a file, and writes nothing for an install that is refused', async () => {
      await withDir(async (dir) => {
        writeFileSync(join(dir, 'mine.xdr'), 'important')
        await failing(
          'install_policy',
          { ...clean, outFile: 'mine.xdr' },
          'INSTALL_BUILD_FAILED',
          /already exists; it is not overwritten/
        )
        expect(readFileSync(join(dir, 'mine.xdr'), 'utf8')).toBe('important')
        await failing(
          'install_policy',
          { ...base, outFile: 'refused.xdr' },
          'INSTALL_BUILD_FAILED',
          /refused: rule 0/
        )
        expect(existsSync(join(dir, 'refused.xdr'))).toBe(false)
      })
    })

    it('needs an absolute directory', async () => {
      const before = process.env.POLICY_BUILDER_OUT_DIR
      process.env.POLICY_BUILDER_OUT_DIR = 'relative/dir'
      try {
        await failing(
          'install_policy',
          { ...clean, outFile: 'a.xdr' },
          'INSTALL_BUILD_FAILED',
          /absolute directory/
        )
      } finally {
        if (before === undefined) delete process.env.POLICY_BUILDER_OUT_DIR
      }
    })

    it('is refused with no directory configured, and for anything but a plain file name', async () => {
      await failing(
        'install_policy',
        { ...clean, outFile: 'a.xdr' },
        'INSTALL_BUILD_FAILED',
        /POLICY_BUILDER_OUT_DIR/
      )
      for (const outFile of [
        '../x',
        '/tmp/x',
        'a/b',
        '.hidden',
        '..',
        'a\\0b',
        '',
        'x'.repeat(101),
      ])
        await failing('install_policy', { ...clean, outFile }, 'INVALID_INPUT')
    })
  })

  it("takes no endpoint or path of its own: those are the operator's", async () => {
    for (const extra of [{ outPath: '/tmp/x.xdr' }, { rpcUrl: 'https://rpc.example.com' }])
      await failing('install_policy', { ...base, ...extra }, 'INVALID_INPUT', /Unrecognized key/)
  })

  it.each([
    ['testnet simple_threshold', 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6'],
    ['mainnet simple_threshold', 'CDOGPGUFGGUDG25P3TG6XIXJKRRYOZ3PXUZIEPVH74KXRZIDKZ5HYEOS'],
    ['mainnet weighted_threshold', 'CDWPZ4YZ3YIJ64XSHRMERRF2L2H7XD6SPUZDP3KI56T7QXQCICC25V3J'],
    ['testnet weighted_threshold', 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2'],
  ])("a rule scoped to OZ's %s (its set_threshold) is refused", async (_n, policy) => {
    await failing(
      'install_policy',
      {
        ...base,
        xdr: undefined,
        limit: undefined,
        intent: { calls: [{ contract: policy, fn: 'set_threshold' }] },
      },
      'INSTALL_BUILD_FAILED',
      /admin calls/
    )
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
      calls: [
        { contract: TOKEN, fn: 'transfer', where: [{ constraint: 'cap', at: [2], max: '5' }] },
      ],
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

  it('an open slippage is refused unless allowOpenSlippage, for a recording and an intent alike', async () => {
    const swap = {
      contract: TOKEN,
      fn: 'swap_exact_tokens_for_tokens',
      where: [{ constraint: 'cap', at: [0], max: '5' }],
    }
    const input = {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      signers: [account(5)],
      allowOverlap: true,
    }
    await failing(
      'install_policy',
      { ...input, intent: { calls: [swap] } },
      'INSTALL_BUILD_FAILED',
      /amount_out_min/
    )
    const floored = {
      ...swap,
      where: [...swap.where, { constraint: 'minOut', at: [1], of: [0], num: '99', den: '100' }],
    }
    expect((await call('install_policy', { ...input, intent: { calls: [floored] } })).ok).toBe(true)
    expect(
      (
        await call('install_policy', {
          ...input,
          intent: { calls: [swap] },
          allowOpenSlippage: true,
        })
      ).ok
    ).toBe(true)
  })

  it('an encoded predicate that caps no amount is asked about it too, unless allowUnboundedAmount', async () => {
    const open = encode(
      callExpr({
        contract: TOKEN,
        fn: 'transfer',
        where: [{ constraint: 'pin', at: [0], to: account(1) }],
      })
    )
    const input = {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      signers: [account(5)],
      encodedPredicate: open,
    }
    await failing('install_policy', input, 'INSTALL_BUILD_FAILED', /most `amount` may be/)
    expect((await call('install_policy', { ...input, allowUnboundedAmount: true })).ok).toBe(true)
  })

  it('an encoded predicate that pins the contract but no function is refused, unless allowUnboundedAmount', async () => {
    const open = encode([
      'and',
      [
        ['eq', ['call_contract'], TOKEN],
        ['eq', ['call_arg', 0], account(1)],
      ],
    ])
    const input = {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      signers: [account(5)],
      encodedPredicate: open,
    }
    await failing('install_policy', input, 'INSTALL_BUILD_FAILED', /no function named/)
    expect((await call('install_policy', { ...input, allowUnboundedAmount: true })).ok).toBe(true)
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
    ['a plain file name', { outFile: 'install.xdr' }, true],
    ['a path', { outFile: 'a/b.xdr' }, false],
    ['a ledger of the maximum', { validUntilLedger: 0xffffffff }, true],
    ['a base fee at the cap', { baseFee: 10_000_000 }, true],
    [
      'a base fee past it (a prompt-injected agent bidding hundreds of XLM)',
      { baseFee: 10_000_001 },
      false,
    ],
    ['a base fee of zero', { baseFee: 0 }, false],
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
    expect(r.data.removes).toMatchObject({
      id: 1,
      scope: { kind: 'call_contract' },
      signers: [SIGNER],
    })
  })
  it('a rule this interpreter polices comes back with what it says', async () => {
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 2,
    })
    expect(r.data.removes.expr).toEqual(['and', expect.any(Array)])
    expect(r.data.removes.review.at(-1)).toBe('   └─ argument 2:  must be at most  1000')
    expect(r.data.removes.reviewTree[0]).toMatchObject({ op: 'contract', raw: expect.any(Array) })
    // A rule it does not police has none.
    const plain = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 1,
    })
    expect(plain.data.removes.review).toBeUndefined()
  })
  it('an account that does not run a known OpenZeppelin build is removed from, but its stored rule is not read or described', async () => {
    const through = accountBehind(() =>
      Response.json({ jsonrpc: '2.0', id: 1, result: instanceResult(ACCOUNT, 'ab'.repeat(32)) })
    )
    try {
      const r = await call('revoke_policy', {
        smartAccount: ACCOUNT,
        sourceAccount: SIGNER,
        ruleId: 2,
      })
      expect(r.ok).toBe(true)
      expect(r.data.describes).toEqual({ contract: ACCOUNT, fn: 'remove_context_rule', args: [2] })
      expect(r.data.removes).toMatchObject({ id: 2, scope: { kind: 'call_contract' } })
      expect(r.data.removes.expr).toBeUndefined()
      expect(r.data.removes.review).toBeUndefined()
      expect(r.data.removes.reviewSkipped).toMatch(
        /does not run a known OpenZeppelin smart account build/
      )
    } finally {
      through.stop()
    }
  })
  it('an account whose code could not be read is not called unknown: the removal is built, the review says it could not look', async () => {
    const through = accountBehind(() => new Response('no available server', { status: 503 }))
    try {
      const r = await call('revoke_policy', {
        smartAccount: ACCOUNT,
        sourceAccount: SIGNER,
        ruleId: 2,
      })
      expect(r.ok).toBe(true)
      expect(r.data.removes.review).toBeUndefined()
      expect(r.data.removes.reviewSkipped).toMatch(/could not read the account's code/)
      expect(r.data.removes.reviewSkipped).not.toMatch(/does not run/)
    } finally {
      through.stop()
    }
  })
  it('a known build is described, and says nothing is skipped', async () => {
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 2,
    })
    expect(r.data.removes.reviewSkipped).toBeUndefined()
  })
  it('a rule whose scope its predicate never names is still named by that scope', async () => {
    // The scope of the removed rule (read from the account) heads the review: a predicate that
    // pins nothing is described under it.
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 2,
    })
    expect(r.data.removes.scope.contract).toBe(r.data.removes.reviewTree[0].value)
  })
  it("refuses the account's admin rule 0 unless told to", async () => {
    const base = { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 0 }
    await failing('revoke_policy', base, 'REVOKE_BUILD_FAILED', /lock/)
    const r = await call('revoke_policy', { ...base, allowAdminRule: true })
    expect(r.data.removes).toMatchObject({ id: 0, scope: { kind: 'default' } })
  })
  it('the account refuses one it does not have', async () => {
    await failing(
      'revoke_policy',
      { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 99 },
      'INSTALL_BUILD_FAILED'.replace('INSTALL', 'REVOKE'),
      /#3000/
    )
  })
  it('revoke_policy caps the base fee too', async () => {
    const base = { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 1 }
    await failing('revoke_policy', { ...base, baseFee: 10_000_001 }, 'INVALID_INPUT', /baseFee/)
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
  it('explainAccount reads the rules and explains the ones this interpreter polices', async () => {
    const r = await call('get_interpreter_info', { explainAccount: ACCOUNT })
    const rules = r.data.account.rules
    expect(rules.map((x: { id: number }) => x.id)).toEqual([0, 1, 2])
    expect(r.data.account).toMatchObject({ complete: true })
    expect(rules[0].review).toBeUndefined()
    expect(rules[2].review.join('\n')).toContain('└─ transfer')
    expect(rules[2].review.join('\n')).toContain('(«smart account»)')
    const raw = await call('get_interpreter_info', { explainAccount: ACCOUNT, raw: true })
    expect(raw.data.account.rules[2].review.join('\n')).toContain(ACCOUNT)
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

describe('describeRules: a rule read off an account is described under its own scope', () => {
  it("a predicate that pins no contract is headed by the rule's scope; one with no stored predicate is skipped by the caller", async () => {
    const pinless = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '5' }],
      ],
    ] as never
    const rule = {
      id: 3,
      scope: { kind: 'call_contract', contract: TOKEN },
      signers: [],
      policies: [],
      expr: pinless,
    } as never
    const [shown] = await describeRules({ network: 'testnet' }, [rule])
    expect(shown?.reviewTree[0]).toMatchObject({ op: 'contract', raw: null, value: TOKEN })
    const dflt = {
      id: 0,
      scope: { kind: 'default' },
      signers: [],
      policies: [],
      expr: pinless,
    } as never
    const [bare] = await describeRules({ network: 'testnet' }, [dflt])
    expect(bare?.reviewTree[0]?.op).toBe('function')
  })
})
