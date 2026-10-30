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
  readRule,
  readRules,
  selectors,
  signerKey,
} from './rules.ts'
import type { Expr, Val } from './wire.ts'

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

  // an `and` of k two-way `or`s, each branch of which pins nothing on the contract or
  // function, used to double the (unreduced, all-wildcard) selector list at every step — 2^k objects
  // by k=26, which crashed review_unsigned (through keyedSafeOnNoGate) with readContracts. The meet
  // is now bounded by a budget and deduplicated, so it collapses to a single wildcard at once.
  it('bounds the exponential selector expansion of an `and` of two-way `or`s', () => {
    const ors: Expr[] = []
    for (let i = 0; i < 26; i++)
      ors.push([
        'or',
        [
          ['lte', ['call_arg', i], 1],
          ['gte', ['call_arg', i], 2],
        ],
      ] as Expr)
    const e: Expr = ['and', ors]
    const t0 = performance.now()
    const s = selectors(e)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(s.length).toBeLessThanOrEqual(1 << 14)
    // It over-approximates (fails closed): a wildcard means every caller treats more calls as served.
    expect(s).toEqual([{ contract: '*', fn: '*' }])
  })
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

  it('a rule at least as loose is refused; a tighter one only listed; any other that permits more is refused', () => {
    expect(scan({ expr: rule('500') })[0]).toMatchObject({ severity: 'refuse', why: 'looser' })
    expect(scan({ expr: rule('900') })[0]).toMatchObject({ severity: 'refuse', why: 'looser' })
    // Tighter: it adds no authority the new rule does not give, so it is information.
    expect(scan({ expr: rule('100') })[0]).toMatchObject({ severity: 'review', why: 'other' })
    expect(scan({ expr: rule('100', [['eq', ['call_arg', 1], KEY]]) })[0]).toMatchObject({
      severity: 'review',
    })
    // Neither: it permits calls the new rule forbids (a different extra pin, so some calls only it allows).
    const differs = rule('900', [['eq', ['call_arg', 1], KEY]])
    expect(scan({ expr: differs })[0]).toMatchObject({ severity: 'refuse', why: 'other' })
  })

  describe('a neighbour that lets the shared key exceed the new rule is refused, however it is written', () => {
    const base = (...conj: Expr[]): Expr => ['and', [['eq', ['call_fn'], 'transfer'], ...conj]]
    const L: Expr = ['call_arg', 2]
    const i = (n: string) => ({ i128: n })
    const newer: Intended = {
      ...mine,
      expr: base(['eq', ['call_arg', 0], KEY], ['lte', L, i('100')]),
    }
    const verdict = (old: Expr, over: Partial<ObservedRule> = {}) =>
      overlaps(newer, [observed({ expr: old, ...over })], INTERP, 'testnet')[0]
    it.each<[string, Expr, string, string]>([
      [
        'a range far above the cap (amt <= 1e12 and amt >= 1)',
        base(['lte', L, i('1000000000000')], ['gte', L, i('1')]),
        'refuse',
        'other',
      ],
      [
        'a recipient exclusion only (to != X)',
        base(['ne', ['call_arg', 1], KEY]),
        'refuse',
        'other',
      ],
      [
        'a bound written constant-first (1e9 >= amt)',
        base(['gte', i('1000000000'), L]),
        'refuse',
        'looser',
      ],
      ['a constant-first lower bound (1 <= amt)', base(['lte', i('1'), L]), 'refuse', 'other'],
      [
        'a function named by a read (eq(call_fn, read(...)))',
        ['and', [['eq', ['call_fn'], ['read', contract(9), 'f', []]]]],
        'refuse',
        'other',
      ],
      ['the same rule (equal is as loose)', newer.expr, 'refuse', 'looser'],
      ['a tighter cap', base(['eq', ['call_arg', 0], KEY], ['lte', L, i('10')]), 'review', 'other'],
    ])('%s', (_n, old, severity, why) => expect(verdict(old)).toMatchObject({ severity, why }))

    it("the neighbour's own scope counts as a pin: a rule scoped to the token need not repeat it", () => {
      const scoped = base(['eq', ['call_arg', 0], KEY], ['lte', L, i('10')])
      const pinned: Intended = {
        ...newer,
        expr: ['and', [['eq', ['call_contract'], TOKEN], ...(newer.expr as [string, Expr[]])[1]]],
      }
      expect(overlaps(pinned, [observed({ expr: scoped })], INTERP, 'testnet')[0]).toMatchObject({
        severity: 'review',
      })
    })

    it('a neighbour with no signer at all is taken to share every signer', () => {
      expect(verdict(base(['lte', L, i('1000')]), { signers: [] })).toMatchObject({
        severity: 'refuse',
      })
    })
  })

  it('a new rolling total is refused where a shared rule serves the calls with none', () => {
    const cap = { amount: '10', periodLedgers: 100 }
    expect(scan({ expr: rule('100') }, { cap })[0]).toMatchObject({
      severity: 'refuse',
      why: 'uncapped',
    })
    // A neighbour with a cap of its own is refused too: caps accumulate per rule, so a shared key
    // spends against the neighbour's window and the new total never sees it.
    for (const theirs of [
      { amount: '5', periodLedgers: 100 },
      { amount: '1000000000000000000000000000000', periodLedgers: 1 },
      { amount: '10', periodLedgers: 1 },
    ])
      expect(
        scan({ expr: rule('100'), policies: [INTERP, LIMIT], cap: theirs }, { cap })[0]
      ).toMatchObject({ severity: 'refuse', why: 'rolling' })
    // Without a new rolling total, a tighter capped neighbour is only information.
    expect(
      scan({
        expr: rule('100'),
        policies: [INTERP, LIMIT],
        cap: { amount: '5', periodLedgers: 100 },
      })[0]
    ).toMatchObject({ severity: 'review' })
    // A neighbour policed by something unrecognised is not judged to carry one: refused.
    expect(scan({ policies: [contract(9)], expr: undefined }, { cap })[0]).toMatchObject({
      severity: 'refuse',
      why: 'other',
    })
  })

  it('a predicate that cannot be read is refused, never assumed narrow', () => {
    expect(scan({ expr: undefined })[0]).toMatchObject({ severity: 'refuse', why: 'unreadable' })
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
      [2, 'call_contract', 1],
      [3, 'call_contract', 1],
      [4, 'call_contract', 1],
      [5, 'call_contract', 1],
      [6, 'call_contract', 1],
      [7, 'call_contract', 1],
    ])
    expect(rules[0]?.signers).toEqual(['GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'])
    // Rules 1 to 5 are policed by earlier instances of the interpreter, rules 6 and 7 by the pinned
    // one; rule 7 follows rule 6's predicate.
    for (const id of [1, 2, 3, 4, 5]) expect(rules[id]?.expr).toBeUndefined()
    const cap500 = callExpr({
      contract: TOKEN,
      fn: 'transfer',
      where: [{ constraint: 'cap', at: [2], max: '500' }],
    })
    expect(rules[6]?.expr).toEqual(cap500)
    expect(rules[6]?.follows).toBeUndefined()
    expect(rules[7]?.expr).toEqual(cap500)
    expect(rules[7]?.follows).toMatchObject({
      account: 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P',
      ruleId: 6,
      nonce: 1,
    })
    expect(rules[7]?.signers).not.toContain(rules[0]?.signers[0])
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
      [1, 'unreadable'], // policed by an interpreter build this package does not trust
      [2, 'unreadable'], // the same
      [3, 'unreadable'], // the same
      [4, 'unreadable'], // the same
      [5, 'unreadable'], // the same
      [6, 'other'],
    ])
  })
})

// ---- the pure parts, exhaustively; the reading, against a stub that has what a live account does not ----

import { Address, type rpc, xdr } from '@stellar/stellar-sdk'
import { dataKey } from './chain.ts'
import { encode, toScVal } from './wire.ts'

describe('implies, against brute force over the integers', () => {
  const ops = ['lt', 'lte', 'gt', 'gte'] as const
  const holds = (op: string, t: number, b: number) =>
    op === 'lt' ? t < b : op === 'lte' ? t <= b : op === 'gt' ? t > b : t >= b
  it('agrees for every pair of bounds on one side, for every strictness', () => {
    const L: Expr = ['call_arg', 2]
    const n = (v: number): Expr => ({ i128: String(v) })
    for (const no of ops) {
      for (const oo of ops) {
        const sameSide =
          (['lt', 'lte'].includes(no) && ['lt', 'lte'].includes(oo)) ||
          (['gt', 'gte'].includes(no) && ['gt', 'gte'].includes(oo))
        for (let x = -3; x <= 3; x++) {
          for (let y = -3; y <= 3; y++) {
            const truth = Array.from({ length: 21 }, (_, i) => i - 10).every(
              (t) => !holds(no, t, x) || holds(oo, t, y)
            )
            const got = implies([no, L, n(x)], [oo, L, n(y)])
            // The scan only claims a bound implies another on its own side; across sides it says no.
            expect(got).toBe(sameSide ? truth : false)
          }
        }
      }
    }
  })

  it('says no for what is not a comparison, and for bounds that are not numbers', () => {
    const L: Expr = ['call_arg', 2]
    expect(implies(5, 6)).toBe(false)
    expect(implies(5, 5)).toBe(true)
    expect(implies(['lte', L, 5], 7)).toBe(false)
    expect(implies(7, ['lte', L, 5])).toBe(false)
    expect(implies(['lte', L, 'x'], ['lte', L, 'y'])).toBe(false)
    expect(implies(['lte', L, { u64: '3' }], ['lte', L, { i128: '9' }])).toBe(true)
    expect(implies(['lte', L, null], ['lte', L, 5])).toBe(false)
    expect(implies(['lte', L, 5], ['lte', L, null])).toBe(false)
  })

  it('the function a call-derived rule pins is a wildcard unless it is eq or in', () => {
    expect(selectors(['ne', ['call_fn'], 'x'])).toEqual([{ contract: '*', fn: '*' }])
    expect(selectors(['nin', ['call_contract'], [TOKEN]])).toEqual([{ contract: '*', fn: '*' }])
    expect(selectors(['in', ['call_fn'], ['lit']])).toEqual([{ contract: '*', fn: 'lit' }])
  })
})

describe('the scan, signers and policies', () => {
  it('a partly shared signer set is shared; none is not', () => {
    const [a, b, c] = [account(1), account(2), account(3)]
    expect(scan({ signers: [a, c], policies: [] }, { signers: [a, b] })).toHaveLength(1)
    expect(scan({ signers: [c], policies: [] }, { signers: [a, b] })).toEqual([])
  })

  it('a neighbour with a policy nobody recognises is not assumed to carry the new total either', () => {
    const cap = { amount: '10', periodLedgers: 100 }
    expect(scan({ policies: [INTERP, contract(9)], expr: rule('100') }, { cap })[0]).toMatchObject({
      severity: 'refuse',
      why: 'rolling',
    })
    expect(scan({ policies: [INTERP, LIMIT], expr: rule('100') }, { cap })[0]).toMatchObject({
      why: 'uncapped',
    })
  })
})

describe('readRules, against a stub account', () => {
  const ACC = contract(5)
  const G = account(9)
  const ruleVal = (id: number, policies: string[] = []): Val => ({
    map: [
      ['context_type', ['Default']],
      ['id', id],
      ['name', { string: `r${id}` }],
      ['policies', policies],
      ['policy_ids', []],
      ['signer_ids', []],
      ['signers', [['Delegated', G]]],
      ['valid_until', null],
    ],
  })
  const entry = (contractId: string, key: xdr.ScVal, val: Val) =>
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
          contract: new Address(contractId).toScAddress(),
          key,
          durability: xdr.ContractDataDurability.persistent(),
          val: toScVal(val),
        })
      ),
      ext: new xdr.LedgerEntryExt(0),
    })
  const instanceKey = dataKey(ACC, xdr.ScVal.scvLedgerKeyContractInstance()).toXDR('base64')
  const ruleDataKey = (id: number) =>
    dataKey(ACC, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ContextRuleData'), xdr.ScVal.scvU32(id)]))
  const instanceEntry = (storage: [string, xdr.ScVal][]) =>
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
          contract: new Address(ACC).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvContractInstance(
            new xdr.ScContractInstance({
              executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
              storage: storage.map(
                ([k, v]) =>
                  new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(k)]), val: v })
              ),
            })
          ),
        })
      ),
      ext: new xdr.LedgerEntryExt(0),
    })
  /** An account whose rules are `rules` (null = a void answer), claiming `count` rules and (unless
   *  `next` says otherwise) one id past the highest rule. `ledger` adds entries; `batches` is the
   *  size of each getLedgerEntries call. */
  const stub = (
    rules: Record<number, Val>,
    count: number,
    ledger: Record<string, xdr.LedgerEntry> = {},
    absent = 'HostError: Error(Contract, #3000)',
    next: xdr.ScVal | null = xdr.ScVal.scvU32(Math.max(-1, ...Object.keys(rules).map(Number)) + 1)
  ) => {
    const asked: number[] = []
    const batches: number[] = []
    let simulations = 0
    const server = {
      async simulateTransaction(tx: { toEnvelope: () => xdr.TransactionEnvelope }) {
        simulations++
        const call = tx
          .toEnvelope()
          .v1()
          .tx()
          .operations()[0]
          ?.body()
          .invokeHostFunctionOp()
          .hostFunction()
          .invokeContract()
        const fn = call?.functionName().toString()
        if (fn === 'get_context_rules_count')
          return { latestLedger: 1, result: { auth: [], retval: toScVal(count) } }
        const id = call?.args()[0]?.u32() as number
        asked.push(id)
        if (rules[id] === undefined) return { latestLedger: 1, error: absent }
        return { latestLedger: 1, result: { auth: [], retval: toScVal(rules[id]) } }
      },
      async getLedgerEntries(...keys: xdr.LedgerKey[]) {
        batches.push(keys.length)
        const mine = Object.fromEntries(
          Object.keys(rules).map((id) => [
            ruleDataKey(Number(id)).toXDR('base64'),
            entry(ACC, ruleDataKey(Number(id)).contractData().key(), null),
          ])
        )
        mine[instanceKey] = instanceEntry(next ? [['NextId', next]] : [])
        return {
          entries: keys.flatMap((k) => {
            const hit = ledger[k.toXDR('base64')] ?? mine[k.toXDR('base64')]
            return hit ? [{ key: k, val: hit.data() }] : []
          }),
        }
      },
    }
    return {
      server: server as unknown as rpc.Server,
      asked,
      batches,
      calls: () => simulations + batches.length,
    }
  }

  it('an account that answers for another rule than it was asked for is not read', async () => {
    const { server } = stub({ 3: ruleVal(7) }, 1)
    await expect(readRule(server, 'testnet', ACC, 3)).rejects.toThrow(/answered for rule 7/)
    await expect(readRules(server, 'testnet', ACC, INTERP)).rejects.toThrow()
  })

  it('a rule read to be described says so when its predicate cannot be read, and is not refused', async () => {
    const { server } = stub({ 1: ruleVal(1, [INTERP]) }, 1)
    // The ledger holds no stored predicate for it.
    expect(await readRule(server, 'testnet', ACC, 1, INTERP)).toMatchObject({
      id: 1,
      unreadable: true,
    })
    expect(await readRule(server, 'testnet', ACC, 1)).not.toHaveProperty('unreadable')
  })

  const rulesAt = (ids: number[]) => Object.fromEntries(ids.map((id) => [id, ruleVal(id)]))

  it('an account with 21 removed ids reads every live rule (PayFi settlement: 15 live of 38 ever made)', async () => {
    const live = [0, ...Array.from({ length: 12 }, (_, i) => 22 + i), 36, 37]
    const { server, asked, batches, calls } = stub(
      rulesAt(live),
      15,
      {},
      undefined,
      xdr.ScVal.scvU32(38)
    )
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.rules.map((x) => x.id)).toEqual(live)
    expect(r.complete).toBe(true)
    // One simulation per live rule (and the count); the removed ids are never asked about.
    expect(asked.sort((x, y) => x - y)).toEqual(live)
    // The instance, then every id's entry in one batch.
    expect(batches).toEqual([1, 38])
    expect(calls()).toBe(1 + 15 + 2)
  })

  it('a gap of any width is crossed: 300 removed ids between two live rules', async () => {
    const { server, asked } = stub(rulesAt([0, 301]), 2)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.rules.map((x) => x.id)).toEqual([0, 301])
    expect(r.complete).toBe(true)
    expect(asked.sort((x, y) => x - y)).toEqual([0, 301])
  })

  it('an account with no removed ids and none live: complete and empty, no simulation of an id', async () => {
    const { server, asked } = stub({}, 0, {}, undefined, null)
    expect(await readRules(server, 'testnet', ACC, INTERP)).toMatchObject({
      rules: [],
      complete: true,
    })
    expect(asked).toEqual([])
  })

  it('fewer rules found than the account counts is incomplete, and says so', async () => {
    const { server, asked } = stub({ 0: ruleVal(0) }, 5)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.complete).toBe(false)
    expect(r.rules).toHaveLength(1)
    expect(asked).toEqual([0])
  })

  it('more rules found than the account counts is incomplete too (a count that is not the data)', async () => {
    const { server } = stub(rulesAt([0, 1, 2]), 2)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.complete).toBe(false)
    expect(r.rules).toHaveLength(3)
  })

  it('an account that counts rules but keeps no next id cannot be scanned: incomplete, nothing asked', async () => {
    const { server, asked } = stub({ 0: ruleVal(0) }, 1, {}, undefined, null)
    expect(await readRules(server, 'testnet', ACC, INTERP)).toMatchObject({
      complete: false,
      rules: [],
    })
    expect(asked).toEqual([])
  })

  it('a next id that is not a u32 is not trusted: incomplete, no ids asked', async () => {
    for (const next of [
      xdr.ScVal.scvI32(3),
      xdr.ScVal.scvSymbol('x'),
      xdr.ScVal.scvU32(4_000_000_000),
    ]) {
      const { server, asked, batches } = stub({ 0: ruleVal(0) }, 1, {}, undefined, next)
      expect(await readRules(server, 'testnet', ACC, INTERP)).toMatchObject({
        complete: false,
        rules: [],
      })
      expect(asked).toEqual([])
      expect(batches).toEqual([1])
    }
  })

  it('instance storage with keys of other shapes is not read as a next id, and does not throw', async () => {
    const { server, asked } = stub({ 0: ruleVal(0) }, 1)
    const real = server.getLedgerEntries.bind(server)
    const odd = [
      new xdr.ScMapEntry({ key: xdr.ScVal.scvU32(1), val: xdr.ScVal.scvU32(1) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('NextId'), val: xdr.ScVal.scvU32(9) }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
        val: xdr.ScVal.scvU32(9),
      }),
    ]
    server.getLedgerEntries = (async (...keys: xdr.LedgerKey[]) => {
      const r = await real(...keys)
      const e = r.entries[0]?.val
      if (e?.contractData().val().switch().name === 'scvContractInstance')
        e.contractData().val().instance().storage(odd)
      return r
    }) as typeof server.getLedgerEntries
    expect(await readRules(server, 'testnet', ACC, INTERP)).toMatchObject({
      complete: false,
      rules: [],
    })
    expect(asked).toEqual([])
  })

  it('an account whose instance entry the ledger does not return is not read as empty', async () => {
    const { server, asked } = stub({}, 0)
    server.getLedgerEntries = (async () => ({ entries: [] })) as never
    expect(await readRules(server, 'testnet', ACC, INTERP)).toMatchObject({
      complete: false,
      rules: [],
    })
    expect(asked).toEqual([])
  })

  it('a count past the id limit is incomplete at once, without reading the ids (a hostile account)', async () => {
    const { server, asked, batches } = stub({ 0: ruleVal(0) }, 4_000_000_000)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r).toMatchObject({ complete: false, rules: [] })
    expect(asked).toEqual([])
    expect(batches).toEqual([1])
  })

  it('a next id of exactly the id limit is read, in batches of 200; one more is not', async () => {
    const at = stub({ 0: ruleVal(0), 511: ruleVal(511) }, 2, {}, undefined, xdr.ScVal.scvU32(512))
    const r = await readRules(at.server, 'testnet', ACC, INTERP)
    expect(r.complete).toBe(true)
    expect(at.batches).toEqual([1, 200, 200, 112])
    expect(at.asked.sort((x, y) => x - y)).toEqual([0, 511])
    // The count may sit at the limit too; one more is refused before any id is read.
    const counted = stub({ 0: ruleVal(0) }, 512, {}, undefined, xdr.ScVal.scvU32(512))
    expect((await readRules(counted.server, 'testnet', ACC, INTERP)).complete).toBe(false)
    expect(counted.asked).toEqual([0])
    const past = stub({ 0: ruleVal(0) }, 1, {}, undefined, xdr.ScVal.scvU32(513))
    expect((await readRules(past.server, 'testnet', ACC, INTERP)).complete).toBe(false)
    expect(past.asked).toEqual([])
    expect(past.batches).toEqual([1])
  })

  it('a count of 513 is refused before any id is read, whatever the next id', async () => {
    const { server, asked } = stub({ 0: ruleVal(0) }, 513, {}, undefined, xdr.ScVal.scvU32(10))
    expect((await readRules(server, 'testnet', ACC, INTERP)).complete).toBe(false)
    expect(asked).toEqual([])
  })

  it('a rule whose entry is there but which the account then calls absent is skipped, and incomplete', async () => {
    const { server } = stub(
      { 0: ruleVal(0), 1: undefined as unknown as Val },
      2,
      {},
      undefined,
      xdr.ScVal.scvU32(2)
    )
    // Id 1 has an entry (the stub lists the key) but no answer: gone between the two reads.
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.rules.map((x) => x.id)).toEqual([0])
    expect(r.complete).toBe(false)
  })

  it('only "no such rule" (#3000) is an absent id: a rate limit or any other failure is an error, at once', async () => {
    for (const failure of [
      'HostError: Error(Contract, #3001)',
      'HostError: Error(WasmVm, MissingValue)',
      'rate limited (429)',
    ]) {
      const { server, asked } = stub({ 0: ruleVal(0) }, 1, {}, failure)
      // Rule 0 answers, so make the failing id one the ledger lists but the account will not read.
      const gone = stub(
        { 0: ruleVal(0), 1: undefined as unknown as Val },
        2,
        {},
        failure,
        xdr.ScVal.scvU32(2)
      )
      await expect(readRules(gone.server, 'testnet', ACC, INTERP)).rejects.toThrow()
      expect(gone.asked.length).toBeLessThanOrEqual(8)
      expect((await readRules(server, 'testnet', ACC, INTERP)).complete).toBe(true)
      expect(asked).toEqual([0])
    }
  })

  it('stops asking when told to', async () => {
    const stopped = new AbortController()
    stopped.abort()
    const { server, asked } = stub({ 0: ruleVal(0) }, 3)
    await expect(readRules(server, 'testnet', ACC, INTERP, stopped.signal)).rejects.toThrow()
    expect(asked).toEqual([])
  })

  it('a rule that comes back void is skipped, not an error', async () => {
    const { server } = stub({ 0: null, 1: ruleVal(1) }, 1)
    expect((await readRules(server, 'testnet', ACC, INTERP)).rules.map((x) => x.id)).toEqual([1])
  })

  it('reads the stored predicate and the spend cap off the ledger; a record it cannot decode is reported', async () => {
    const mine = rule('77')
    const doc = (hex: string): Val => ({
      map: [
        ['nonce', 1],
        ['predicate_bytes', { bytes: hex }],
      ],
    })
    const ledger: Record<string, xdr.LedgerEntry> = {}
    const acct = new Address(ACC).toScVal()
    const key = (id: number) => dataKey(INTERP, xdr.ScVal.scvVec([acct, xdr.ScVal.scvU32(id)]))
    ledger[key(1).toXDR('base64')] = entry(
      INTERP,
      xdr.ScVal.scvVec([acct, xdr.ScVal.scvU32(1)]),
      doc(Buffer.from(encode(mine), 'base64').toString('hex'))
    )
    ledger[key(2).toXDR('base64')] = entry(
      INTERP,
      xdr.ScVal.scvVec([acct, xdr.ScVal.scvU32(2)]),
      doc('00')
    )
    const capKey = (id: number) =>
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('AccountContext'), acct, xdr.ScVal.scvU32(id)])
    ledger[dataKey(LIMIT, capKey(1)).toXDR('base64')] = entry(LIMIT, capKey(1), {
      map: [
        ['period_ledgers', 100],
        ['spending_limit', { i128: '5' }],
      ],
    })
    const { server } = stub(
      { 0: ruleVal(0), 1: ruleVal(1, [INTERP, LIMIT]), 2: ruleVal(2, [INTERP]) },
      3,
      ledger
    )
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.rules[1]?.expr).toEqual(mine)
    expect(r.rules[1]?.cap).toEqual({ amount: '5', periodLedgers: 100 })
    expect(r.rules[0]?.expr).toBeUndefined()
    expect(r.rules[2]?.expr).toBeUndefined()
    expect(r.unreadable).toEqual([2])
  })

  it('a spend cap record missing its limit is no cap', async () => {
    const acct = new Address(ACC).toScVal()
    const capKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('AccountContext'),
      acct,
      xdr.ScVal.scvU32(0),
    ])
    const ledger = {
      [dataKey(LIMIT, capKey).toXDR('base64')]: entry(LIMIT, capKey, {
        map: [['period_ledgers', 100]],
      }),
    }
    const { server } = stub({ 0: ruleVal(0, [LIMIT]) }, 1, ledger)
    expect((await readRules(server, 'testnet', ACC, INTERP)).rules[0]?.cap).toBeUndefined()
  })
})

describe('what the scan cannot judge is refused, and what it can judge is judged by meaning', () => {
  const otherGrammar = 'CAOBQ4ZXANKXAGEJWJLIGQJDFCTHMEZVUPLPX277KSDMEU4MEWVVXO2R'
  const untrustedBuild = 'CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB'

  it('a neighbour policed by a known interpreter this build cannot decode (another grammar, or a build this package does not trust) is refused', () => {
    for (const policies of [[otherGrammar], [untrustedBuild], [otherGrammar, LIMIT]]) {
      expect(scan({ policies, expr: undefined })[0]).toMatchObject({
        severity: 'refuse',
        why: 'unreadable',
      })
    }
  })

  it('a neighbour with only a spending limit has no predicate: refused, whatever its cap', () => {
    const cap = { amount: '1', periodLedgers: 10 }
    expect(scan({ policies: [LIMIT], expr: undefined, cap })[0]).toMatchObject({
      severity: 'refuse',
      why: 'other',
    })
    expect(scan({ policies: [LIMIT], expr: undefined, cap }, { cap })[0]?.severity).toBe('refuse')
  })

  it('an ed25519 key enrolled as an External signer is the G key it is', () => {
    const external = (hex: string): Val => ['External', contract(9), { bytes: hex }]
    expect(signerKey(external(Buffer.alloc(32, 1).toString('hex')))).toBe(KEY)
    expect(signerKey(['Delegated', KEY])).toBe(KEY)
    // Any other key stays what it is: a P-256 key is not an account.
    expect(signerKey(external('abcd'))).toBe(`External:${contract(9)}:abcd`)
    expect(
      scan({
        policies: [],
        expr: undefined,
        signers: [signerKey(external(Buffer.alloc(32, 1).toString('hex')))],
      })[0]
    ).toMatchObject({ severity: 'refuse' })
  })

  it('eq(call_fn, read(...)) serves any function, not the one named "read,..."', () => {
    const viaRead: Expr = [
      'and',
      [
        ['eq', ['call_contract'], TOKEN],
        ['eq', ['call_fn'], ['read', contract(9), 'allowed_fn', []]],
      ],
    ]
    expect(selectors(viaRead)).toEqual([{ contract: TOKEN, fn: '*' }])
    expect(scan({ expr: viaRead })[0]?.ruleId).toBe(3)
  })

  it('a looser neighbour is found whichever way it spells the same thing', () => {
    const spelled = (b: Expr): Expr => [
      'and',
      [['eq', ['call_contract'], TOKEN], ['eq', ['call_fn'], 'transfer'], b],
    ]
    for (const b of [
      ['lte', ['call_path', 2], { i128: '1000' }], // call_path for call_arg
      ['lte', ['call_arg', 2], ['lit', { i128: '1000' }]], // lit-wrapped bound
      ['lte', ['call_arg', 2], { u64: '1000' }], // another integer type
    ] as Expr[]) {
      expect(scan({ expr: spelled(b) })[0]).toMatchObject({ severity: 'refuse', why: 'looser' })
    }
    // Values compare as numbers across types: u32 5 is i128 5.
    expect(
      implies(['eq', ['call_arg', 0], 5], ['in', ['call_arg', 0], [{ i128: '5' }, { i128: '6' }]])
    ).toBe(true)
    expect(implies(['eq', ['call_arg', 0], { i128: '5' }], ['eq', ['call_arg', 0], 5])).toBe(true)
    expect(implies(['lte', ['call_arg_len', 1], 3], ['lte', ['call_path', 1, true], 4])).toBe(true)
    expect(implies(['eq', ['call_arg', 0], 5], ['eq', ['call_arg', 0], 6])).toBe(false)
  })
})
