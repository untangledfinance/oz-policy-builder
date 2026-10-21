// What a person reads must be what the interpreter does. These are the rules the audit showed
// the old text misstating, each run through the real `check` and read back. Replays a live
// testnet run; OPB_LIVE=1 bun test src/verdict.test.ts records it again.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { account } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { forgetLimits } from './chain.ts'
import { run } from './tools.ts'

setDefaultTimeout(30_000)
const net = recorded('verdict')
// The interpreter's limits are cached for the whole process. Forget them, so this file reads
// them through its own recording whether it runs alone or after a file that read them first.
beforeAll(forgetLimits)
afterAll(() => net.stop())

const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const FAKE = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
const [G1, G2] = [account(3), account(1)]
const pin = (...rest: unknown[]) => ['and', [['eq', ['call_contract'], XLM], ...rest]]
const transfer = (amount: string, to = G2) => ({
  contract: XLM,
  fn: 'transfer',
  args: [G1, to, { i128: amount }],
})

describe('what the text says is what the interpreter does (live)', () => {
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
      "argument 2:  must not be  '0'",
    ],
    [
      'ne(amount, u256 0): amount 0 passes',
      pin(['eq', ['call_fn'], 'transfer'], ['ne', ['call_arg', 2], { u256: '0' }]),
      transfer('0'),
      true,
      'argument 2:  must not be  0 (u256)',
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
      const r = (await run('simulate_policy', { network: 'testnet', expr, calls: [call] })) as {
        ok: boolean
        data: { results: { permitted: boolean }[]; review: string[] }
      }
      expect(r.ok).toBe(true)
      expect(r.data.results[0]?.permitted).toBe(permitted)
      expect(r.data.review.join('\n')).toContain(line)
    })
})
