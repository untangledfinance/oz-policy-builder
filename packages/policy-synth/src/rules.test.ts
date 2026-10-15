import { afterAll, describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { SPENDING_LIMIT } from './config.ts'
import { callExpr } from './intent.ts'
import {
  covers,
  type Intended,
  implies,
  type ObservedRule,
  overlaps,
  readRules,
  selectors,
} from './rules.ts'
import type { Expr } from './wire.ts'

const KEY = account(1)
const TOKEN = contract(7)
const INTERP = interpreterFor('testnet')
const LIMIT = SPENDING_LIMIT.testnet

const rule = (cap: string, extra: Expr[] = []): Expr => [
  'and',
  [
    ['eq', ['call_contract'], TOKEN],
    ['eq', ['call_fn'], 'transfer'],
    ['lte', ['call_arg', 2], { i128: cap }],
    ...extra,
  ],
]

const mine: Intended = {
  scope: { kind: 'call_contract', contract: TOKEN },
  signers: [KEY],
  expr: rule('500'),
}
const observed = (o: Partial<ObservedRule>): ObservedRule => ({
  id: 3,
  scope: { kind: 'call_contract', contract: TOKEN },
  signers: [KEY],
  policies: [INTERP],
  expr: rule('500'),
  ...o,
})
const scan = (o: Partial<ObservedRule>, m: Partial<Intended> = {}) =>
  overlaps({ ...mine, ...m }, [observed(o)], INTERP, 'testnet')

describe('selectors: which calls an expression can serve', () => {
  const C = TOKEN
  it.each<[string, Expr, unknown]>([
    ['contract and function', callExpr({ contract: C, fn: 'pay' }), [{ contract: C, fn: 'pay' }]],
    [
      'an or is a union',
      [
        'or',
        [
          ['eq', ['call_fn'], 'a'],
          ['eq', ['call_fn'], 'b'],
        ],
      ],
      [
        { contract: '*', fn: 'a' },
        { contract: '*', fn: 'b' },
      ],
    ],
    [
      'in over functions',
      ['in', ['call_fn'], ['a', 'b']],
      [
        { contract: '*', fn: 'a' },
        { contract: '*', fn: 'b' },
      ],
    ],
    [
      'two different functions meet nowhere',
      [
        'and',
        [
          ['eq', ['call_fn'], 'a'],
          ['eq', ['call_fn'], 'b'],
        ],
      ],
      [],
    ],
    ['anything else is a wildcard', ['lte', ['call_arg', 0], 5], [{ contract: '*', fn: '*' }]],
  ])('%s', (_n, e, want) => expect(selectors(e)).toEqual(want as never))
})

describe('implies: a conjunct of the new rule that forbids what the old one does', () => {
  const L: Expr = ['call_arg', 2]
  it.each<[string, Expr, Expr, boolean]>([
    ['identical', ['eq', L, 1], ['eq', L, 1], true],
    ['a lower cap', ['lte', L, { i128: '5' }], ['lte', L, { i128: '9' }], true],
    ['a higher cap', ['lte', L, { i128: '9' }], ['lte', L, { i128: '5' }], false],
    ['below is within at most', ['lt', L, { i128: '10' }], ['lte', L, { i128: '9' }], true],
    ['at most is not within below', ['lte', L, { i128: '10' }], ['lt', L, { i128: '10' }], false],
    ['a higher floor', ['gte', L, { i128: '5' }], ['gte', L, { i128: '1' }], true],
    ['a lower floor', ['gte', L, { i128: '1' }], ['gte', L, { i128: '5' }], false],
    ['a smaller set', ['in', L, [1]], ['in', L, [1, 2]], true],
    ['a larger set', ['in', L, [1, 2]], ['in', L, [1]], false],
    ['a pinned value inside the set', ['eq', L, 2], ['in', L, [1, 2]], true],
    ['a pinned value outside it', ['eq', L, 3], ['in', L, [1, 2]], false],
    ['another argument', ['lte', ['call_arg', 1], { i128: '5' }], ['lte', L, { i128: '9' }], false],
  ])('%s', (_n, nc, oc, want) => expect(implies(nc, oc)).toBe(want))

  it('covers: every branch of the new rule is served by some branch of the old', () => {
    const a: Expr = callExpr({ contract: TOKEN, fn: 'a' })
    const b: Expr = callExpr({ contract: TOKEN, fn: 'b' })
    expect(covers(['or', [a, b]], a)).toBe(true)
    expect(covers(a, ['or', [a, b]])).toBe(false)
  })
})

describe('the overlap scan', () => {
  it('a shared signer on an unpoliced rule: refused, the new rule never runs', () => {
    const [o] = scan({ policies: [], expr: undefined, scope: { kind: 'default' } })
    expect(o).toMatchObject({ ruleId: 3, severity: 'refuse', why: 'unpoliced' })
    expect(o?.advice).toContain('never runs')
  })

  it('nothing in common is not an overlap', () => {
    expect(scan({ signers: [account(2)] })).toEqual([])
    expect(
      scan({
        scope: { kind: 'call_contract', contract: contract(8) },
        expr: callExpr({ contract: contract(8), fn: 'transfer' }),
      })
    ).toEqual([])
    expect(scan({ scope: { kind: 'create_contract', wasmHash: 'ab' }, policies: [] })).toEqual([])
  })

  it('a rule at least as loose is refused; a tighter or different one is for review', () => {
    expect(scan({ expr: rule('500') })[0]).toMatchObject({ severity: 'refuse', why: 'looser' })
    expect(scan({ expr: rule('900') })[0]).toMatchObject({ severity: 'refuse', why: 'looser' })
    expect(scan({ expr: rule('100') })[0]).toMatchObject({ severity: 'review', why: 'other' })
    const differs = rule('900', [['eq', ['call_arg', 1], KEY]])
    expect(scan({ expr: differs })[0]).toMatchObject({ severity: 'review' })
  })

  it('a new rolling total is refused where a shared rule serves the calls with none', () => {
    const cap = { amount: '10', periodLedgers: 100 }
    expect(scan({ expr: rule('100') }, { cap })[0]).toMatchObject({
      severity: 'refuse',
      why: 'uncapped',
    })
    // The neighbour has its own cap: the scan falls through to the comparison.
    expect(
      scan(
        { expr: rule('100'), policies: [INTERP, LIMIT], cap: { amount: '5', periodLedgers: 100 } },
        { cap }
      )[0]
    ).toMatchObject({ severity: 'review' })
    // A neighbour policed by something unrecognised may well carry one: advisory.
    expect(scan({ policies: [contract(9)], expr: undefined }, { cap })[0]).toMatchObject({
      severity: 'review',
      why: 'other',
    })
  })

  it('a predicate that cannot be read is for review, never assumed narrow', () => {
    expect(scan({ expr: undefined })[0]).toMatchObject({ severity: 'review', why: 'unreadable' })
  })
})

// ---- the account as the chain reports it (recorded from a live testnet account) ----

const net = recorded('rules')
afterAll(() => net.stop())

describe('readRules, on a live account', () => {
  it('reads the rules by simulation and the interpreter record as one ledger entry', async () => {
    const server = connect(net.endpoint)
    const { rules, complete, unreadable } = await readRules(
      server,
      'testnet',
      'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P',
      INTERP
    )
    expect(complete).toBe(true)
    expect(unreadable).toEqual([])
    expect(rules.map((r) => [r.id, r.scope.kind, r.policies.length])).toEqual([
      [0, 'default', 0],
      [1, 'call_contract', 1],
    ])
    expect(rules[0]?.signers).toEqual(['GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'])
    expect(rules[1]?.expr).toEqual(
      callExpr({
        contract: TOKEN,
        fn: 'transfer',
        where: [
          { rule: 'pin', at: [0], to: 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P' },
          { rule: 'cap', at: [2], max: '1000' },
        ],
      })
    )
  })

  it('and the scan, over what it read: the Default rule with no policy shadows any rule for its signer', async () => {
    const server = connect(net.endpoint)
    const { rules } = await readRules(
      server,
      'testnet',
      'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P',
      INTERP
    )
    const signer = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
    const found = overlaps(
      {
        scope: { kind: 'call_contract', contract: TOKEN },
        signers: [signer],
        expr: callExpr({ contract: TOKEN, fn: 'transfer' }),
      },
      rules,
      INTERP,
      'testnet'
    )
    expect(found.map((o) => [o.ruleId, o.why])).toEqual([
      [0, 'unpoliced'],
      [1, 'other'],
    ])
  })
})
