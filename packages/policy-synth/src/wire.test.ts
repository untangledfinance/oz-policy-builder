import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import type { Val } from './wire.ts'
import { decode, encode, fromScVal, hashOf, toScVal, validate, WireError } from './wire.ts'

interface Case {
  name: string
  json: Val
  xdr: string
  code: number
}
const corpus: Case[] = JSON.parse(
  readFileSync(new URL('../fixtures/parity/grammar7.json', import.meta.url), 'utf8')
).cases
const REFUSED = new Set([201, 207, 216])

describe('parity with the contract (fixtures/parity/grammar7.json)', () => {
  it('has the corpus', () => expect(corpus.length).toBeGreaterThan(70))
  for (const c of corpus) {
    it(`${c.name}: same bytes, same JSON`, () => {
      expect(encode(c.json)).toBe(c.xdr)
      expect(decode(c.xdr)).toEqual(c.json)
    })
    it(`${c.name}: validate ${REFUSED.has(c.code) ? 'refuses' : 'accepts'} like check (${c.code})`, () => {
      if (REFUSED.has(c.code)) expect(() => validate(c.json)).toThrow(WireError)
      else expect(() => validate(c.json)).not.toThrow()
    })
  }
})

const HASH = 'cf1a39b616d66c17e7645d181c7842dc57f1b529006da4a7fe9380d9a5658244' // sha256 of the corpus case "eq fn", taken with sha256sum
const G = 'GDVCJST665C2GG4NNSQI6W2YIUX4HCIOEFWUJB7UDMHQEETEIGA5FTCO'

describe('the codec refuses what it cannot encode exactly', () => {
  it.each<[string, Val]>([
    ['a negative number', -1],
    ['a number past u32', 2 ** 32],
    ['a fraction', 1.5],
    ['a symbol with a space', 'a b'],
    ['an empty symbol', ''],
    ['a symbol over 32 characters', 'a'.repeat(33)],
    ['an i128 out of range', { i128: (2n ** 127n).toString() }],
    ['a u64 below zero', { u64: '-1' }],
    ['a non-integer i128', { i128: '1.5' }],
    ['an i32 out of range', { i32: 2 ** 31 }],
    ['odd-length hex', { bytes: 'abc' }],
    ['two tags in one object', { i128: '1', u64: '1' } as unknown as Val],
    ['an unknown tag', { float: 1 } as unknown as Val],
    [
      'a duplicate map key',
      {
        map: [
          ['a', 1],
          ['a', 2],
        ],
      },
    ],
  ])('%s', (_n, v) => expect(() => encode(v)).toThrow(WireError))

  it('sorts map keys the way the host does, so the map loads', () => {
    const m: Val = {
      map: [
        ['b', 1],
        ['a', 2],
        [G, 3],
      ],
    }
    expect(decode(encode(m))).toEqual({
      map: [
        ['a', 2],
        ['b', 1],
        [G, 3],
      ],
    })
    const nums: Val = {
      map: [
        [{ i64: '10' }, 1],
        [{ i64: '-2' }, 2],
      ],
    }
    expect(decode(encode(nums))).toEqual({
      map: [
        [{ i64: '-2' }, 2],
        [{ i64: '10' }, 1],
      ],
    })
    const text: Val = {
      map: [
        [{ string: 'ab' }, 1],
        [{ string: 'b' }, 2],
      ],
    }
    expect(decode(encode(text))).toEqual(text)
  })

  it('round-trips every value type, wide integers included', () => {
    const all: Val[] = [
      null,
      true,
      false,
      0,
      4294967295,
      'transfer',
      G,
      { i128: (-(2n ** 127n)).toString() },
      { u128: (2n ** 128n - 1n).toString() },
      { i256: (-(2n ** 255n)).toString() },
      { u256: (2n ** 256n - 1n).toString() },
      { u64: '18446744073709551615' },
      { i64: '-9223372036854775808' },
      { i32: -5 },
      { timepoint: '1' },
      { duration: '2' },
      { bytes: '00ff' },
      { string: 'héllo' },
      [[1, [2]], 'x'],
    ]
    for (const v of all) expect(decode(encode(v))).toEqual(v)
    expect(fromScVal(toScVal(all))).toEqual(all)
  })

  it('hashes the stored bytes', () => {
    const b64 = encode(['eq', ['call_fn'], 'pay'])
    expect(hashOf(b64)).toBe(HASH)
  })
})

describe('validate', () => {
  const sel: Val = ['eq', ['call_fn'], 'pay']
  it.each<[string, Val]>([
    ['a bare scalar', 5],
    ['an unknown operator', ['xor', 1, 2]],
    ['a comparison of three', ['eq', 1, 2, 3]],
    ['an unknown selector', ['eq', ['call_nothing'], 1]],
    ['depth 6', ['and', [['and', [['and', [['and', [['and', [sel]]]]]]]]]]],
    ['an empty and', ['and', []]],
    ['a rule that never reads the call', ['lt', ['now'], { u64: '5' }]],
    [
      '201 leaves',
      [
        'and',
        [sel, ...Array.from({ length: 99 }, (_, i) => ['in', ['call_arg', 0], [i, i + 1]] as Val)],
      ],
    ],
  ])('refuses %s', (_n, v) => expect(() => validate(v)).toThrow(WireError))

  it('counts a quantifier body 32 times', () => {
    const body = (n: number): Val => [
      'and',
      Array.from({ length: n }, (_, i) => ['eq', ['elem', i], 1] as Val),
    ]
    expect(() => validate(['all', ['call_path', 0], body(3)])).not.toThrow()
    expect(() => validate(['all', ['call_path', 0], body(4)])).toThrow(/at most 6/)
    expect(() =>
      validate([
        'and',
        [sel, ['all', ['call_path', 0], body(3)], ['all', ['call_path', 1], body(3)]],
      ])
    ).toThrow()
  })

  it('reads: four distinct calls fit, a fifth does not, one call with two paths is one', () => {
    const read = (c: number, path = 0): Val => [
      'gte',
      ['read', StrKey.encodeContract(Buffer.alloc(32, c + 1)), 'f', [], path],
      0,
    ]
    expect(() =>
      validate(['and', [sel, read(0), read(0, 1), read(1), read(2), read(3)]])
    ).not.toThrow()
    expect(() => validate(['and', [sel, read(0), read(1), read(2), read(3), read(4)]])).toThrow(
      /reads/
    )
  })

  it('refuses an encoding over the byte cap', () => {
    const big: Val = ['eq', ['call_arg', 0], ['lit', { bytes: '00'.repeat(33 * 1024) }]]
    expect(() => validate(big)).toThrow(/bytes/)
  })
})
