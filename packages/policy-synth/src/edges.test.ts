// Boundaries and exact lowerings the mutation runner found unpinned: the typed template
// parameters and what each template lowers to, card phrases, synthesis fallbacks and the
// scan's integer edges.

import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { card, operand } from './card.ts'
import type { CallIntent } from './intent.ts'
import type { Call } from './record.ts'
import { TEMPLATES, TemplateParams } from './registry.ts'
import { implies } from './rules.ts'
import { synthesize } from './synth.ts'
import { decode, type Expr, encode, type Val, validate, WireError } from './wire.ts'

const [A, C] = [account(1), contract(1)]

describe('template parameters: every bound is a bound', () => {
  const ok = (name: keyof typeof TemplateParams, p: object) =>
    TemplateParams[name].safeParse(p).success
  const batch = (o: object) => ({ adapter: C, targets: [contract(2)], ...o })
  const venue = (o: object) => ({ pool: C, token: contract(2), account: A, max: '1', ...o })
  const many = (n: number) => Array.from({ length: n }, (_, i) => contract(i + 1))

  it.each<[string, object, boolean]>([
    ['one target', batch({}), true],
    ['32 targets', batch({ targets: many(32) }), true],
    ['33 targets', batch({ targets: many(33) }), false],
    ['one function of one character', batch({ functions: ['a'] }), true],
    ['a function name of 32 characters', batch({ functions: ['a'.repeat(32)] }), true],
    ['a function name of 33', batch({ functions: ['a'.repeat(33)] }), false],
    ['32 functions', batch({ functions: Array.from({ length: 32 }, () => 'f') }), true],
    ['33 functions', batch({ functions: Array.from({ length: 33 }, () => 'f') }), false],
    ['no functions', batch({ functions: [] }), false],
    ['one call', batch({ maxCalls: 1 }), true],
    ['64 calls', batch({ maxCalls: 64 }), true],
    ['65 calls', batch({ maxCalls: 65 }), false],
  ])('adapter_batch: %s', (_n, p, want) => expect(ok('adapter_batch', p)).toBe(want))

  it.each<[string, object, boolean]>([
    ['an amount of 1', venue({ max: '1' }), true],
    ['an amount of 10', venue({ max: '10' }), true],
    ['an amount of 29', venue({ max: '29' }), true],
    ['an amount of 0', venue({ max: '0' }), false],
    ['an amount of 01', venue({ max: '01' }), false],
    ['maxType 0', venue({ maxType: 0 }), true],
    ['maxType 1', venue({ maxType: 1 }), true],
    ['maxType 2', venue({ maxType: 2 }), false],
    ['a spender and a receiver', venue({ spender: contract(3), receiver: A }), true],
  ])('blend_venue: %s', (_n, p, want) => expect(ok('blend_venue', p)).toBe(want))
})

describe('what each template lowers to', () => {
  it('adapter_batch: at most maxCalls (8 unless said), each call to a target (and function), no grants, no wait', () => {
    const intent = TEMPLATES.adapter_batch({
      adapter: C,
      targets: [contract(2)],
      functions: ['supply'],
    })
    expect(intent.calls).toEqual([
      {
        contract: C,
        fn: 'execute',
        where: [
          { rule: 'length', at: [0], max: 8 },
          {
            rule: 'each',
            at: [0],
            where: [
              { rule: 'allow', at: ['target'], in: [contract(2)] },
              { rule: 'allow', at: ['function_name'], in: ['supply'] },
            ],
          },
          { rule: 'length', at: [1], max: 0 },
          { rule: 'pin', at: [2], to: 0 },
        ],
      },
    ])
    const plain = TEMPLATES.adapter_batch({ adapter: C, targets: [contract(2)], maxCalls: 3 })
    expect(plain.calls[0]?.where?.[0]).toEqual({ rule: 'length', at: [0], max: 3 })
    expect(plain.calls[0]?.where?.[1]).toEqual({
      rule: 'each',
      at: [0],
      where: [{ rule: 'allow', at: ['target'], in: [contract(2)] }],
    })
  })

  it('blend_venue: the account pinned in all three places, one request, one token, a type up to maxType, an amount from 1 to max', () => {
    const where = (p: object) =>
      TEMPLATES.blend_venue({ pool: C, token: contract(2), account: A, max: '500', ...p }).calls[0]
        ?.where
    expect(where({})).toEqual([
      { rule: 'pin', at: [0], to: A },
      { rule: 'pin', at: [1], to: A },
      { rule: 'pin', at: [2], to: A },
      { rule: 'length', at: [3], max: 1 },
      { rule: 'pin', at: [3, 0, 'address'], to: contract(2) },
      { rule: 'cap', at: [3, 0, 'request_type'], max: '1' },
      { rule: 'floor', at: [3, 0, 'amount'], min: '1' },
      { rule: 'cap', at: [3, 0, 'amount'], max: '500' },
    ])
    const other = where({ spender: contract(3), receiver: contract(4), maxType: 0 })
    expect(other?.slice(0, 3)).toEqual([
      { rule: 'pin', at: [0], to: A },
      { rule: 'pin', at: [1], to: contract(3) },
      { rule: 'pin', at: [2], to: contract(4) },
    ])
    expect(other?.[5]).toEqual({ rule: 'cap', at: [3, 0, 'request_type'], max: '0' })
  })
})

describe('the review card, the edges', () => {
  it('the length step of a path is (count); a read with one argument names it; an in list shows its lit entries as values', () => {
    expect(card(['eq', ['call_arg_field', 3, 0, true], 1])).toEqual([
      'argument 3 > 0 > (count) must be 1',
    ])
    expect(operand(['read', C, 'price', ['USD']])).toBe(`price(USD) on ${C}`)
    expect(operand(['read', C, 'price', []])).toBe(`price() on ${C}`)
    expect(card(['in', ['call_arg', 0], [['lit', { string: 'a' }], 5]])).toEqual([
      'argument 0 must be one of ["a", 5]',
    ])
  })
})

describe('synthesis, the edges', () => {
  const unknown: Call = { contract: C, fn: 'weird', args: [A] }
  const req = (type: number): Val => ({
    map: [
      ['address', C],
      ['amount', { i128: '10' }],
      ['request_type', type],
    ],
  })
  const submit: Call = { contract: contract(5), fn: 'submit', args: [A, A, A, [req(0), req(1)]] }

  it('only calls on more than one contract earn the one-install-each warning', () => {
    expect(synthesize([unknown]).warnings.join(' ')).not.toContain('contracts')
    expect(
      synthesize([unknown, { ...unknown, contract: contract(2) }]).warnings.join(' ')
    ).toContain('2 contracts')
  })

  it('the flat fallback forgets the questions and warnings of the attempt it replaces, and only those', () => {
    const s = synthesize([unknown, submit])
    // The unknown function's warning stays; the request amount is asked once, not twice.
    expect(s.warnings.filter((w) => w.includes('weird'))).toHaveLength(1)
    expect(
      s.ambiguities.map((a) => a.question).filter((q) => q.includes('requests.amount'))
    ).toHaveLength(1)
    expect(s.ambiguities).toHaveLength(1)
  })

  it('an amount that is capped is no question, and a vec of structs with no amount field has none to ask', () => {
    expect(synthesize([submit], { limit: '50' }).ambiguities).toEqual([])
    const noAmount: Call = { ...submit, args: [A, A, A, [{ map: [['address', C]] } as Val]] }
    expect(synthesize([noAmount]).ambiguities).toEqual([])
  })
})

describe('the scan, the integer edges', () => {
  it('an equal bound in another integer type is implied (at most 5 is at most 5)', () => {
    const L: Expr = ['call_arg', 2]
    expect(implies(['lte', L, { i128: '5' }], ['lte', L, { u64: '5' }])).toBe(true)
    expect(implies(['gte', L, { i128: '5' }], ['gte', L, { u64: '5' }])).toBe(true)
    expect(implies(['lte', L, { i128: '6' }], ['lte', L, { u64: '5' }])).toBe(false)
  })
})

it('a CallIntent type is imported for the sake of the lowering rows above', () => {
  const c: CallIntent = { contract: C, fn: 'f' }
  expect(c.fn).toBe('f')
})

describe('the wire codec, the edges', () => {
  const eqLit = (v: Val): Expr => [
    'and',
    [
      ['eq', ['call_fn'], 'f'],
      ['eq', ['call_arg', 0], v],
    ],
  ]
  const lteIs = (n: Val): Expr => [
    'and',
    [
      ['eq', ['call_fn'], 'f'],
      ['lte', ['call_arg', 0], n],
    ],
  ]

  it('a string of hex digits only: stringHex takes exactly pairs of hex digits', () => {
    expect(() => encode(eqLit(['lit', { stringHex: 'zz' }]) as Expr)).toThrow(WireError)
    expect(() => encode(eqLit(['lit', { stringHex: 'abc' }]) as Expr)).toThrow(WireError)
    expect(() => encode(eqLit(['lit', { stringHex: '09afAF' }]) as Expr)).not.toThrow()
  })

  it('the i128 edges are numbers: the minimum and the maximum are accepted, one past is not', () => {
    const min = (-(2n ** 127n)).toString()
    const max = (2n ** 127n - 1n).toString()
    expect(() => validate(lteIs({ i128: min }))).not.toThrow()
    expect(() => validate(lteIs({ i128: max }))).not.toThrow()
    expect(() => encode(lteIs({ i128: (2n ** 127n).toString() }))).toThrow(WireError)
  })

  it('a scaled of constants folds like the contract: positive, within i128, nested folds included', () => {
    const scaled = (src: Val, num: Val, den: string, add: Val): Expr => [
      'and',
      [
        ['eq', ['call_fn'], 'f'],
        ['gte', ['call_arg', 0], ['scaled', src, num, { i128: den }, add]],
      ],
    ]
    const n = (x: string): Val => ({ i128: x })
    const big = (2n ** 127n - 1n).toString()
    expect(() => validate(scaled(n('2'), n('3'), '4', n('1')))).not.toThrow()
    // 2 * 3 / 4 is 1; the nested fold is positive, so it may stand for src.
    expect(() =>
      validate(scaled(['scaled', n('2'), n('3'), n('4'), n('0')], n('1'), '1', n('0')))
    ).not.toThrow()
    // A nested fold that is zero is not positive.
    expect(() =>
      validate(scaled(['scaled', n('1'), n('1'), n('2'), n('0')], n('1'), '1', n('0')))
    ).toThrow(WireError)
    // The nested fold is also read as num.
    expect(() =>
      validate(scaled(n('1'), ['scaled', n('1'), n('1'), n('2'), n('0')], '1', n('0')))
    ).toThrow(WireError)
    // The addend's constant counts in the fold: max * 1 / 1 + 1 overflows.
    expect(() => validate(scaled(n(big), n('1'), '1', n('1')))).toThrow(WireError)
    expect(() => validate(scaled(n(big), n('1'), '1', n('0')))).not.toThrow()
    // A negative addend makes the fold smaller, not an error.
    expect(() => validate(scaled(n(big), n('1'), '1', n('-1')))).not.toThrow()
    // A nested constant whose own fold overflows is refused whatever its parent is.
    expect(() =>
      validate(scaled(['scaled', n(big), n('2'), n('1'), n('0')], n('1'), '1', n('0')))
    ).toThrow(WireError)
  })

  it('a path takes a number, the length last, and a constant key, and a key is checked at depth one', () => {
    const at = (...s: Val[]): Expr => [
      'and',
      [
        ['eq', ['call_fn'], 'f'],
        ['eq', ['call_path', ...s], 1],
      ],
    ]
    expect(() => validate(at(0, 'amount', true))).not.toThrow()
    expect(() => validate(at(true, 0))).toThrow(WireError)
    expect(() => validate(at(false))).not.toThrow() // a bare constant is a key
    expect(() => validate(at([[1]]))).not.toThrow()
    expect(() => validate(at({ map: [['a', 1]] }))).toThrow(WireError)
    expect(() => validate(at([[[[[1]]]]]))).toThrow(WireError) // five deep inside a key at depth one
  })

  it('call_arg_field: two indexes, then one step', () => {
    const f = (...r: Val[]): Expr => [
      'and',
      [
        ['eq', ['call_fn'], 'f'],
        ['eq', ['call_arg_field', ...r], 1],
      ],
    ]
    expect(() => validate(f(0, 1, 'amount'))).not.toThrow()
    expect(() => validate(f(0, 'x', 'amount'))).toThrow(WireError)
    expect(() => validate(f(0, 1, [['bad']] as Val))).toThrow(WireError)
  })

  it('the keys of a map are ordered by type first, then by value, entry by entry for vecs and maps', () => {
    const keys = (...ks: Val[]): Val[] =>
      (
        (decode(encode(['lit', { map: ks.map((k) => [k, 1] as [Val, Val]) }])) as Val[])[1] as {
          map: [Val, Val][]
        }
      ).map.map(([k]) => k)
    expect(keys(['b'], ['a', 'z'], ['a'])).toEqual([['a'], ['a', 'z'], ['b']]) // a prefix is smaller
    expect(keys({ i128: '2' }, { i128: '-3' }, { i128: '10' })).toEqual([
      { i128: '-3' },
      { i128: '2' },
      { i128: '10' },
    ])
    expect(keys(true, false)).toEqual([false, true])
    expect(keys({ bytes: 'ff' }, { bytes: '0000' }, { bytes: '00' })).toEqual([
      { bytes: '00' },
      { bytes: '0000' },
      { bytes: 'ff' },
    ])
  })
})
