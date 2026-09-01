// A rolling total is stored per (account, RULE id), so it bounds one rule and
// never a key. These cover the consequence: installing a cap next to a rule
// that serves the same calls WITHOUT one leaves the cap decorative.
//
// Proven on chain first - see docs/audit/evidence/oz-two-rule-blend-cap.log,
// where an uncapped sibling rule permitted the exact supply the capped rule
// refused with #3221. These tests pin the scan to that observed behaviour.

import { describe, expect, test } from 'bun:test'
import type { PredicateNode } from '../types.ts'
import {
  findAuthorityOverlaps,
  type IntendedInstall,
  type KnownPolicies,
  type ObservedRule,
} from './authority-overlap.ts'

const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5'
const SPENDING_LIMIT = 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP'
const OTHER_POLICY = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const TOKEN = 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV'
const AGENT = 'GDBWWRYVW73US5V3MON64FEELLQBMYUXJEBMPL55VBID7HBU4TI27LRZ'

const KNOWN: KnownPolicies = { interpreter: INTERPRETER, spendingLimit: SPENDING_LIMIT }

/** Permits `transfer` on the token, which is what a capped token rule looks
 *  like. Both sides use it so the two rules always share a selector. */
const TRANSFERS: PredicateNode = {
  op: 'and',
  children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
    { op: 'eq', left: { kind: 'call_contract' }, right: { kind: 'literal_address', value: TOKEN } },
  ],
}

function intended(spendCap?: { amount: string; periodLedgers: number }): IntendedInstall {
  return {
    ruleId: -1,
    contextType: { kind: 'call_contract', contract: TOKEN },
    signers: [{ kind: 'delegated', address: AGENT }],
    predicate: TRANSFERS,
    ...(spendCap ? { spendCap } : {}),
  }
}

function neighbour(policyAddresses: string[], extra?: Partial<ObservedRule>): ObservedRule {
  return {
    id: 3,
    contextType: { kind: 'call_contract', contract: TOKEN },
    signers: [{ kind: 'delegated', address: AGENT }],
    policyAddresses,
    predicate: TRANSFERS,
    ...extra,
  }
}

describe('spend-cap aware cross-rule scan', () => {
  test('an uncapped neighbour voids the cap being installed', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [neighbour([INTERPRETER])],
      knownPolicies: KNOWN,
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.capBypass).toBe(true)
    expect(found[0]?.severity).toBe('bypass')
    expect(found[0]?.advice).toContain('will not bind')
  })

  test('a neighbour that also carries a cap is not a bypass', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [
        neighbour([INTERPRETER, SPENDING_LIMIT], {
          spendCap: { amount: '3000000', periodLedgers: 17280 },
        }),
      ],
      knownPolicies: KNOWN,
    })
    expect(found[0]?.capBypass).toBeUndefined()
    expect(found[0]?.severity).toBe('not-restricting')
    // The budgets are separate, so the operator needs the SUM, not a warning
    // that two caps exist.
    expect(found[0]?.advice).toContain('8000000')
    expect(found[0]?.spendCap).toEqual({ amount: '3000000', periodLedgers: 17280 })
  })

  test('caps over different periods are reported without being added up', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [
        neighbour([INTERPRETER, SPENDING_LIMIT], {
          spendCap: { amount: '3000000', periodLedgers: 120960 },
        }),
      ],
      knownPolicies: KNOWN,
    })
    expect(found[0]?.advice).toContain('periods differ')
    expect(found[0]?.advice).not.toContain('8000000')
  })

  test('an unrecognised policy on the neighbour stays advisory, never a refusal', () => {
    // It could BE a spend cap. Refusing over a contract we cannot read would be
    // a guess dressed up as a proof.
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [neighbour([INTERPRETER, OTHER_POLICY])],
      knownPolicies: KNOWN,
    })
    expect(found[0]?.capBypass).toBeUndefined()
    expect(found[0]?.severity).not.toBe('bypass')
  })

  test('no cap being installed means an uncapped neighbour is not a cap bypass', () => {
    const found = findAuthorityOverlaps({
      intended: intended(),
      existing: [neighbour([INTERPRETER])],
      knownPolicies: KNOWN,
    })
    expect(found[0]?.capBypass).toBeUndefined()
    expect(found[0]?.severity).toBe('not-restricting')
  })

  test('omitting knownPolicies reproduces the previous behaviour exactly', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [neighbour([INTERPRETER])],
    })
    expect(found[0]?.capBypass).toBeUndefined()
    expect(found[0]?.severity).toBe('not-restricting')
  })

  test('a neighbour sharing no signer is not a cap bypass', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [
        neighbour([INTERPRETER], {
          signers: [
            {
              kind: 'delegated',
              address: 'GC3EYJPADIX3OGTF6Z2MZ4ESRWTK4KHFP2XZUP442XVOMFA67RKN6UZA',
            },
          ],
        }),
      ],
      knownPolicies: KNOWN,
    })
    expect(found).toHaveLength(0)
  })

  test('a neighbour serving different calls is not a cap bypass', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [
        neighbour([INTERPRETER], {
          contextType: { kind: 'call_contract', contract: OTHER_POLICY },
          predicate: {
            op: 'eq',
            left: { kind: 'call_contract' },
            right: { kind: 'literal_address', value: OTHER_POLICY },
          },
        }),
      ],
      knownPolicies: KNOWN,
    })
    expect(found).toHaveLength(0)
  })

  test('an unpoliced neighbour still reports as the original bypass, not a cap one', () => {
    const found = findAuthorityOverlaps({
      intended: intended({ amount: '5000000', periodLedgers: 17280 }),
      existing: [neighbour([], { predicate: undefined })],
      knownPolicies: KNOWN,
    })
    expect(found[0]?.severity).toBe('bypass')
    expect(found[0]?.ruleClass).toBe('unpoliced')
    expect(found[0]?.advice).toContain('no policy attached')
  })
})
