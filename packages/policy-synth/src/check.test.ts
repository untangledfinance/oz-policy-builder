import { describe, expect, it } from 'bun:test'
import { StrKey } from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import { denyCases } from './check.ts'
import { callExpr } from './intent.ts'
import type { Call } from './record.ts'
import { branches, type Expr, type Val } from './wire.ts'

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

  it('names every deny the interpreter returns: overflow, an ordering over the function, an oversized rule', async () => {
    const fn: Expr = ['eq', ['call_fn'], 'transfer']
    const overflow: Expr = [
      'and',
      [
        fn,
        [
          'gte',
          [
            'scaled',
            ['call_arg', 2],
            { i128: (2n ** 126n).toString() },
            { i128: '1' },
            { i128: '0' },
          ],
          { i128: '0' },
        ],
      ],
    ]
    const unsupported: Expr = ['and', [fn, ['lt', ['call_fn'], ['call_arg', 0]]]]
    const [[o], [u]] = await Promise.all([ask(overflow, pay), ask(unsupported, pay)])
    expect(o).toEqual({ permitted: false, code: 102, reason: 'ARITHMETIC_OVERFLOW' })
    expect(u).toEqual({ permitted: false, code: 103, reason: 'UNSUPPORTED_NODE' })
    const big: Expr = ['eq', ['call_arg', 0], ['lit', { bytes: '00'.repeat(49 * 1024) }]]
    expect((await ask(big, pay))[0]).toEqual({
      permitted: false,
      code: 207,
      reason: 'PREDICATE_TOO_LARGE',
    })
    const [listed] = await ask(['in', ['call_arg', 1], [A, X]], pay)
    expect(listed).toEqual({ permitted: false, code: 105, reason: 'NOT_IN_ALLOWLIST' })
  })

  it('takes exactly the most calls a request may make, and no more', async () => {
    const all = await ask(rule, ...Array.from({ length: 64 }, () => pay))
    expect(all).toHaveLength(64)
    expect(all.every((v) => v.permitted)).toBe(true)
  })

  it('refuses more calls than one request may make, before any is sent', async () => {
    await expect(ask(rule, ...Array.from({ length: 65 }, () => pay))).rejects.toThrow(/at most 64/)
  })
})

describe('verify, on the live interpreter', () => {
  const check = (e: Expr, ...calls: Call[]) =>
    verifyRule(server, 'testnet', interpreter, e, calls.length > 0 ? calls : [pay])

  it('a tight rule: the permit passes, every leaf turned against the call is refused, each conjunct is needed', async () => {
    const v = await check(rule)
    expect(v.permit.permitted).toBe(true)
    expect(v.cases).toHaveLength(5)
    expect(v.cases.every((c) => c.denied)).toBe(true)
    expect(v.minimal).toBe(true)
    expect(v.ok).toBe(true)
    expect(v.complete).toBe(true) // nothing is left untested
    expect(v.untested).toEqual([])
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
    expect(strict.complete).toBe(false)
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

  it('only the branches the permitted call takes are turned against it', async () => {
    const other: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'burn'],
        ['lte', ['call_arg', 2], { i128: '5' }],
      ],
    ]
    const mine: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '1000' }],
      ],
    ]
    const v = await check(['or', [other, mine]])
    expect(v.cases).toHaveLength(2)
    expect(v.cases.map((c) => c.label).join(' ')).toContain('transfer')
    expect(v.cases.map((c) => c.label).join(' ')).not.toContain('burn')
    // One call for the whole rule, one for the branch it can take (the other pins `burn`), two per case.
    expect(v.checks).toBe(2 + 2 * 2)
    expect(v.unexamined).toHaveLength(1)
    expect(v.ok).toBe(false)
    // With a call for the other branch too, both are turned against theirs.
    const burn: Call = { contract: C, fn: 'burn', args: [A, B, { i128: '3' }] }
    const both = await check(['or', [other, mine]], pay, burn)
    expect(both.cases).toHaveLength(4)
    expect(both.ok).toBe(true)
  })

  it('a rule permitted by something that is not the call has nothing to verify against: not ok', async () => {
    const v = await check([
      'or',
      [
        ['lte', ['now'], { u64: '99999999999' }],
        ['eq', ['call_fn'], 'x'],
      ],
    ])
    expect(v.permit.permitted).toBe(true)
    expect(v.cases).toEqual([])
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
    // Listed once: only one of two copies can go.
    expect(v.redundant).toEqual(['["lte",["call_arg",2],{"i128":"1000"}]'])
    expect(v.ok).toBe(true)
  })

  it('a spend cap is not called redundant because another conjunct denies its case too (swap: cap 5000 + minOut 99%)', async () => {
    const amt = (n: string): Val => ({ i128: n })
    const swap = callExpr({
      contract: C,
      fn: 'swap',
      where: [
        { constraint: 'cap', at: [0], max: '5000' },
        { constraint: 'minOut', at: [1], of: [0], num: '99', den: '100' },
        { constraint: 'pin', at: [2], to: A },
      ],
    })
    const v = await check(swap, { contract: C, fn: 'swap', args: [amt('1000'), amt('990'), A] })
    expect(v.ok).toBe(true)
    // The cap's case (5001) also fails the 99% floor, so whether the cap is needed cannot be told
    // from it: not redundant, and not complete. Dropping it really would permit 10^9 for 990000000.
    expect(v.redundant).toEqual([])
    expect(v.untested.some((u) => u.includes('"lte","call_arg"') || u.includes('5000'))).toBe(true)
    expect(v.complete).toBe(false)
  })

  it('a rule with no case to derive is not ok, even though its one call is permitted', async () => {
    const v = await check(['eq', ['lit', 5], ['call_arg', 0]], { contract: C, fn: 'f', args: [5] })
    expect(v.permit.permitted).toBe(true)
    expect(v.cases).toEqual([])
    expect(v.ok).toBe(false)
  })

  it("every deny case carries the interpreter's own verdict, in the order the conjuncts are written", async () => {
    const v = await check(rule)
    expect(v.cases.map((c) => c.verdict.code)).toEqual([101, 100, 100, 100, 100])
    expect(v.cases.map((c) => c.verdict.reason)).toEqual([
      'CONTRACT_SCOPE',
      'ARG_MISMATCH',
      'ARG_MISMATCH',
      'ARG_MISMATCH',
      'ARG_MISMATCH',
    ])
  })

  it('one conjunct is enough to verify, and one case let through is enough to fail', async () => {
    const lone = await check(['eq', ['call_fn'], 'transfer'])
    expect(lone.cases).toHaveLength(1)
    expect(lone.ok).toBe(true)
    const either: Expr = [
      'or',
      [
        [
          'and',
          [
            ['eq', ['call_fn'], 'transfer'],
            ['lte', ['call_arg', 2], { i128: '1000' }],
          ],
        ],
        [
          'and',
          [
            ['eq', ['call_fn'], 'transfer'],
            ['eq', ['call_arg', 1], B],
          ],
        ],
      ],
    ]
    const mixed = await check(either)
    expect(mixed.cases.map((c) => c.denied).sort()).toEqual([false, false, true, true])
    expect(mixed.ok).toBe(false)
  })

  it('at most 24 deny cases, however many conjuncts the rule has', async () => {
    const args = Array.from({ length: 30 }, () => ({ i128: '1' }) as Val)
    const wide: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ...args.map((_, i): Expr => ['lte', ['call_arg', i], { i128: '100' }]),
      ],
    ]
    const v = await check(wide, { contract: C, fn: 'transfer', args })
    expect(v.cases).toHaveLength(24)
    expect(v.checks).toBe(1 + 2 * 24)
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

describe('verify, what it does not know it says', () => {
  const check = (e: Expr, ...calls: Call[]) =>
    verifyRule(server, 'testnet', interpreter, e, calls.length > 0 ? calls : [pay])
  const fnIs = (f: string): Expr => ['eq', ['call_fn'], f]
  const amt = (n: string): Val => ({ i128: n })

  it('the only conjunct of a rule is needed, not redundant (dropping it leaves a rule the contract refuses)', async () => {
    const v = await check(fnIs('transfer'))
    expect(v.redundant).toEqual([])
    expect(v.minimal).toBe(true)
    expect(v.ok).toBe(true)
  })

  it('a conjunct whose drop makes the rule invalid, or that shares its argument with another, is never called redundant', async () => {
    // Dropping the pin leaves a rule with no leaf over the call: refused (216), so the pin is needed.
    const pinned = await check([
      'and',
      [
        ['eq', ['call_arg', 1], B],
        ['lte', ['now'], { u64: '9999999999' }],
      ],
    ])
    expect(pinned.redundant).toEqual([])
    expect(pinned.untested).toHaveLength(1) // the clock has no case
    expect(pinned.ok).toBe(true) // what was tried held,
    expect(pinned.complete).toBe(false) // but not everything was tried
    // `eq` and `in` on one argument: the case that breaks one breaks the other, so neither can be judged.
    const both = await check([
      'and',
      [
        fnIs('transfer'),
        ['eq', ['call_arg', 2], amt('500')],
        ['in', ['call_arg', 2], [amt('500'), amt('700')]],
      ],
    ])
    expect(both.redundant).toEqual([])
    expect(both.untested).toHaveLength(2)
    expect(both.minimal).toBe(true)
  })

  it('a branch of one conjunct is needed too, and a branch no call took is said, and is not ok', async () => {
    const v = await check(['or', [fnIs('transfer'), fnIs('burn')]])
    expect(v.redundant).toEqual([])
    expect(v.minimal).toBe(true)
    expect(v.unexamined).toEqual(['["eq",["call_fn"],"burn"]'])
    expect(v.ok).toBe(false)
  })

  it('every branch must be exercised: a widening branch the permit does not take used to pass', async () => {
    const wide: Expr = [
      'or',
      [
        [
          'and',
          [fnIs('transfer'), ['eq', ['call_arg', 0], A], ['lte', ['call_arg', 2], amt('1000')]],
        ],
        fnIs('approve'),
      ],
    ]
    const only = await check(wide)
    expect(only.ok).toBe(false)
    expect(only.unexamined).toHaveLength(1)
    // With a call for each branch, each is turned against its own call.
    const approve: Call = { contract: C, fn: 'approve', args: [A, B, amt('5'), 100] }
    const both = await check(wide, pay, approve)
    expect(both.unexamined).toEqual([])
    expect(both.permits.map((p) => p.permitted)).toEqual([true, true])
    expect(both.ok).toBe(true)
  })

  it('a branch that pins another contract than the call is not asked about it', async () => {
    const elsewhere: Expr = ['and', [['eq', ['call_contract'], contract(9)], fnIs('transfer')]]
    const here: Expr = ['and', [['eq', ['call_contract'], C], fnIs('transfer')]]
    const v = await check(['or', [elsewhere, here]])
    // The whole rule, and the one branch that can take the call; two calls per case.
    expect(v.checks).toBe(2 + 2 * v.cases.length)
    expect(v.unexamined).toHaveLength(1)
  })

  it('every call given must be permitted: one that is not makes the rule not ok', async () => {
    const wrong: Call = { contract: C, fn: 'burn', args: [A, B, amt('5')] }
    const v = await check(fnIs('transfer'), pay, wrong)
    expect(v.permits.map((p) => p.permitted)).toEqual([true, false])
    expect(v.ok).toBe(false)
  })

  it('a branch that names several functions is a candidate for a call to any one of them', async () => {
    const either: Expr = ['or', [['in', ['call_fn'], ['transfer', 'burn']], fnIs('mint')]]
    const v = await check(either)
    expect(v.unexamined).toEqual(['["eq",["call_fn"],"mint"]'])
    expect(v.cases.length).toBeGreaterThan(0) // the `in` branch took the call, so it was tried
  })

  it('a nested or is not ok: it can permit what the intent never named, and no case can be derived from it', async () => {
    const nested: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        [
          'or',
          [
            [
              'and',
              [fnIs('transfer'), ['eq', ['call_arg', 0], A], ['lte', ['call_arg', 2], amt('1000')]],
            ],
            fnIs('approve'),
          ],
        ],
      ],
    ]
    const v = await check(nested)
    expect(v.permit.permitted).toBe(true)
    expect(v.untested.some((u) => u.includes('"or"'))).toBe(true)
    expect(v.ok).toBe(false)
    expect(v.complete).toBe(false)
    // An untested clock or read cannot widen a rule: the rest still counts.
    const clock = await check(['and', [fnIs('transfer'), ['lte', ['now'], { u64: '9999999999' }]]])
    expect(clock.ok).toBe(true)
    expect(clock.complete).toBe(false)
  })

  it('an or inside a quantifier body is not ok either: the case derived for the quantifier does not reach its wide branch', async () => {
    const body: Expr = [
      'and',
      [
        fnIs('pay'),
        [
          'any',
          ['call_arg', 0],
          [
            'or',
            [
              ['eq', ['elem'], 1],
              ['gte', ['elem'], 0],
            ],
          ],
        ],
      ],
    ]
    const v = await check(body, { contract: C, fn: 'pay', args: [[1]] })
    expect(v.permit.permitted).toBe(true)
    expect(v.ok).toBe(false)
    expect(v.complete).toBe(false)
  })

  it('one request makes at most 64 calls, an or of a hundred branches included', async () => {
    const hundred: Expr = [
      'or',
      Array.from({ length: 100 }, (_, i): Expr => ['eq', ['call_arg', 3], i]),
    ]
    const v = await check(hundred, { contract: C, fn: 'f', args: [A, B, amt('1'), 7] })
    expect(v.checks).toBeLessThanOrEqual(64)
    expect(v.unexamined.length).toBeGreaterThan(0)
    expect(v.ok).toBe(false)
  })

  it('a call that is not permitted ends the work: the cases cannot make it ok', async () => {
    const wide: Expr = [
      'and',
      [
        fnIs('transfer'),
        ...Array.from({ length: 20 }, (_, i): Expr => ['lte', ['call_arg', 2], amt(String(i + 1))]),
      ],
    ]
    const v = await check(wide)
    expect(v.permit.permitted).toBe(false)
    // Calls already on their way (one pool's width, twice over) are all that is spent: 20 conjuncts would be 41.
    expect(v.checks).toBeLessThanOrEqual(16)
    expect(v.ok).toBe(false)
  })
})

describe('deny cases, edge by edge', () => {
  const call = (args: Val[], more: Partial<Call> = {}): Call => ({
    contract: C,
    fn: 'pay',
    args,
    ...more,
  })
  const one = (c: Expr, p: Call) => denyCases([c], p)[0]?.call

  it('breaks a constant on the left of a comparison as well as on the right', () => {
    expect(one(['gte', { i128: '5' }, ['call_arg', 0]], call([{ i128: '3' }]))?.args[0]).toEqual({
      i128: '6',
    })
    expect(one(['eq', 7, ['call_arg', 0]], call([7]))?.args[0]).toBe(8)
  })

  it('takes the bound of a lit, and of a scaled with an addend', () => {
    expect(one(['eq', ['call_arg', 0], ['lit', ['a', 1]]], call([['a', 1]]))?.args[0]).toEqual([
      'a',
      1,
      1,
    ])
    const floor: Expr = [
      'gte',
      ['call_arg', 1],
      ['scaled', ['call_arg', 0], { i128: '2' }, { i128: '1' }, { i128: '10' }],
    ]
    expect(one(floor, call([{ i128: '5' }, { i128: '20' }]))?.args[1]).toEqual({ i128: '19' }) // 5 * 2 / 1 + 10 = 20; one below
  })

  it('moves a length through call_arg_len, and keeps the type of what it moves', () => {
    const grown = one(['lte', ['call_arg_len', 0], 2], call([[1, 2]]))?.args[0] as Val[]
    expect(grown).toEqual([1, 2, 2])
    expect(one(['lte', ['call_arg', 0], { i128: '4' }], call([{ u64: '1' }]))?.args[0]).toEqual({
      u64: '5',
    })
    expect(one(['lte', ['call_arg', 0], { i128: '4' }], call([{ i32: 1 }]))?.args[0]).toEqual({
      i32: 5,
    })
    expect(one(['eq', ['call_arg', 0], 5], call([5]))?.args[0]).toBe(6)
    expect(one(['lte', ['call_arg', 0], 4294967295], call([4294967295]))?.args[0]).toEqual({
      i128: '4294967296',
    })
    expect(one(['gte', ['call_arg', 0], 1], call([1]))?.args[0]).toBe(0)
    expect(one(['gte', ['call_arg', 0], 0], call([0]))?.args[0]).toEqual({ i128: '-1' })
  })

  it('moves a different value of every type', () => {
    const moved = (v: Val) => one(['eq', ['call_arg', 0], ['lit', v]], call([v]))?.args[0]
    expect(moved(true)).toBe(false)
    expect(moved({ bytes: 'ab' })).toEqual({ bytes: 'ab00' })
    expect(moved({ string: 'x' })).toEqual({ string: 'xx' })
    expect(moved([1, 2])).toEqual([1, 2, 2])
    expect(moved(['a'])).toEqual(['a', 'a'])
    expect(moved('short')).toBe('short_x')
    const addr = moved(A) as string
    expect(addr).not.toBe(A)
    expect(addr).toMatch(/^G[A-Z2-7]{55}$/)
    const ctr = moved(C) as string
    expect(ctr).toMatch(/^C[A-Z2-7]{55}$/)
    expect(ctr).not.toBe(C)
  })

  it('walks a set until it is out of it, however long the run of consecutive members', () => {
    const run = [7, 8, 9, 10, 11, 12]
    const out = one(['in', ['call_arg', 0], run], call([7]))?.args[0]
    expect(run).not.toContain(out)
    expect(one(['in', ['call_arg', 0], []], call([7]))).toBeUndefined()
    expect(one(['nin', ['call_arg', 0], [9, 3]], call([7]))?.args[0]).toBe(9)
  })

  it('every comparison against a total: below, at, above, either side', () => {
    const total = (op: string, n: string) =>
      one(
        [op, ['sum', ['call_arg', 0], 'amount'], { i128: n }],
        call([[{ map: [['amount', { i128: '4' }]] }, { map: [['amount', { i128: '6' }]] }]])
      )
    const sum = (c: Call | undefined) =>
      ((c?.args[0] ?? []) as { map: [string, { i128: string }][] }[]).reduce(
        (t, m) => t + Number(m.map[0]?.[1].i128),
        0
      )
    expect(sum(total('lte', '10'))).toBe(11)
    expect(sum(total('lt', '10'))).toBe(10)
    expect(sum(total('gte', '10'))).toBe(9)
    expect(sum(total('gt', '10'))).toBe(10)
    expect(total('eq', '10')).toBeUndefined()
    expect(
      one(['lte', ['sum', ['call_arg', 0], 'amount'], { i128: '1' }], call([[]]))
    ).toBeUndefined()
    expect(
      one(['lte', ['sum', ['call_arg', 5], 'amount'], { i128: '1' }], call([[]]))
    ).toBeUndefined()
  })

  it('a quantifier: the first element is the one broken; a non-and body is one leaf; an empty or missing vec has none', () => {
    const items: Val = [
      {
        map: [
          ['to', A],
          ['n', 1],
        ],
      },
      {
        map: [
          ['to', A],
          ['n', 1],
        ],
      },
    ]
    const first = (c: Call | undefined) =>
      (c?.args[0] as { map: [string, Val][] }[] | undefined)?.[0]?.map
    expect(
      first(one(['all', ['call_arg', 0], ['eq', ['elem', 'n'], 1]], call([items])))
    ).toContainEqual(['n', 2])
    expect(
      first(one(['all', ['call_arg', 0], ['and', [['eq', ['elem', 'n'], 1]]]], call([items])))
    ).toContainEqual(['n', 2])
    expect(first(one(['all', ['call_arg', 0], ['eq', 5, 5]], call([items])))).toBeUndefined()
    expect(one(['all', ['call_arg', 0], ['eq', ['elem', 'n'], 1]], call([[]]))).toBeUndefined()
    expect(one(['all', ['call_arg', 0], ['eq', ['elem', 'n'], 1]], call([5]))).toBeUndefined()
    expect(one(['all', ['call_arg', 9], ['eq', ['elem', 'n'], 1]], call([items]))).toBeUndefined()
    expect(one(['any', ['call_arg', 0], ['eq', ['elem', 'n'], 1]], call([[]]))).toBeUndefined()
    expect(one(['any', ['call_arg', 9], ['eq', ['elem', 'n'], 1]], call([items]))).toBeUndefined()
    // elem in the second operand is rewritten too
    const against = one(
      ['all', ['call_arg', 0], ['lte', ['elem', 'n'], ['elem', 'm']]],
      call([
        [
          {
            map: [
              ['m', 3],
              ['n', 3],
            ],
          },
        ],
      ])
    )
    expect(first(against)).toContainEqual(['n', 4])
  })

  it('keeps a u32 a u32 up to its maximum, and writes a number into another kind of value as an i128', () => {
    expect(one(['lte', ['call_arg', 0], 4294967294], call([4294967294]))?.args[0]).toBe(4294967295)
    expect(one(['lte', ['call_arg', 0], { i128: '4' }], call([{ string: 'x' }]))?.args[0]).toEqual({
      i128: '5',
    })
  })

  it('a path into something that is not there or not a container derives nothing', () => {
    expect(one(['eq', ['call_path', 0, 'x'], 1], call([5]))).toBeUndefined()
    expect(one(['eq', ['call_path', 0, 3], 1], call([{ map: [['a', 1]] }]))).toBeUndefined()
    expect(one(['eq', ['call_path', 0, 'x'], 1], call([[1]]))).toBeUndefined()
  })

  it('grows an empty vec with zeros, and breaks an empty one with a zero', () => {
    expect(one(['lte', ['call_path', 0, true], 0], call([[]]))?.args[0]).toEqual([0])
    expect(one(['eq', ['call_arg', 0], ['lit', []]], call([[]]))?.args[0]).toEqual([0])
  })

  it('another address of the same kind differs from the original in its first byte only', () => {
    const mixed = StrKey.encodeEd25519PublicKey(
      Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
    )
    const was = StrKey.decodeEd25519PublicKey(mixed)
    const now = StrKey.decodeEd25519PublicKey(
      one(['eq', ['call_arg', 0], mixed], call([mixed]))?.args[0] as string
    )
    expect(now[0]).toBe((was[0] as number) ^ 1)
    expect(now.subarray(1)).toEqual(was.subarray(1))
  })

  it('a scaled bound over an argument the call does not carry derives nothing', () => {
    const floor: Expr = [
      'gte',
      ['call_arg', 1],
      ['scaled', ['call_arg', 7], { i128: '2' }, { i128: '1' }, { i128: '0' }],
    ]
    expect(one(floor, call([{ i128: '1' }, { i128: '2' }]))).toBeUndefined()
    const floor3: Expr = [
      'gte',
      ['call_arg', 1],
      ['scaled', ['call_arg', 0], ['call_arg', 7], { i128: '1' }, { i128: '0' }],
    ]
    expect(one(floor3, call([{ i128: '1' }, { i128: '2' }]))).toBeUndefined()
    const floor2: Expr = [
      'gte',
      ['call_arg', 1],
      ['scaled', ['call_arg', 0], { i128: '2' }, { i128: '1' }, ['call_arg', 7]],
    ]
    expect(one(floor2, call([{ i128: '1' }, { i128: '2' }]))).toBeUndefined()
  })

  it('a deny case says what it breaks, in at most 80 characters of the conjunct', () => {
    const long: Expr = ['in', ['call_arg', 0], Array.from({ length: 20 }, (_, i) => i + 1000)]
    const [d] = denyCases([long], call([1000]))
    expect(d?.label.length).toBe('breaks '.length + 80)
    expect(d?.label.startsWith('breaks ["in"')).toBe(true)
  })

  it('no more than 24 cases from one rule', () => {
    const many = Array.from({ length: 30 }, (_, i): Expr => ['lte', ['call_arg', i], { i128: '9' }])
    const permit = call(Array.from({ length: 30 }, () => ({ i128: '1' }) as Val))
    expect(denyCases(many, permit)).toHaveLength(30)
  })
})

// ---- the verdict is the contract error: nothing a `check` does can commit ----

describe('what counts as a verdict', () => {
  const stub = (sim: unknown) =>
    ({
      simulateTransaction: async () => sim,
    }) as unknown as import('@stellar/stellar-sdk').rpc.Server
  const ask = (sim: unknown) =>
    runChecks(stub(sim), 'testnet', contract(9), encode(['eq', ['call_fn'], 'pay']), [
      { contract: C, fn: 'pay', args: [] },
    ])

  it('reads the code from the contract error, 0 being a permit', async () => {
    const said = (n: number) =>
      ask({
        error: `HostError: Error(Contract, #${n})\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Contract, #7)]`,
      })
    expect((await said(0))[0]).toEqual({ permitted: true, code: 0, reason: 'PERMIT' })
    expect((await said(100))[0]).toMatchObject({
      permitted: false,
      code: 100,
      reason: 'ARG_MISMATCH',
    })
    // The first line is the verdict: a code the event log mentions later is a callee's.
    expect((await said(105))[0]?.code).toBe(105)
  })

  it('only the contract error of the call itself is the verdict, not one a callee raised or the log mentions', async () => {
    await expect(
      ask({
        error: 'HostError: Error(WasmVm, InvalidAction)\n\nEvent log:\n 0: Error(Contract, #100)',
      })
    ).rejects.toThrow(/no verdict/)
    await expect(
      ask({ error: 'something wrapped HostError: Error(Contract, #100)' })
    ).rejects.toThrow(/no verdict/)
  })

  it('a simulation that returns a value is not a verdict: that interpreter can commit what it reads', async () => {
    await expect(ask({ result: { retval: { u32: () => 0 } } })).rejects.toThrow(/no verdict/)
  })

  it('an error that is not a contract error is not a verdict', async () => {
    await expect(ask({ error: 'HostError: Error(Budget, ExceededLimit)' })).rejects.toThrow(
      /no verdict \(Error\(Budget, ExceededLimit\)\)/
    )
    await expect(ask({ error: 'HostError: Error(WasmVm, InvalidAction)' })).rejects.toThrow(
      /no verdict/
    )
  })
})

describe('a length bound is never allocated', () => {
  const call: Call = { contract: C, fn: 'f', args: [[1]] }
  const big = (op: string, n: number) => denyCases([[op, ['call_arg_len', 0], n]], call)

  it('a bound of ten million (or the u32 maximum) derives no case, at once, in little memory', () => {
    const before = process.memoryUsage().rss
    const t = performance.now()
    for (const op of ['lte', 'lt', 'gte', 'gt', 'eq'])
      for (const n of [10_000_000, 4_294_967_295]) expect(big(op, n)).toEqual([])
    expect(performance.now() - t).toBeLessThan(200)
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024)
  })

  it('a bound within reach still derives a vec just over it, and only that long', () => {
    const [c] = big('lte', 3)
    expect(c?.call.args[0]).toHaveLength(4)
    const edge = big('lte', 255)[0]
    expect(edge?.call.args[0]).toHaveLength(256)
    expect(big('lte', 256)).toEqual([]) // one past what a case may grow to
  })
})

describe('a pinned muxed address', () => {
  it('is broken as an address of its own kind, not decoded as an ed25519 key', () => {
    const m = StrKey.encodeMed25519PublicKey(
      Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(8, 1)])
    )
    const call: Call = { contract: C, fn: 'pay', args: [m] }
    const [c] = denyCases([['eq', ['call_arg', 0], m]], call)
    const broken = c?.call.args[0] as string
    expect(broken).not.toBe(m)
    expect(broken[0]).toBe('M')
    expect(StrKey.isValidMed25519PublicKey(broken)).toBe(true)
  })
})

describe('an in case is a value the set does not hold', () => {
  it('skips past the values the set does hold (5 and 6 are in, so 7)', () => {
    const call: Call = { contract: C, fn: 'f', args: [{ i128: '5' }] }
    const set: Val[] = [{ i128: '5' }, { i128: '6' }]
    expect(denyCases([['in', ['call_arg', 0], set]], call)[0]?.call.args[0]).toEqual({ i128: '7' })
  })
})

describe('a length case at the edges', () => {
  const call: Call = { contract: C, fn: 'f', args: [[1, 2]] }
  it('a floor of one item breaks to an empty vec, a floor of zero to none (nothing is below it)', () => {
    expect(denyCases([['gte', ['call_arg_len', 0], 1]], call)[0]?.call.args[0]).toEqual([])
    expect(denyCases([['gt', ['call_arg_len', 0], 0]], call)[0]?.call.args[0]).toEqual([])
    expect(denyCases([['gte', ['call_arg_len', 0], 0]], call)).toEqual([])
  })
})

describe('the integer a case is built from', () => {
  const at = (args: Val[]): Call => ({ contract: C, fn: 'f', args })
  it('an i32 is an integer of its own type: eq and lte get cases that stay i32', () => {
    expect(
      denyCases([['eq', ['call_arg', 0], { i32: 5 }]], at([{ i32: 5 }]))[0]?.call.args[0]
    ).toEqual({ i32: 6 })
    expect(
      denyCases([['lte', ['call_arg', 0], { i32: 5 }]], at([{ i32: 5 }]))[0]?.call.args[0]
    ).toEqual({ i32: 6 })
  })
  it('bytes or text made of digits are not numbers', () => {
    const bytes = denyCases(
      [['eq', ['call_arg', 0], ['lit', { bytes: '1234' }]]],
      at([{ bytes: '1234' }])
    )
    expect(bytes[0]?.call.args[0]).toEqual({ bytes: '123400' })
    const text = denyCases(
      [['eq', ['call_arg', 0], ['lit', { string: '12' }]]],
      at([{ string: '12' }])
    )
    expect(text[0]?.call.args[0]).toEqual({ string: '12x' })
  })
})
