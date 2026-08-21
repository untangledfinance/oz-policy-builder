import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { ParseConfidence, PredicateNode, RecordedTransaction } from '../types.ts'
import { verifyPolicy } from './verify.ts'

const USDC_SAC = Address.contract(Buffer.alloc(32, 0x20)).toString()
const OWNER = Address.account(Buffer.alloc(32, 0x50)).toString()
const BILLER = Address.account(Buffer.alloc(32, 0x51)).toString()
const EXTRA_BILLER = Address.account(Buffer.alloc(32, 0x52)).toString()

const LEDGER = 1_000_000
const NOW_SECONDS = 1_700_000_000

const FULL_CONFIDENCE: ParseConfidence = {
  overall: 1,
  knownContracts: [],
  unknownContracts: [],
  opaqueScVals: [],
  thresholdUsed: 1,
}

/** Minimal `and`-shaped predicate that permits exactly the SEP-41 transfer
 *  to BILLER on USDC_SAC. Every conjunct is load-bearing; the minimizer
 *  must drop none. */
function minimalSep41Predicate(): PredicateNode {
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

/** Same as `minimalSep41Predicate` PLUS a redundant duplicate `call_fn`
 *  conjunct. The minimizer must drop the duplicate and surface a
 *  VERIFICATION_FAILED naming the dropped conjunct. */
function overBroadSep41Predicate(): PredicateNode {
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
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'transfer' },
      },
      {
        op: 'in',
        needle: { kind: 'call_arg', index: 1 },
        haystack: [
          { kind: 'literal_address', value: BILLER },
          { kind: 'literal_address', value: EXTRA_BILLER },
        ],
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

// ---------------------------------------------------------------------------
// verifyPolicy: ok path (minimal policy)
// ---------------------------------------------------------------------------

describe('verifyPolicy - minimal policies', () => {
  it('returns ok for a minimal SEP-41 predicate (every conjunct is load-bearing)', () => {
    const res = verifyPolicy(minimalSep41Predicate(), sep41Tx())
    expect(res.ok).toBe(true)
  })

  it('returns ok for a non-and predicate (minimize is a no-op on non-and shapes)', () => {
    // An `or` is structurally not minimisable - dropping a disjunct makes
    // the policy MORE restrictive, not less. The static check returns ok;
    // the runtime harness in simulatePolicy covers over-broad OR shapes.
    const orPredicate: PredicateNode = {
      op: 'or',
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
      ],
    }
    const res = verifyPolicy(orPredicate, sep41Tx())
    expect(res.ok).toBe(true)
  })

  it('returns ok for an `eq` predicate (atomic shape, no removable conjuncts)', () => {
    const eqOnly: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: USDC_SAC },
    }
    const res = verifyPolicy(eqOnly, sep41Tx())
    expect(res.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyPolicy: VERIFICATION_FAILED path (over-broad)
// ---------------------------------------------------------------------------

describe('verifyPolicy - over-broad policies', () => {
  it('returns VERIFICATION_FAILED for a policy carrying a redundant conjunct, naming the droppable constraint(s)', () => {
    const res = verifyPolicy(overBroadSep41Predicate(), sep41Tx())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.severity).toBe('error')
    expect(res.error.retryable).toBe(false)
    expect(res.error.message).toContain('over-broad')
    // `details.droppedConstraints` lists the structurally-fingerprinted
    // dropped conjuncts. The minimiser drops the duplicate `call_fn == transfer`
    // conjunct; its fingerprint is one of the dropped entries.
    const details = res.error.details as { droppedConstraints?: string[] }
    expect(details).toBeDefined()
    expect(Array.isArray(details?.droppedConstraints)).toBe(true)
    expect(details?.droppedConstraints?.length).toBeGreaterThan(0)
    const allFingerprints = details?.droppedConstraints?.join('\n') ?? ''
    // The dropped conjunct is the duplicate `eq call_fn 'transfer'`; its
    // fingerprint carries both the operator and the literal value.
    expect(allFingerprints).toContain('"op":"eq"')
    expect(allFingerprints).toContain('"kind":"call_fn"')
    expect(allFingerprints).toContain('"value":"transfer"')
  })
})

// ---------------------------------------------------------------------------
// Boundary: SIMULATION_ERROR vs VERIFICATION_FAILED are distinguishable
// ---------------------------------------------------------------------------

describe('verifyPolicy - SIMULATION_ERROR vs VERIFICATION_FAILED boundary', () => {
  it('a minimality failure surfaces VERIFICATION_FAILED, never SIMULATION_ERROR', () => {
    const res = verifyPolicy(overBroadSep41Predicate(), sep41Tx())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.code).not.toBe('SIMULATION_ERROR')
  })

  it('a minimal policy returns ok (not VERIFICATION_FAILED, not SIMULATION_ERROR)', () => {
    const res = verifyPolicy(minimalSep41Predicate(), sep41Tx())
    expect(res.ok).toBe(true)
    // The boundary contract: the only two outcomes are `{ok:true}` and
    // a ToolError whose `code` is `VERIFICATION_FAILED`. A success path
    // emits neither error code.
    if (res.ok) {
      expect(res.data).toBe(true)
    } else {
      expect(res.error.code).toBe('VERIFICATION_FAILED')
    }
  })

  it('a malformed recorded tx (no top-level invocation) is reported as VERIFICATION_FAILED - this module never emits SIMULATION_ERROR', () => {
    const emptyTx: RecordedTransaction = {
      ...sep41Tx(),
      invocations: [],
    }
    const res = verifyPolicy(minimalSep41Predicate(), emptyTx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    // Boundary pin: verify.ts only emits VERIFICATION_FAILED. Even when
    // the runtime path cannot be exercised, this module never emits
    // SIMULATION_ERROR - the boundary is a one-way contract.
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.code).not.toBe('SIMULATION_ERROR')
  })

  it('a malformed amount (non-numeric token movement) fails the context build with VERIFICATION_FAILED, not SIMULATION_ERROR', () => {
    const badTx: RecordedTransaction = {
      ...sep41Tx(),
      tokenMovements: [{ token: USDC_SAC, from: OWNER, to: BILLER, amount: 'not-a-number' }],
    }
    const res = verifyPolicy(minimalSep41Predicate(), badTx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.code).not.toBe('SIMULATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('verifyPolicy - determinism', () => {
  it('same (predicate, permitTx) -> byte-identical verdict across runs', () => {
    const a = verifyPolicy(overBroadSep41Predicate(), sep41Tx())
    const b = verifyPolicy(overBroadSep41Predicate(), sep41Tx())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the dropped-constraint fingerprint list is deterministic', () => {
    const a = verifyPolicy(overBroadSep41Predicate(), sep41Tx())
    const b = verifyPolicy(overBroadSep41Predicate(), sep41Tx())
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (a.ok || b.ok) return
    const aDetails = a.error.details as { droppedConstraints?: string[] }
    const bDetails = b.error.details as { droppedConstraints?: string[] }
    expect(aDetails.droppedConstraints).toEqual(bDetails.droppedConstraints)
  })
})
