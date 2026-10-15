// What each argument of each known call IS, one row at a time: which argument a
// rule pins, which it caps, which it leaves open. These are the 1.x per-protocol
// argument-role tests, asserted from outside the registry (a role that is wrong
// here is a rule that bounds the wrong argument, and an unbounded spend).

import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import type { Call } from './record.ts'
import { identify, PROTOCOLS } from './registry.ts'
import { propose, synthesize } from './synth.ts'
import { type Expr, isSelector, type Val } from './wire.ts'

const [A, B, C] = [account(1), account(2), contract(1)]
const i128 = (n: string): Val => ({ i128: n })
const LIMIT = '777'

/** `op:argument` for every leaf of the rule that is about an argument. */
function leaves(expr: Expr): string[] {
  const [op, rest] = expr as [string, Expr]
  if (op === 'and') return (rest as Expr[]).flatMap(leaves)
  const at = (expr as Expr[])[1]
  return isSelector(at) && at[0] === 'call_arg' ? [`${op}:${at[1]}`] : []
}
const roles = (c: Call, answers = { limit: LIMIT }) => {
  const s = synthesize([c], answers)
  return { leaves: leaves(propose(s.intent)[0]?.expr as Expr), s }
}
const call = (fn: string, args: Val[]): Call => ({ contract: C, fn, args })

describe('SEP-41', () => {
  it.each<[string, Val[], string[]]>([
    ['transfer', [A, B, i128('5')], ['eq:0', 'eq:1', 'lte:2']],
    ['approve', [A, B, i128('5'), 1000], ['eq:0', 'eq:1', 'lte:2']], // the expiry is left to the caller
    ['mint', [B, i128('5')], ['eq:0', 'lte:1']],
    ['burn', [A, i128('5')], ['eq:0', 'lte:1']],
  ])('%s pins who and caps the amount', (fn, args, want) => {
    const r = roles(call(fn, args))
    expect(r.leaves).toEqual(want)
    expect(r.s.ambiguities).toEqual([])
    expect(identify(fn, args)?.protocol).toBe('sep41')
  })

  it('an amount with no answer is a question, for every function that moves one', () => {
    for (const [fn, args] of [
      ['transfer', [A, B, i128('5')]],
      ['approve', [A, B, i128('5'), 1000]],
      ['mint', [B, i128('5')]],
      ['burn', [A, i128('5')]],
    ] as [string, Val[]][])
      expect(synthesize([call(fn, args)]).ambiguities.map((a) => a.code)).toEqual([
        'AMOUNT_BOUND_MISSING',
      ])
  })
})

describe('Soroswap: the cap lands on what is SPENT', () => {
  const path = [C, contract(2)]
  const swap = {
    exactIn: call('swap_exact_tokens_for_tokens', [i128('9'), i128('1'), path, A, 1_700_000_000]),
    exactOut: call('swap_tokens_for_exact_tokens', [i128('1'), i128('9'), path, A, 1_700_000_000]),
    exactInNoDeadline: call('swap_exact_in_for_tokens', [i128('9'), i128('1'), path, A]),
  }

  it('swap_exact_tokens_for_tokens caps amount_in (arg 0); the minimum out and the deadline stay open', () => {
    const r = roles(swap.exactIn)
    expect(r.leaves).toEqual(['lte:0', 'eq:2', 'eq:3'])
    expect(r.s.warnings.join(' ')).toContain('amount_out_min')
  })

  it('swap_tokens_for_exact_tokens caps amount_in_max (arg 1), NOT amount_out (arg 0): the input is what is spent', () => {
    const r = roles(swap.exactOut)
    expect(r.leaves).toEqual(['lte:1', 'eq:2', 'eq:3'])
    expect(r.leaves).not.toContain('lte:0')
    expect(r.s.ambiguities).toEqual([])
    // With no answer, the question is about the amount that is spent.
    expect(synthesize([swap.exactOut]).ambiguities[0]?.question).toContain('amount_in_max')
  })

  it('swap_exact_in_for_tokens (no deadline) caps amount_in (arg 0)', () => {
    expect(roles(swap.exactInNoDeadline).leaves).toEqual(['lte:0', 'eq:2', 'eq:3'])
  })

  it('the recipient is pinned unless an allowlist replaces it, and the path is pinned exactly', () => {
    const r = roles(swap.exactIn, { limit: LIMIT, allow: { to: [A, B] } } as never)
    expect(r.leaves).toEqual(['lte:0', 'eq:2', 'in:3'])
  })
})

describe('Blend', () => {
  const request = (type: number): Val => ({
    map: [
      ['address', C],
      ['amount', i128('10')],
      ['request_type', type],
    ],
  })

  it('submit pins from, spender and to; the requests are bounded, not pinned by position', () => {
    const c = call('submit', [A, A, B, [request(0)]])
    const r = roles(c)
    expect(r.leaves).toEqual(['eq:0', 'eq:1', 'eq:2'])
    expect(JSON.stringify(propose(r.s.intent)[0]?.expr)).toContain(
      '["lte",["call_path",3,0,"amount"],{"i128":"777"}]'
    )
    expect(identify('submit', c.args)?.protocol).toBe('blend')
  })

  it('claim pins from, the reserve ids and to', () => {
    const r = roles(call('claim', [A, [0, 1], B]), {} as never)
    expect(r.leaves).toEqual(['eq:0', 'eq:1', 'eq:2'])
    expect(r.s.ambiguities).toEqual([])
  })

  it('a requests argument whose elements are not structs is not Blend (a vec of vecs is pinned as it is)', () => {
    const c = call('submit', [
      A,
      A,
      A,
      [
        [A, i128('5')],
        [A, i128('7')],
      ],
    ])
    expect(identify('submit', c.args)).toBeNull()
    expect(() => synthesize([c], { limit: '10' })).not.toThrow()
    expect(roles(c).leaves).toContain('eq:3')
  })
})

describe('identification is by interface, and fails closed', () => {
  it('any token or pool address is recognised, an unknown function is not', () => {
    expect(identify('transfer', [A, B, i128('1')])?.protocol).toBe('sep41')
    expect(identify('some_other_fn', [A, B, i128('1')])).toBeNull()
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'an Object.prototype name (%s) is not a function of any protocol',
    (fn) => {
      expect(identify(fn, [A])).toBeNull()
      expect(() => synthesize([call(fn, [A])])).not.toThrow()
    }
  )

  it('the wrong arity or the wrong argument types are not recognised', () => {
    expect(identify('transfer', [A, B])).toBeNull()
    expect(identify('transfer', [A, B, i128('1'), 1])).toBeNull()
    expect(identify('transfer', [A, B, 5])).toBeNull() // a u32 is not an i128 amount
    expect(identify('transfer', ['not_an_address', B, i128('1')])).toBeNull()
    expect(identify('approve', [A, B, i128('1'), 'soon'])).toBeNull()
  })

  it('a muxed account is an address', () => {
    const muxed = `M${'A'.repeat(68)}`
    expect(identify('transfer', [A, muxed, i128('1')])?.protocol).toBe('sep41')
  })

  it('every protocol row names each argument and every function once', () => {
    for (const [, fns] of Object.entries(PROTOCOLS))
      for (const row of Object.values(fns))
        expect(new Set(row.map(([n]) => n)).size).toBe(row.length)
  })
})
