import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { PredicateNode } from '../types.ts'
import { generateCases } from './deny-cases.ts'
import type { EvalContext } from './evaluate.ts'
import { runHarness } from './harness.ts'

const CONTRACT = Address.contract(Buffer.alloc(32, 0x11)).toString()
const TOKEN = CONTRACT

function context(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    contract: CONTRACT,
    fn: 'transfer',
    args: [{ type: 'i128', value: '50' }],
    atLedger: 1_000,
    nowSeconds: 1_700_000_000,
    amountByToken: { [TOKEN]: '50' },
    windowSpentByToken: {},
    ...overrides,
  }
}

const boundedPolicy: PredicateNode = {
  op: 'and',
  children: [
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: CONTRACT },
    },
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'transfer' },
    },
    {
      op: 'lte',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_i128', value: '100' },
    },
  ],
}

describe('runHarness', () => {
  it('passes a correct policy against its generated battery', () => {
    const permitCtx = context()

    expect(runHarness(boundedPolicy, generateCases(boundedPolicy, permitCtx))).toEqual({ ok: true })
  })

  it('reports the exact dimension permitted by an over-broad policy', () => {
    const permitCtx = context()
    const cases = generateCases(boundedPolicy, permitCtx)
    const withoutArgBound: PredicateNode = {
      op: 'and',
      children: boundedPolicy.op === 'and' ? boundedPolicy.children.slice(0, 2) : [],
    }

    expect(runHarness(withoutArgBound, cases)).toEqual({
      ok: false,
      failures: [
        {
          dimension: 'arg_amount_bound',
          expected: 'deny',
          got: 'permit',
          reason: 'DENY_CASE_FAILURE',
        },
      ],
    })
  })

  it('reports the evaluator reason when the intended permit case is denied', () => {
    const cases = {
      permit: context({ fn: 'withdraw' }),
      denies: [],
    }

    expect(runHarness(boundedPolicy, cases)).toEqual({
      ok: false,
      failures: [
        {
          dimension: 'PERMIT_CASE_FAILED',
          expected: 'permit',
          got: 'deny',
          reason: 'FN_MISMATCH',
        },
      ],
    })
  })
})
