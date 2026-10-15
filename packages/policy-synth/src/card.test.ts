import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { account, contract } from '../test/fixtures.ts'
import { card, contractsOf, lines, type Node, tree, type View } from './card.ts'
import { SPENDING_LIMIT } from './config.ts'
import { decodeEnvelope } from './record.ts'
import { TEMPLATES } from './registry.ts'
import { SAC } from './spec.ts'
import { propose, synthesize } from './synth.ts'
import { decode, type Expr, validate } from './wire.ts'

const [A, B, C, D] = [account(1), account(2), contract(1), contract(2)]
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const USDC = { decimals: 7, symbol: 'USDC' }
const token: View = { info: { [C]: { fns: SAC, token: USDC } } }
const one = (e: Expr, v?: View) => card(e, v)[0] as string

describe('operators and operands are words', () => {
  it.each<[Expr, string]>([
    [['eq', ['call_fn'], 'transfer'], "the function:  must be  'transfer'"],
    [['ne', ['call_contract'], C], `the contract:  must not be  ${short(C)}`],
    [['lt', ['call_arg', 0], { i128: '5' }], 'argument 0:  must be below  5'],
    [['lte', ['call_arg', 2], { i128: '100' }], 'argument 2:  must be at most  100'],
    [['gt', ['call_arg', 2], 0], 'argument 2:  must be above  0'],
    [['gte', ['call_arg', 2], { u64: '7' }], 'argument 2:  must be at least  7'],
    [['in', ['call_arg', 1], [A, C]], `argument 1:  must be one of  [${short(A)}, ${short(C)}]`],
    [['nin', ['call_arg', 1], [A]], `argument 1:  must not be one of  [${short(A)}]`],
    [
      ['eq', ['call_path', 3, 0, 'amount'], { i128: '1' }],
      'argument 3 › [0] › amount:  must be  1',
    ],
    [['lte', ['call_path', 3, true], 2], 'the number of items in argument 3:  must be at most  2'],
    [['lte', ['call_arg_len', 3], 2], 'the number of items in argument 3:  must be at most  2'],
    [['eq', ['call_arg_field', 3, 0, 'amount'], 1], 'argument 3 › [0] › amount:  must be  1'],
    [
      ['eq', ['call_arg_field', 3, 0, true], 1],
      'the number of items in argument 3 › [0]:  must be  1',
    ],
    [['eq', ['call_arg', 0], ['lit', { string: 'memo' }]], 'argument 0:  must be  "memo"'],
    [['eq', ['call_arg', 0], ['lit', { bytes: 'ab' }]], 'argument 0:  must be  0xab'],
    [
      ['eq', ['call_arg', 0], ['lit', ['Stellar', A]]],
      `argument 0:  must be  ['Stellar', ${short(A)}]`,
    ],
    [['eq', ['call_arg', 0], ['lit', true]], 'argument 0:  must be  true'],
    [['eq', ['call_arg', 0], null], 'argument 0:  must be  null'],
    [
      ['in', ['call_arg', 0], [['lit', { string: 'a' }], 5]],
      'argument 0:  must be one of  ["a", 5]',
    ],
    [['eq', ['call_path', 3, ['lit', 'amount']], 1], 'argument 3 › amount:  must be  1'],
    [
      ['eq', ['call_arg', 0], ['lit', { map: [['k', { i128: '1' }]] }]],
      "argument 0:  must be  {'k': 1 (i128)}",
    ],
    [
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, { i128: '0' }],
      ],
      'argument 1:  must be at least  argument 0 × 99 ÷ 100',
    ],
    [
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, ['call_arg', 3]],
      ],
      'argument 1:  must be at least  argument 0 × 99 ÷ 100 + argument 3',
    ],
    [
      ['gte', ['read', C, 'price', [['call_arg', 1], 'USD'], 'price'], { i128: '5' }],
      `price(argument 1, 'USD') on ${short(C)} › price:  must be at least  5`,
    ],
    [
      ['gte', ['read', C, 'price', []], { i128: '5' }],
      `price() on ${short(C)}:  must be at least  5`,
    ],
    [
      [
        'eq',
        [
          'read',
          C,
          'f',
          [
            ['lit', 5],
            ['lit', { string: 'k' }],
          ],
        ],
        1,
      ],
      `f(5, "k") on ${short(C)}:  must be  1`,
    ],
    [
      [
        'gte',
        ['call_arg', 1],
        [
          'scaled',
          ['scaled', ['call_arg', 0], 2, { i128: '3' }, 0],
          ['lit', 4],
          { i128: '5' },
          ['lit', 6],
        ],
      ],
      'argument 1:  must be at least  (argument 0 × 2 ÷ 3) × 4 ÷ 5 + 6',
    ],
    [
      ['lte', ['sum', ['call_arg', 0], 'amount'], { i128: '9' }],
      'the total of amount in argument 0:  must be at most  9',
    ],
  ])('%j', (expr, text) => expect(one(expr)).toBe(text))

  it('an unknown operator is shown as written, never as a phrase from the prototype', () => {
    expect(one(['constructor', ['call_arg', 0], 1] as Expr)).toBe('argument 0:  constructor  1')
    expect(one(['toString', ['call_arg', 0], 1] as Expr)).toBe('argument 0:  toString  1')
  })

  it('a constant on the left is read as written (and in its own unit)', () => {
    expect(one(['lte', 7, ['call_arg', 2]])).toBe('7:  must be at most  argument 2')
    expect(
      card(
        [
          'and',
          [
            ['eq', ['call_fn'], 'transfer'],
            ['lte', { i128: '70000000' }, ['call_arg', 2]],
          ],
        ],
        tokenOf(['transfer'])
      ).at(-1)
    ).toBe('   └─ 7 USDC (70000000):  must be at most  amount')
  })
})

/** A view in which C is a token and its function `fn` takes `params`. */
function tokenOf(fns: string[], params: [string, unknown][] = SAC.transfer as [string, unknown][]) {
  const v: View = {
    info: { [C]: { fns: Object.fromEntries(fns.map((f) => [f, params])) as never, token: USDC } },
  }
  return { ...v, contract: C }
}

describe('names from the contract interface', () => {
  // The function comes from a pin in the rule: a bare leaf has none, so lift it with an `and`.
  const inPay = (leaf: Expr, v: View = {}): string[] =>
    card(['and', [['eq', ['call_fn'], 'pay'], leaf]], {
      contract: C,
      info: {
        [C]: {
          fns: {
            pay: [
              [
                'payments',
                {
                  vec: {
                    fields: {
                      to: 'address',
                      amount: 'i128',
                      memo: { map: 'string' },
                      pair: { tuple: ['u32', 'address'] },
                    },
                  },
                },
              ],
              ['note', 'string'],
              ['pool', { fields: { owner: 'address', limits: { vec: 'i128' } } }],
            ],
          },
        },
      },
      ...v,
    })

  it('call_arg is the parameter, a path walks struct fields, vector indices, tuples and map keys', () => {
    expect(inPay(['eq', ['call_arg', 1], { string: 'x' }]).at(-1)).toContain('note:  must be  "x"')
    expect(inPay(['eq', ['call_path', 0, 0, 'to'], A]).at(-1)).toContain(
      `payments › [0] › to:  must be  ${short(A)}`
    )
    expect(inPay(['eq', ['call_arg_field', 0, 3, 'to'], A]).at(-1)).toContain(
      'payments › [3] › to:'
    )
    expect(
      inPay(['eq', ['call_path', 0, 1, 'memo', ['lit', { string: 'k' }]], { string: 'v' }]).at(-1)
    ).toContain('payments › [1] › memo › "k":  must be  "v"')
    expect(inPay(['eq', ['call_path', 0, 0, 'memo', 'sym'], { string: 'v' }]).at(-1)).toContain(
      'memo › sym:'
    )
    expect(inPay(['eq', ['call_path', 0, 0, 'pair', 1], A]).at(-1)).toContain('pair › [1]:')
    expect(inPay(['lte', ['call_path', 2, 'limits', true], 3]).at(-1)).toContain(
      'the number of items in pool › limits:'
    )
    expect(inPay(['lte', ['call_arg_len', 0], 3]).at(-1)).toContain(
      'the number of items in payments:'
    )
  })

  it('names the function by its signature, from a pin in the rule', () => {
    expect(inPay(['eq', ['call_arg', 1], { string: 'x' }])[1]).toBe('└─ pay(payments, note, pool)')
  })

  it.each<[string, Expr]>([
    ['an argument past the end', ['eq', ['call_arg', 9], 1]],
    ['a field that is not there', ['eq', ['call_path', 0, 0, 'nope'], 1]],
    ['a field name where a vector wants an index', ['eq', ['call_path', 0, 'to'], 1]],
    ['an index where a struct wants a field', ['eq', ['call_path', 2, 0], 1]],
    ['a tuple index past the end', ['eq', ['call_path', 0, 0, 'pair', 5], 1]],
    ['a step into a number', ['eq', ['call_path', 0, 0, 'amount', 'x'], 1]],
  ])('%s keeps the wire wording, never a guess', (_n, leaf) => {
    const out = inPay(leaf).at(-1) as string
    expect(out).toMatch(/^ +└─ argument \d/)
    expect(out).not.toContain('payments')
  })

  it('no interface, a function the interface lacks, or no pinned function: "argument N"', () => {
    expect(
      card(
        [
          'and',
          [
            ['eq', ['call_fn'], 'pay'],
            ['eq', ['call_arg', 0], 1],
          ],
        ],
        { contract: C }
      )
    ).toEqual([short(C), '└─ pay', '   └─ argument 0:  must be  1'])
    expect(inPay(['eq', ['call_arg', 0], 1], { contract: D }).at(-1)).toBe(
      '   └─ argument 0:  must be  1'
    )
    const other = card(
      [
        'and',
        [
          ['eq', ['call_fn'], 'other'],
          ['eq', ['call_arg', 0], 1],
        ],
      ],
      tokenOf(['pay'])
    )
    expect(other.at(-1)).toBe('   └─ argument 0:  must be  1')
    expect(card(['eq', ['call_arg', 0], 1], tokenOf(['pay']))[0]).toBe(`${short(C)}  (token)`)
  })

  it('--raw: the wire index follows each name, addresses and values are as written', () => {
    const e: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '50000000000' }],
      ],
    ]
    expect(card(e, { ...tokenOf(['transfer']), raw: true }).at(-1)).toBe(
      `   └─ amount (argument 2):  must be at most  50000000000 (i128)`
    )
    expect(card(e, tokenOf(['transfer'])).at(-1)).toBe(
      '   └─ amount:  must be at most  5,000 USDC (50000000000)'
    )
  })

  it('the node says where its name came from, and the wire leaf it stands for', () => {
    const leaf: Expr = ['lte', ['call_arg', 2], { i128: '5' }]
    const [n] = tree(['and', [['eq', ['call_fn'], 'transfer'], leaf]], tokenOf(['transfer']))
    const fn = n?.children?.[0] as Node
    expect(fn).toMatchObject({
      op: 'function',
      label: 'transfer(from, to, amount)',
      value: 'transfer',
    })
    expect(fn.children?.[0]).toMatchObject({
      label: 'amount',
      op: 'lte',
      index: 'argument 2',
      raw: leaf,
    })
  })
})

describe('quantifiers say what they range over, and name the fields of the item', () => {
  const view = (param: string, item: unknown): View => ({
    contract: C,
    info: { [C]: { fns: { pay: [[param, { vec: item as never }]] } } },
  })
  const rule = (inner: Expr): Expr => ['and', [['eq', ['call_fn'], 'pay'], inner]]

  it('every item of the parameter, then the field of the item', () => {
    const out = card(
      rule(['all', ['call_arg', 0], ['eq', ['elem', 'to'], A]]),
      view('payments', { fields: { to: 'address' } })
    )
    expect(out.slice(2)).toEqual([
      '   └─ every item of payments',
      `      └─ the item › to:  must be  ${short(A)}`,
    ])
  })

  it('some, and an item that is a plain value is the item', () => {
    const out = card(rule(['any', ['call_arg', 0], ['eq', ['elem'], A]]), view('payers', 'address'))
    expect(out.slice(2)).toEqual([
      '   └─ some item of payers',
      `      └─ the item:  must be  ${short(A)}`,
    ])
  })

  it('a field the item does not have keeps the wire wording', () => {
    const out = card(
      rule(['all', ['call_arg', 0], ['eq', ['elem', 'nope'], A]]),
      view('payments', { fields: { to: 'address' } })
    )
    expect(out.at(-1)).toBe(`      └─ the item › nope:  must be  ${short(A)}`)
  })

  it("without an interface it reads as it always did: the item's path", () => {
    const e: Expr = [
      'all',
      ['call_arg', 0],
      [
        'and',
        [
          ['in', ['elem', 'to'], [A]],
          ['gte', ['elem', 'amount'], 0],
        ],
      ],
    ]
    expect(card(e)).toEqual([
      'every item of argument 0',
      `├─ the item › to:  must be one of  [${short(A)}]`,
      '└─ the item › amount:  must be at least  0',
    ])
    expect(card(['any', ['call_arg', 0], ['eq', ['elem'], 'repay']])).toEqual([
      'some item of argument 0',
      "└─ the item:  must be  'repay'",
    ])
  })
})

describe('amounts', () => {
  const amount = (n: string, v: View = token): string =>
    card(
      [
        'and',
        [
          ['eq', ['call_fn'], 'transfer'],
          ['lte', ['call_arg', 2], { i128: n }],
        ],
      ],
      { contract: C, ...v }
    ).at(-1) as string

  it('a token amount is grouped, in its symbol, with the raw number after it', () => {
    expect(amount('50000000000')).toContain('amount:  must be at most  5,000 USDC (50000000000)')
    expect(amount('1')).toContain('0.0000001 USDC (1)')
    expect(amount('15000000')).toContain('1.5 USDC (15000000)')
    expect(amount('123456789012345678901234567890')).toContain(
      '12,345,678,901,234,567,890,123.456789 USDC'
    )
    expect(amount('-5000000')).toContain('-0.5 USDC (-5000000)')
    expect(amount('0')).toContain('  0 USDC (0)')
  })

  it('decimals 0, and no token at all: the number alone', () => {
    const t = (token: object): View => ({ info: { [C]: { fns: SAC, token } as never } })
    expect(amount('1234', t({ decimals: 0, symbol: 'X' }))).toContain('1,234 X (1234)')
    expect(amount('50000000000', { info: {} }).endsWith('  50000000000')).toBe(true)
    expect(amount('50000000000', { info: { [C]: { fns: SAC } } }).endsWith('  50000000000')).toBe(
      true
    )
  })

  it("only the SEP-41 amount of the token's own function: nothing is guessed from a name", () => {
    const fns = {
      transfer: [
        ['from', 'address'],
        ['to', 'address'],
        ['amount', 'i128'],
      ],
    }
    const notToken: View = { info: { [C]: { fns: fns as never } } }
    expect(amount('50000000000', notToken).endsWith('  50000000000')).toBe(true)
    const e = (fn: string, name: string, ty: string, v: unknown): string =>
      card(
        [
          'and',
          [
            ['eq', ['call_fn'], fn],
            ['eq', ['call_arg', 0], v as Expr],
          ],
        ],
        { contract: C, info: { [C]: { fns: { [fn]: [[name, ty]] } as never, token: USDC } } }
      ).at(-1) as string
    const ten = { i128: '10000000' }
    expect(e('transfer', 'amount', 'i128', ten)).toContain('1 USDC (10000000)')
    expect(e('approve', 'amount', 'i128', ten)).toContain('1 USDC (10000000)')
    // Another function of the token, another parameter name or type, another value type.
    for (const [fn, name, ty, v] of [
      ['deposit', 'amount', 'i128', ten],
      ['transfer', 'max_amount', 'i128', ten],
      ['transfer', 'amount_in', 'i128', ten],
      ['transfer', 'price', 'i128', ten],
      ['transfer', 'amounts', 'i128', ten],
      ['transfer', 'amount', 'u64', { u64: '10000000' }],
    ] as const)
      expect(e(fn, name, ty, v)).not.toContain('USDC')
  })

  it('never the unit of one contract on the amount of another', () => {
    const [x, y] = [contract(11), contract(12)]
    const info: View['info'] = {
      [x]: { fns: SAC, token: { decimals: 7, symbol: 'AAA' } },
      [y]: { fns: SAC },
    }
    const rule = (c: string): Expr => [
      'and',
      [
        ['eq', ['call_contract'], c],
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '50000000000' }],
      ],
    ]
    expect(card(['or', [rule(x), rule(y)]], { info }).join('\n')).toMatch(
      /5,000 AAA \(50000000000\)(.|\n)*at most {2}50000000000$/
    )
  })

  it('a struct field named amount is raw, in a list and in an in-list', () => {
    const v: View = {
      contract: C,
      info: {
        [C]: { fns: { pay: [['payments', { vec: { fields: { amount: 'i128' } } }]] }, token: USDC },
      },
    }
    const out = card(
      [
        'and',
        [
          ['eq', ['call_fn'], 'pay'],
          ['in', ['call_path', 0, 0, 'amount'], [{ i128: '10000000' }, { i128: '20000000' }]],
        ],
      ],
      v
    )
    expect(out.at(-1)).toContain('payments › [0] › amount:  must be one of  [10000000, 20000000]')
  })

  it('--raw shows the number alone', () => {
    expect(amount('50000000000', { ...token, raw: true })).toContain(
      '(argument 2):  must be at most  50000000000'
    )
  })
})

describe('labels', () => {
  it('addresses are shortened, with the name the request gave them', () => {
    const v: View = { labels: { [A]: 'treasury', [D]: 'vault' } }
    expect(one(['eq', ['call_arg', 0], A], v)).toBe(
      `argument 0:  must be  ${short(A)} («treasury»)`
    )
    expect(one(['nin', ['call_arg', 1], [A, B]], v)).toBe(
      `argument 1:  must not be one of  [${short(A)} («treasury»), ${short(B)}]`
    )
    expect(one(['gte', ['read', D, 'balance', [A]], { i128: '1' }], v)).toBe(
      `balance(${short(A)} («treasury»)) on ${short(D)} («vault»):  must be at least  1`
    )
  })

  it('the pins of this package are known by name; the request cannot rename them', () => {
    const sl = SPENDING_LIMIT.testnet
    expect(one(['eq', ['call_arg', 0], sl])).toBe(
      `argument 0:  must be  ${short(sl)} (spending limit)`
    )
    // The package's own name wins: a request cannot call its policy contracts something else.
    expect(one(['eq', ['call_arg', 0], sl], { labels: { [sl]: 'my cap' } })).toContain(
      '(spending limit)'
    )
  })

  it('--raw: the whole address, and still its name', () => {
    expect(one(['eq', ['call_arg', 0], A], { labels: { [A]: 'treasury' }, raw: true })).toBe(
      `argument 0:  must be  ${A} («treasury»)`
    )
  })

  it('a header: the name, the short address, and whether it is a token', () => {
    const e: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_fn'], 'transfer'],
      ],
    ]
    expect(card(e, { labels: { [C]: 'USDC test' }, ...token })[0]).toBe(
      `«USDC test»  ${short(C)}  (token)`
    )
    expect(card(e)[0]).toBe(short(C))
    expect(card(e, { raw: true })[0]).toBe(C)
  })
})

describe('time', () => {
  it('a compare against the ledger time is a UTC date', () => {
    expect(one(['gte', ['now'], { u64: '1798761600' }])).toBe(
      'the ledger time:  must be at least  2027-01-01 00:00:00 UTC (1798761600)'
    )
    expect(one(['lt', ['now'], 1830297600])).toBe(
      'the ledger time:  must be below  2028-01-01 00:00:00 UTC (1830297600)'
    )
    expect(one(['lt', ['now'], { timepoint: '1830297600' }])).toContain(
      '2028-01-01 00:00:00 UTC (1830297600)'
    )
    expect(one(['lte', ['now'], { i128: '1900000000' }])).toContain(
      '2030-03-17 17:46:40 UTC (1900000000)'
    )
  })

  it('the first and the last second of the calendar, and one past it', () => {
    expect(one(['gte', ['now'], { u64: '0' }])).toContain('1970-01-01 00:00:00 UTC (0)')
    expect(one(['lte', ['now'], { u64: '253402300799' }])).toContain(
      '9999-12-31 23:59:59 UTC (253402300799)'
    )
    expect(one(['lte', ['now'], { u64: '253402300800' }])).toContain('  253402300800')
    expect(one(['lte', ['now'], { i128: '-1' }])).toContain('  -1')
  })

  it('what is not a plausible time, and --raw, stays a number', () => {
    expect(one(['lte', ['now'], { u64: '99999999999999' }])).toBe(
      'the ledger time:  must be at most  99999999999999'
    )
    expect(one(['gte', ['now'], { u64: '1798761600' }], { raw: true })).toBe(
      'the ledger time:  must be at least  1798761600 (u64)'
    )
    expect(one(['eq', ['call_arg', 0], { u64: '1798761600' }])).toBe(
      'argument 0:  must be  1798761600'
    )
  })
})

describe('the tree', () => {
  const pay: Expr = [
    'and',
    [
      ['eq', ['call_fn'], 'transfer'],
      ['lte', ['call_arg', 2], { i128: '100' }],
    ],
  ]
  const approve: Expr = [
    'and',
    [
      ['eq', ['call_fn'], 'approve'],
      ['lte', ['call_arg', 2], { i128: '5' }],
    ],
  ]

  it('contract, then function, then what is left of the rule', () => {
    const e: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_fn'], 'transfer'],
        ['eq', ['call_arg', 0], A],
        ['nin', ['call_arg', 1], [B]],
        ['lte', ['call_arg', 2], { i128: '50000000000' }],
      ],
    ]
    expect(card(e, { ...token, labels: { [A]: 'treasury' } })).toEqual([
      `${short(C)}  (token)`,
      '└─ transfer(from, to, amount)',
      `   ├─ from:  must be  ${short(A)} («treasury»)`,
      `   ├─ to:  must not be one of  [${short(B)}]`,
      '   └─ amount:  must be at most  5,000 USDC (50000000000)',
    ])
  })

  it('an or of and: each branch is its own group, the order is the rule’s', () => {
    expect(card(['or', [pay, approve]])).toEqual([
      'any one of',
      '├─ transfer',
      '│  └─ argument 2:  must be at most  100',
      '└─ approve',
      '   └─ argument 2:  must be at most  5',
    ])
  })

  it('a branch with several conditions and no pin is "all of"; one condition is itself', () => {
    const e: Expr = [
      'or',
      [
        [
          'and',
          [
            ['eq', ['call_arg', 0], 1],
            ['eq', ['call_arg', 1], 2],
          ],
        ],
        ['and', [['eq', ['call_arg', 0], 3]]],
        ['eq', ['call_arg', 1], 4],
      ],
    ]
    expect(card(e)).toEqual([
      'any one of',
      '├─ all of',
      '│  ├─ argument 0:  must be  1',
      '│  └─ argument 1:  must be  2',
      '├─ argument 0:  must be  3',
      '└─ argument 1:  must be  4',
    ])
  })

  it('an and under an and stays a group (nothing is merged), an and under an or is never flattened into it', () => {
    const flat: Expr = [
      'or',
      [
        ['eq', ['call_fn'], 'transfer'],
        ['lte', ['call_arg', 2], { i128: '100' }],
        ['eq', ['call_fn'], 'approve'],
        ['lte', ['call_arg', 2], { i128: '5' }],
      ],
    ]
    expect(card(flat)).not.toEqual(card(['or', [pay, approve]]))
    expect(card(flat)).toHaveLength(5)
    expect(
      card([
        'and',
        [
          ['eq', ['call_arg', 0], 1],
          [
            'and',
            [
              ['eq', ['call_arg', 1], 2],
              ['eq', ['call_arg', 1], 3],
            ],
          ],
        ],
      ])
    ).toEqual([
      'argument 0:  must be  1',
      'all of',
      '├─ argument 1:  must be  2',
      '└─ argument 1:  must be  3',
    ])
  })

  it('nested or, and, all and any, with the bars carried down', () => {
    const rule: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        [
          'or',
          [
            pay,
            [
              'and',
              [
                ['eq', ['call_fn'], 'pay'],
                [
                  'all',
                  ['call_arg', 0],
                  [
                    'or',
                    [
                      ['eq', ['elem', 'to'], A],
                      ['eq', ['elem', 'to'], B],
                    ],
                  ],
                ],
                ['any', ['call_arg', 0], ['eq', ['elem'], 'x']],
              ],
            ],
          ],
        ],
      ],
    ]
    expect(card(rule)).toEqual([
      short(C),
      '└─ any one of',
      '   ├─ transfer',
      '   │  └─ argument 2:  must be at most  100',
      '   └─ pay',
      '      ├─ every item of argument 0',
      '      │  └─ any one of',
      `      │     ├─ the item › to:  must be  ${short(A)}`,
      `      │     └─ the item › to:  must be  ${short(B)}`,
      '      └─ some item of argument 0',
      "         └─ the item:  must be  'x'",
    ])
  })

  it('a rule scoped to a contract by its context rule gets that contract as its header', () => {
    expect(card(pay, tokenOf(['transfer']))).toEqual([
      `${short(C)}  (token)`,
      '└─ transfer(from, to, amount)',
      '   └─ amount:  must be at most  0.00001 USDC (100)',
    ])
    // One the predicate pins itself is not repeated.
    const same: Expr = ['and', [['eq', ['call_contract'], C], ...(pay[1] as Expr[])]]
    expect(card(same, tokenOf(['transfer']))[0]).toBe(`${short(C)}  (token)`)
    expect(card(same, tokenOf(['transfer']))).toHaveLength(3)
    // A rule scoped to C whose predicate pins D can never permit: both are said.
    const other: Expr = ['and', [['eq', ['call_contract'], D], ...(pay[1] as Expr[])]]
    const out = card(other, tokenOf(['transfer']))
    expect(out.slice(0, 2)).toEqual([`${short(C)}  (token)`, `└─ ${short(D)}`])
    // And a pin in only one branch does not hide the scope of the other.
    const some: Expr = ['or', [other, approve]]
    expect(card(some, tokenOf(['transfer']))[0]).toBe(`${short(C)}  (token)`)
  })

  it('a pin that is not a plain constant is a condition like any other', () => {
    expect(
      card([
        'and',
        [
          ['in', ['call_fn'], ['a', 'b']],
          ['ne', ['call_contract'], C],
        ],
      ])
    ).toEqual([
      "the function:  must be one of  ['a', 'b']",
      `the contract:  must not be  ${short(C)}`,
    ])
    expect(
      card([
        'and',
        [
          ['eq', ['call_fn'], ['read', C, 'f', []]],
          ['eq', ['call_arg', 0], 1],
        ],
      ])[0]
    ).toContain('the function:  must be')
  })

  it('every node carries its raw leaf or group; a scope header has none', () => {
    const [h] = tree(pay, { contract: C })
    expect(h).toMatchObject({ op: 'contract', raw: null, value: C })
    const [t] = tree(['or', [pay, approve]])
    expect(t?.raw).toEqual(['or', [pay, approve]])
    expect(JSON.parse(JSON.stringify(t)).children[0].raw).toEqual(['eq', ['call_fn'], 'transfer'])
  })

  it('a node with nothing under it has no children, not an empty list', () => {
    expect(tree(['and', [['eq', ['call_contract'], C]]])[0]).not.toHaveProperty('children')
    expect(tree(['eq', ['call_arg', 0], 1])[0]).not.toHaveProperty('children')
  })

  it('a non-node is shown as the value it is', () => {
    expect(card(5 as unknown as Expr)).toEqual(['5'])
    expect(lines([])).toEqual([])
  })
})

describe('only a real pin is lifted into a header', () => {
  it('a constant that spells a selector compares two constants (never true): it stays a condition', () => {
    for (const head of ['call_contract', 'call_fn']) {
      const e: Expr = [
        'and',
        [
          ['eq', head === 'call_contract' ? head : ['call_contract'], C],
          ['eq', head === 'call_fn' ? head : ['call_fn'], 'transfer'],
          ['lte', ['call_arg', 2], { i128: '5' }],
        ],
      ]
      validate(e)
      const nodes = tree(e, token)
      const fake = (ns: Node[]): Node[] => ns.flatMap((n) => [n, ...fake(n.children ?? [])])
      const lifted = fake(nodes).find(
        (n) => n.op === (head === 'call_fn' ? 'function' : 'contract')
      )
      expect(lifted?.raw).not.toEqual(['eq', head, head === 'call_fn' ? 'transfer' : C])
      expect(card(e, token).join('\n')).toContain(`'${head}':  must be`)
    }
  })
  it('eq(call_fn symbol, call_fn symbol) is always true: it is not a function the rule pins', () => {
    const e: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', 'call_fn', 'call_fn'],
        ['lte', ['call_arg', 2], { i128: '5' }],
      ],
    ]
    validate(e)
    expect(tree(e, token)[0]?.children?.[0]?.op).not.toBe('function')
    expect(card(e, token)).toContain("├─ 'call_fn':  must be  'call_fn'")
  })
})

describe('a Blend request', () => {
  const [POOL, TOK] = [contract(5), contract(6)]
  const r = propose(
    TEMPLATES.blend_venue({ pool: POOL, token: TOK, account: A, max: '5000000000' })
  )[0]
  const info = {
    [POOL]: {
      fns: {
        submit: [
          ['from', 'address'],
          ['spender', 'address'],
          ['to', 'address'],
          [
            'requests',
            { vec: { fields: { address: 'address', amount: 'i128', request_type: 'u32' } } },
          ],
        ],
      },
    },
  } as unknown as View['info']

  it('names the request fields; the amount is a pool amount, not a token one, so it stays raw', () => {
    expect(card((r as { expr: Expr }).expr, { info, labels: { [A]: 'treasury' } })).toEqual([
      short(POOL),
      '└─ submit(from, spender, to, requests)',
      `   ├─ from:  must be  ${short(A)} («treasury»)`,
      `   ├─ spender:  must be  ${short(A)} («treasury»)`,
      `   ├─ to:  must be  ${short(A)} («treasury»)`,
      '   ├─ the number of items in requests:  must be at most  1',
      `   ├─ requests › [0] › address:  must be  ${short(TOK)}`,
      '   ├─ requests › [0] › request_type:  must be at most  1',
      '   ├─ requests › [0] › amount:  must be at least  1',
      '   └─ requests › [0] › amount:  must be at most  5000000000',
    ])
  })

  it('and without the interface, the wire wording', () => {
    const out = card((r as { expr: Expr }).expr)
    expect(out[1]).toBe('└─ submit')
    expect(out[4]).toBe(`   ├─ argument 2:  must be  ${short(A)}`)
    expect(out.at(-1)).toBe('   └─ argument 3 › [0] › amount:  must be at most  5000000000')
  })
})

describe('contractsOf', () => {
  it('the contracts a predicate pins (a read target or a ne names no argument)', () => {
    const e: Expr = [
      'or',
      [
        [
          'and',
          [
            ['eq', ['call_contract'], C],
            ['gte', ['read', D, 'b', []], 1],
          ],
        ],
        ['ne', ['call_contract'], B],
      ],
    ]
    expect([...contractsOf(e)].sort()).toEqual([C])
  })
})

// ---- never misstate: the tree is the rule, nothing more or less ----

/** The predicate a tree stands for, rebuilt from its `raw`s and its shape alone. */
function rebuild(n: Node): Expr {
  const kids = (n.children ?? []).map(rebuild)
  if (n.op === 'contract' || n.op === 'function')
    return ['and', [...(n.raw ? [n.raw] : []), ...kids]]
  if (n.op === 'and' || n.op === 'or') return [n.op, kids]
  if (n.op === 'all' || n.op === 'any') return [n.op, (n.raw as Expr[])[1] as Expr, ['and', kids]]
  return n.raw as Expr
}
/** An `and` is a set of conditions: flattened, sorted, and its own self when alone. */
function canon(e: Expr): Expr {
  if (!Array.isArray(e) || typeof e[0] !== 'string') return e
  const [op, a, b] = e as [string, Expr, Expr]
  if (op === 'and') {
    const all = (a as Expr[]).flatMap((x) => {
      const c = canon(x)
      return Array.isArray(c) && c[0] === 'and' ? (c[1] as Expr[]) : [c]
    })
    all.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
    return all.length === 1 ? (all[0] as Expr) : ['and', all]
  }
  if (op === 'or') return ['or', (a as Expr[]).map(canon)]
  if (op === 'all' || op === 'any') return [op, a, canon(b)]
  return e
}
const leaves = (e: Expr, out: string[] = []): string[] => {
  const [op, a, b] = e as [string, Expr, Expr]
  if (op === 'and' || op === 'or') for (const x of a as Expr[]) leaves(x, out)
  else if (op === 'all' || op === 'any') leaves(b, out)
  else out.push(JSON.stringify(e))
  return out
}
const walk = (ns: Node[]): Node[] => ns.flatMap((n) => [n, ...walk(n.children ?? [])])
/** The leaves a tree shows: every node that is not a group, from its raw. */
const shownLeaves = (ns: Node[]) =>
  walk(ns).flatMap((n) =>
    n.raw && !['and', 'or', 'all', 'any'].includes(n.op) ? [JSON.stringify(n.raw)] : []
  )

/** The tree and the predicate say the same thing: same structure, every leaf exactly once. */
export function roundTrips(e: Expr, v: View = {}, ns: Node[] = tree(e, v)) {
  const rebuilt = ns.length === 1 ? rebuild(ns[0] as Node) : ['and', ns.map(rebuild)]
  expect(canon(rebuilt as Expr)).toEqual(canon(e))
  expect(shownLeaves(ns).sort()).toEqual(leaves(e).sort())
  const subtrees = new Set<string>()
  const all = (x: Expr) => {
    subtrees.add(JSON.stringify(x))
    const [op, a, b] = x as [string, Expr, Expr]
    if (op === 'and' || op === 'or') for (const y of a as Expr[]) all(y)
    if (op === 'all' || op === 'any') all(b)
  }
  all(e)
  for (const n of walk(ns)) if (n.raw) expect(subtrees.has(JSON.stringify(n.raw))).toBe(true)
  // The text has a line for every node.
  expect(lines(ns)).toHaveLength(walk(ns).length)
}

const corpus = (f: string): { name: string; xdr?: string; json?: Expr }[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/parity/${f}.json`, import.meta.url), 'utf8')).cases

describe('round trip: every node is one leaf or group of the predicate, every leaf once', () => {
  const rich: View = {
    contract: C,
    labels: { [A]: 'a' },
    info: { [C]: { fns: SAC, token: USDC } },
  }
  for (const f of ['grammar7', 'accuracy'])
    for (const c of corpus(f)) {
      const e = c.json ?? decode(c.xdr as string)
      let valid = true
      try {
        validate(e)
      } catch {
        valid = false
      }
      // A rule the contract would refuse is not described (the tools describe only what validates; a
      // predicate read off the chain that does not decode into a rule is reported as such).
      it(`${f}: ${c.name}`, () => {
        if (valid) {
          roundTrips(e)
          roundTrips(e, rich)
          roundTrips(e, { raw: true })
        }
      })
    }

  it('the 33 real transactions: every rule they synthesise, with and without names', () => {
    const real: { envelopeXdr: string }[] = JSON.parse(
      readFileSync(new URL('../fixtures/corpus/mainnet.json', import.meta.url), 'utf8')
    )
    let rules = 0
    for (const t of real) {
      const rec = decodeEnvelope(t.envelopeXdr, 'mainnet')
      for (const limit of ['1000000000000000000', undefined])
        for (const r of propose(synthesize(rec.contexts, { limit }).intent)) {
          roundTrips(r.expr)
          roundTrips(r.expr, {
            contract: r.contract,
            info: { [r.contract]: { fns: SAC, token: USDC } },
          })
          rules++
        }
    }
    expect(rules).toBeGreaterThanOrEqual(66)
  })

  it('and a hand-made rule using every construct', () => {
    const e: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        [
          'or',
          [
            [
              'and',
              [
                ['eq', ['call_fn'], 'a'],
                ['lte', ['call_arg', 0], { i128: '1' }],
                ['in', ['call_arg', 1], [A, B]],
              ],
            ],
            [
              'and',
              [
                ['eq', ['call_fn'], 'b'],
                ['all', ['call_arg', 0], ['gte', ['elem', 'x'], 0]],
                ['lte', ['sum', ['call_arg', 1], 'y'], 5],
              ],
            ],
            [
              'and',
              [
                [
                  'gte',
                  ['read', D, 'balance', [['call_arg', 0]]],
                  ['scaled', ['call_arg', 1], { i128: '3' }, { i128: '4' }, { i128: '0' }],
                ],
                ['lt', ['now'], 5],
              ],
            ],
          ],
        ],
      ],
    ]
    validate(e)
    roundTrips(e)
  })

  it('a tree that dropped a leaf, moved one under an or, or merged an and into an or would not pass', () => {
    const e: Expr = [
      'or',
      [
        [
          'and',
          [
            ['eq', ['call_arg', 0], 1],
            ['eq', ['call_arg', 1], 2],
          ],
        ],
        ['eq', ['call_arg', 0], 3],
      ],
    ]
    const ns = tree(e)
    const broken = (f: (n: Node[]) => Node[]) => () => {
      const m = f(structuredClone(ns))
      expect(canon(m.length === 1 ? rebuild(m[0] as Node) : ['and', m.map(rebuild)])).toEqual(
        canon(e)
      )
    }
    const group = (ns[0] as Node).children as Node[]
    expect(broken((x) => x)).not.toThrow()
    expect(
      broken((x) => {
        ;((x[0] as Node).children as Node[]).pop()
        return x
      })
    ).toThrow()
    expect(
      broken((x) => {
        ;((x[0] as Node).children as Node[]).splice(0, 1, ...(group[0]?.children ?? []))
        return x
      })
    ).toThrow()
    expect(
      broken((x) => {
        ;((x[0] as Node).children?.[0] as Node).op = 'or'
        return x
      })
    ).toThrow()
    expect(
      broken((x) => {
        ;((x[0] as Node).children?.[1] as Node).raw = ['eq', ['call_arg', 0], 4]
        return x
      })
    ).toThrow()
  })

  it('the whole check refuses a tree that dropped, repeated or invented a leaf, or bent a quantifier', () => {
    const q: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'f'],
        [
          'all',
          ['call_arg', 0],
          [
            'and',
            [
              ['gte', ['elem', 'x'], 0],
              ['lte', ['elem', 'x'], 9],
            ],
          ],
        ],
        ['eq', ['call_arg', 1], 2],
      ],
    ]
    const fresh = () => structuredClone(tree(q))
    expect(() => roundTrips(q, {}, fresh())).not.toThrow()
    const quant = (ns: Node[]) => ((ns[0] as Node).children as Node[])[0] as Node
    const mutate: [string, (ns: Node[]) => void][] = [
      ['a leaf of the quantifier body dropped', (ns) => quant(ns).children?.pop()],
      ['a leaf repeated', (ns) => quant(ns).children?.push(quant(ns).children?.[0] as Node)],
      ['the quantifier turned into another', (ns) => (quant(ns).op = 'any')],
      [
        'a leaf out of the quantifier',
        (ns) => (ns[0] as Node).children?.push((quant(ns).children as Node[]).pop() as Node),
      ],
      [
        'a leaf that is not in the rule',
        (ns) => (((ns[0] as Node).children?.at(-1) as Node).raw = ['eq', ['call_arg', 1], 3]),
      ],
      ['a header without its pin', (ns) => ((ns[0] as Node).raw = null)],
      [
        'a group with a node of its own',
        (ns) => (ns[0] as Node).children?.push({ label: 'x', op: 'and', raw: ['and', []] }),
      ],
    ]
    for (const [, f] of mutate) {
      const ns = fresh()
      f(ns)
      expect(() => roundTrips(q, {}, ns)).toThrow()
    }
  })
})

describe('a constant never looks like another value, a name or a selector', () => {
  const eq = (v: Expr, view?: View) => one(['eq', ['call_arg', 0], v], view)
  it.each<[string, Expr, string]>([
    ['an i128', { i128: '5000' }, '5000'],
    ['a u32', 5000, '5000'],
    ['a u64', { u64: '5000' }, '5000'],
    ['a symbol that spells a number', '5000', "'5000'"],
    ['a symbol that spells a bool', 'true', "'true'"],
    ['a bool', true, 'true'],
    ['a symbol that spells null', 'null', "'null'"],
    ['void', null, 'null'],
    ['a string', { string: '5000' }, '"5000"'],
    ['bytes', { bytes: 'ab' }, '0xab'],
    ['a string of other bytes', { stringHex: 'ab' }, 'hex"ab"'],
    ['a u256', { u256: '5000' }, '5000 (u256)'],
    ['an i256', { i256: '5000' }, '5000 (i256)'],
    ['a vec holds typed numbers', [5, { i128: '5' }], '[5 (u32), 5 (i128)]'],
    ['a map holds typed numbers', { map: [['k', 5]] }, "{'k': 5 (u32)}"],
    ['a symbol that is a parameter name', 'to', "'to'"],
    ['a symbol that is a selector', 'function', "'function'"],
  ])('%s', (_n, v, text) => expect(eq(v)).toBe(`argument 0:  must be  ${text}`))

  it('on the left too: a constant is never a name', () => {
    expect(one(['nin', 'to', [A]])).toBe(`'to':  must not be one of  [${short(A)}]`)
    expect(one(['ne', ['call_arg', 2], '0'])).toBe("argument 2:  must not be  '0'")
    expect(one(['ne', ['call_arg', 2], { u256: '0' }])).toBe('argument 2:  must not be  0 (u256)')
    expect(one(['eq', 5, ['call_arg', 0]])).toBe('5:  must be  argument 0')
  })

  it('--raw shows the wire type of every number', () => {
    expect(eq({ i128: '5' }, { raw: true })).toBe('argument 0:  must be  5 (i128)')
    expect(eq(5, { raw: true })).toBe('argument 0:  must be  5 (u32)')
    expect(eq(['lit', { u64: '5' }], { raw: true })).toBe('argument 0:  must be  5 (u64)')
  })

  it('a string cannot bend a line: controls, bidi and line separators are escaped', () => {
    const t = eq({ string: 'a\nb\u2028c\u202ed\u2066e\u0085f' })
    expect(t).toBe('argument 0:  must be  "a\\nb\\u2028c\\u202ed\\u2066e\\u0085f"')
    expect(t).not.toMatch(/[\n\u2028\u202e\u2066\u0085]/)
  })
})

describe('a step of a path says what it is', () => {
  const path = (...steps: Expr[]) => one(['eq', ['call_path', 0, ...steps], 1])
  it('an index, a key, a typed key, the length', () => {
    expect(path(2)).toBe('argument 0 › [2]:  must be  1')
    expect(path(['lit', 2])).toBe('argument 0 › 2 (u32):  must be  1')
    expect(path(['lit', { i128: '2' }])).toBe('argument 0 › 2 (i128):  must be  1')
    expect(path('k')).toBe('argument 0 › k:  must be  1')
    expect(path(['lit', 'k'])).toBe('argument 0 › k:  must be  1')
    expect(path(['lit', { string: 'k' }])).toBe('argument 0 › "k":  must be  1')
    expect(path(true)).toBe('the number of items in argument 0:  must be  1')
  })

  it('the length step is the length for every selector, never the word "true"', () => {
    const leaf = (sel: Expr) => one(['lte', sel, 3])
    expect(leaf(['elem', 'memo', true])).toBe(
      'the number of items in the item › memo:  must be at most  3'
    )
    expect(leaf(['elem', true])).toBe('the number of items in the item:  must be at most  3')
    expect(leaf(['read', C, 'list', [], true])).toBe(
      `the number of items in list() on ${short(C)}:  must be at most  3`
    )
    expect(leaf(['read', C, 'list', [], ['lit', true]])).toBe(
      `list() on ${short(C)} › true:  must be at most  3`
    )
    expect(leaf(['call_arg_len', 1])).toBe('the number of items in argument 1:  must be at most  3')
    expect(leaf(['call_path', 1, true])).toBe(
      'the number of items in argument 1:  must be at most  3'
    )
    expect(leaf(['sum', ['call_arg', 0], 'amount'])).toBe(
      'the total of amount in argument 0:  must be at most  3'
    )
  })

  it('with a type: an index only into a vector or tuple, a key only into a map', () => {
    const v = (ty: unknown): View => ({
      contract: C,
      info: { [C]: { fns: { f: [['p', ty as never]] } } },
    })
    const at = (ty: unknown, step: Expr) =>
      card(
        [
          'and',
          [
            ['eq', ['call_fn'], 'f'],
            ['eq', ['call_path', 0, step], 1],
          ],
        ],
        v(ty)
      ).at(-1)
    expect(at({ vec: 'u32' }, 0)).toContain('p › [0]:')
    expect(at({ vec: 'u32' }, ['lit', 0])).toContain('argument 0 › 0 (u32):')
    expect(at({ map: 'u32' }, ['lit', 5])).toContain('p › 5 (u32):')
    expect(at({ map: 'u32' }, 5)).toContain('argument 0 › [5]:')
    expect(at({ tuple: ['u32'] }, 0)).toContain('p › [0]:')
    expect(at({ fields: { to: 'address' } }, 'to')).toContain('p › to:')
    expect(at({ fields: { to: 'address' } }, ['lit', 'to'])).toContain('p › to:')
    expect(at({ fields: { to: 'address' } }, 0)).toContain('argument 0 › [0]:')
    expect(at({ fields: { to: 'address' } }, 'constructor')).toContain('argument 0 › constructor:')
  })
})

describe('an item field and a call argument of one name read differently', () => {
  it('x <= y is not y <= x', () => {
    const view: View = {
      contract: C,
      info: {
        [C]: {
          fns: {
            pay: [
              ['payments', { vec: { fields: { amount: 'i128', to: 'address' } } }],
              ['to', 'address'],
              ['amount', 'i128'],
            ],
          },
        },
      },
    }
    const rule = (l: Expr, r: Expr): string =>
      card(
        [
          'and',
          [
            ['eq', ['call_fn'], 'pay'],
            ['all', ['call_arg', 0], ['lte', l, r]],
          ],
        ],
        view
      ).at(-1) as string
    const a = rule(['elem', 'amount'], ['call_arg', 2])
    const b = rule(['call_arg', 2], ['elem', 'amount'])
    expect(a).toBe('      └─ the item › amount:  must be at most  amount')
    expect(b).toBe('      └─ amount:  must be at most  the item › amount')
  })
})

describe('labels from a request', () => {
  const label = (l: string) => one(['eq', ['call_arg', 0], A], { labels: { [A]: l } })
  it("are plain words, marked as the caller's", () => {
    expect(label('payroll-1')).toBe(`argument 0:  must be  ${short(A)} («payroll-1»)`)
  })
  it.each([
    ['a line break', 'x)\n   └─ amount:  must be at most  1'],
    ['a box character', '└─ x'],
    ['an escape', 'x\u001b[2K'],
    ['a right-to-left mark', 'x\u202e'],
    ['brackets', 'x (verified)'],
    ['more than 24 characters', 'a'.repeat(25)],
    ['nothing', ''],
    ['a digit first', '1x'],
  ])('%s is dropped', (_n, l) => expect(label(l)).toBe(`argument 0:  must be  ${short(A)}`))
})
