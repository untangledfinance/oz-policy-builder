import { describe, expect, it } from 'bun:test'
import { account, contract, recording } from '../test/fixtures.ts'
import { type CallIntent, callExpr, intentExprs, lower, type Rule } from './intent.ts'
import type { Call } from './record.ts'
import { identify, TEMPLATES } from './registry.ts'
import { propose, synthesize } from './synth.ts'
import { type Expr, type Val, validate } from './wire.ts'

const A = account(1)
const C = contract(1)

describe('lowering: one row per rule', () => {
  const cases: [Rule, Expr][] = [
    [{ rule: 'pin', at: [0], to: A }, ['eq', ['call_arg', 0], A]],
    [{ rule: 'not', at: [0], to: 'x' }, ['ne', ['call_arg', 0], 'x']],
    [{ rule: 'allow', at: [1, 'k'], in: [A, 5] }, ['in', ['call_path', 1, 'k'], [A, 5]]],
    [{ rule: 'deny', at: [0], nin: [{ i128: '1' }] }, ['nin', ['call_arg', 0], [{ i128: '1' }]]],
    [{ rule: 'cap', at: [2], max: '100' }, ['lte', ['call_arg', 2], { i128: '100' }]],
    [{ rule: 'floor', at: [2], min: '1' }, ['gte', ['call_arg', 2], { i128: '1' }]],
    [{ rule: 'length', at: [3], max: 4 }, ['lte', ['call_path', 3, true], 4]],
    [
      { rule: 'minOut', at: [1], of: [0], num: '99', den: '100' },
      [
        'gte',
        ['call_arg', 1],
        ['scaled', ['call_arg', 0], { i128: '99' }, { i128: '100' }, { i128: '0' }],
      ],
    ],
    [
      {
        rule: 'each',
        at: [0],
        where: [
          { rule: 'allow', at: ['to'], in: [A] },
          { rule: 'floor', at: ['amount'], min: '0' },
        ],
      },
      [
        'all',
        ['call_arg', 0],
        [
          'and',
          [
            ['in', ['elem', 'to'], [A]],
            ['gte', ['elem', 'amount'], { i128: '0' }],
          ],
        ],
      ],
    ],
    [
      { rule: 'some', at: [0], where: [{ rule: 'pin', at: [], to: 'repay' }] },
      ['any', ['call_arg', 0], ['eq', ['elem'], 'repay']],
    ],
    [
      { rule: 'total', at: [0], of: ['amount'], max: '1000' },
      ['lte', ['sum', ['call_arg', 0], 'amount'], { i128: '1000' }],
    ],
    [
      {
        rule: 'read',
        contract: C,
        fn: 'price',
        args: [{ arg: [1] }, 'USD'],
        path: ['price'],
        op: 'gte',
        to: { i128: '5' },
      },
      ['gte', ['read', C, 'price', [['call_arg', 1], 'USD'], 'price'], { i128: '5' }],
    ],
    [{ rule: 'until', ts: 1_900_000_000 }, ['lte', ['now'], { u64: '1900000000' }]],
    [{ rule: 'from', ts: 5 }, ['gte', ['now'], { u64: '5' }]],
  ]
  it.each(cases)('%j', (rule, expr) => expect(lower(rule)).toEqual(expr))

  it('wraps what a bare value cannot carry in lit', () => {
    expect(lower({ rule: 'pin', at: [0], to: ['a', 1] })).toEqual([
      'eq',
      ['call_arg', 0],
      ['lit', ['a', 1]],
    ])
    expect(lower({ rule: 'pin', at: [0], to: { string: 'memo' } })).toEqual([
      'eq',
      ['call_arg', 0],
      ['lit', { string: 'memo' }],
    ])
    expect(lower({ rule: 'pin', at: [0], to: true })).toEqual([
      'eq',
      ['call_arg', 0],
      ['lit', true],
    ])
  })

  it('pins contract and function, keeps the order written, groups by contract with an or', () => {
    const one: CallIntent = {
      contract: C,
      fn: 'pay',
      where: [
        { rule: 'pin', at: [1], to: 2 },
        { rule: 'pin', at: [0], to: 1 },
      ],
    }
    expect(callExpr(one)).toEqual([
      'and',
      [
        ['eq', ['call_contract'], C],
        ['eq', ['call_fn'], 'pay'],
        ['eq', ['call_arg', 1], 2],
        ['eq', ['call_arg', 0], 1],
      ],
    ])
    const exprs = intentExprs({
      calls: [one, { contract: C, fn: 'refund' }, { contract: contract(2), fn: 'x' }],
    })
    expect([...exprs.keys()]).toEqual([C, contract(2)])
    expect((exprs.get(C) as Expr[])[0]).toBe('or')
  })
})

describe('the registry', () => {
  it('identifies a call by function and argument shapes, not by address', () => {
    expect(identify('transfer', [A, A, { i128: '1' }])?.protocol).toBe('sep41')
    expect(identify('transfer', [A, A, 1])).toBeNull()
    expect(identify('transfer', [A, A])).toBeNull()
    expect(identify('nothing', [])).toBeNull()
  })

  it('templates lower to rules the contract would decode', () => {
    const batch = TEMPLATES.adapter_batch({
      adapter: C,
      targets: [contract(2), contract(3)],
      functions: ['supply'],
    })
    const venue = TEMPLATES.blend_venue({ pool: C, token: contract(2), account: A, max: '1000' })
    for (const intent of [batch, venue])
      for (const r of propose(intent)) expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    const [rule] = propose(batch)
    expect(JSON.stringify(rule?.expr)).toContain('"all"')
    expect(JSON.stringify(rule?.expr)).toContain('["lte",["call_path",1,true],0]')
  })

  it('a batch template that cannot fit the contract body cap is refused, not truncated', () => {
    const wide = TEMPLATES.adapter_batch({
      adapter: C,
      targets: [1, 2, 3, 4, 5, 6].map(contract),
      functions: ['a'],
    })
    expect(() => propose(wide)).toThrow(/leaves/)
  })
})

describe('synthesis from what was recorded', () => {
  it('a SEP-41 transfer: pin who, cap how much; no cap is a question, not a guess', () => {
    const [call] = recording('sep41').contexts as [Call]
    const capped = synthesize([call], { limit: '8000000000' })
    expect(capped.ambiguities).toEqual([])
    const [rule] = propose(capped.intent)
    expect(rule?.expr).toEqual([
      'and',
      [
        ['eq', ['call_contract'], call.contract],
        ['eq', ['call_fn'], 'transfer'],
        ['eq', ['call_arg', 0], call.args[0]],
        ['eq', ['call_arg', 1], call.args[1]],
        ['lte', ['call_arg', 2], { i128: '8000000000' }],
      ],
    ])
    const open = synthesize([call])
    expect(open.ambiguities.map((a) => a.code)).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(JSON.stringify(propose(open.intent)[0]?.expr)).not.toContain('"lte"')
  })

  it('an allowlist replaces the pin on who', () => {
    const [call] = recording('sep41').contexts as [Call]
    const s = synthesize([call], { limit: '1', allow: { to: [A, contract(9)] } })
    expect(JSON.stringify(propose(s.intent)[0]?.expr)).toContain(
      `["in",["call_arg",1],["${A}","${contract(9)}"]]`
    )
  })

  it('a swap: the router rule and the nested token transfer are separate rules; a missing floor is said', () => {
    const s = synthesize(recording('soroswap').contexts, {
      limits: { amount_in: '400000000' },
      limit: '400000000',
    })
    const rules = propose(s.intent)
    expect(rules.map((r) => r.contract)).toEqual(
      recording('soroswap').contexts.map((c) => c.contract)
    )
    expect(s.warnings.some((w) => w.includes('no minimum output'))).toBe(true)
    expect(s.warnings.some((w) => w.includes('2 contracts'))).toBe(true)
    const router = JSON.stringify(rules[0]?.expr)
    expect(router).toContain('"lit"') // the path is pinned exactly, as a constant
    expect(router).not.toContain('["call_arg",1]') // amount_out_min is left to the caller
    expect(router).not.toContain('["call_arg",4]') // and so is the deadline
  })

  it('a function the registry does not know: pinned, amounts asked for, and it says so', () => {
    const call: Call = { contract: C, fn: 'weird', args: [A, { i128: '5' }, 7, ['x']] }
    const s = synthesize([call])
    expect(s.warnings[0]).toContain('not a function the registry knows')
    expect(s.ambiguities).toHaveLength(1)
    const text = JSON.stringify(propose(s.intent)[0]?.expr)
    expect(text).toContain('["eq",["call_arg",2],7]')
    expect(text).toContain('["eq",["call_arg",3],["lit",["x"]]]')
  })

  it('refuses nothing to scope a policy to', () => expect(() => synthesize([])).toThrow(/no call/))

  describe('a vec of structs', () => {
    const req = (type: number, amount: string): Val => ({
      map: [
        ['address', C],
        ['amount', { i128: amount }],
        ['request_type', type],
      ],
    })
    const submit = (...requests: Val[]): Call => ({
      contract: contract(5),
      fn: 'submit',
      args: [A, A, A, requests],
    })

    it('two fields: a quantifier over the elements, capped, at most as many as recorded', () => {
      const two = (amount: string): Val => ({
        map: [
          ['address', C],
          ['amount', { i128: amount }],
        ],
      })
      const text = JSON.stringify(
        propose(synthesize([submit(two('10'), two('20'))], { limit: '50' }).intent)[0]?.expr
      )
      expect(text).toContain('["lte",["call_path",3,true],2]')
      expect(text).toContain('"all",["call_arg",3]')
      expect(text).toContain('["lte",["elem","amount"],{"i128":"50"}]')
      expect(text).toContain(`["eq",["elem","address"],"${C}"]`)
    })

    it('three fields overflow the leaf cap, so each recorded element is pinned in turn', () => {
      const s = synthesize([submit(req(0, '10'), req(1, '20'))], { limit: '50' })
      const text = JSON.stringify(propose(s.intent)[0]?.expr)
      expect(text).not.toContain('"all"')
      expect(text).toContain('["lte",["call_path",3,1,"amount"],{"i128":"50"}]')
      expect(text).toContain('["eq",["call_path",3,0,"request_type"],0]')
      expect(text).toContain('["eq",["call_path",3,1,"request_type"],1]')
    })

    it('an amount with no cap is a question, asked once', () => {
      const s = synthesize([submit(req(0, '10'), req(1, '20'))])
      expect(s.ambiguities).toHaveLength(1)
      expect(s.ambiguities[0]?.question).toContain('requests.amount')
    })
  })

  it('every recorded flow yields rules the contract would decode', () => {
    for (const n of ['blend', 'sep41', 'soroswap'] as const) {
      for (const r of propose(synthesize(recording(n).contexts, { limit: '1' }).intent))
        expect(() => validate(r.expr)).not.toThrow()
    }
  })
})
