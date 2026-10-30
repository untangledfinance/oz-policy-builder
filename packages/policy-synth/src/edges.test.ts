// Boundaries the mutation runner found unpinned: card phrases, synthesis fallbacks and the
// scan's integer edges.

import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import type { CallIntent } from './intent.ts'
import type { Call } from './record.ts'
import { implies } from './rules.ts'
import { synthesize } from './synth.ts'
import { decode, type Expr, encode, type Val, validate, WireError } from './wire.ts'

const [A, C] = [account(1), contract(1)]

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

  it('an amount that is capped is no question; a submit whose requests omit the amount is still asked', () => {
    expect(synthesize([submit], { limit: '50' }).ambiguities).toEqual([])
    // The question is asked from the function's definition (a `submit` carries an amount per
    // request), not from whether the recorded elements include an `amount` key: omitting it must not
    // slip an uncapped Blend rule past the gate.
    const noAmount: Call = { ...submit, args: [A, A, A, [{ map: [['address', C]] } as Val]] }
    expect(synthesize([noAmount]).ambiguities.map((a) => a.code)).toEqual(['AMOUNT_BOUND_MISSING'])
    // Answering it (a cap on the amount field) settles it, even though no element was recorded with one.
    expect(synthesize([noAmount], { limit: '50' }).ambiguities).toEqual([])
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
