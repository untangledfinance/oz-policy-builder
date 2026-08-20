import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { PredicateNode, ScVal } from '../types.ts'
import { generateCases } from './deny-cases.ts'
import { type EvalContext, evaluate } from './evaluate.ts'

const BLEND_POOL = Address.contract(Buffer.alloc(32, 0x10)).toString()
const USDC_SAC = Address.contract(Buffer.alloc(32, 0x20)).toString()
const SOROSWAP_ROUTER = Address.contract(Buffer.alloc(32, 0x30)).toString()
const XLM_SAC = Address.contract(Buffer.alloc(32, 0x40)).toString()
const OWNER = Address.contract(Buffer.alloc(32, 0x50)).toString()
const BILLER = Address.contract(Buffer.alloc(32, 0x51)).toString()

const LEDGER = 1_000_000
const NOW_SECONDS = 1_700_000_000

function address(value: string): ScVal {
  return { type: 'address', value }
}

function context(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    contract: BLEND_POOL,
    fn: 'claim',
    args: [],
    atLedger: LEDGER,
    validUntilLedger: LEDGER + 1_000,
    nowSeconds: NOW_SECONDS,
    amountByToken: {},
    windowSpentByToken: {},
    ...overrides,
  }
}

const blendClaim: PredicateNode = {
  op: 'and',
  children: [
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: BLEND_POOL },
    },
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'claim' },
    },
  ],
}

const blendPermit = context()

const sep41Subscription: PredicateNode = {
  op: 'and',
  children: [
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: USDC_SAC },
    },
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'transfer' },
    },
    {
      op: 'in',
      needle: { kind: 'call_arg', index: 1 },
      haystack: [{ kind: 'literal_address', value: BILLER }],
    },
  ],
}

const sep41Permit = context({
  contract: USDC_SAC,
  fn: 'transfer',
  args: [address(OWNER), address(BILLER), { type: 'i128', value: '1000000000' }],
})

const soroswapBounded: PredicateNode = {
  op: 'and',
  children: [
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: SOROSWAP_ROUTER },
    },
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'swap_exact_tokens_for_tokens' },
    },
    {
      op: 'eq',
      left: { kind: 'call_arg', index: 2 },
      right: {
        kind: 'literal_vec',
        elements: [
          { kind: 'literal_address', value: XLM_SAC },
          { kind: 'literal_address', value: USDC_SAC },
        ],
      },
    },
    {
      op: 'lte',
      left: { kind: 'amount', token: XLM_SAC },
      right: { kind: 'literal_i128', value: '1000000000' },
    },
  ],
}

const soroswapPermit = context({
  contract: SOROSWAP_ROUTER,
  fn: 'swap_exact_tokens_for_tokens',
  args: [
    { type: 'i128', value: '900000000' },
    { type: 'i128', value: '800000000' },
    { type: 'vec', value: [address(XLM_SAC), address(USDC_SAC)] },
    address(OWNER),
    { type: 'u64', value: String(NOW_SECONDS + 300) },
  ],
  amountByToken: { [XLM_SAC]: '900000000' },
})

function expectEveryGeneratedDenyToDeny(
  predicate: PredicateNode,
  permitCtx: EvalContext,
  dimensions: string[]
): void {
  const cases = generateCases(predicate, permitCtx)

  expect(cases.permit).toEqual(permitCtx)
  expect(cases.permit).not.toBe(permitCtx)
  expect(cases.denies.map((deny) => deny.dimension)).toEqual(dimensions)
  for (const deny of cases.denies) {
    expect(deny.ctx).not.toBe(permitCtx)
    expect(evaluate(predicate, deny.ctx).permit).toBe(false)
  }
}

describe('generateCases - reference policies', () => {
  it('generates only the applicable Blend claim dimensions', () => {
    expectEveryGeneratedDenyToDeny(blendClaim, blendPermit, ['contract', 'function', 'timing'])
  })

  it('generates recipient and authorized-call mismatches for SEP-41 transfer', () => {
    expectEveryGeneratedDenyToDeny(sep41Subscription, sep41Permit, [
      'contract',
      'function',
      'timing',
      'arg_bound',
      'scope_contract_fn_arg',
      'argument_reorder',
    ])
  })

  it('generates amount, asset, and exact-path cases for SoroSwap', () => {
    expectEveryGeneratedDenyToDeny(soroswapBounded, soroswapPermit, [
      'amount',
      'asset',
      'contract',
      'function',
      'timing',
      'scope_contract_fn_arg',
      'soroswap_allowed_path',
    ])
  })
})

describe('generateCases - numeric boundaries', () => {
  it('uses BigInt-safe amount mutation above Number.MAX_SAFE_INTEGER', () => {
    const bound = '123456789012345678901234567890'
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'amount', token: XLM_SAC },
      right: { kind: 'literal_i128', value: bound },
    }
    const permitCtx = context({ amountByToken: { [XLM_SAC]: bound } })
    const amountCase = generateCases(predicate, permitCtx).denies.find(
      ({ dimension }) => dimension === 'amount'
    )

    expect(amountCase?.ctx.amountByToken[XLM_SAC]).toBe(((BigInt(bound) * 101n) / 100n).toString())
    expect(amountCase && evaluate(predicate, amountCase.ctx)).toEqual({
      permit: false,
      reason: 'AMOUNT_BOUND',
    })
  })

  it('mutates prior window spend past its bound', () => {
    const predicate: PredicateNode = {
      op: 'lte',
      left: { kind: 'window_spent', token: XLM_SAC, windowSeconds: 3_600 },
      right: { kind: 'literal_i128', value: '500' },
    }
    const permitCtx = context({
      validUntilLedger: undefined,
      windowSpentByToken: { [XLM_SAC]: '499' },
    })
    const cases = generateCases(predicate, permitCtx)

    expect(cases.denies.map(({ dimension }) => dimension)).toEqual(['asset', 'time_window'])
    expect(cases.denies[1]?.ctx.windowSpentByToken[XLM_SAC]).toBe('501')
  })

  it('does not mutate the supplied permit context', () => {
    const before = structuredClone(soroswapPermit)

    generateCases(soroswapBounded, soroswapPermit)

    expect(soroswapPermit).toEqual(before)
  })

  it('emits an arg_amount_bound deny case for an ordered numeric call_arg bound', () => {
    const predicate: PredicateNode = {
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'swap_exact_tokens_for_tokens' },
        },
        {
          op: 'lte',
          left: { kind: 'call_arg', index: 0 },
          right: { kind: 'literal_i128', value: '50000000' },
        },
      ],
    }
    const permitCtx = context({
      fn: 'swap_exact_tokens_for_tokens',
      args: [{ type: 'i128', value: '40000000' }],
      validUntilLedger: undefined,
    })
    const cases = generateCases(predicate, permitCtx)
    const argCase = cases.denies.find(({ dimension }) => dimension === 'arg_amount_bound')
    expect(argCase).toBeDefined()
    if (!argCase) return
    // The generated case pushes call_arg[0] past the cap (bound + 1) so it must
    // deny under the predicate, while the intended call still permits.
    expect(evaluate(predicate, argCase.ctx).permit).toBe(false)
    expect(evaluate(predicate, cases.permit).permit).toBe(true)
  })
})
