import { describe, expect, it } from 'bun:test'
import { account, contract, recording } from '../test/fixtures.ts'
import { type CallIntent, type Constraint, callExpr, intentExprs, lower } from './intent.ts'
import type { Call } from './record.ts'
import { identify, TEMPLATES } from './registry.ts'
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

  it('templates lower to rules the contract would decode', () => {
    const batch = TEMPLATES.adapter_batch({
      adapter: C,
      targets: [contract(2), contract(3)],
      functions: ['supply'],
    })
    const venue = TEMPLATES.blend_venue({ pool: C, token: contract(2), account: A, max: '1000' })
    for (const intent of [batch, venue])
      for (const r of propose(intent)) expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    const [rule] = propose(batch)
    expect(JSON.stringify(rule?.expr)).toContain('"all"')
    expect(JSON.stringify(rule?.expr)).toContain('["lte",["call_path",1,true],0]')
  })

  it('a batch template that cannot fit the contract body cap is refused, not truncated', () => {
    const wide = TEMPLATES.adapter_batch({
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
    expect(unpinned[0]).toContain('no function named')
    // Only a negative on the function names none either.
    expect(
      q([
        'and',
        [
          ['eq', ['call_contract'], C],
          ['ne', ['call_fn'], 'burn'],
        ],
      ])[0]
    ).toContain('no function named')
    // An or: the unpinned branch asks, the pinned and capped one does not.
    const mixed = q([
      'or',
      [pin('transfer', ['lte', ['call_arg', 2], amt]), ['and', [['eq', ['call_contract'], C]]]],
    ])
    expect(mixed).toHaveLength(1)
    expect(mixed[0]).toContain('no function named')
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
  })

  it('every recorded flow yields rules the contract would decode', () => {
    for (const n of ['blend', 'sep41', 'soroswap'] as const) {
      for (const r of propose(synthesize(recording(n).contexts, { limit: '1' }).intent))
        expect(() => validate(r.expr)).not.toThrow()
    }
  })
})
