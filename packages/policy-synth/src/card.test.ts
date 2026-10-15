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
        { rule: 'cap', at: [2], max: '100' },
        { rule: 'deny', at: [1], nin: [A] },
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
