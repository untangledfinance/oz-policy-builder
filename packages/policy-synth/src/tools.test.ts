// Every tool: the input it refuses, the answer it gives, the envelope around both.
// Network answers replay a live testnet run (OPB_LIVE=1 bun test src/tools.test.ts
// records it again), through the real SDK against a local JSON-RPC server.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
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
import { connect, forgetLimits } from './chain.ts'
import { INTERPRETER, SAFE_READS, thresholdAddress } from './config.ts'
import { callExpr } from './intent.ts'
import { reviewUnsigned } from './review.ts'
import { readRules } from './rules.ts'
import { explain, run, TOOLS } from './tools.ts'
import { encode, hashOf } from './wire.ts'

// PayFi's settlement account on testnet: 38 rule ids handed out, 21+ removed.
const SETTLEMENT = 'CAF4HZO4DARULJGBJCNDEXLR5ZXEKLVI4TMX7VDGTESTJ222U4SXVQXS'
const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const INSTALL_TX = '02b97de9c49e27d40f6a97de8d18fc906835f3050fe7f618bf89985db4ca3bdd' // rule 6 (deployments/interpreter-testnet.json)
const TOKEN = contract(7)
const PIN = INTERPRETER.testnet?.address as string
/** What the built bytes call, decoded back out of them. */
const callOf = (b64: string) => reviewUnsigned({ network: 'testnet', xdr: b64 }).call
setDefaultTimeout(30_000) // a live run makes dozens of calls
const net = recorded('tools')
// The limits cache is process-wide: read them through this file's own recording, whatever ran first.
beforeAll(forgetLimits)
afterAll(() => net.stop())

type Out = { ok: boolean; data?: any; error?: any }
const call = (name: string, input: object = {}, _live = true) =>
  run(name, { network: 'testnet', ...input }) as Promise<Out>
const failing = async (name: string, input: object, code: string, text?: RegExp) => {
  const r = await call(name, input)
  expect(r.ok).toBe(false)
  expect(r.error.code).toBe(code)
  expect(r.error).not.toHaveProperty('severity')
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
  it('has the nine tools, each with a name, a description and a shape', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'record_transaction',
      'synthesize_policy',
      'simulate_policy',
      'verify_policy',
      'install_policy',
      'revoke_policy',
      'bind_policy',
      'get_interpreter_info',
      'review_unsigned',
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
      error: { code: 'INVALID_INPUT', retryable: false },
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

describe('the review reads nothing off the network', () => {
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
  it('simulate asks only for its verdicts', async () => {
    const s = spy()
    try {
      const r = await call('simulate_policy', { encodedPredicate: encodedRule, xdr: transferXdr() })
      expect(r.ok).toBe(true)
      expect(s.log.filter((m) => m === 'check').length).toBeGreaterThan(0)
      expect(s.log).not.toContain('spec')
    } finally {
      s.stop()
    }
  })
  it('verify too', async () => {
    const s = spy()
    try {
      const r = await call('verify_policy', { expr: rule, xdr: transferXdr() })
      expect(r.ok).toBe(true)
      expect(s.log).not.toContain('spec')
    } finally {
      s.stop()
    }
  })
})

describe('get_interpreter_info: only a trusted interpreter is read from', () => {
  it('an untrusted build named for a network with no pin is refused, its limits never believed', async () => {
    const fake = fakeInterpreter(contract(3), 'cd'.repeat(32))
    const undo = fake.use()
    try {
      await failing(
        'get_interpreter_info',
        { network: 'mainnet', interpreterAddress: contract(3) },
        'INTERPRETER_MISMATCH'
      )
      expect(fake.asked).not.toContain('simulate limits')
    } finally {
      undo()
      fake.stop()
    }
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

  it('an intent and a recording are other ways in', async () => {
    const intent = {
      calls: [{ contract: TOKEN, fn: 'pay', where: [{ constraint: 'cap', at: [0], max: '5' }] }],
    }
    expect((await call('synthesize_policy', { intent }, false)).data.rules[0].review.at(-1)).toBe(
      '   └─ argument 0:  must be at most  5'
    )
    const batch = {
      calls: [
        {
          contract: TOKEN,
          fn: 'execute',
          where: [
            {
              constraint: 'each',
              at: [0],
              where: [{ constraint: 'allow', at: ['target'], in: [contract(2)] }],
            },
          ],
        },
      ],
    }
    expect(
      (await call('synthesize_policy', { intent: batch }, false)).data.rules[0].review.join('\n')
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
    const targets = Array.from({ length: 20 }, (_, i) => contract(i + 1))
    const wide = {
      calls: [
        {
          contract: TOKEN,
          fn: 'execute',
          where: [
            {
              constraint: 'each',
              at: [0],
              where: [
                { constraint: 'allow', at: ['target'], in: targets },
                { constraint: 'allow', at: ['function_name'], in: ['a'] },
              ],
            },
          ],
        },
      ],
    }
    await failing('synthesize_policy', { intent: wide }, 'MALFORMED_PREDICATE', /leaves/)
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
    // The refusal does not teach the agent the flag that waives it (P0-4).
    expect(r.error.message).not.toMatch(/allow[A-Z]|override/i)
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
    expect(callOf(r.data.unsignedXdr)).toMatchObject({ contract: ACCOUNT, fn: 'add_context_rule' })
    expect(callOf(r.data.unsignedXdr).args[1]).toEqual({ string: 'pay-9m' })
    expect(
      r.data.authorityScan.overlaps.map((o: { ruleId: number; why: string }) => [o.ruleId, o.why])
    ).toEqual([
      [0, 'unpoliced'],
      [1, 'unreadable'],
      [2, 'unreadable'],
      [3, 'unreadable'],
      [4, 'unreadable'],
      [5, 'unreadable'],
      [6, 'other'],
    ])
    expect(r.data.interpreter.matches).toBe(true)
    expect(r.data.rule.review.at(-1)).toBe('   └─ argument 2:  must be at most  9000000')
    // The override opens the review, and is a field of its own, with the refusal it waived.
    expect(r.data.overrides).toEqual([
      { flag: 'allowOverlap', waived: expect.stringMatching(/^refused: rule 0: has no policy/) },
    ])
    expect(r.data.rule.review[0]).toBe('Overrides set in the request')
    expect(r.data.rule.review[1]).toMatch(
      /^└─ allowOverlap: {2}waived: refused: rule 0: has no policy/
    )
    expect(r.data.rule.reviewTree[0]).toMatchObject({
      label: 'Overrides set in the request',
      op: 'overrides',
    })
    expect(r.data.rule.reviewTree[1].label).toBe('Authority')
    expect(r.data.rule.reviewTree[2].raw).toEqual(['eq', ['call_contract'], TOKEN])
  })

  it('on mainnet an override is refused before the network is asked, install and revoke alike', async () => {
    // An endpoint that counts what it is asked: nothing, for either tool.
    let asked = 0
    const rpc = Bun.serve({
      port: 0,
      fetch: () => {
        asked++
        return new Response('no', { status: 503 })
      },
    })
    const before = process.env.POLICY_BUILDER_RPC_URL_MAINNET
    process.env.POLICY_BUILDER_RPC_URL_MAINNET = `http://127.0.0.1:${rpc.port}`
    try {
      const main = { ...base, network: 'mainnet', interpreterAddress: contract(3) }
      await failing(
        'install_policy',
        { ...main, allowOpenSlippage: true },
        'INSTALL_BUILD_FAILED',
        /allowOpenSlippage is set, and on mainnet .*POLICY_BUILDER_ALLOW_OVERRIDES=1/
      )
      await failing(
        'install_policy',
        { ...main, signers: [SIGNER, account(1)], anyOne: true },
        'INSTALL_BUILD_FAILED',
        /anyOne is set, and on mainnet .*POLICY_BUILDER_ALLOW_OVERRIDES=1/
      )
      await failing(
        'revoke_policy',
        {
          network: 'mainnet',
          smartAccount: ACCOUNT,
          sourceAccount: SIGNER,
          ruleId: 0,
          allowAdminRule: true,
        },
        'REVOKE_BUILD_FAILED',
        /allowAdminRule is set, and on mainnet .*POLICY_BUILDER_ALLOW_OVERRIDES=1/
      )
      await Bun.sleep(50)
      expect(asked).toBe(0)
    } finally {
      rpc.stop(true)
      if (before === undefined) delete process.env.POLICY_BUILDER_RPC_URL_MAINNET
      else process.env.POLICY_BUILDER_RPC_URL_MAINNET = before
    }
  })

  it('the description says the overrides are echoed and gated, and never offers one as the way past a refusal', () => {
    const d = TOOLS.find((t) => t.name === 'install_policy')?.description ?? ''
    expect(d).toMatch(/overrides/)
    expect(d).toMatch(/POLICY_BUILDER_ALLOW_OVERRIDES/)
    expect(d).not.toMatch(/installs anyway|refused unless `allow/)
  })

  it('the review opens with the authority (after any override): signers, the rule, admins, expiry, total, interpreter; the policy follows', async () => {
    const r = await call('install_policy', {
      ...base,
      allowOverlap: true,
      signers: [SIGNER, account(1)],
      threshold: { simple: 2 },
      validUntilLedger: 99_999_999,
      spendingLimit: { amount: '5000000', periodLedgers: 17280 },
      xdr: undefined,
      limit: undefined,
      intent: {
        calls: [
          {
            contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
            fn: 'transfer',
            where: [{ constraint: 'cap', at: [2], max: '5000000' }],
          },
        ],
      },
    })
    expect(r.ok).toBe(true)
    const review = r.data.rule.review as string[]
    // allowOverlap is set (rule 0 of the test account has no policy), so its line comes first.
    expect(review.slice(0, 3)).toEqual([
      'Overrides set in the request',
      expect.stringMatching(/^└─ allowOverlap: {2}waived: refused: rule 0/),
      'Authority',
    ])
    const text = review.join('\n')
    expect(text).toContain('signer:  GAT7JH…CWBCSB ([source account])')
    expect(text).toContain('to act:  any 2 of these 2 signers must approve')
    expect(text).toContain(
      'admins:  GAT7JH…CWBCSB ([source account]) (all of them together: alone, may uninstall the predicate, which stops the rule; with the account, may re-install, replace the admins or bind an executor)'
    )
    expect(text).toContain('expires:  valid through ledger 99999999')
    expect(text).toContain(
      'total:  at most 5000000 in total per 17280 ledgers (rolling, OZ spending_limit)'
    )
    expect(text).toMatch(
      /interpreter: {2}CDER6P…\w{6} \(\[interpreter\]\) \(reads ≤ 8, leaves ≤ 400, predicate_bytes ≤ 24576, elems ≤ 32, in_operands ≤ 32, depth ≤ 5\)/
    )
    // The predicate's own tree follows the header; the authority comes after the overrides.
    expect(r.data.rule.reviewTree[0]).toMatchObject({ op: 'overrides', raw: null })
    expect(r.data.rule.reviewTree[1]).toMatchObject({ op: 'authority', raw: null })
    expect(r.data.rule.reviewTree[2]).toMatchObject({ op: 'contract' })
    expect(review.findIndex((l) => l.endsWith('└─ transfer'))).toBeGreaterThan(6)
  })

  it('the review names the accounts the request names', async () => {
    const r = await call('install_policy', {
      ...base,
      allowOverlap: true,
      admins: [account(2)],
      signers: [SIGNER, account(1)],
      anyOne: true,
    })
    const text = r.data.rule.review.join('\n')
    expect(text).toContain('GAAQCA…AQDZ7H ([signer])')
    expect(text).toContain('GABAEA…BAEJXA ([admin])')
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
    expect(r.data.rule.review.join('\n')).toContain('GAT7JH…CWBCSB ([source account])')
  })

  it('a signer the account does not share is a clean install', async () => {
    const r = await call('install_policy', { ...base, signers: [account(5)] })
    expect(r.ok).toBe(true)
    expect(r.data.authorityScan).toEqual({ complete: true, overlaps: [] })
  })

  it('threshold: one of simple or weighted, with nothing else beside it', async () => {
    const two = { ...base, signers: [SIGNER, account(1)], allowOverlap: true }
    await failing('install_policy', { ...two, threshold: {} }, 'INVALID_INPUT')
    await failing(
      'install_policy',
      { ...two, threshold: { simple: 1, weighted: { weights: {}, n: 1 } } },
      'INVALID_INPUT'
    )
    await failing('install_policy', { ...two, threshold: { simple: 0 } }, 'INVALID_INPUT')
    await failing('install_policy', { ...two, threshold: { simple: 1, extra: 1 } }, 'INVALID_INPUT')
    await failing(
      'install_policy',
      { ...two, threshold: { weighted: { weights: { notanaddress: 1 }, n: 1 } } },
      'INVALID_INPUT'
    )
    await failing('install_policy', { ...two, anyOne: 'yes' }, 'INVALID_INPUT')
  })

  it('more than one signer and no threshold is refused by the tool, with the reason; anyOne installs', async () => {
    const two = { ...base, signers: [SIGNER, account(1)], allowOverlap: true }
    await failing('install_policy', two, 'INSTALL_BUILD_FAILED', /any ONE of the 2 signers/)
    expect((await call('install_policy', { ...two, anyOne: true })).ok).toBe(true)
  })

  it('threshold { simple }: the built bytes carry OZ simple_threshold beside the interpreter, and say so in the bytes', async () => {
    const r = await call('install_policy', {
      ...base,
      signers: [SIGNER, account(1)],
      allowOverlap: true,
      threshold: { simple: 2 },
    })
    expect(r.ok).toBe(true)
    const policies = callOf(r.data.unsignedXdr).args[4].map as [string, unknown][]
    expect(policies.map(([a]) => a)).toContain(thresholdAddress('testnet', false))
    expect(policies.find(([a]) => a === thresholdAddress('testnet', false))?.[1]).toEqual({
      map: [['threshold', 2]],
    })
  })

  it("a rule that reads a live value is refused READ_UNSAFE by the tool; the operator's environment, not an input, allows it", async () => {
    const withRead = {
      ...base,
      xdr: undefined,
      limit: undefined,
      allowOverlap: true,
      intent: {
        calls: [
          {
            contract: TOKEN,
            fn: 'transfer',
            where: [
              { constraint: 'cap', at: [2], max: '9000000' },
              {
                constraint: 'read',
                contract: contract(9),
                fn: 'balance',
                args: [{ arg: [0] }],
                op: 'gte',
                to: { i128: '1' },
              },
            ],
          },
        ],
      },
    }
    const before = process.env.POLICY_BUILDER_ALLOW_SPOT_READS
    delete process.env.POLICY_BUILDER_ALLOW_SPOT_READS
    try {
      await failing('install_policy', withRead, 'READ_UNSAFE', /balance on /)
      await failing(
        'install_policy',
        { ...withRead, allowSpotReads: true },
        'INVALID_INPUT',
        /allowSpotReads/
      )
    } finally {
      if (before !== undefined) process.env.POLICY_BUILDER_ALLOW_SPOT_READS = before
    }
  })

  it("the package's own roles are [bracketed]; a caller's label is «marked», whatever it says, and can never be bracketed", async () => {
    const variants = [
      'source account',
      'source account ',
      'source  account',
      'the source account',
      'signer A',
      'policy admin',
      'owner',
      'Source Account',
      'admin',
      'interpreter',
      'smart account',
      '[source account]',
      '[admin]',
      'x]',
    ]
    for (const word of variants) {
      const r = await call('synthesize_policy', {
        xdr: transferXdr(),
        limit: '9000000',
        allow: { [word]: [account(2)] },
      })
      const text = r.data.rules[0].review.join('\n')
      // Either shown as the caller's («word») or, when it is not plain words, not shown at all; never bracketed.
      expect(text).not.toMatch(/GABAEA…BAEJXA \(\[/)
      if (/^[A-Za-z][\w .-]{0,23}$/.test(word)) expect(text).toContain(`GABAEA…BAEJXA («${word}»)`)
      else expect(text).not.toContain('GABAEA…BAEJXA (')
    }
  })

  it('a role beats a caller label on the same address', async () => {
    const r = await call('install_policy', {
      ...base,
      allowOverlap: true,
      allow: { payee: [SIGNER] },
    })
    const text = r.data.rule.review.join('\n')
    expect(text).toContain('GAT7JH…CWBCSB ([source account])')
    expect(text).not.toContain('«payee»')
  })

  it('the review knows its network: a listed oracle on it is not called movable', async () => {
    const REFL = Object.keys(SAFE_READS.testnet)[0] as string
    const r = await call('simulate_policy', {
      expr: [
        'and',
        [
          ['eq', ['call_fn'], 'f'],
          ['gte', ['call_arg', 0], ['read', REFL, 'lastprice', [{ i128: '1' }]]],
        ],
      ],
    })
    expect(r.data.review.join('\n')).not.toContain('live value')
  })

  it('the review marks a read as a live value', async () => {
    const r = await call('simulate_policy', {
      expr: [
        'and',
        [
          ['eq', ['call_fn'], 'f'],
          ['gte', ['call_arg', 0], ['read', contract(9), 'balance', []]],
        ],
      ],
    })
    expect(r.data.review.join('\n')).toContain('(live value, movable within one transaction)')
  })

  it('an unanswered cap is refused, unless asked for', async () => {
    const open = { ...base, limit: undefined, allowOverlap: true }
    await failing('install_policy', open, 'INSTALL_BUILD_FAILED', /Answer with `limit`/)
    expect((await call('install_policy', { ...open, allowUnboundedAmount: true })).ok).toBe(true)
  })

  it('a rolling total rides on the same rule, on a real token (the native asset) with transfer pinned', async () => {
    const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
    const r = await call('install_policy', {
      ...base,
      xdr: undefined,
      limit: undefined,
      intent: {
        calls: [
          {
            contract: XLM,
            fn: 'transfer',
            where: [{ constraint: 'cap', at: [2], max: '100000000' }],
          },
        ],
      },
      spendingLimit: { amount: '100000000', periodLedgers: 17280 },
      allowOverlap: true,
    })
    expect(r.ok).toBe(true)
    expect(callOf(r.data.unsignedXdr).args[4].map).toHaveLength(2)
  })

  it('a rolling total on a contract that is not shown to be a token, or without transfer pinned, is refused with the reason', async () => {
    await failing(
      'install_policy',
      { ...base, spendingLimit: { amount: '100000000', periodLedgers: 17280 }, allowOverlap: true },
      'INSTALL_BUILD_FAILED',
      /not shown to be a token/
    )
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
      /no interpreter is pinned for mainnet/
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
    await failing('install_policy', input, 'INSTALL_BUILD_FAILED', /no function pinned/)
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
    ['an outFile (no longer taken)', { outFile: 'install.xdr' }, false],
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
  // Rule 3, not 1: the instances behind rules 1 and 2 are archived on testnet, so removing either
  // restores their entries for a resource fee above the builder's ceiling, which it refuses.
  it('builds the removal of a rule the account has', async () => {
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 3,
    })
    expect(callOf(r.data.unsignedXdr)).toEqual({
      contract: ACCOUNT,
      fn: 'remove_context_rule',
      args: [3],
    })
    expect(r.data.removes).toMatchObject({
      id: 3,
      scope: { kind: 'call_contract' },
      signers: [SIGNER],
    })
  })
  it('a rule this interpreter polices comes back with what it says', async () => {
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 6,
    })
    expect(r.data.removes.expr).toEqual(['and', expect.any(Array)])
    expect(r.data.removes.review.at(-1)).toBe('   └─ argument 2:  must be at most  500')
    expect(r.data.removes.reviewTree[0]).toMatchObject({ op: 'contract', raw: expect.any(Array) })
    // A rule it does not police has none.
    const plain = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 3,
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
        ruleId: 6,
      })
      expect(r.ok).toBe(true)
      expect(callOf(r.data.unsignedXdr)).toEqual({
        contract: ACCOUNT,
        fn: 'remove_context_rule',
        args: [6],
      })
      expect(r.data.removes).toMatchObject({ id: 6, scope: { kind: 'call_contract' } })
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
        ruleId: 6,
      })
      expect(r.ok).toBe(true)
      expect(r.data.removes.review).toBeUndefined()
      expect(r.data.removes.reviewSkipped).toMatch(/could not read the account's code/)
      expect(r.data.removes.reviewSkipped).not.toMatch(/does not run/)
      expect(r.data.removes.reviewSkipped).toMatch(/unverified/)
    } finally {
      through.stop()
    }
  })
  it('an account with no code entry at all (nothing to read the hash of) is not a known build: the review is skipped, saying so', async () => {
    const through = accountBehind(() =>
      Response.json({ jsonrpc: '2.0', id: 1, result: { latestLedger: 1, entries: [] } })
    )
    try {
      const r = await call('revoke_policy', {
        smartAccount: ACCOUNT,
        sourceAccount: SIGNER,
        ruleId: 6,
      })
      expect(r.ok).toBe(true)
      expect(r.data.removes.review).toBeUndefined()
      expect(r.data.removes.reviewSkipped).toMatch(
        /does not run a known OpenZeppelin smart account build \(code none\)/
      )
    } finally {
      through.stop()
    }
  })
  it('a known build is described, and says nothing is skipped', async () => {
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 6,
    })
    expect(r.data.removes.reviewSkipped).toBeUndefined()
  })
  it('a rule whose scope its predicate never names is still named by that scope', async () => {
    // The scope of the removed rule (read from the account) heads the review: a predicate that
    // pins nothing is described under it.
    const r = await call('revoke_policy', {
      smartAccount: ACCOUNT,
      sourceAccount: SIGNER,
      ruleId: 6,
    })
    expect(r.data.removes.scope.contract).toBe(r.data.removes.reviewTree[0].value)
  })
  it("refuses the account's admin rule 0 unless told to", async () => {
    const base = { smartAccount: ACCOUNT, sourceAccount: SIGNER, ruleId: 0 }
    await failing('revoke_policy', base, 'REVOKE_BUILD_FAILED', /lock/)
    const r = await call('revoke_policy', { ...base, allowAdminRule: true })
    expect(r.data.removes).toMatchObject({ id: 0, scope: { kind: 'default' } })
    expect(r.data.overrides).toEqual([
      { flag: 'allowAdminRule', waived: expect.stringMatching(/lock the account out/) },
    ])
    expect(r.data.removes.review[0]).toBe('Overrides set in the request')
    expect(r.data.removes.review[1]).toMatch(
      /^└─ allowAdminRule: {2}waived: rule 0 is Default-scoped/
    )
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

describe('the limits of the pinned instance', () => {
  const reads = (k: number) =>
    Array.from({ length: k }, (_, i) => ({
      constraint: 'read',
      contract: contract(80 + i),
      fn: 'price',
      op: 'gte',
      to: { i128: '1' },
    }))

  it('synthesize_policy holds a rule to them: eight reads fit reads 8, nine do not', async () => {
    const some = (k: number) => ({
      intent: { calls: [{ contract: TOKEN, fn: 'pay', where: reads(k) }] },
    })
    // The default limits allow four: five distinct reads would be refused without the instance's.
    const ok = await call('synthesize_policy', some(8))
    expect(ok.ok).toBe(true)
    expect(ok.data.rules).toHaveLength(1)
    await failing(
      'synthesize_policy',
      some(9),
      'MALFORMED_PREDICATE',
      /9 distinct reads, at most 8/
    )
  })

  it('simulate_policy holds a predicate to them when it checks calls', async () => {
    const five = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ...reads(5).map((r) => ['gte', ['read', r.contract, r.fn, []], r.to]),
      ],
    ]
    const r = await call('simulate_policy', { expr: five, xdr: transferXdr() })
    expect(r.ok).toBe(true)
  })

  it('an explain-only simulate is held to them too (not to the defaults, not to the ceilings)', async () => {
    const five = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ...reads(5).map((r) => ['gte', ['read', r.contract, r.fn, []], r.to]),
      ],
    ]
    const ok = await call('simulate_policy', { expr: five })
    expect(ok.ok).toBe(true)
    expect(ok.data.heldTo).toBe(
      'the limits of CDER6P73JWMIVD3X6TGGOQIDAH3DLU7OKRTLT4ULPTZ3QJJ3QUGTK7CM'
    )
    // 30,000 bytes: inside the ceiling (40 KiB), over what the pinned instance was deployed with (24 KiB)
    const blob = ['eq', ['call_arg', 0], { bytes: 'ab'.repeat(30_000) }]
    await failing('simulate_policy', { expr: blob }, 'MALFORMED_PREDICATE', /over 24576 bytes/)
  })
})

describe('get_interpreter_info', () => {
  it('the pin, and the limits the instance says it was deployed with', async () => {
    const r = await call('get_interpreter_info', {})
    expect(r.data).toMatchObject({
      network: 'testnet',
      pinned: true,
      grammarVersion: 7,
      address: 'CDER6P73JWMIVD3X6TGGOQIDAH3DLU7OKRTLT4ULPTZ3QJJ3QUGTK7CM',
      // read from limits() on the instance (deployments/interpreter-testnet.json records the same)
      limits: {
        max_reads: 8,
        max_leaves: 400,
        max_predicate_bytes: 24576,
        max_elems: 32,
        max_in_operands: 32,
        max_depth: 5,
      },
      ceilings: {
        max_reads: 8,
        max_leaves: 400,
        max_predicate_bytes: 40960,
        max_elems: 64,
        max_in_operands: 64,
        max_depth: 8,
      },
    })
    expect(r.data.wasmSha256).toBe(
      '6704996f626904a4e33b95bda17b73963fc9cf502ffdfdbe9d85b4b10288e0d4'
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
      limits: r.data.limits,
    })
  })
  it('readRules reads every rule, with the stored predicate of the ones this interpreter polices', async () => {
    const r = await readRules(connect({ network: 'testnet' }), 'testnet', ACCOUNT, PIN)
    expect(r.rules.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(r.complete).toBe(true)
    expect(r.rules[0]?.expr).toBeUndefined()
    expect(r.rules[5]?.expr).toBeUndefined()
    expect(JSON.stringify(r.rules[6]?.expr)).toContain('"transfer"')
    // Rule 7 follows rule 6: its predicate is rule 6's, read through it.
    expect(r.rules[7]?.expr).toEqual(r.rules[6]?.expr)
    expect(r.rules[7]?.follows).toMatchObject({ account: ACCOUNT, ruleId: 6, nonce: 1 })
  })
  it('readRules lists every rule of an account that has removed many (PayFi settlement: 15 or more live, past 21 removed ids)', async () => {
    const r = await readRules(connect({ network: 'testnet' }), 'testnet', SETTLEMENT, PIN)
    const ids: number[] = r.rules.map((x) => x.id)
    expect(r.complete).toBe(true)
    expect(ids.length).toBeGreaterThanOrEqual(15)
    expect(ids).toEqual([...ids].sort((x, y) => x - y))
    // The rules past the removed run (ids 1..21 on the recording) are read, not only rule 0.
    expect(ids.filter((id) => id > 21).length).toBeGreaterThanOrEqual(14)
  })
  it('mainnet has no pin yet, and says so rather than guess', async () => {
    await failing(
      'get_interpreter_info',
      { network: 'mainnet' },
      'INTERPRETER_MISMATCH',
      /no interpreter is pinned/
    )
  })
})

describe('explain: a rule read off an account is described under its own scope', () => {
  it("a predicate that pins no contract is headed by the rule's scope; one with no stored predicate is skipped by the caller", async () => {
    const pinless = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '5' }],
      ],
    ] as never
    const shown = explain({ network: 'testnet' }, { expr: pinless, contract: TOKEN })
    expect(shown.reviewTree[0]).toMatchObject({ op: 'contract', raw: null, value: TOKEN })
    const bare = explain({ network: 'testnet' }, { expr: pinless })
    expect(bare.reviewTree[0]?.op).toBe('function')
  })
})
