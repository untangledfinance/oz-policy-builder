import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { branches, denyCases } from './check.ts'
import type { Call } from './record.ts'
import type { Expr, Val } from './wire.ts'

const A = account(1)
const B = account(2)
const X = account(3)
const C = contract(1)

const permit: Call = {
  contract: C,
  fn: 'transfer',
  args: [
    A,
    B,
    { i128: '100' },
    [
      {
        map: [
          ['amount', { i128: '4' }],
          ['to', A],
        ],
      },
      {
        map: [
          ['amount', { i128: '6' }],
          ['to', B],
        ],
      },
    ],
    7,
  ],
}
const broken = (c: Expr): Call | undefined => denyCases([c], permit)[0]?.call
const arg = (n: number) => permit.args[n] as Val

describe('a deny case is derived from the leaf, not typed in', () => {
  it('breaks the contract and the function', () => {
    expect(broken(['eq', ['call_contract'], C])?.contract).not.toBe(C)
    expect(broken(['eq', ['call_fn'], 'transfer'])?.fn).not.toBe('transfer')
    expect(broken(['ne', ['call_fn'], 'burn'])?.fn).toBe('burn')
  })

  it('moves a number just across its bound, keeping its type', () => {
    expect(broken(['lte', ['call_arg', 2], { i128: '1000' }])?.args[2]).toEqual({ i128: '1001' })
    expect(broken(['lt', ['call_arg', 2], { i128: '100' }])?.args[2]).toEqual({ i128: '100' })
    expect(broken(['gte', ['call_arg', 2], { i128: '1' }])?.args[2]).toEqual({ i128: '0' })
    expect(broken(['gt', ['call_arg', 2], { i128: '100' }])?.args[2]).toEqual({ i128: '100' })
    expect(broken(['eq', ['call_arg', 4], 7])?.args[4]).toBe(8)
    expect(broken(['lte', ['call_arg', 4], 7])?.args[4]).toBe(8)
  })

  it('changes an address to another of its kind', () => {
    const arg0 = broken(['eq', ['call_arg', 0], A])?.args[0] as string
    expect(arg0).not.toBe(A)
    expect(arg0[0]).toBe('G')
    expect(arg0).toHaveLength(56)
  })

  it('leaves a set: out of an allowlist, into a denylist', () => {
    const out = broken(['in', ['call_arg', 1], [B, A]])?.args[1]
    expect([B, A]).not.toContain(out)
    expect(broken(['nin', ['call_arg', 1], [X]])?.args[1]).toBe(X)
    expect(broken(['in', ['call_arg', 4], [7, 8]])?.args[4]).not.toBe(7)
  })

  it('grows a vec past its length bound by repeating the last element', () => {
    const v = broken(['lte', ['call_path', 3, true], 2])?.args[3] as Val[]
    expect(v).toHaveLength(3)
    expect(v[2]).toEqual(v[1])
  })

  it('breaks the first element of an all, and empties the vec of an any', () => {
    const all: Expr = [
      'all',
      ['call_arg', 3],
      [
        'and',
        [
          ['in', ['elem', 'to'], [A, B]],
          ['lte', ['elem', 'amount'], { i128: '10' }],
        ],
      ],
    ]
    const items = (broken(all)?.args[3] ?? []) as { map: [string, Val][] }[]
    expect(items[0]?.map.find(([k]) => k === 'to')?.[1]).not.toBe(A)
    expect(broken(['any', ['call_arg', 3], ['eq', ['elem', 'to'], A]])?.args[3]).toEqual([])
  })

  it('pushes a total over its cap through the first element', () => {
    const c = broken(['lte', ['sum', ['call_arg', 3], 'amount'], { i128: '10' }])
    const items = (c?.args[3] ?? []) as { map: [string, Val][] }[]
    const amounts = items.map((m) => Number((m.map[0] as [string, { i128: string }])[1].i128))
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(11)
  })

  it('turns a scaled floor against the call it is a floor of', () => {
    const floor: Expr = [
      'gte',
      ['call_arg', 2],
      ['scaled', ['call_arg', 2], { i128: '99' }, { i128: '100' }, { i128: '0' }],
    ]
    expect(broken(floor)?.args[2]).toEqual({ i128: '98' }) // 100 * 99 / 100 = 99; one below is 98
  })

  it('derives nothing from the clock or a read: those are not the call', () => {
    expect(broken(['lte', ['now'], { u64: '5' }])).toBeUndefined()
    expect(broken(['gte', ['read', C, 'f', [], 'p'], 1])).toBeUndefined()
    expect(broken(['eq', ['call_arg', 9], 1])).toBeUndefined() // an argument the call does not carry
  })

  it('an or has one branch per child; an and its conjuncts, in order', () => {
    const a: Expr = ['eq', ['call_fn'], 'a']
    const b: Expr = ['eq', ['call_arg', 0], A]
    expect(branches(['and', [a, b]])).toEqual([[a, b]])
    expect(branches(['or', [['and', [a, b]], a]])).toEqual([[a, b], [a]])
    expect(branches(a)).toEqual([[a]])
    expect(arg(0)).toBe(A)
  })
})

// ---- through the contract: replayed from a live run on the testnet interpreter ----
// OPB_LIVE=1 bun test src/check.test.ts   (re-records against the network)

import { afterAll } from 'bun:test'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { runChecks, verifyRule } from './check.ts'
import { encode } from './wire.ts'

const net = recorded('check')
afterAll(() => net.stop())
const server = connect(net.endpoint)
const interpreter = interpreterFor('testnet')

const rule: Expr = [
  'and',
  [
    ['eq', ['call_contract'], C],
    ['eq', ['call_fn'], 'transfer'],
    ['eq', ['call_arg', 0], A],
    ['eq', ['call_arg', 1], B],
    ['lte', ['call_arg', 2], { i128: '1000' }],
  ],
]
const pay: Call = { contract: C, fn: 'transfer', args: [A, B, { i128: '500' }] }

describe('check, on the live interpreter', () => {
  const ask = (e: Expr, ...calls: Call[]) =>
    runChecks(server, 'testnet', interpreter, encode(e), calls)

  it('permits what the rule describes and names why it denies the rest', async () => {
    const over = { ...pay, args: [A, B, { i128: '1001' }] }
    const wrongFn = { ...pay, fn: 'burn' }
    const elsewhere = { ...pay, contract: contract(9) }
    const [ok, no, fn, scope] = await ask(rule, pay, over, wrongFn, elsewhere)
    expect(ok).toEqual({ permitted: true, code: 0, reason: 'PERMIT' })
    expect(no).toEqual({ permitted: false, code: 100, reason: 'ARG_MISMATCH' })
    expect(fn?.code).toBe(100)
    expect(scope).toEqual({ permitted: false, code: 101, reason: 'CONTRACT_SCOPE' })
  })

  it('reports an allowlist miss as 105 and refuses a rule the contract will not decode', async () => {
    const [listed, bad, noSelector] = await Promise.all([
      ask(['in', ['call_arg', 1], [A, X]], pay),
      ask(['bogus'], pay),
      ask(['lt', ['now'], { u64: '5' }], pay),
    ])
    expect(listed[0]?.code).toBe(105)
    expect(bad[0]).toEqual({ permitted: false, code: 201, reason: 'MALFORMED_PREDICATE' })
    expect(noSelector[0]?.reason).toBe('SELECTOR_LEAF_REQUIRED')
  })

  it('refuses more calls than one request may make, before any is sent', async () => {
    await expect(ask(rule, ...Array.from({ length: 65 }, () => pay))).rejects.toThrow(/at most 64/)
  })
})

describe('verify, on the live interpreter', () => {
  const check = (e: Expr, call = pay) => verifyRule(server, 'testnet', interpreter, e, encode, call)

  it('a tight rule: the permit passes, every leaf turned against the call is refused, each conjunct is needed', async () => {
    const v = await check(rule)
    expect(v.permit.permitted).toBe(true)
    expect(v.cases).toHaveLength(5)
    expect(v.cases.every((c) => c.denied)).toBe(true)
    expect(v.minimal).toBe(true)
    expect(v.ok).toBe(true)
    expect(v.checks).toBe(1 + 5 + 5)
  })

  it('a rule that does not permit its own call is not ok', async () => {
    const strict = await check([
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '10' }],
      ],
    ])
    expect(strict.permit).toMatchObject({ permitted: false, code: 100 })
    expect(strict.ok).toBe(false)
  })

  it('a branch that lets a broken call through makes the rule too loose', async () => {
    const loose: Expr = [
      'or',
      [
        [
          'and',
          [
            ['eq', ['call_fn'], 'transfer'],
            ['lte', ['call_arg', 2], { i128: '1000' }],
          ],
        ],
        ['eq', ['call_arg', 0], A],
      ],
    ]
    const v = await check(loose)
    expect(v.cases.some((c) => !c.denied)).toBe(true)
    expect(v.ok).toBe(false)
  })

  it('a duplicated conjunct is not needed: dropping it changes nothing', async () => {
    const twice: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '1000' }],
        ['lte', ['call_arg', 2], { i128: '1000' }],
      ],
    ]
    const v = await check(twice)
    expect(v.minimal).toBe(false)
    expect(v.redundant).toHaveLength(2)
    expect(v.ok).toBe(true)
  })

  it('a rule nothing can be derived from verifies nothing', async () => {
    const v = await check([
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['now'], { u64: '9999999999' }],
      ],
    ])
    expect(v.cases.length).toBe(1)
    const none = await check(['lte', ['now'], { u64: '9999999999' }])
    expect(none.permit.code).toBe(216)
    expect(none.ok).toBe(false)
  })
})
