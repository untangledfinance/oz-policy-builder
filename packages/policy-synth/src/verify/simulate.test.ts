import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { ParseConfidence, PredicateNode, RecordedTransaction } from '../types.ts'
import { simulatePolicy } from './simulate.ts'

const BLEND_POOL = Address.contract(Buffer.alloc(32, 0x10)).toString()
const USDC_SAC = Address.contract(Buffer.alloc(32, 0x20)).toString()
const SOROSWAP_ROUTER = Address.contract(Buffer.alloc(32, 0x30)).toString()
const XLM_SAC = Address.contract(Buffer.alloc(32, 0x40)).toString()
const OWNER = Address.account(Buffer.alloc(32, 0x50)).toString()
const BILLER = Address.account(Buffer.alloc(32, 0x51)).toString()

const LEDGER = 1_000_000
const NOW_SECONDS = 1_700_000_000

const FULL_CONFIDENCE: ParseConfidence = {
  overall: 1,
  knownContracts: [],
  unknownContracts: [],
  opaqueScVals: [],
  thresholdUsed: 1,
}

// ---------------------------------------------------------------------------
// Fixtures: the three walkthroughs (Blend yield-claim, SEP-41 subscription,
// SoroSwap bounded). Mirrors the fixture shapes used by the orchestrator's
// self-verify tests so the boundary pins are easy to read.
// ---------------------------------------------------------------------------

function blendClaimPredicate(): PredicateNode {
  return {
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
}

function blendTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [OWNER],
    invocations: [
      {
        contract: BLEND_POOL,
        fn: 'claim',
        args: [{ type: 'address', value: OWNER }],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: XLM_SAC, from: BLEND_POOL, to: OWNER, amount: '1500000' }],
    events: [],
    authEntries: [],
    ledgerSequence: LEDGER,
    fetchedAt: NOW_SECONDS,
    parseConfidence: FULL_CONFIDENCE,
    sourceAccount: OWNER,
  }
}

function sep41Predicate(): PredicateNode {
  return {
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
      {
        op: 'lte',
        left: { kind: 'call_arg', index: 2 },
        right: { kind: 'literal_i128', value: '1000000000' },
      },
    ],
  }
}

function sep41Tx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [OWNER],
    invocations: [
      {
        contract: USDC_SAC,
        fn: 'transfer',
        args: [
          { type: 'address', value: OWNER },
          { type: 'address', value: BILLER },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: USDC_SAC, from: OWNER, to: BILLER, amount: '1000000000' }],
    events: [],
    authEntries: [],
    ledgerSequence: LEDGER,
    fetchedAt: NOW_SECONDS,
    parseConfidence: FULL_CONFIDENCE,
    sourceAccount: OWNER,
  }
}

function soroswapPredicate(): PredicateNode {
  return {
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
        left: { kind: 'call_arg', index: 0 },
        right: { kind: 'literal_i128', value: '50000000' },
      },
    ],
  }
}

function soroswapTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [OWNER],
    invocations: [
      {
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [
          { type: 'i128', value: '50000000' },
          { type: 'i128', value: '45000000' },
          {
            type: 'vec',
            value: [
              { type: 'address', value: XLM_SAC },
              { type: 'address', value: USDC_SAC },
            ],
          },
          { type: 'address', value: OWNER },
          { type: 'u64', value: '1700000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: XLM_SAC, from: OWNER, to: SOROSWAP_ROUTER, amount: '50000000' },
      { token: USDC_SAC, from: SOROSWAP_ROUTER, to: OWNER, amount: '45000000' },
    ],
    events: [],
    authEntries: [],
    ledgerSequence: LEDGER,
    fetchedAt: NOW_SECONDS,
    parseConfidence: FULL_CONFIDENCE,
    sourceAccount: OWNER,
  }
}

// ---------------------------------------------------------------------------
// simulatePolicy: walkthrough permits
// ---------------------------------------------------------------------------

describe('simulatePolicy - walkthrough permits', () => {
  it('Blend yield-claim: permit for the intended call + every deny dimension denies', () => {
    const res = simulatePolicy(blendClaimPredicate(), blendTx())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permit).toEqual({ tx: 'permit' })
    expect(res.data.backend).toBe('ts-model')
    expect(typeof res.data.simulatorVersion).toBe('string')
    // The Blend walkthrough predicate has contract + fn leaves (no amount
    // leaf, no window_spent leaf). The deny battery is therefore: contract,
    // function (+ the permit row).
    const dims = res.data.evaluatedCases.map((c) => c.dimension)
    expect(dims).toContain('permit')
    expect(dims).toContain('contract')
    expect(dims).toContain('function')
    // Every non-permit case must be a deny
    for (const c of res.data.evaluatedCases) {
      if (c.dimension === 'permit') {
        expect(c.outcome).toBe('permit')
      } else {
        expect(c.outcome).toBe('deny')
      }
    }
  })

  it('SEP-41 subscription: permit for the intended call + exact deny reason per dimension', () => {
    const res = simulatePolicy(sep41Predicate(), sep41Tx())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permit).toEqual({ tx: 'permit' })

    // Locate specific dimensions and assert the exact deny reason.
    const cases = new Map(res.data.evaluatedCases.map((c) => [c.dimension, c]))
    expect(cases.get('contract')?.outcome).toBe('deny')
    expect(cases.get('contract')?.reason).toBe('CONTRACT_SCOPE')
    expect(cases.get('function')?.outcome).toBe('deny')
    expect(cases.get('function')?.reason).toBe('FN_MISMATCH')
    expect(cases.get('arg_amount_bound')?.outcome).toBe('deny')
    expect(cases.get('arg_amount_bound')?.reason).toBe('ARG_MISMATCH')
    // The `in` allowlist deny case renders an opaque needle: the
    // evaluator's `in` returns `NOT_IN_ALLOWLIST` (NOT_IN_ALLOWLIST is the
    // surfaced reason; the evaluator's `arg_bound` path is for `eq`
    // comparisons, not `in` membership).
    expect(cases.get('arg_bound')?.outcome).toBe('deny')
    expect(cases.get('arg_bound')?.reason).toBe('NOT_IN_ALLOWLIST')
  })

  it('SoroSwap bounded: permit for the intended call + exact deny reason per dimension', () => {
    const res = simulatePolicy(soroswapPredicate(), soroswapTx())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permit).toEqual({ tx: 'permit' })

    const cases = new Map(res.data.evaluatedCases.map((c) => [c.dimension, c]))
    expect(cases.get('contract')?.reason).toBe('CONTRACT_SCOPE')
    expect(cases.get('function')?.reason).toBe('FN_MISMATCH')
    expect(cases.get('soroswap_allowed_path')?.outcome).toBe('deny')
    expect(cases.get('soroswap_allowed_path')?.reason).toBe('ARG_MISMATCH')
    expect(cases.get('arg_amount_bound')?.reason).toBe('ARG_MISMATCH')
  })

  it('null predicate (OZ-only): envelope still emitted with an empty deny battery', () => {
    const res = simulatePolicy(null, sep41Tx())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permit).toEqual({ tx: 'permit' })
    // Only the permit case row; no deny dimensions exist (no interpreter
    // predicate to verify).
    expect(res.data.evaluatedCases).toHaveLength(1)
    expect(res.data.evaluatedCases[0]?.dimension).toBe('permit')
  })

  it('a predicate that rejects the intended call returns deny with the exact reason', () => {
    // A predicate that demands a DIFFERENT recipient denies the intended
    // call outright - the envelope must surface the deny verdict + reason
    // rather than mask the failure as a SIMULATION_ERROR.
    const wrongRecipient: PredicateNode = {
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
          haystack: [{ kind: 'literal_address', value: OWNER }],
        },
      ],
    }
    const res = simulatePolicy(wrongRecipient, sep41Tx())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permit.tx).toBe('deny')
    if (res.data.permit.tx === 'deny') {
      expect(res.data.permit.reason).toBe('NOT_IN_ALLOWLIST')
    }
  })
})

// ---------------------------------------------------------------------------
// simulatePolicy: SIMULATION_ERROR path
// ---------------------------------------------------------------------------

describe('simulatePolicy - SIMULATION_ERROR boundary', () => {
  it('a recorded tx with no top-level invocation is malformed input -> SIMULATION_ERROR', () => {
    const emptyTx: RecordedTransaction = {
      ...blendTx(),
      invocations: [],
    }
    const res = simulatePolicy(blendClaimPredicate(), emptyTx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
    expect(res.error.severity).toBe('error')
    expect(res.error.retryable).toBe(false)
  })

  it('a malformed amount (non-numeric token movement) throws at context-build -> SIMULATION_ERROR', () => {
    const badTx: RecordedTransaction = {
      ...blendTx(),
      tokenMovements: [{ token: XLM_SAC, from: BLEND_POOL, to: OWNER, amount: 'not-a-number' }],
    }
    const res = simulatePolicy(blendClaimPredicate(), badTx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
    expect(res.error.message).toContain('permit evaluation context')
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('simulatePolicy - determinism', () => {
  it('same (predicate, permitTx, opts) -> byte-identical envelope across runs', () => {
    const a = simulatePolicy(blendClaimPredicate(), blendTx())
    const b = simulatePolicy(blendClaimPredicate(), blendTx())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('simulatorVersion is the pinned constant for the TS-model backend', () => {
    const res = simulatePolicy(blendClaimPredicate(), blendTx())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.simulatorVersion).toBe('ts-model-1.0.0')
  })
})
