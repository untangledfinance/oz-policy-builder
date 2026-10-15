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
    ])
    expect(rules[0]?.signers).toEqual(['GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'])
    // Rule 1 is policed by the first build of the interpreter, rule 2 by the current one.
    expect(rules[1]?.expr).toBeUndefined()
    expect(rules[2]?.expr).toEqual(
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
      [1, 'unreadable'], // policed by the first build of the interpreter
      [2, 'other'],
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

  it('a neighbour with a policy nobody recognises is not assumed to lack a cap', () => {
    const cap = { amount: '10', periodLedgers: 100 }
    expect(scan({ policies: [INTERP, contract(9)], expr: rule('100') }, { cap })[0]).toMatchObject({
      severity: 'review',
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
  const stub = (
    rules: Record<number, Val>,
    count: number,
    ledger: Record<string, xdr.LedgerEntry> = {}
  ) => {
    const asked: number[] = []
    const server = {
      async simulateTransaction(tx: { toEnvelope: () => xdr.TransactionEnvelope }) {
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
        if (rules[id] === undefined)
          return { latestLedger: 1, error: 'HostError: Error(Contract, #3000)' }
        return { latestLedger: 1, result: { auth: [], retval: toScVal(rules[id]) } }
      },
      async getLedgerEntries(...keys: xdr.LedgerKey[]) {
        return {
          entries: keys.flatMap((k) => {
            const hit = ledger[k.toXDR('base64')]
            return hit ? [{ key: k, val: hit.data() }] : []
          }),
        }
      },
    }
    return { server: server as unknown as rpc.Server, asked }
  }

  it('walks ids upward until every live rule is found, across gaps and batches', async () => {
    const { server, asked } = stub(
      { 0: ruleVal(0), 3: ruleVal(3), 9: ruleVal(9), 20: ruleVal(20) },
      4
    )
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.rules.map((x) => x.id)).toEqual([0, 3, 9, 20])
    expect(r.complete).toBe(true)
    // The count says 4, so the first batch asks 4 ids; then batches of eight until all four are found.
    expect(asked.slice(0, 4).sort((x, y) => x - y)).toEqual([0, 1, 2, 3])
    expect(Math.max(...asked)).toBe(27)
  })

  it('asks the count first and then only as many ids as there are rules: two rules, two simulations', async () => {
    const { server, asked } = stub({ 0: ruleVal(0), 1: ruleVal(1) }, 2)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.complete).toBe(true)
    expect(asked.sort()).toEqual([0, 1])
  })

  it('a count past the id limit is incomplete at once, without walking the ids (a hostile account)', async () => {
    const { server, asked } = stub({ 0: ruleVal(0) }, 4_000_000_000)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r).toMatchObject({ complete: false, rules: [] })
    expect(asked).toEqual([])
  })

  it('stops asking when told to', async () => {
    const stopped = new AbortController()
    stopped.abort()
    const { server, asked } = stub({ 0: ruleVal(0) }, 3)
    await expect(readRules(server, 'testnet', ACC, INTERP, stopped.signal)).rejects.toThrow()
    expect(asked).toEqual([])
  })

  it('an account with fewer rules than its count says is incomplete, and the walk stops at the id limit', async () => {
    const { server, asked } = stub({ 0: ruleVal(0) }, 5)
    const r = await readRules(server, 'testnet', ACC, INTERP)
    expect(r.complete).toBe(false)
    expect(r.rules).toHaveLength(1)
    expect(Math.max(...asked)).toBe(511) // and not one past it
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
  const mainnetG6 = 'CAOBQ4ZXANKXAGEJWJLIGQJDFCTHMEZVUPLPX277KSDMEU4MEWVVXO2R'
  const firstG7 = 'CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB'

  it('a neighbour policed by a known interpreter this build cannot decode (grammar 6, the first grammar-7 build) is refused', () => {
    for (const policies of [[mainnetG6], [firstG7], [mainnetG6, LIMIT]]) {
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
