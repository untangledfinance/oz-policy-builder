// Names from the real network: a Stellar Asset Contract (testnet's native asset) and a real
// wasm contract's own `contractspecv0` (this package's interpreter). Replays a live testnet run;
// OPB_LIVE=1 bun test src/names.test.ts records it again.

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { account } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { run } from './tools.ts'

setDefaultTimeout(30_000)
const net = recorded('spec')
afterAll(() => net.stop())

const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const INTERPRETER = 'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV'
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
// biome-ignore lint/suspicious/noExplicitAny: a tool's data is untyped JSON
const call = async (name: string, input: object): Promise<any> => {
  const r = (await run(name, { network: 'testnet', ...input })) as { ok: boolean; data?: unknown }
  expect(r.ok).toBe(true)
  return r.data
}

describe('names from the network', () => {
  it('a Stellar Asset Contract transfer: the SEP-41 names, and the amount in the asset', async () => {
    const data = await call('synthesize_policy', {
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
    const data = await call('simulate_policy', { expr })
    expect(data.review).toEqual([
      `interpreter  ${short(INTERPRETER)}`,
      '└─ install(install_params, context_rule, smart_account)',
      '   ├─ install_params › grammar_version:  must be  7',
      '   ├─ install_params › install_nonce:  must be at most  3',
      `   ├─ smart_account:  must be  ${short(account(1))}`,
      '   └─ context_rule › id:  must be  4',
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
    expect((await call('simulate_policy', { expr })).review.at(-1)).toBe(
      '   └─ argument 0:  must be  1'
    )
    const field = [
      'and',
      [...expr[1].slice(0, 1), ['eq', ['call_fn'], 'install'], ['eq', ['call_path', 0, 'nope'], 1]],
    ]
    expect((await call('simulate_policy', { expr: field })).review.at(-1)).toBe(
      '   └─ argument 0 > nope:  must be  1'
    )
  })
})
