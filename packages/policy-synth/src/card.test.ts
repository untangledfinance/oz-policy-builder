import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { account, contract } from '../test/fixtures.ts'
import { type Authority, authority, card, lines, type Node, tree, type View } from './card.ts'
import { INTERPRETER, SAFE_READS, SPENDING_LIMIT } from './config.ts'
import { decodeEnvelope } from './record.ts'
import { propose, synthesize } from './synth.ts'
import { decode, type Expr, validate } from './wire.ts'

const [A, B, C, D] = [account(1), account(2), contract(1), contract(2)]
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`
const tokenOf = (_fns: string[]): View => ({ contract: C })
const one = (e: Expr, v?: View) => card(e, v)[0] as string

// the interpreter truncates scaled() toward zero (dsl.rs), so an exact `num / den`
// rendering misreads a floor as nothing. lte(scaled(arg2, 1, 10^18, 0), 0) permits every amount
// below 10^18 (floor(x / 10^18) = 0 for 0 <= x < 10^18), not only x <= 0.
describe('scaled is rendered as truncating', () => {
  const E18 = (10n ** 18n).toString()
  it('marks a floor division as rounded toward zero, so it does not read as "nothing"', () => {
    const text = one(['lte', ['scaled', ['call_arg', 2], { i128: '1' }, { i128: E18 }, { i128: '0' }], 0])
    expect(text).toContain('rounded toward zero')
    expect(text).toBe(
      `argument 2 × 1 ÷ ${E18}, rounded toward zero:  must be at most  0`
    )
  })
  it('a division by one cannot truncate, so it carries no note', () => {
    const text = one(['gte', ['call_arg', 1], ['scaled', ['call_arg', 0], { i128: '5' }, { i128: '1' }, { i128: '0' }]])
    expect(text).not.toContain('rounded toward zero')
    expect(text).toBe('argument 1:  must be at least  argument 0 × 5 ÷ 1')
  })
})

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
      'argument 1:  must be at least  argument 0 × 99 ÷ 100, rounded toward zero',
    ],
    [
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, ['call_arg', 3]],
      ],
      'argument 1:  must be at least  argument 0 × 99 ÷ 100 + argument 3, rounded toward zero',
    ],
    [
      ['gte', ['read', C, 'price', [['call_arg', 1], 'USD'], 'price'], { i128: '5' }],
      `price(argument 1, 'USD') on ${short(C)} (live value, movable within one transaction) › price:  must be at least  5`,
    ],
    [
      ['gte', ['read', C, 'price', []], { i128: '5' }],
      `price() on ${short(C)} (live value, movable within one transaction):  must be at least  5`,
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
      `f(5, "k") on ${short(C)} (live value, movable within one transaction):  must be  1`,
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
      'argument 1:  must be at least  (argument 0 × 2 ÷ 3, rounded toward zero) × 4 ÷ 5 + 6, rounded toward zero',
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

  it('a constant on the left is read as written', () => {
    expect(one(['lte', 7, ['call_arg', 2]])).toBe('7:  must be at most  argument 2')
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
      `balance(${short(A)} («treasury»)) on ${short(D)} («vault») (live value, movable within one transaction):  must be at least  1`
    )
  })

  it('the pins of this package are known by name; the request cannot rename them', () => {
    const sl = SPENDING_LIMIT.testnet
    expect(one(['eq', ['call_arg', 0], sl])).toBe(
      `argument 0:  must be  ${short(sl)} ([spending limit])`
    )
    // The package's own name wins: a request cannot call its policy contracts something else.
    expect(one(['eq', ['call_arg', 0], sl], { labels: { [sl]: 'my cap' } })).toContain(
      '([spending limit])'
    )
  })

  it('--raw: the whole address, and still its name', () => {
    expect(one(['eq', ['call_arg', 0], A], { labels: { [A]: 'treasury' }, raw: true })).toBe(
      `argument 0:  must be  ${A} («treasury»)`
    )
  })

  it('a header: the name and the short address', () => {
    const e: Expr = [
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_fn'], 'transfer'],
      ],
    ]
    expect(card(e, { labels: { [C]: 'USDC test' } })[0]).toBe(`«USDC test»  ${short(C)}`)
    expect(card(e)[0]).toBe(short(C))
    expect(card(e, { raw: true })[0]).toBe(C)
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
    expect(card(e, { labels: { [A]: 'treasury' } })).toEqual([
      short(C),
      '└─ transfer',
      `   ├─ argument 0:  must be  ${short(A)} («treasury»)`,
      `   ├─ argument 1:  must not be one of  [${short(B)}]`,
      '   └─ argument 2:  must be at most  50000000000',
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
      short(C),
      '└─ transfer',
      '   └─ argument 2:  must be at most  100',
    ])
    // One the predicate pins itself is not repeated.
    const same: Expr = ['and', [['eq', ['call_contract'], C], ...(pay[1] as Expr[])]]
    expect(card(same, tokenOf(['transfer']))[0]).toBe(short(C))
    expect(card(same, tokenOf(['transfer']))).toHaveLength(3)
    // A rule scoped to C whose predicate pins D can never permit: both are said.
    const other: Expr = ['and', [['eq', ['call_contract'], D], ...(pay[1] as Expr[])]]
    const out = card(other, tokenOf(['transfer']))
    expect(out.slice(0, 2)).toEqual([
      short(C),
      `└─ ${short(D)}  (never matches: the rule is scoped to ${short(C)})`,
    ])
    // And a pin in only one branch does not hide the scope of the other.
    const some: Expr = ['or', [other, approve]]
    expect(card(some, tokenOf(['transfer']))[0]).toBe(short(C))
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
      const nodes = tree(e)
      const fake = (ns: Node[]): Node[] => ns.flatMap((n) => [n, ...fake(n.children ?? [])])
      const lifted = fake(nodes).find(
        (n) => n.op === (head === 'call_fn' ? 'function' : 'contract')
      )
      expect(lifted?.raw).not.toEqual(['eq', head, head === 'call_fn' ? 'transfer' : C])
      expect(card(e).join('\n')).toContain(`'${head}':  must be`)
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
    expect(tree(e)[0]?.children?.[0]?.op).not.toBe('function')
    expect(card(e)).toContain("├─ 'call_fn':  must be  'call_fn'")
  })
})

describe('a pin is lifted only with a value of its own kind', () => {
  it('a function pinned to an address, and a contract pinned to a symbol, stay conditions', () => {
    const out = (a: Expr, b: Expr) =>
      card(['and', [a, b, ['lte', ['call_arg', 2], { i128: '5' }]]]).join('\n')
    const fnIsAddress = out(['eq', ['call_contract'], C], ['eq', ['call_fn'], D])
    expect(fnIsAddress).toContain(`the function:  must be  ${short(D)}`)
    const contractIsSymbol = out(
      ['eq', ['call_contract'], 'transfer'],
      ['eq', ['call_fn'], 'transfer']
    )
    expect(contractIsSymbol).toContain("the contract:  must be  'transfer'")
    expect(contractIsSymbol.split('\n')[0]).toBe('transfer')
  })
})

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
  }
  for (const f of ['grammar', 'accuracy'])
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
    ['a map keyed by numbers', { map: [[5, 6]] }, '{5 (u32): 6 (u32)}'],
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
      `the number of items in list() on ${short(C)} (live value, movable within one transaction):  must be at most  3`
    )
    expect(leaf(['read', C, 'list', [], ['lit', true]])).toBe(
      `list() on ${short(C)} (live value, movable within one transaction) › true:  must be at most  3`
    )
    expect(leaf(['call_arg_len', 1])).toBe('the number of items in argument 1:  must be at most  3')
    expect(leaf(['call_path', 1, true])).toBe(
      'the number of items in argument 1:  must be at most  3'
    )
    expect(leaf(['sum', ['call_arg', 0], 'amount'])).toBe(
      'the total of amount in argument 0:  must be at most  3'
    )
  })
})

describe('labels from a request', () => {
  const label = (l: string) => one(['eq', ['call_arg', 0], A], { labels: { [A]: l } })
  it("are plain words, marked as the caller's", () => {
    expect(label('payroll-1')).toBe(`argument 0:  must be  ${short(A)} («payroll-1»)`)
  })
  it('from one to 24 characters', () => {
    expect(label('A')).toContain('(«A»)')
    expect(label('a'.repeat(24))).toContain(`(«${'a'.repeat(24)}»)`)
    expect(label('a'.repeat(25))).not.toContain('«')
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

describe('a symbol key that looks like a value is quoted', () => {
  const path = (...steps: Expr[]) => one(['eq', ['call_path', 0, ...steps], 1])
  it.each(['true', 'false', 'null', '', '5', '9a', 'a b'.replace(' ', '_')])('%j', (k) => {
    const t = path(k)
    if (/^(?!(true|false|null)$)[A-Za-z_]\w*$/.test(k))
      expect(t).toBe(`argument 0 › ${k}:  must be  1`)
    else expect(t).toBe(`argument 0 › '${k}':  must be  1`)
  })
  it('and so differs from the bool and void keys, bare or lit', () => {
    expect(path(['lit', true])).toBe(
      'argument 0 › true (bool)'.replace(' (bool)', '') + ':  must be  1'
    )
    expect(path('true')).not.toBe(path(['lit', true]))
    expect(path('false')).not.toBe(path(['lit', false]))
    expect(path('null')).not.toBe(path(['lit', null]))
    expect(path(['lit', 'true'])).toBe(path('true'))
  })
})

describe('what a person cannot see is escaped', () => {
  const str = (s: string) => one(['eq', ['call_arg', 0], { string: s }])
  it('zero-width, soft hyphen, BOM, Arabic letter mark, combining marks, tags, other spaces', () => {
    const plain = str('abc')
    for (const ch of [
      '\u200b',
      '\u200d',
      '\u2060',
      '\u00ad',
      '\ufeff',
      '\u061c',
      '\u0301',
      '\u00a0',
      '\u3000',
      '\u{e0041}',
      '\u180e',
    ])
      expect(str(`ab${ch}c`)).not.toBe(plain)
    expect(str('ab\u200bc')).toBe('argument 0:  must be  "ab\\u200bc"')
    expect(str('a\u0301')).not.toBe(str('\u00e1'))
    expect(str('\u{e0041}')).toBe('argument 0:  must be  "\\u{e0041}"')
    expect(str('x\ud800y')).not.toContain('\ud800')
  })
  it('the last character of the basic plane and the first beyond it', () => {
    expect(str('\uffff')).toBe('argument 0:  must be  "\\uffff"')
    expect(str('\u{10000}')).toBe('argument 0:  must be  "\\u{10000}"')
  })
  it('printable ASCII is as written, quotes and backslashes escaped', () => {
    expect(str('a "b" \\ c')).toBe('argument 0:  must be  "a \\"b\\" \\\\ c"')
  })
  it('symbols too (a symbol is ASCII, but a spec name or key may not be)', () => {
    expect(one(['eq', ['call_arg', 0], 'a\u200bb'])).toBe("argument 0:  must be  'a\\u200bb'")
  })
})

describe('shortened addresses keep six and six', () => {
  it('in the default view; raw is whole', () => {
    expect(one(['eq', ['call_arg', 0], A])).toBe(
      `argument 0:  must be  ${A.slice(0, 6)}…${A.slice(-6)}`
    )
    expect(one(['eq', ['call_arg', 0], A], { raw: true })).toContain(A)
  })
})

describe('a function pinned to nothing is a condition, not an empty header', () => {
  it('eq(call_fn, empty symbol)', () => {
    const out = card([
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_fn'], ''],
        ['lte', ['call_arg', 2], 1],
      ],
    ])
    expect(out).toEqual([
      short(C),
      "├─ the function:  must be  ''",
      '└─ argument 2:  must be at most  1',
    ])
  })
})

describe('a pin on another contract than the rule is scoped to says it never matches', () => {
  const rule = (c: string): Expr => [
    'and',
    [
      ['eq', ['call_contract'], c],
      ['eq', ['call_fn'], 'transfer'],
    ],
  ]
  it('a root pin of another contract', () => {
    expect(card(rule(D), { contract: C })).toEqual([
      short(C),
      `└─ ${short(D)}  (never matches: the rule is scoped to ${short(C)})`,
      '   └─ transfer',
    ])
  })
  it('a pin in one branch of an or, the other branch is fine', () => {
    const out = card(['or', [rule(D), rule(C)]], { contract: C })
    expect(out.filter((l) => l.includes('never matches'))).toHaveLength(1)
    expect(out.find((l) => l.includes(short(D)))).toContain(`scoped to ${short(C)}`)
  })
  it('the same contract is not flagged; with no scope nothing is', () => {
    expect(card(rule(C), { contract: C }).join('\n')).not.toContain('never')
    expect(card(rule(D)).join('\n')).not.toContain('never')
  })
  it('raw names it whole', () => {
    expect(card(rule(D), { contract: C, raw: true })[1]).toContain(`scoped to ${C}`)
  })
})

describe('a read says what it is: a live value, unless its source cannot be moved', () => {
  const LIVE = ' (live value, movable within one transaction)'
  const REFLECTOR = Object.keys(SAFE_READS.testnet)[0] as string
  const price = (target: string, fn: string, v?: View, args: Expr[] = []) =>
    one(['gte', ['read', target, fn, args], { i128: '5' }], v)
  it('an unlisted source is marked, in every view', () => {
    expect(price(D, 'balance')).toBe(`balance() on ${short(D)}${LIVE}:  must be at least  5`)
    expect(price(D, 'balance', { raw: true })).toContain(LIVE)
    expect(price(D, 'balance', { network: 'testnet' })).toContain(LIVE)
  })
  it('a listed oracle on its own network is not; on another network, or another function, it is', () => {
    expect(price(REFLECTOR, 'lastprice', { network: 'testnet' })).not.toContain(LIVE)
    expect(price(REFLECTOR, 'lastprice', { network: 'mainnet' })).toContain(LIVE)
    expect(price(REFLECTOR, 'set_price', { network: 'testnet' })).toContain(LIVE)
    expect(price(REFLECTOR, 'lastprice')).toContain(LIVE)
  })
  it('a listed oracle read with an argument taken from the call is marked too; a constant is not', () => {
    const v = { network: 'testnet' as const }
    expect(price(REFLECTOR, 'lastprice', v, [['call_arg', 1]])).toContain(LIVE)
    expect(price(REFLECTOR, 'lastprice', v, [{ i128: '1' }])).not.toContain(LIVE)
  })
  it('an operator-listed read (POLICY_BUILDER_SAFE_READS_<NET>) is not marked, on its network only', () => {
    process.env.POLICY_BUILDER_SAFE_READS_TESTNET = `${D}:position`
    try {
      expect(price(D, 'position', { network: 'testnet' })).not.toContain(LIVE)
      expect(price(D, 'balance', { network: 'testnet' })).toContain(LIVE)
      expect(price(D, 'position', { network: 'mainnet' })).toContain(LIVE)
    } finally {
      delete process.env.POLICY_BUILDER_SAFE_READS_TESTNET
    }
  })
  it('a lit that spells a read is a constant, never marked', () => {
    expect(one(['ne', ['call_arg', 1], ['lit', ['read', D, 'balance', []]]])).not.toContain(
      'live value'
    )
  })
  it('inside scaled and sum it is still marked once per read', () => {
    const t = one([
      'gte',
      ['call_arg', 1],
      ['scaled', ['read', D, 'p', []], { i128: '1' }, { i128: '2' }, { i128: '0' }],
    ])
    expect(t.split(LIVE)).toHaveLength(2)
  })
})

describe('the authority header: who can act, under what rule, until when, up to how much', () => {
  const [G1, G2, G3] = [account(1), account(2), account(3)]
  const KC = contract(4)
  const text = (a: Authority, v: View = {}) => lines([authority(a, v)])
  const INT = INTERPRETER.testnet?.address as string
  const base: Authority = {
    signers: [G1],
    admins: [G1],
    validUntil: null,
    total: null,
    interpreter: INT,
  }

  it('one signer, never expiring, no total: every fact on its own line, signers in full six and six', () => {
    expect(text(base)).toEqual([
      'Authority',
      "├─ legend:  […] the package's roles; «…» labels given in the request",
      `├─ signer:  ${G1.slice(0, 6)}…${G1.slice(-6)}`,
      '├─ to act:  the signer acts alone',
      `├─ admins:  ${G1.slice(0, 6)}…${G1.slice(-6)} (all of them together: alone, may uninstall the predicate, which stops the rule; with the account, may re-install, replace the admins or bind an executor)`,
      '├─ expires:  never expires',
      '├─ total:  no total limit: each call may move up to its own cap',
      `└─ interpreter:  ${INT.slice(0, 6)}…${INT.slice(-6)} ([interpreter])`,
    ])
  })

  it('any ONE of n, any m of n, and weighted totals: the rule says which', () => {
    const rule = (a: Authority) => text(a).find((l) => l.includes('to act')) as string
    expect(rule({ ...base, signers: [G1, G2, G3] })).toContain(
      'any ONE of these 3 signers acts alone'
    )
    expect(rule({ ...base, signers: [G1, G2, G3], threshold: { n: 2 } })).toContain(
      'any 2 of these 3 signers must approve'
    )
    expect(
      rule({ ...base, signers: [G1, G2], threshold: { n: 3, weights: { [G1]: 2, [G2]: 1 } } })
    ).toContain('signers whose weights total at least 3 must approve')
  })

  it('a threshold one signer meets alone: simple n=1 is any ONE; a weighted one keeps its sentence and names who can act alone', () => {
    const rule = (a: Authority) => text(a).find((l) => l.includes('to act')) as string
    const s6 = (x: string) => `${x.slice(0, 6)}…${x.slice(-6)}`
    expect(rule({ ...base, signers: [G1, G2, G3], threshold: { n: 1 } })).toContain(
      'any ONE of these 3 signers acts alone'
    )
    expect(
      rule({ ...base, signers: [G1, G2], threshold: { n: 2, weights: { [G1]: 2, [G2]: 1 } } })
    ).toBe(
      `├─ to act:  signers whose weights total at least 2 must approve (${s6(G1)} can act alone)`
    )
    // {3,2,2}, n 3: A alone, but B + C act too: never "A alone can act".
    const three = rule({
      ...base,
      signers: [G1, G2, G3],
      threshold: { n: 3, weights: { [G1]: 3, [G2]: 2, [G3]: 2 } },
    })
    expect(three).toContain('signers whose weights total at least 3 must approve')
    expect(three).toContain(`(${s6(G1)} can act alone)`)
    expect(three).not.toContain(`${s6(G2)} can`)
    expect(
      rule({ ...base, signers: [G1, G2], threshold: { n: 2, weights: { [G1]: 2, [G2]: 2 } } })
    ).toContain(`(each of ${s6(G1)}, ${s6(G2)} can act alone)`)
    expect(
      rule({ ...base, signers: [G1, G2], threshold: { n: 2, weights: { [G1]: 1, [G2]: 1 } } })
    ).not.toContain('alone')
  })

  it('a threshold without a number is not described: a library caller gets an error, never "any undefined"', () => {
    expect(() => authority({ ...base, signers: [G1, G2], threshold: {} as never }, {})).toThrow(
      /threshold/
    )
  })

  it('the first line says what the marks mean', () => {
    expect((authority(base, {}).children ?? [])[0]).toMatchObject({
      label: 'legend',
      raw: null,
      value: "[…] the package's roles; «…» labels given in the request",
    })
  })

  it("a caller label that spells a role plus a space or dot is the caller's, next to the real role", () => {
    const out = lines([
      authority(
        { signers: [G1, G2], admins: [G1] },
        { roles: { [G1]: 'signer' }, labels: { [G2]: 'signer ' } }
      ),
    ]).join('\n')
    expect(out).toContain(`${G1.slice(0, 6)}…${G1.slice(-6)} ([signer])`)
    expect(out).toContain(`${G2.slice(0, 6)}…${G2.slice(-6)} («signer »)`)
    const dot = lines([authority({ signers: [G2] }, { labels: { [G2]: 'signer.' } })]).join('\n')
    expect(dot).toContain('(«signer.»)')
    expect(dot).not.toContain('[signer]')
  })

  it('under raw: to act is the policy entry it came from, and the total is the raw amount', () => {
    const entry = ['CAYT', { map: [['threshold', 2]] }] as never
    const n = authority(
      {
        ...base,
        signers: [G1, G2],
        threshold: { n: 2, raw: entry },
        total: { amount: '50000000000', periodLedgers: 9 },
      },
      { raw: true, contract: C }
    )
    expect((n.children ?? []).find((x) => x.label === 'to act')?.raw).toEqual(entry)
    expect((n.children ?? []).find((x) => x.label === 'total')?.value).toBe(
      'at most 50000000000 in total per 9 ledgers (rolling, OZ spending_limit)'
    )
  })

  it('a weight follows its signer; a contract signer is said to be one; labels are marked', () => {
    const out = text(
      { ...base, signers: [G1, KC], threshold: { n: 2, weights: { [G1]: 2, [KC]: 1 } } },
      { labels: { [G1]: 'agent' } }
    )
    expect(out[2]).toBe(`├─ signer:  ${G1.slice(0, 6)}…${G1.slice(-6)} («agent»)  weight 2`)
    expect(out[3]).toBe(`├─ signer:  contract ${KC.slice(0, 6)}…${KC.slice(-6)}  weight 1`)
  })

  it('expiry: the ledger it lapses after (no estimated date); the total, per window; unknown facts are left out', () => {
    const out = text(
      { ...base, validUntil: 5_300_000, total: { amount: '50000000000', periodLedgers: 17280 } },
      { contract: C }
    )
    expect(out).toContain('├─ expires:  valid through ledger 5300000')
    expect(out).toContain(
      '├─ total:  at most 50000000000 in total per 17280 ledgers (rolling, OZ spending_limit)'
    )
    expect(text({ signers: [G1] }).join('\n')).not.toMatch(/expires|total|admins|interpreter/)
    expect(text({ ...base, total: { amount: '7', periodLedgers: 2 } })).toContain(
      '├─ total:  at most 7 in total per 2 ledgers (rolling, OZ spending_limit)'
    )
  })

  it('every node carries what it came from: the signer, the weight entry, the policy parameter, the list, the ledger', () => {
    const n = authority(
      {
        ...base,
        signers: [G1, G2],
        threshold: { n: 2, weights: { [G1]: 1, [G2]: 1 } },
        validUntil: 7,
        total: { amount: '9', periodLedgers: 3 },
      },
      {}
    )
    expect(n).toMatchObject({ op: 'authority', raw: null })
    const raws = (n.children ?? []).map((x) => x.raw)
    expect(raws[0]).toBeNull() // the legend
    expect(raws[1]).toEqual([['Delegated', G1], 1])
    expect(raws[3]).toBe(2)
    expect(raws).toContainEqual([['Delegated', G1]])
    expect(raws).toContain(7)
    expect(raws).toContainEqual({
      map: [
        ['period_ledgers', 3],
        ['spending_limit', { i128: '9' }],
      ],
    })
    expect((authority(base, {}).children ?? [])[2]?.raw).toBeNull() // no threshold: nothing to point at
  })

  it('under raw, addresses are whole', () => {
    expect(text(base, { raw: true })[2]).toBe(`├─ signer:  ${G1}`)
  })
})
