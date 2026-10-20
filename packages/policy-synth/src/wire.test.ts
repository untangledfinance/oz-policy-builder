import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import type { Val } from './wire.ts'
import {
  decode,
  encode,
  fromScVal,
  hashOf,
  isAddress,
  toScVal,
  validate,
  WireError,
} from './wire.ts'

interface Case {
  name: string
  json: Val
  xdr: string
  code: number
}
const corpus: Case[] = JSON.parse(
  readFileSync(new URL('../fixtures/parity/grammar.json', import.meta.url), 'utf8')
).cases
const REFUSED = new Set([201, 207, 216])

describe('parity with the contract (fixtures/parity/grammar.json)', () => {
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

// ---- the edge corpus (fixtures/parity/accuracy.json): 106 shapes at the edges of the wire
// format, as the host's canonical bytes, with what `check` says about each ----

const edges: { name: string; xdr: string; check: number; installEnforce: number }[] = JSON.parse(
  readFileSync(new URL('../fixtures/parity/accuracy.json', import.meta.url), 'utf8')
).cases

describe("the edge corpus: the host's bytes, byte for byte, and the contract's refusals, case for case", () => {
  it('has 106 cases, on which check and a real install + enforce agree', () => {
    expect(edges).toHaveLength(106)
    for (const c of edges) expect(c.check).toBe(c.installEnforce)
  })
  for (const c of edges) {
    it(`${c.name}: decode then encode gives the host's bytes`, () => {
      expect(encode(decode(c.xdr))).toBe(c.xdr)
    })
    it(`${c.name}: validate ${REFUSED.has(c.check) ? 'refuses' : 'accepts'} like check (${c.check})`, () => {
      const e = decode(c.xdr)
      if (REFUSED.has(c.check)) expect(() => validate(e)).toThrow(WireError)
      else expect(() => validate(e)).not.toThrow()
    })
  }

  it('map entries written in any order are sorted as the host sorts them', () => {
    for (const c of edges) {
      const e = decode(c.xdr)
      const flip = (v: Val): Val =>
        Array.isArray(v)
          ? v.map(flip)
          : v !== null && typeof v === 'object' && 'map' in v
            ? { map: [...v.map].reverse().map(([k, x]) => [flip(k), flip(x)] as [Val, Val]) }
            : v
      expect(encode(flip(e))).toBe(c.xdr)
    }
  })
})

describe('a string that is not text, and the empty symbol', () => {
  it('keeps the bytes of a string that is not UTF-8 (they are not text, so they are hex)', () => {
    const v: Val = { stringHex: 'fffe41' }
    const back = decode(encode(v))
    expect(back).toEqual(v)
    expect(decode(encode({ string: 'héllo €' }))).toEqual({ string: 'héllo €' })
  })
  it('the empty symbol is a symbol', () => {
    expect(decode(encode(['eq', ['call_fn'], '']))).toEqual(['eq', ['call_fn'], ''])
  })
})

const HASH = 'cf1a39b616d66c17e7645d181c7842dc57f1b529006da4a7fe9380d9a5658244' // sha256 of the corpus case "eq fn", taken with sha256sum
const G = 'GDVCJST665C2GG4NNSQI6W2YIUX4HCIOEFWUJB7UDMHQEETEIGA5FTCO'

describe('the codec refuses what it cannot encode exactly', () => {
  it.each<[string, Val]>([
    ['a negative number', -1],
    ['a number past u32', 2 ** 32],
    ['a fraction', 1.5],
    ['a symbol with a space', 'a b'],
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
    expect(() => validate(['all', ['call_path', 0], body(4)])).toThrow(/leaves, at most 200/)
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

describe('the encoding edges', () => {
  const MUXED = StrKey.encodeMed25519PublicKey(
    Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(32, 2)])
  )

  it('an address is a G, C or M strkey of the right length and alphabet; anything else is a symbol or nothing', () => {
    expect(isAddress(G)).toBe(true)
    expect(isAddress(MUXED)).toBe(true)
    expect(isAddress(`${G}A`)).toBe(false)
    expect(isAddress(`${MUXED}A`)).toBe(false)
    expect(isAddress(5)).toBe(false)
    expect(isAddress('transfer')).toBe(false)
    expect(decode(encode(MUXED))).toBe(MUXED)
    expect(() => encode(`G${'8'.repeat(55)}`)).toThrow(WireError) // '8' is not base32
    expect(() => encode(`${MUXED}A`)).toThrow(WireError)
    expect(() => encode(`M${'8'.repeat(68)}`)).toThrow(WireError)
  })

  it.each([
    ['i128', 128, true],
    ['u128', 128, false],
    ['i64', 64, true],
    ['u64', 64, false],
    ['i256', 256, true],
    ['u256', 256, false],
    ['timepoint', 64, false],
    ['duration', 64, false],
  ] as const)('%s takes its whole range and not a value past it', (tag, bits, signed) => {
    const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n
    const min = signed ? -(2n ** BigInt(bits - 1)) : 0n
    for (const n of [min, max])
      expect(decode(encode({ [tag]: n.toString() } as Val))).toEqual({ [tag]: n.toString() })
    for (const n of [max + 1n, min - 1n]) {
      if (n >= 0n || signed) expect(() => encode({ [tag]: n.toString() } as Val)).toThrow(WireError)
    }
    if (!signed) expect(() => encode({ [tag]: '-1' } as Val)).toThrow(WireError)
  })

  it('i32 takes odd and even values, its extremes, and not a value past them', () => {
    for (const n of [0, 2, -2, 7, -5, 2 ** 31 - 1, -(2 ** 31)])
      expect(decode(encode({ i32: n }))).toEqual({ i32: n })
    expect(() => encode({ i32: 2 ** 31 })).toThrow(WireError)
    expect(() => encode({ i32: -(2 ** 31) - 1 })).toThrow(WireError)
  })

  it("a map is an array of pairs, keys are unique, and the host's order is by type then value", () => {
    expect(() => encode({ map: 'x' } as unknown as Val)).toThrow(WireError)
    expect(() =>
      encode({
        map: [
          [{ i64: '1' }, 1],
          [{ i64: '1' }, 2],
        ],
      })
    ).toThrow(/duplicate/)
    expect(() =>
      encode({
        map: [
          [7, 1],
          [7, 2],
        ],
      })
    ).toThrow(/duplicate/)
    const mixed: Val = {
      map: [
        [G, 4],
        ['a', 3],
        [{ i64: '1' }, 2],
        [7, 1],
      ],
    }
    expect((decode(encode(mixed)) as { map: [Val, Val][] }).map.map(([, v]) => v)).toEqual([
      1, 2, 3, 4,
    ])
    const nums: Val = {
      map: [
        [{ u128: '9' }, 1],
        [{ u128: '10' }, 2],
        [{ u128: '2' }, 3],
      ],
    }
    expect((decode(encode(nums)) as { map: [Val, Val][] }).map.map(([, v]) => v)).toEqual([3, 1, 2])
  })
})

describe('validate: what is not a node, and the byte cap to the byte', () => {
  it('an unknown operator is refused whatever it carries, and an ordering needs a number', () => {
    expect(() => validate(['bogus', 1, ['eq', ['call_fn'], 'x']])).toThrow(/unknown operator/)
    expect(() =>
      validate([
        'and',
        [
          ['eq', ['call_fn'], 'x'],
          ['lt', ['call_arg', 0], ['lit', null]],
        ],
      ])
    ).toThrow(WireError)
    expect(() =>
      validate([
        'and',
        [
          ['eq', ['call_fn'], 'x'],
          ['lt', ['call_arg', 0], ['lit', [1]]],
        ],
      ])
    ).toThrow(WireError)
  })

  it.each<[string, unknown]>([
    ['a string', 'eq'],
    ['null', null],
    ['an object', { i128: '1' }],
    ['an empty list', []],
    ['a list led by a number', [1, 2]],
    ['a selector where a node goes', ['call_arg', 0]],
  ])('%s', (_n, v) => expect(() => validate(v as Val)).toThrow(WireError))

  it('an encoding of exactly 32 KiB is accepted, a few bytes more is refused', () => {
    const sized = (bytes: number): Val => [
      'eq',
      ['call_arg', 0],
      ['lit', { bytes: '00'.repeat(bytes) }],
    ]
    const base = Buffer.from(encode(sized(0)), 'base64').length
    const exact = 32 * 1024 - base
    expect(Buffer.from(encode(sized(exact)), 'base64').length).toBe(32 * 1024)
    expect(() => validate(sized(exact))).not.toThrow()
    expect(() => validate(sized(exact + 4))).toThrow(/32768 bytes/)
  })
})

describe('validate does not throw anything but a WireError', () => {
  it('a malformed den is refused as a wire error', () => {
    const e = (den: Val): Val => [
      'eq',
      ['call_arg', 0],
      ['scaled', ['call_arg', 1], { i128: '1' }, den, { i128: '0' }],
    ]
    expect(() => validate(e({ i128: 'abc' }))).toThrow(WireError)
    expect(() => validate(e({ i128: '0' }))).toThrow(WireError)
    expect(() => validate(e({ i128: '1000000000000000001' }))).toThrow(WireError)
    expect(() => validate(e({ i128: '1000000000000000000' }))).not.toThrow()
  })
})
