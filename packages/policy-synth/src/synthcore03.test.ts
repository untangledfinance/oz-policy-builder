// SYNTH-CORE-03: verify_policy exercised only the first breakable leaf of an `all` body, so a later
// vacuous leaf (a self-comparison that binds nothing) passed while `ok`/`complete` still came back
// true. denyCases now emits one case per body leaf, so every leaf is turned against the call.

import { afterAll, describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { denyCases, verifyRule } from './check.ts'
import type { Call } from './record.ts'
import type { Expr, Val } from './wire.ts'

const A = account(1)
const B = account(2)
const C = contract(1)

/** One Blend-style request `{ address, amount, request_type }` as a map value. */
const req = (address: string, amount: string, type: number): Val => ({
  map: [
    ['address', address],
    ['amount', { i128: amount }],
    ['request_type', type],
  ],
})

describe('denyCases expands an `all` body into one case per leaf (SYNTH-CORE-03)', () => {
  const permit: Call = { contract: C, fn: 'submit', args: [A, A, A, [req(A, '500', 2)]] }

  it('derives a case for every breakable body leaf, not just the first', () => {
    const body: Expr = [
      'all',
      ['call_arg', 3],
      [
        'and',
        [
          ['eq', ['elem', 'request_type'], 2],
          ['lte', ['elem', 'amount'], { i128: '1000' }],
          ['eq', ['elem', 'address'], A],
        ],
      ],
    ]
    const cases = denyCases([body], permit)
    // The old code returned a single case (the first leaf). Every body leaf is now exercised.
    expect(cases).toHaveLength(3)
    expect(cases.every((c) => c.conjunct === body)).toBe(true)
    expect(new Set(cases.map((c) => JSON.stringify(c.leaf))).size).toBe(3)
    // Each case breaks element 0 of the requests vec, on its own field.
    expect(cases.map((c) => (c.call.args[3] as Val[])[0])).not.toContainEqual(req(A, '500', 2))
  })
})

describe('verify_policy on the live interpreter: an untested quantifier leaf is no longer complete', () => {
  const net = recorded('synthcore03')
  afterAll(() => net.stop())
  const server = connect(net.endpoint)
  const interpreter = interpreterFor('testnet')
  const check = (e: Expr, permit: Call) => verifyRule(server, 'testnet', interpreter, e, [permit])

  const scope = (body: Expr): Expr => [
    'and',
    [['eq', ['call_contract'], C], ['eq', ['call_fn'], 'submit'], body],
  ]
  const permit: Call = { contract: C, fn: 'submit', args: [A, A, A, [req(A, '500', 2)]] }

  it('a vacuous later leaf (amount <= amount, address == address) is caught: ok is false', async () => {
    const vacuous = scope([
      'all',
      ['call_arg', 3],
      [
        'and',
        [
          ['eq', ['elem', 'request_type'], 2],
          ['lte', ['elem', 'amount'], ['elem', 'amount']],
          ['eq', ['elem', 'address'], ['elem', 'address']],
        ],
      ],
    ])
    const v = await check(vacuous, permit)
    expect(v.permit.permitted).toBe(true)
    // At least one body-leaf case is not denied (the vacuous self-comparison still holds), so the
    // rule does not prove complete (the old code reported ok: true, complete: true here).
    expect(v.cases.some((c) => !c.denied)).toBe(true)
    expect(v.ok).toBe(false)
    expect(v.complete).toBe(false)
  })

  it('an honest `all` body with real bounds on every leaf still reads ok and complete', async () => {
    const honest = scope([
      'all',
      ['call_arg', 3],
      [
        'and',
        [
          ['eq', ['elem', 'request_type'], 2],
          ['lte', ['elem', 'amount'], { i128: '1000' }],
          ['in', ['elem', 'address'], [A, B]],
        ],
      ],
    ])
    const v = await check(honest, permit)
    expect(v.permit.permitted).toBe(true)
    // Two top-level pins (contract, fn) plus one case per `all` body leaf.
    expect(v.cases.length).toBe(5)
    expect(v.cases.every((c) => c.denied)).toBe(true)
    expect(v.ok).toBe(true)
    expect(v.complete).toBe(true)
    expect(v.untested).toEqual([])
  })
})
