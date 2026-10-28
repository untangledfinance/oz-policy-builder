// SYNTH-CORE-01 remnant: the amount gate did not model Blend v2's `flash_loan`, so a rule over it
// installed with no cap on the borrowed amount and no warning. The amount lives one field deep inside
// the FlashLoan struct; it is now capped (or asked), the lender and asset pinned, and any OTHER
// function the gate does not model earns a warning.

import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import type { Constraint } from './intent.ts'
import type { Call } from './record.ts'
import { identify } from './registry.ts'
import { propose, synthesize, unbounded, unboundedExpr, unmodeledWarnings } from './synth.ts'
import type { Expr, Val } from './wire.ts'

const A = account(1)
const B = account(2)
const C = contract(1)
const POOL = contract(5)

/** Blend v2 `FlashLoan { amount, asset, contract }`. */
const loanVal = (amount: string, asset: string, lender: string): Val => ({
  map: [
    ['amount', { i128: amount }],
    ['asset', asset],
    ['contract', lender],
  ],
})
const request = (amount: string): Val => ({
  map: [
    ['address', B],
    ['amount', { i128: amount }],
    ['request_type', 5],
  ],
})

const pin = (fn: string, ...rest: Expr[]): Expr => [
  'and',
  [['eq', ['call_contract'], C], ['eq', ['call_fn'], fn], ...rest],
]
const amt: Val = { i128: '1000' }

describe('flash_loan is identified and its nested amount is modelled (SYNTH-CORE-01)', () => {
  it('identifies the ABI: (from, FlashLoan, requests)', () => {
    expect(identify('flash_loan', [A, loanVal('5', B, POOL), [request('1')]])?.protocol).toBe(
      'blend'
    )
    // The struct must carry an i128 amount and two addresses, or it is not a FlashLoan.
    expect(identify('flash_loan', [A, { map: [['amount', { i128: '5' }]] }, []])).toBeNull()
    expect(identify('flash_loan', [A, loanVal('5', B, POOL)])).toBeNull()
  })

  it('an encoded predicate that leaves the borrowed amount open is asked (gate, not guess)', () => {
    const noReq: Expr = ['lte', ['call_path', 2, true], 0] // bound the requests vec to empty
    const q = (e: Expr) => unboundedExpr(e).map((a) => a.question)
    // No cap on flash_loan.amount: a question.
    const open = pin('flash_loan', ['eq', ['call_arg', 0], A], noReq)
    expect(unboundedExpr(open).map((a) => a.code)).toEqual(['AMOUNT_BOUND_MISSING'])
    expect(q(open).some((x) => x.includes('flash_loan.amount'))).toBe(true)
    // A cap on the nested amount answers it.
    const capped = pin('flash_loan', ['lte', ['call_path', 1, 'amount'], amt], noReq)
    expect(unboundedExpr(capped).map((a) => a.code)).toEqual([])
  })

  it('an intent over flash_loan is asked the nested-amount question too', () => {
    const q = (where: Constraint[]) =>
      unbounded({ calls: [{ contract: C, fn: 'flash_loan', where }] }).map((a) => a.question)
    // Nothing capped: the borrowed amount is asked.
    expect(q([]).some((x) => x.includes('flash_loan.amount'))).toBe(true)
    // With the nested amount capped, the flash_loan amount is no longer a question.
    const capped: Constraint[] = [{ constraint: 'cap', at: [1, 'amount'], max: '1000' }]
    expect(q(capped).some((x) => x.includes('flash_loan.amount'))).toBe(false)
  })

  it('a recorded flash_loan caps the amount, pins the lender and asset, and installs honestly', () => {
    const call: Call = {
      contract: POOL,
      fn: 'flash_loan',
      args: [A, loanVal('1000', B, C), [request('500')]],
    }
    // No cap given: the borrowed amount is a question, never silently uncapped.
    const open = synthesize([call])
    expect(open.ambiguities.some((a) => a.question.includes('flash_loan.amount'))).toBe(true)
    // With a limit, the amount is capped and the lender and asset are pinned.
    const done = synthesize([call], { limit: '1000' })
    expect(done.ambiguities).toEqual([])
    const where = done.intent.calls[0]?.where ?? []
    const at = (c: Constraint['constraint'], path: (string | number)[]) =>
      where.find((w) => w.constraint === c && JSON.stringify(w.at) === JSON.stringify(path))
    expect(at('cap', [1, 'amount'])).toMatchObject({ max: '1000' })
    expect(at('pin', [1, 'contract'])).toMatchObject({ to: C })
    expect(at('pin', [1, 'asset'])).toMatchObject({ to: B })
    // The produced rule is one the interpreter would decode.
    expect(() => propose(done.intent)).not.toThrow()
  })
})

describe('the safety net: a function the gate does not model earns a warning (SYNTH-CORE-01)', () => {
  it('warns for an unmodelled function in a predicate, and stays quiet for a modelled one', () => {
    const w = unmodeledWarnings(pin('mystery_withdraw', ['eq', ['call_arg', 0], A]))
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/not a function the amount gate models/)
    // A modelled function (and one with no function pinned, handled by the amount gate) is not warned.
    expect(unmodeledWarnings(pin('transfer', ['lte', ['call_arg', 2], amt]))).toEqual([])
    expect(unmodeledWarnings(pin('flash_loan', ['eq', ['call_arg', 0], A]))).toEqual([])
  })
})
