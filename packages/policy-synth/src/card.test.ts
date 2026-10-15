import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { card, operand } from './card.ts'
import { callExpr } from './intent.ts'
import { type Expr, validate } from './wire.ts'

const A = account(1)
const C = contract(1)

describe('operators and operands are words', () => {
  it.each<[Expr, string]>([
    [['eq', ['call_fn'], 'transfer'], 'the function must be transfer'],
    [['ne', ['call_contract'], C], `the contract must not be ${C}`],
    [['lt', ['call_arg', 0], { i128: '5' }], 'argument 0 must be below 5'],
    [['lte', ['call_arg', 2], { i128: '100' }], 'argument 2 must be at most 100'],
    [['gt', ['call_arg', 2], 0], 'argument 2 must be above 0'],
    [['gte', ['call_arg', 2], { u64: '7' }], 'argument 2 must be at least 7'],
    [['in', ['call_arg', 1], [A, C]], `argument 1 must be one of [${A}, ${C}]`],
    [['nin', ['call_arg', 1], [A]], `argument 1 must not be one of [${A}]`],
    [['eq', ['call_path', 3, 0, 'amount'], { i128: '1' }], 'argument 3 > 0 > amount must be 1'],
    [['lte', ['call_path', 3, true], 2], 'the number of items in argument 3 must be at most 2'],
    [['lte', ['call_arg_len', 3], 2], 'the number of items in argument 3 must be at most 2'],
    [['eq', ['call_arg_field', 3, 0, 'amount'], 1], 'argument 3 > 0 > amount must be 1'],
    [['lte', ['now'], { u64: '1900000000' }], 'the ledger time must be at most 1900000000'],
    [['eq', ['call_arg', 0], ['lit', { string: 'memo' }]], 'argument 0 must be "memo"'],
    [['eq', ['call_arg', 0], ['lit', { bytes: 'ab' }]], 'argument 0 must be 0xab'],
    [['eq', ['call_arg', 0], ['lit', ['Stellar', A]]], `argument 0 must be [Stellar, ${A}]`],
    [['eq', ['call_arg', 0], ['lit', true]], 'argument 0 must be true'],
    [
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, { i128: '0' }],
      ],
      'argument 1 must be at least (argument 0 x 99 / 100)',
    ],
    [
      ['gte', ['read', C, 'price', [['call_arg', 1], 'USD'], 'price'], { i128: '5' }],
      `argument 1 must be at least 5`.replace(
        'argument 1',
        `price(argument 1, USD) on ${C} > price`
      ),
    ],
    [
      ['lte', ['sum', ['call_arg', 0], 'amount'], { i128: '9' }],
      'the total of amount in argument 0 must be at most 9',
    ],
  ])('%j', (expr, text) => expect(card(expr)).toEqual([text]))

  it('every operator the contract knows has a phrase, every selector a name', () => {
    for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])
      expect(card([op, ['call_arg', 0], 1])[0]).toContain(' must ')
    for (const op of ['in', 'nin']) expect(card([op, ['call_arg', 0], [1]])[0]).toContain(' must ')
    const selectors: Expr[] = [
      ['call_contract'],
      ['call_fn'],
      ['now'],
      ['call_arg', 0],
      ['call_path', 0],
      ['elem'],
      ['lit', 1],
    ]
    for (const sel of selectors) expect(operand(sel)).not.toStartWith('[')
  })
})

describe('structure', () => {
  it('quantifiers and groups indent their bodies', () => {
    const rule: Expr = [
      'and',
      [
        ['eq', ['call_fn'], 'pay'],
        [
          'all',
          ['call_arg', 0],
          [
            'and',
            [
              ['in', ['elem', 'to'], [A]],
              ['gte', ['elem', 'amount'], 0],
            ],
          ],
        ],
        ['any', ['call_arg', 0], ['eq', ['elem'], 'repay']],
        [
          'or',
          [
            ['eq', ['call_arg', 1], 1],
            ['eq', ['call_arg', 1], 2],
          ],
        ],
      ],
    ]
    expect(card(rule)).toEqual([
      'the function must be pay',
      'For every item in argument 0:',
      `  the item's to must be one of [${A}]`,
      "  the item's amount must be at least 0",
      'For at least one item in argument 0:',
      '  the item must be repay',
      'Any one of:',
      '  argument 1 must be 1',
      '  argument 1 must be 2',
    ])
  })

  it('reads the order the rule is written in, never a sorted one', () => {
    const one = card([
      'and',
      [
        ['eq', ['call_arg', 1], 2],
        ['eq', ['call_fn'], 'pay'],
      ],
    ])
    expect(one).toEqual(['argument 1 must be 2', 'the function must be pay'])
  })

  it('describes an intent end to end', () => {
    const e = callExpr({
      contract: C,
      fn: 'transfer',
      where: [
        { constraint: 'cap', at: [2], max: '100' },
        { constraint: 'deny', at: [1], nin: [A] },
      ],
    })
    validate(e)
    expect(card(e)).toEqual([
      `the contract must be ${C}`,
      'the function must be transfer',
      'argument 2 must be at most 100',
      `argument 1 must not be one of [${A}]`,
    ])
  })
})

describe('an `and` under an `or` is a group, never a flat list', () => {
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

  it('or(and, and) says each call needs ALL of its own conditions (it used to read as one long "any")', () => {
    expect(card(['or', [pay, approve]])).toEqual([
      'Any one of:',
      '  All of:',
      '    the function must be transfer',
      '    argument 2 must be at most 100',
      '  All of:',
      '    the function must be approve',
      '    argument 2 must be at most 5',
    ])
  })

  it('and of the same four conditions, flat in an or, is a different rule and reads like one', () => {
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
  })

  it('a branch of one condition is not a group, and the groups nest', () => {
    expect(card(['or', [pay, ['eq', ['call_fn'], 'burn']]])).toEqual([
      'Any one of:',
      '  All of:',
      '    the function must be transfer',
      '    argument 2 must be at most 100',
      '  the function must be burn',
    ])
    const nested = card([
      'and',
      [
        ['eq', ['call_arg', 0], 1],
        ['or', [pay, approve]],
      ],
    ])
    expect(nested[0]).toBe('argument 0 must be 1')
    expect(nested.slice(1)).toEqual(card(['or', [pay, approve]]))
    // An `and` of one is the condition itself.
    expect(card(['or', [['and', [['eq', ['call_fn'], 'burn']]], approve]])[1]).toBe(
      '  the function must be burn'
    )
  })

  it('inside a quantifier body, and for every kind of leaf (reads, lit, ne, nin, now, sum, scaled)', () => {
    const leaves: Expr[] = [
      ['gte', ['read', C, 'price', ['USD']], { i128: '5' }],
      ['eq', ['call_arg', 0], ['lit', { string: 'memo' }]],
      ['ne', ['call_arg', 1], A],
      ['nin', ['call_arg', 1], [A, C]],
      ['lte', ['now'], { u64: '1900000000' }],
      ['lte', ['sum', ['call_arg', 3], 'amount'], { i128: '9' }],
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, { i128: '0' }],
      ],
    ]
    const branch = (l: Expr): Expr => ['and', [l, ['eq', ['call_fn'], 'x']]]
    const rule: Expr = ['or', leaves.map(branch)]
    const lines = card(rule)
    // One group per branch, each with its leaf's own phrase and the function.
    expect(lines.filter((l) => l === '  All of:')).toHaveLength(leaves.length)
    leaves.forEach((l, n) => {
      expect(lines[1 + n * 3]).toBe('  All of:')
      expect(lines[2 + n * 3]?.trim()).toBe(card(l)[0] as string)
      expect(lines[3 + n * 3]).toBe('    the function must be x')
    })
    const body: Expr = [
      'all',
      ['call_arg', 3],
      ['or', [branch(['eq', ['elem', 'to'], A]), branch(['gte', ['elem', 'amount'], 0])]],
    ]
    expect(card(body)).toEqual([
      'For every item in argument 3:',
      '  Any one of:',
      '    All of:',
      `      the item's to must be ${A}`,
      '      the function must be x',
      '    All of:',
      "      the item's amount must be at least 0",
      '      the function must be x',
    ])
  })

  it('a lit key in a path is its value, not a list', () => {
    expect(card(['eq', ['call_path', 3, ['lit', 'amount']], 1])).toEqual([
      'argument 3 > amount must be 1',
    ])
    expect(operand(['call_path', 3, ['lit', { string: 'a b' }], true])).toBe(
      'the number of items in argument 3 > "a b"'
    )
  })
})
