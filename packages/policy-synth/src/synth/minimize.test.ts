import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { PredicateNode } from '../types.ts'
import { generateCases } from './deny-cases.ts'
import { type EvalContext, evaluate } from './evaluate.ts'
import { minimize } from './minimize.ts'

const CONTRACT = Address.contract(Buffer.alloc(32, 0x12)).toString()
const TOKEN = CONTRACT

function context(): EvalContext {
  return {
    contract: CONTRACT,
    fn: 'transfer',
    args: [{ type: 'i128', value: '50' }],
    atLedger: 1_000,
    nowSeconds: 1_700_000_000,
    amountByToken: { [TOKEN]: '50' },
    windowSpentByToken: {},
  }
}

const contractConstraint: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_contract' },
  right: { kind: 'literal_address', value: CONTRACT },
}

const functionConstraint: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'transfer' },
}

const argBoundConstraint: PredicateNode = {
  op: 'lte',
  left: { kind: 'call_arg', index: 0 },
  right: { kind: 'literal_i128', value: '100' },
}

describe('minimize', () => {
  it('drops a redundant duplicate and keeps every load-bearing constraint in order', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        contractConstraint,
        functionConstraint,
        { ...functionConstraint },
        argBoundConstraint,
      ],
    }
    const permitCtx = context()

    expect(minimize(predicate, permitCtx)).toEqual({
      op: 'and',
      children: [contractConstraint, functionConstraint, argBoundConstraint],
    })
    expect(predicate.op === 'and' && predicate.children).toHaveLength(4)
  })

  it('keeps an argument bound whose deny mutation becomes permitted without it', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [contractConstraint, functionConstraint, argBoundConstraint],
    }
    const permitCtx = context()
    const amountCase = generateCases(predicate, permitCtx).denies.find(
      ({ dimension }) => dimension === 'arg_amount_bound'
    )
    const withoutAmount: PredicateNode = {
      op: 'and',
      children: [contractConstraint, functionConstraint],
    }

    expect(amountCase).toBeDefined()
    if (!amountCase) return
    expect(evaluate(predicate, amountCase.ctx).permit).toBe(false)
    expect(evaluate(withoutAmount, amountCase.ctx)).toEqual({ permit: true })
    expect(minimize(predicate, permitCtx)).toEqual(predicate)
  })

  it('keeps a call_arg input-amount cap - the deny battery makes it load-bearing', () => {
    // Regression: an ordered call_arg cap must NOT be pruned as redundant.
    // Without a deny case that violates it, minimize would silently drop the
    // caller-requested restriction (warn-and-weaken).
    const argCap: PredicateNode = {
      op: 'lte',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_i128', value: '50000000' },
    }
    const predicate: PredicateNode = {
      op: 'and',
      children: [contractConstraint, functionConstraint, argCap],
    }
    const permitCtx = context()
    permitCtx.args = [{ type: 'i128', value: '40000000' }]

    const minimized = minimize(predicate, permitCtx)
    expect(minimized).toEqual(predicate)
    if (minimized.op !== 'and') return
    const keptArgCap = minimized.children.some((c) => c.op === 'lte' && c.left.kind === 'call_arg')
    expect(keptArgCap).toBe(true)
  })

  it('leaves a non-conjunction predicate unchanged', () => {
    expect(minimize(functionConstraint, context())).toBe(functionConstraint)
  })
})
