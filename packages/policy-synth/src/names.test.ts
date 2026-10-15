// Names from the real network: a Stellar Asset Contract (testnet's native asset) and a real
// wasm contract's own `contractspecv0` (this package's interpreter). Replays a live testnet run;
// OPB_LIVE=1 bun test src/names.test.ts records it again.

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { account } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { explain, run } from './tools.ts'

setDefaultTimeout(30_000)
const net = recorded('spec')
afterAll(() => net.stop())

const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const INTERPRETER = 'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV'
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`
// biome-ignore lint/suspicious/noExplicitAny: a tool's data is untyped JSON
const ask = async (name: string, input: object): Promise<any> => {
  const r = (await run(name, { network: 'testnet', ...input })) as { ok: boolean; data?: unknown }
  expect(r.ok).toBe(true)
  return r.data
}

describe('names from the network', () => {
  it('a Stellar Asset Contract transfer: the SEP-41 names, and the amount in the asset', async () => {
    const data = await ask('synthesize_policy', {
      intent: {
        calls: [
          {
            contract: XLM,
            fn: 'transfer',
            where: [
              { constraint: 'pin', at: [0], to: account(1) },
              { constraint: 'deny', at: [1], nin: [account(2)] },
              { constraint: 'cap', at: [2], max: '50000000000' },
            ],
          },
        ],
      },
    })
    expect(data.rules[0].review).toEqual([
      `${short(XLM)}  (token)`,
      '└─ transfer(from, to, amount)',
      `   ├─ from:  must be  ${short(account(1))}`,
      `   ├─ to:  must not be one of  [${short(account(2))}]`,
      '   └─ amount:  must be at most  5,000 native (50000000000)',
    ])
    // The raw wire leaf is what the node stands for, whatever it is called.
    const [amount] = data.rules[0].reviewTree[0].children[0].children.slice(-1)
    expect(amount).toMatchObject({ label: 'amount', index: 'argument 2' })
    expect(amount.raw).toEqual(['lte', ['call_arg', 2], { i128: '50000000000' }])
  })

  it('an issued asset is named CODE:ISSUER, so another issuer of the same code reads differently', async () => {
    // Blend's testnet USDC: a Stellar Asset Contract issued by GATALTGT…V56, not by Circle.
    const USDC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
    const expr = [
      'and',
      [
        ['eq', ['call_contract'], USDC],
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '50000000000' }],
      ],
    ]
    const data = await ask('simulate_policy', { expr })
    expect(data.review.at(-1)).toMatch(
      /^ {3}└─ amount: {2}must be at most {2}5,000 USDC:GATALTGT\w{48} \(50000000000\)$/
    )
    expect(data.review[0]).toBe(`${short(USDC)}  (token)`)
  })

  it('a wasm contract: its own spec names the arguments and walks into a struct', async () => {
    const expr = [
      'and',
      [
        ['eq', ['call_contract'], INTERPRETER],
        ['eq', ['call_fn'], 'install'],
        ['eq', ['call_path', 0, 'grammar_version'], 7],
        ['lte', ['call_path', 0, 'install_nonce'], 3],
        ['eq', ['call_arg', 2], account(1)],
        ['eq', ['call_path', 1, 'id'], 4],
      ],
    ]
    const data = await ask('simulate_policy', { expr })
    expect(data.review).toEqual([
      `interpreter  ${short(INTERPRETER)}`,
      '└─ install(install_params, context_rule, smart_account)',
      '   ├─ install_params › grammar_version:  must be  7',
      '   ├─ install_params › install_nonce:  must be at most  3',
      `   ├─ smart_account:  must be  ${short(account(1))}`,
      '   └─ context_rule › id:  must be  4',
    ])
  })

  it('a rule scoped to a contract by its context rule is named by that contract, though its predicate never says so', async () => {
    const expr = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '10000000' }],
      ],
    ]
    const [shown] = await explain({ network: 'testnet' }, [{ expr: expr as never, contract: XLM }])
    expect(shown?.review).toEqual([
      `${short(XLM)}  (token)`,
      '└─ transfer(from, to, amount)',
      '   └─ amount:  must be at most  1 native (10000000)',
    ])
    expect(shown?.reviewTree[0]).toMatchObject({ op: 'contract', raw: null, value: XLM })
  })

  it('a review that cannot be made is said so and never fails the tool', async () => {
    const [shown] = await explain({ network: 'testnet' }, [
      { expr: ['eq', ['call_arg', 0], undefined] as never },
    ])
    expect(shown).toEqual({ review: ['(this predicate could not be described)'], reviewTree: [] })
  })

  it('an abort of the request leaves the plain wording: the names are not worth waiting for', async () => {
    const expr = [
      'and',
      [
        ['eq', ['call_contract'], XLM],
        ['eq', ['call_fn'], 'transfer'],
        ['eq', ['call_arg', 0], account(1)],
      ],
    ]
    const gone = AbortSignal.abort()
    const r = (await run('simulate_policy', { network: 'testnet', expr }, gone)) as {
      ok: boolean
      data: { review: string[] }
    }
    expect(r.ok).toBe(true)
    expect(r.data.review).toEqual([
      short(XLM),
      '└─ transfer',
      `   └─ argument 0:  must be  ${short(account(1))}`,
    ])
  })

  it('a function the contract does not have, and a field a struct does not have, are not named', async () => {
    const expr = [
      'and',
      [
        ['eq', ['call_contract'], INTERPRETER],
        ['eq', ['call_fn'], 'nope'],
        ['eq', ['call_arg', 0], 1],
      ],
    ]
    expect((await ask('simulate_policy', { expr })).review.at(-1)).toBe(
      '   └─ argument 0:  must be  1'
    )
    const field = [
      'and',
      [...expr[1].slice(0, 1), ['eq', ['call_fn'], 'install'], ['eq', ['call_path', 0, 'nope'], 1]],
    ]
    expect((await ask('simulate_policy', { expr: field })).review.at(-1)).toBe(
      '   └─ argument 0 › nope:  must be  1'
    )
  })
})

// What a person reads must be what the interpreter does. These are the rules the audit showed
// the old text misstating, each run through the real `check` and read back.
describe('what the text says is what the interpreter does (live)', () => {
  const G1 = account(3)
  const G2 = account(1)
  const FAKE = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
  const pin = (...rest: unknown[]) => ['and', [['eq', ['call_contract'], XLM], ...rest]]
  const transfer = (amount: string, to = G2) => ({
    contract: XLM,
    fn: 'transfer',
    args: [G1, to, { i128: amount }],
  })
  const cases: [string, unknown, unknown, boolean, string][] = [
    [
      "eq('call_fn','call_fn') pins no function: approve passes",
      pin(['eq', 'call_fn', 'call_fn'], ['lte', ['call_arg', 2], { i128: '100' }]),
      { contract: XLM, fn: 'approve', args: [G1, G2, { i128: '50' }, 100] },
      true,
      "├─ 'call_fn':  must be  'call_fn'",
    ],
    [
      "eq('call_contract', C) is a constant, so nothing passes",
      [
        'and',
        [
          ['eq', 'call_contract', XLM],
          ['eq', ['call_fn'], 'transfer'],
        ],
      ],
      transfer('50'),
      false,
      "'call_contract':  must be  ",
    ],
    [
      "nin('to', [G]) is no denylist on `to`: a transfer to G passes",
      pin(['eq', ['call_fn'], 'transfer'], ['nin', 'to', [G2]]),
      transfer('50'),
      true,
      "'to':  must not be one of",
    ],
    [
      "ne(amount, '0') is a symbol: amount 0 passes",
      pin(['eq', ['call_fn'], 'transfer'], ['ne', ['call_arg', 2], '0']),
      transfer('0'),
      true,
      "amount:  must not be  '0'",
    ],
    [
      'ne(amount, u256 0): amount 0 passes',
      pin(['eq', ['call_fn'], 'transfer'], ['ne', ['call_arg', 2], { u256: '0' }]),
      transfer('0'),
      true,
      'amount:  must not be  0 (u256)',
    ],
    [
      'a bare u32 step into a map does not resolve',
      [
        'and',
        [
          ['eq', ['call_fn'], 'f'],
          ['lte', ['call_path', 0, 5], { i128: '2' }],
        ],
      ],
      { contract: FAKE, fn: 'f', args: [{ map: [[5, { i128: '1' }]] }] },
      false,
      'argument 0 › [5]:  must be at most  2',
    ],
    [
      'a lit u32 step into the same map does',
      [
        'and',
        [
          ['eq', ['call_fn'], 'f'],
          ['lte', ['call_path', 0, ['lit', 5]], { i128: '2' }],
        ],
      ],
      { contract: FAKE, fn: 'f', args: [{ map: [[5, { i128: '1' }]] }] },
      true,
      'argument 0 › 5 (u32):  must be at most  2',
    ],
  ]
  for (const [name, expr, call, permitted, line] of cases)
    it(name, async () => {
      const data = await ask('simulate_policy', { expr, calls: [call] })
      expect(data.results[0].permitted).toBe(permitted)
      expect(data.review.join('\n')).toContain(line)
    })
})
