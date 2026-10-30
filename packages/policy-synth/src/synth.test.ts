import { describe, expect, it } from 'bun:test'
import { account, batchIntent, contract, recording, venueIntent } from '../test/fixtures.ts'
import { Refusal } from './envelope.ts'
import { type CallIntent, type Constraint, callExpr, intentExprs, lower } from './intent.ts'
import type { Call } from './record.ts'
import { identify } from './registry.ts'
import { propose, synthesize, unbounded, unboundedExpr } from './synth.ts'
import { type Expr, type Val, validate } from './wire.ts'

const A = account(1)
const C = contract(1)

describe('lowering: one row per rule', () => {
  const cases: [Constraint, Expr][] = [
    [{ constraint: 'pin', at: [0], to: A }, ['eq', ['call_arg', 0], A]],
    [{ constraint: 'not', at: [0], to: 'x' }, ['ne', ['call_arg', 0], 'x']],
    [{ constraint: 'allow', at: [1, 'k'], in: [A, 5] }, ['in', ['call_path', 1, 'k'], [A, 5]]],
    [
      { constraint: 'deny', at: [0], nin: [{ i128: '1' }] },
      ['nin', ['call_arg', 0], [{ i128: '1' }]],
    ],
    [{ constraint: 'cap', at: [2], max: '100' }, ['lte', ['call_arg', 2], { i128: '100' }]],
    [{ constraint: 'floor', at: [2], min: '1' }, ['gte', ['call_arg', 2], { i128: '1' }]],
    [{ constraint: 'length', at: [3], max: 4 }, ['lte', ['call_path', 3, true], 4]],
    [
      { constraint: 'minOut', at: [1], of: [0], num: '99', den: '100' },
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, { i128: '0' }],
      ],
    ],
    [
      {
        constraint: 'each',
        at: [0],
        where: [
          { constraint: 'allow', at: ['to'], in: [A] },
          { constraint: 'floor', at: ['amount'], min: '0' },
        ],
      },
      [
        'all',
        ['call_arg', 0],
        [
          'and',
          [
            ['in', ['elem', 'to'], [A]],
            ['gte', ['elem', 'amount'], { i128: '0' }],
          ],
        ],
      ],
    ],
    [
      { constraint: 'some', at: [0], where: [{ constraint: 'pin', at: [], to: 'repay' }] },
      ['any', ['call_arg', 0], ['eq', ['elem'], 'repay']],
    ],
    [
      { constraint: 'total', at: [0], of: ['amount'], max: '1000' },
      ['lte', ['sum', ['call_arg', 0], 'amount'], { i128: '1000' }],
    ],
    [
      {
        constraint: 'read',
        contract: C,
        fn: 'price',
        args: [{ arg: [1] }, 'USD'],
        path: ['price'],
        op: 'gte',
        to: { i128: '5' },
      },
      ['gte', ['read', C, 'price', [['call_arg', 1], 'USD'], 'price'], { i128: '5' }],
    ],
    [{ constraint: 'until', ts: 1_900_000_000 }, ['lte', ['now'], { u64: '1900000000' }]],
    [{ constraint: 'from', ts: 5 }, ['gte', ['now'], { u64: '5' }]],
  ]
  it.each(cases)('%j', (rule, expr) => expect(lower(rule)).toEqual(expr))

  it('wraps what a bare value cannot carry in lit', () => {
    expect(lower({ constraint: 'pin', at: [0], to: ['a', 1] })).toEqual([
      'eq',
      ['call_arg', 0],
      ['lit', ['a', 1]],
    ])
    expect(lower({ constraint: 'pin', at: [0], to: { string: 'memo' } })).toEqual([
      'eq',
      ['call_arg', 0],
      ['lit', { string: 'memo' }],
    ])
    expect(lower({ constraint: 'pin', at: [0], to: true })).toEqual([
      'eq',
      ['call_arg', 0],
      ['lit', true],
    ])
  })

  it('pins contract and function, keeps the order written, groups by contract with an or', () => {
    const one: CallIntent = {
      contract: C,
      fn: 'pay',
      where: [
        { constraint: 'pin', at: [1], to: 2 },
        { constraint: 'pin', at: [0], to: 1 },
      ],
    }
    expect(callExpr(one)).toEqual([
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_fn'], 'pay'],
        ['eq', ['call_arg', 1], 2],
        ['eq', ['call_arg', 0], 1],
      ],
    ])
    const exprs = intentExprs({
      calls: [one, { contract: C, fn: 'refund' }, { contract: contract(2), fn: 'x' }],
    })
    expect([...exprs.keys()]).toEqual([C, contract(2)])
    expect((exprs.get(C) as Expr[])[0]).toBe('or')
  })
})

describe('the registry', () => {
  it('identifies a call by function and argument shapes, not by address', () => {
    expect(identify('transfer', [A, A, { i128: '1' }])?.protocol).toBe('sep41')
    expect(identify('transfer', [A, A, 1])).toBeNull()
    expect(identify('transfer', [A, A])).toBeNull()
    expect(identify('nothing', [])).toBeNull()
  })

  it('mandates (a batch, a venue) lower to rules the contract would decode', () => {
    const batch = batchIntent({
      adapter: C,
      targets: [contract(2), contract(3)],
      functions: ['supply'],
    })
    const venue = venueIntent({ pool: C, token: contract(2), account: A, max: '1000' })
    for (const intent of [batch, venue])
      for (const r of propose(intent)) expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    const [rule] = propose(batch)
    expect(JSON.stringify(rule?.expr)).toContain('"all"')
    expect(JSON.stringify(rule?.expr)).toContain('["lte",["call_path",1,true],0]')
  })

  it('a batch mandate that cannot fit the contract body cap is refused, not truncated', () => {
    const wide = batchIntent({
      adapter: C,
      targets: [1, 2, 3, 4, 5, 6].map(contract),
      functions: ['a'],
    })
    expect(() => propose(wide)).toThrow(/leaves/)
  })
})

describe('an intent is asked the question a recording is: how much?', () => {
  const call = (fn: string, where: CallIntent['where']): CallIntent => ({ contract: C, fn, where })
  const codes = (...calls: CallIntent[]) => unbounded({ calls }).map((a) => a.code)

  it('a minOut floor below the minimum ratio is no floor, so the slippage question stands (SYNTH-CORE-02)', () => {
    const swap = (num: string, den: string): CallIntent =>
      call('swap_exact_tokens_for_tokens', [
        { constraint: 'cap', at: [0], max: '1000' },
        { constraint: 'minOut', at: [1], of: [0], num, den },
      ])
    // Below one in a million (1/10^18, 1/10^7): a degenerate floor, so the question stands.
    expect(codes(swap('1', '1000000000000000000'))).toContain('SLIPPAGE_FLOOR_MISSING')
    expect(codes(swap('1', '10000000'))).toContain('SLIPPAGE_FLOOR_MISSING')
    // A ratio at or above one in a million is an honest floor, even a small one.
    expect(codes(swap('1', '1000'))).not.toContain('SLIPPAGE_FLOOR_MISSING')
    expect(codes(swap('1', '3'))).not.toContain('SLIPPAGE_FLOOR_MISSING')
    expect(codes(swap('1', '2'))).not.toContain('SLIPPAGE_FLOOR_MISSING')
    expect(codes(swap('99', '100'))).not.toContain('SLIPPAGE_FLOOR_MISSING')
  })

  it('a known function whose amount nobody capped is a question; a cap, or a total, answers it', () => {
    expect(codes(call('transfer', undefined))).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(codes(call('transfer', [{ constraint: 'pin', at: [1], to: A }]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(codes(call('transfer', [{ constraint: 'cap', at: [2], max: '5' }]))).toEqual([])
    // The cap must be on the amount, not on another argument.
    expect(codes(call('transfer', [{ constraint: 'cap', at: [1], max: '5' }]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(
      codes(call('swap_tokens_for_exact_tokens', [{ constraint: 'cap', at: [0], max: '5' }]))
    ).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(
      codes(call('swap_tokens_for_exact_tokens', [{ constraint: 'cap', at: [1], max: '5' }]))
    ).toEqual([])
  })

  it('a cap inside each, on the field of a vec of structs, answers it for a Blend submit', () => {
    expect(codes(call('submit', [{ constraint: 'length', at: [3], max: 1 }]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    const capped: CallIntent['where'] = [
      { constraint: 'each', at: [3], where: [{ constraint: 'cap', at: ['amount'], max: '5' }] },
    ]
    expect(codes(call('submit', capped))).toEqual([])
    expect(
      codes(
        call('submit', [
          { constraint: 'each', at: [3], where: [{ constraint: 'pin', at: ['address'], to: C }] },
        ])
      )
    ).toEqual(['AMOUNT_BOUND_MISSING'])
  })

  it('a cap on another field of the requests does not answer for the amount (request_type <= 1 leaves the amount open)', () => {
    const typeOnly: CallIntent['where'] = [
      { constraint: 'cap', at: [3, 0, 'request_type'], max: '1' },
    ]
    expect(codes(call('submit', typeOnly))).toEqual(['AMOUNT_BOUND_MISSING'])
    const inEach: CallIntent['where'] = [
      {
        constraint: 'each',
        at: [3],
        where: [{ constraint: 'cap', at: ['request_type'], max: '1' }],
      },
    ]
    expect(codes(call('submit', inEach))).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(codes(call('submit', [{ constraint: 'cap', at: [3, 0, 'amount'], max: '5' }]))).toEqual(
      []
    )
    expect(
      codes(call('submit', [{ constraint: 'total', at: [3], of: ['amount'], max: '5' }]))
    ).toEqual([])
    // A cap on a field of an amount argument's... own path is not the amount either.
    expect(codes(call('transfer', [{ constraint: 'cap', at: [2, 'x'], max: '5' }]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
  })

  it('the least output of a swap is a question too, answered by a floor or a minOut on that argument', () => {
    const swap = (where: CallIntent['where']) => codes(call('swap_exact_tokens_for_tokens', where))
    const cap: Constraint = { constraint: 'cap', at: [0], max: '5' }
    expect(swap([cap])).toEqual(['SLIPPAGE_FLOOR_MISSING'])
    expect(swap([cap, { constraint: 'minOut', at: [1], of: [0], num: '99', den: '100' }])).toEqual(
      []
    )
    expect(swap([cap, { constraint: 'floor', at: [1], min: '1' }])).toEqual([])
    // A floor of zero (or below) is no floor.
    expect(swap([cap, { constraint: 'floor', at: [1], min: '0' }])).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    expect(swap([cap, { constraint: 'floor', at: [1], min: '-5' }])).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    // A floor on another argument does not set it.
    expect(swap([cap, { constraint: 'floor', at: [0], min: '1' }])).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    // An exact-out swap has no least output to ask for: its input is what is capped.
    expect(
      codes(call('swap_tokens_for_exact_tokens', [{ constraint: 'cap', at: [1], max: '5' }]))
    ).toEqual([])
  })

  it('a function nobody knows is not guessed at, and each call is asked about once', () => {
    expect(codes(call('weird', undefined))).toEqual([])
    expect(codes(call('transfer', undefined), call('mint', undefined))).toHaveLength(2)
  })
})

describe('an encoded predicate is asked the same question', () => {
  const asks = (e: Val) => unboundedExpr(e as Expr).map((a) => a.code)
  const pin = (fn: string, ...rest: Expr[]): Expr => [
    'and',
    [['eq', ['call_contract'], C], ['eq', ['call_fn'], fn], ...rest],
  ]
  const amt = { i128: '9' }

  it('a known function with an amount argument and no upper bound on it is a question', () => {
    expect(asks(pin('transfer', ['eq', ['call_arg', 0], A]))).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(asks(pin('transfer', ['lte', ['call_arg', 2], amt]))).toEqual([])
    expect(asks(pin('transfer', ['lt', ['call_arg', 2], amt]))).toEqual([])
    expect(asks(pin('transfer', ['gte', amt, ['call_arg', 2]]))).toEqual([]) // constant first
    // A lower bound is not a cap, and a cap on another argument is not this one.
    expect(asks(pin('transfer', ['gte', ['call_arg', 2], amt]))).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(asks(pin('transfer', ['lte', ['call_arg', 1], amt]))).toEqual(['AMOUNT_BOUND_MISSING'])
  })

  it('is asked per branch of an or, and a bound counts only against a constant', () => {
    const cap: Expr = ['lte', ['call_arg', 2], amt]
    const branch = (...r: Expr[]) => pin('transfer', ...r)
    // The second branch is an uncapped transfer: the first one's cap does not cover it.
    expect(asks(['or', [branch(cap), branch(['eq', ['call_arg', 1], A])]])).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(asks(['or', [branch(cap), branch(['lt', ['call_arg', 2], amt])]])).toEqual([])
    // A cap inside a nested or holds for one alternative only.
    expect(asks(branch(['or', [cap, ['eq', ['call_arg', 1], A]]]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    // An amount compared with itself (or with another argument) bounds nothing.
    expect(asks(branch(['lte', ['call_arg', 2], ['call_arg', 2]]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(asks(branch(['lte', ['call_arg', 2], ['call_arg', 0]]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
  })

  it('a cap on requests[0] only is no cap on the requests: it needs all of them (or each recorded one and a length bound)', () => {
    const one: Expr = ['lte', ['call_path', 3, 0, 'amount'], amt]
    expect(asks(pin('submit', one))).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(asks(pin('submit', one, ['lte', ['call_path', 3, true], 1]))).toEqual([])
    expect(asks(pin('submit', one, ['lte', ['call_path', 3, true], 2]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(
      asks(
        pin(
          'submit',
          one,
          ['lte', ['call_path', 3, 1, 'amount'], amt],
          ['lte', ['call_path', 3, true], 2]
        )
      )
    ).toEqual([])
  })

  it('a branch that names no function permits every function and any amount: asked, unless it pins one', () => {
    const q = (e: Expr) => unboundedExpr(e).map((a) => a.question)
    const unpinned = q([
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_arg', 0], A],
      ],
    ])
    expect(unpinned).toHaveLength(1)
    expect(unpinned[0]).toContain('no function pinned')
    // Only a negative on the function names none either.
    expect(
      q([
        'and',
        [
          ['eq', ['call_contract'], C],
          ['ne', ['call_fn'], 'burn'],
        ],
      ])[0]
    ).toContain('no function pinned')
    // An or: the unpinned branch asks, the pinned and capped one does not.
    const mixed = q([
      'or',
      [pin('transfer', ['lte', ['call_arg', 2], amt]), ['and', [['eq', ['call_contract'], C]]]],
    ])
    expect(mixed).toHaveLength(1)
    expect(mixed[0]).toContain('no function pinned')
    expect(q(pin('transfer', ['lte', ['call_arg', 2], amt]))).toEqual([])
  })

  it('a floor of zero is no floor on the least output', () => {
    const swap = (...r: Expr[]): Expr =>
      pin('swap_exact_tokens_for_tokens', ['lte', ['call_arg', 0], amt], ...r)
    expect(asks(swap(['gte', ['call_arg', 1], { i128: '0' }]))).toEqual(['SLIPPAGE_FLOOR_MISSING'])
    expect(asks(swap(['gt', ['call_arg', 1], { i128: '-1' }]))).toEqual(['SLIPPAGE_FLOOR_MISSING'])
    expect(asks(swap(['gte', ['call_arg', 1], { i128: '1' }]))).toEqual([])
    expect(asks(swap(['gt', ['call_arg', 1], { i128: '0' }]))).toEqual([])
  })

  it('a requests argument needs an upper bound on a field called amount; a function nobody knows is not guessed at', () => {
    expect(asks(pin('submit', ['lte', ['call_path', 3, true], 1]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(
      asks(pin('submit', ['all', ['call_arg', 3], ['lte', ['elem', 'request_type'], 1]]))
    ).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(asks(pin('submit', ['all', ['call_arg', 3], ['lte', ['elem', 'amount'], amt]]))).toEqual(
      []
    )
    // One request's cap alone is not a cap on them all (see the test below).
    expect(asks(pin('submit', ['lte', ['call_path', 3, 0, 'amount'], amt]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    expect(asks(pin('weird', ['eq', ['call_arg', 0], A]))).toEqual([])
    // An or of functions asks about each one.
    expect(asks(['or', [pin('transfer'), pin('burn')]])).toHaveLength(2)
  })
})

describe('an encoded predicate is asked about the least output too', () => {
  const swap = (...rest: Expr[]): Expr => [
    'and',
    [
      ['eq', ['call_contract'], C],
      ['eq', ['call_fn'], 'swap_exact_tokens_for_tokens'],
      ['lte', ['call_arg', 0], { i128: '5' }],
      ...rest,
    ],
  ]
  const codes = (e: Expr) => unboundedExpr(e).map((a) => a.code)
  it('needs a lower bound on amount_out_min', () => {
    expect(codes(swap())).toEqual(['SLIPPAGE_FLOOR_MISSING'])
    expect(codes(swap(['gte', ['call_arg', 1], { i128: '1' }]))).toEqual([])
    expect(
      codes(
        swap([
          'gt',
          ['call_arg', 1],
          ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, { i128: '0' }],
        ])
      )
    ).toEqual([])
    expect(codes(swap(['lte', ['call_arg', 1], { i128: '9' }]))).toEqual(['SLIPPAGE_FLOOR_MISSING'])
  })
})

// the safety gate walks the FINISHED rule, so none of the shapes that pinned the
// INPUT while leaving the produced rule uncapped slips through. Honest forms still pass.
describe('the gate is judged on the produced rule, not the input shape', () => {
  const amt = { i128: '9' }
  const pin = (fn: string, ...rest: Expr[]): Expr => [
    'and',
    [['eq', ['call_contract'], C], ['eq', ['call_fn'], fn], ...rest],
  ]
  const codes = (e: Expr) => unboundedExpr(e).map((a) => a.code)

  it('a cap under `some` (not `each`) does not cap the requests', () => {
    expect(
      codes(pin('submit', ['any', ['call_arg', 3], ['lte', ['elem', 'amount'], amt]]))
    ).toEqual(['AMOUNT_BOUND_MISSING'])
    // The honest `each` form caps every element, and asks nothing.
    expect(
      codes(pin('submit', ['all', ['call_arg', 3], ['lte', ['elem', 'amount'], amt]]))
    ).toEqual([])
  })

  it('a cap on requests[0] alone does not cap them all', () => {
    expect(codes(pin('submit', ['lte', ['call_path', 3, 0, 'amount'], amt]))).toEqual([
      'AMOUNT_BOUND_MISSING',
    ])
    // With a length bound of one and a cap on that one element, it is covered.
    expect(
      codes(
        pin(
          'submit',
          ['lte', ['call_path', 3, 0, 'amount'], amt],
          ['lte', ['call_path', 3, true], 1]
        )
      )
    ).toEqual([])
  })

  it('a minOut that bounds the output by itself is no floor', () => {
    const swap = (floor: Expr) =>
      pin('swap_exact_tokens_for_tokens', ['lte', ['call_arg', 0], amt], floor)
    const scaled = (src: number): Expr => [
      'scaled',
      ['call_arg', src],
      { i128: '99' },
      { i128: '100' },
      { i128: '0' },
    ]
    // amount_out_min >= amount_out_min * 99/100 permits a trade at any price.
    expect(codes(swap(['gte', ['call_arg', 1], scaled(1)]))).toEqual(['SLIPPAGE_FLOOR_MISSING'])
    // amount_out_min >= amount_in * 99/100 is an honest slippage floor.
    expect(codes(swap(['gte', ['call_arg', 1], scaled(0)]))).toEqual([])
  })

  it('the allowance-based value movers are asked too (SYNTH-CORE-01)', () => {
    // transfer_from, burn_from and submit_with_allowance move value under an allowance, so an
    // uncapped rule over any of them is a question, like transfer and submit.
    for (const fn of ['transfer_from', 'burn_from', 'submit_with_allowance'])
      expect(codes(pin(fn, ['eq', ['call_arg', 0], A]))).toEqual(['AMOUNT_BOUND_MISSING'])
    // transfer_from's amount is argument 3; capping it answers the question.
    expect(codes(pin('transfer_from', ['lte', ['call_arg', 3], amt]))).toEqual([])
  })

  it('a scaled slippage floor must be a ratio of the input amount with a non-negative add (SYNTH-CORE-02)', () => {
    const swap = (floor: Expr) =>
      pin('swap_exact_tokens_for_tokens', ['lte', ['call_arg', 0], amt], floor)
    const sc = (src: number, num: string, den: string, add: string): Expr => [
      'scaled',
      ['call_arg', src],
      { i128: num },
      { i128: den },
      { i128: add },
    ]
    // A negative add, or a source that is not the input amount (here the deadline), admits a 0 output.
    expect(codes(swap(['gte', ['call_arg', 1], sc(0, '1', '1', '-1')]))).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    expect(codes(swap(['gte', ['call_arg', 1], sc(4, '99', '100', '0')]))).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    // The honest floor (a ratio of amount_in, non-negative add) passes.
    expect(codes(swap(['gte', ['call_arg', 1], sc(0, '99', '100', '0')]))).toEqual([])
  })

  it('a scaled floor must meet the minimum ratio: a degenerate 1/10^18 is no floor (SYNTH-CORE-02)', () => {
    const swap = (floor: Expr) =>
      pin('swap_exact_tokens_for_tokens', ['lte', ['call_arg', 0], amt], floor)
    const sc = (num: string, den: string): Expr => [
      'scaled',
      ['call_arg', 0],
      { i128: num },
      { i128: den },
      { i128: '0' },
    ]
    // out >= in * 1/10^18, and any ratio below one in a million (1/10^7), admit a near-zero output.
    expect(codes(swap(['gte', ['call_arg', 1], sc('1', '1000000000000000000')]))).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    expect(codes(swap(['gte', ['call_arg', 1], sc('1', '10000000')]))).toEqual([
      'SLIPPAGE_FLOOR_MISSING',
    ])
    // One in a million (the minimum) and tighter pass, including an honest small floor.
    expect(codes(swap(['gte', ['call_arg', 1], sc('1', '1000')]))).toEqual([])
    expect(codes(swap(['gte', ['call_arg', 1], sc('1', '3')]))).toEqual([])
    expect(codes(swap(['gte', ['call_arg', 1], sc('1', '2')]))).toEqual([])
    expect(codes(swap(['gte', ['call_arg', 1], sc('99', '100')]))).toEqual([])
  })

  it('a known function recorded with the wrong number of arguments is refused', () => {
    // A transfer without its amount (two args, not three): the rule would never bound the amount.
    expect(() => synthesize([{ contract: C, fn: 'transfer', args: [A, A] }])).toThrow(
      /transfer: recorded with 2 argument\(s\), but transfer takes 3/
    )
    // A swap without its deadline (four args, not five): amount_out_min would be mis-typed.
    expect(() =>
      synthesize([
        {
          contract: C,
          fn: 'swap_exact_tokens_for_tokens',
          args: [{ i128: '5' }, { i128: '1' }, [C], A],
        },
      ])
    ).toThrow(/recorded with 4 argument\(s\), but swap_exact_tokens_for_tokens takes 5/)
    // The honest, complete forms synthesise (no over-restriction).
    expect(() =>
      synthesize([{ contract: C, fn: 'transfer', args: [A, A, { i128: '5' }] }], { limit: '5' })
    ).not.toThrow()
  })
})

describe('synthesis from what was recorded', () => {
  it('a SEP-41 transfer: pin who, cap how much; no cap is a question, not a guess', () => {
    const [call] = recording('sep41').contexts as [Call]
    const capped = synthesize([call], { limit: '8000000000' })
    expect(capped.ambiguities).toEqual([])
    const [rule] = propose(capped.intent)
    expect(rule?.expr).toEqual([
      'and',
      [
        ['eq', ['call_contract'], call.contract],
        ['eq', ['call_fn'], 'transfer'],
        ['eq', ['call_arg', 0], call.args[0]],
        ['eq', ['call_arg', 1], call.args[1]],
        ['lte', ['call_arg', 2], { i128: '8000000000' }],
      ],
    ])
    const open = synthesize([call])
    expect(open.ambiguities.map((a) => a.code)).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(JSON.stringify(propose(open.intent)[0]?.expr)).not.toContain('"lte"')
  })

  it('an allowlist replaces the pin on who', () => {
    const [call] = recording('sep41').contexts as [Call]
    const s = synthesize([call], { limit: '1', allow: { to: [A, contract(9)] } })
    expect(JSON.stringify(propose(s.intent)[0]?.expr)).toContain(
      `["in",["call_arg",1],["${A}","${contract(9)}"]]`
    )
  })

  it('a swap: the router rule and the nested token transfer are separate rules; a missing floor is said', () => {
    const s = synthesize(recording('soroswap').contexts, {
      limits: { amount_in: '400000000' },
      limit: '400000000',
    })
    const rules = propose(s.intent)
    expect(rules.map((r) => r.contract)).toEqual(
      recording('soroswap').contexts.map((c) => c.contract)
    )
    expect(s.ambiguities.map((a) => a.code)).toEqual(['SLIPPAGE_FLOOR_MISSING'])
    expect(s.warnings.some((w) => w.includes('2 contracts'))).toBe(true)
    const router = JSON.stringify(rules[0]?.expr)
    expect(router).toContain('"lit"') // the path is pinned exactly, as a constant
    expect(router).not.toContain('["call_arg",1]') // amount_out_min is left to the caller
    expect(router).not.toContain('["call_arg",4]') // and so is the deadline
  })

  it('a function the registry does not know: pinned, amounts asked for, and it says so', () => {
    const call: Call = { contract: C, fn: 'weird', args: [A, { i128: '5' }, 7, ['x']] }
    const s = synthesize([call])
    expect(s.warnings[0]).toContain('not a function the registry knows')
    expect(s.ambiguities).toHaveLength(1)
    const text = JSON.stringify(propose(s.intent)[0]?.expr)
    expect(text).toContain('["eq",["call_arg",2],7]')
    expect(text).toContain('["eq",["call_arg",3],["lit",["x"]]]')
  })

  it('refuses nothing to scope a policy to', () => expect(() => synthesize([])).toThrow(/no call/))

  describe('a vec of structs', () => {
    const req = (type: number, amount: string): Val => ({
      map: [
        ['address', C],
        ['amount', { i128: amount }],
        ['request_type', type],
      ],
    })
    const submit = (...requests: Val[]): Call => ({
      contract: contract(5),
      fn: 'submit',
      args: [A, A, A, requests],
    })

    it('two fields: a quantifier over the elements, capped, at most as many as recorded', () => {
      const two = (amount: string): Val => ({
        map: [
          ['address', C],
          ['amount', { i128: amount }],
        ],
      })
      const text = JSON.stringify(
        propose(synthesize([submit(two('10'), two('20'))], { limit: '50' }).intent)[0]?.expr
      )
      expect(text).toContain('["lte",["call_path",3,true],2]')
      expect(text).toContain('"all",["call_arg",3]')
      expect(text).toContain('["lte",["elem","amount"],{"i128":"50"}]')
      expect(text).toContain(`["eq",["elem","address"],"${C}"]`)
    })

    it('three fields overflow the leaf cap, so each recorded element is pinned in turn', () => {
      const s = synthesize([submit(req(0, '10'), req(1, '20'))], { limit: '50' })
      const text = JSON.stringify(propose(s.intent)[0]?.expr)
      expect(text).not.toContain('"all"')
      expect(text).toContain('["lte",["call_path",3,1,"amount"],{"i128":"50"}]')
      expect(text).toContain('["eq",["call_path",3,0,"request_type"],0]')
      expect(text).toContain('["eq",["call_path",3,1,"request_type"],1]')
    })

    it('two fields that each take more than one value are never a quantifier: it would permit their cross-product', () => {
      const other = contract(9)
      const mixed = (type: number, address: string, amount: string): Val => ({
        map: [
          ['address', address],
          ['amount', { i128: amount }],
          ['request_type', type],
        ],
      })
      const s = synthesize([submit(mixed(0, C, '10'), mixed(1, other, '20'))], { limit: '50' })
      const text = JSON.stringify(propose(s.intent)[0]?.expr)
      // Flat: each recorded element pinned in turn, so {C, type 1} (a pair nobody recorded) is not allowed.
      expect(text).not.toContain('"all"')
      expect(text).toContain(`["eq",["call_path",3,0,"address"],"${C}"]`)
      expect(text).toContain(`["eq",["call_path",3,1,"address"],"${other}"]`)
      expect(text).toContain('["eq",["call_path",3,1,"request_type"],1]')
    })

    it('an amount with no cap is a question, asked once', () => {
      const s = synthesize([submit(req(0, '10'), req(1, '20'))])
      expect(s.ambiguities).toHaveLength(1)
      expect(s.ambiguities[0]?.question).toContain('requests.amount')
    })

    // a 4000-request submit whose elements carry 4000 keys each would pin 16M fields
    // and crash the server. It is refused from the element sizes alone, before any constraint is
    // built. (The elements share one map value, so the oversized input itself costs nothing.)
    it('refuses an oversized vec of structs instead of building 16M constraints', () => {
      const big = { map: Array.from({ length: 4000 }, (_, i) => [`k${i}`, { i128: '1' }]) } as Val
      const vec = Array.from({ length: 4000 }, () => big)
      const t0 = performance.now()
      expect(() => synthesize([submit(...vec)], { limit: '50' })).toThrow(
        /4000 requests of up to 4000 fields exceed the interpreter's ceilings/
      )
      expect(performance.now() - t0).toBeLessThan(1000)
    })

    it('still builds an honest small submit (no over-restriction)', () => {
      const s = synthesize([submit(req(0, '10'), req(1, '20'))], { limit: '50' })
      expect(() => propose(s.intent)).not.toThrow()
    })

    // Small elements can still name many fields between them: 4000 requests of one key each, every
    // key different, carry 4000 distinct fields, and both forms build one constraint per distinct
    // field (the flat form once per element, 16M in all). The per-element size passes; the distinct
    // field count is what refuses it, before any constraint is built.
    it('refuses one-key requests that each name a different field instead of building 16M constraints', () => {
      const vec = Array.from({ length: 4000 }, (_, i): Val => ({ map: [[`k${i}`, { i128: '1' }]] }))
      const t0 = performance.now()
      let thrown: unknown
      try {
        synthesize([submit(...vec)], { limit: '50' })
      } catch (e) {
        thrown = e
      }
      expect(performance.now() - t0).toBeLessThan(1000)
      expect(thrown).toBeInstanceOf(Refusal)
      expect((thrown as Refusal).code).toBe('SYNTHESIS_ERROR')
      expect((thrown as Refusal).message).toMatch(
        /4000 requests with 4000 distinct fields exceed the interpreter's ceilings/
      )
    })

    it('still builds an honest batch of many requests over a few fields', () => {
      const vec = Array.from({ length: 20 }, (_, i) => req(i % 3, String(10 + i)))
      const s = synthesize([submit(...vec)], { limit: '50' })
      const [rule] = propose(s.intent)
      const text = JSON.stringify(rule?.expr)
      expect(text).toContain('["lte",["call_path",3,true],20]')
      expect(text).toContain('["lte",["call_path",3,19,"amount"],{"i128":"50"}]')
      expect(text).toContain('["eq",["call_path",3,19,"request_type"],1]')
    })
  })

  it('every recorded flow yields rules the contract would decode', () => {
    for (const n of ['blend', 'sep41', 'soroswap'] as const) {
      for (const r of propose(synthesize(recording(n).contexts, { limit: '1' }).intent))
        expect(() => validate(r.expr)).not.toThrow()
    }
  })
})
