// Tests for cross-rule authority analysis.
//
// The headline case is not hypothetical: it is the mistake made in this
// project's own e2e harness on 2026-08-22, where the same key sat on a policed
// rule and on the unpoliced rule the account constructor creates. The forbidden
// call was denied naming the policed rule and PERMITTED naming the other.

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { PredicateNode, SignerDraft } from '../types.ts'
import {
  ANY,
  findAuthorityOverlaps,
  intersectSelectors,
  type ObservedRule,
  permittedSelectors,
  signerKey,
} from './authority-overlap.ts'

const TOKEN = Address.contract(Buffer.alloc(32, 0x0b)).toString()
const OTHER = Address.contract(Buffer.alloc(32, 0x0c)).toString()
const AGENT = Address.account(Buffer.alloc(32, 0xa1)).toString()
const ADMIN = Address.account(Buffer.alloc(32, 0xb2)).toString()

const agent: SignerDraft = { kind: 'delegated', address: AGENT }
const admin: SignerDraft = { kind: 'delegated', address: ADMIN }

const transferOnly: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'transfer' },
}

function intended(signers: SignerDraft[], predicate: PredicateNode = transferOnly) {
  return { ruleId: 1, contextType: { kind: 'default' } as const, signers, predicate }
}

describe('permittedSelectors over-approximates', () => {
  it('reads a pinned method', () => {
    expect(permittedSelectors(transferOnly)).toEqual([{ contract: ANY, fn: 'transfer' }])
  })

  it('intersects conjuncts', () => {
    const node: PredicateNode = {
      op: 'and',
      children: [
        transferOnly,
        {
          op: 'eq',
          left: { kind: 'call_contract' },
          right: { kind: 'literal_address', value: TOKEN },
        },
      ],
    }
    expect(permittedSelectors(node)).toEqual([{ contract: TOKEN, fn: 'transfer' }])
  })

  it('expands an `in` over methods', () => {
    const node: PredicateNode = {
      op: 'in',
      needle: { kind: 'call_fn' },
      haystack: [
        { kind: 'literal_symbol', value: 'transfer' },
        { kind: 'literal_symbol', value: 'burn' },
      ],
    }
    expect(permittedSelectors(node)).toEqual([
      { contract: ANY, fn: 'transfer' },
      { contract: ANY, fn: 'burn' },
    ])
  })

  it('widens to the wildcard for a bound that does not pin a selector', () => {
    // `lte` binds an amount. Reporting it as narrowing would be the fail-OPEN
    // direction: it would let two colliding rules look disjoint.
    const node: PredicateNode = {
      op: 'lte',
      left: { kind: 'call_arg', index: 2 },
      right: { kind: 'literal_i128', value: '5' },
    }
    expect(permittedSelectors(node)).toEqual([{ contract: ANY, fn: ANY }])
  })

  it('treats disjoint selectors as non-intersecting', () => {
    const a = permittedSelectors(transferOnly)
    const b = permittedSelectors({
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'approve' },
    })
    expect(intersectSelectors(a, b)).toEqual([])
  })
})

describe('findAuthorityOverlaps', () => {
  it('flags an unpoliced neighbour as a BYPASS', () => {
    // The 2026-08-22 incident, in one assertion. Rule 0 is what the OZ account
    // constructor creates: no policy, and the agent is on it.
    const rule0: ObservedRule = {
      id: 0,
      contextType: { kind: 'default' },
      signers: [agent, admin],
      policyAddresses: [],
    }
    const found = findAuthorityOverlaps({ intended: intended([agent]), existing: [rule0] })
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe('bypass')
    expect(found[0]?.ruleClass).toBe('unpoliced')
    expect(found[0]?.sharedSigners.map(signerKey)).toEqual([signerKey(agent)])
    expect(found[0]?.advice).toContain('no constraint at all')
  })

  it('says nothing when the constrained key is on the policed rule ALONE', () => {
    // The fix that made the e2e evidence mean what it claimed. The admin holds
    // rule 0, the agent does not, so the agent cannot reroute.
    const rule0: ObservedRule = {
      id: 0,
      contextType: { kind: 'default' },
      signers: [admin],
      policyAddresses: [],
    }
    expect(findAuthorityOverlaps({ intended: intended([agent]), existing: [rule0] })).toEqual([])
  })

  it('flags an unreadable foreign policy as UNKNOWN rather than safe', () => {
    const foreign: ObservedRule = {
      id: 2,
      contextType: { kind: 'default' },
      signers: [agent],
      policyAddresses: [OTHER],
    }
    const found = findAuthorityOverlaps({ intended: intended([agent]), existing: [foreign] })
    expect(found[0]?.severity).toBe('unknown')
    expect(found[0]?.ruleClass).toBe('foreign')
  })

  it('flags a wider sibling of ours as NOT-RESTRICTING', () => {
    const sibling: ObservedRule = {
      id: 3,
      contextType: { kind: 'default' },
      signers: [agent],
      policyAddresses: [TOKEN],
      predicate: {
        op: 'eq',
        left: { kind: 'call_fn' },
        right: { kind: 'literal_symbol', value: 'transfer' },
      },
    }
    const found = findAuthorityOverlaps({ intended: intended([agent]), existing: [sibling] })
    expect(found[0]?.severity).toBe('not-restricting')
    expect(found[0]?.advice).toContain('edit rule 3')
  })

  it('ignores a rule sharing no signer, however permissive', () => {
    const wideOpen: ObservedRule = {
      id: 4,
      contextType: { kind: 'default' },
      signers: [admin],
      policyAddresses: [],
    }
    expect(findAuthorityOverlaps({ intended: intended([agent]), existing: [wideOpen] })).toEqual([])
  })

  it('ignores a rule that shares a signer but no call', () => {
    // Same key, disjoint selectors: no single call can be routed to both, so
    // there is nothing to reroute.
    const disjoint: ObservedRule = {
      id: 5,
      contextType: { kind: 'call_contract', contract: OTHER },
      signers: [agent],
      policyAddresses: [],
    }
    const onToken = intended([agent], {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: TOKEN },
    })
    expect(findAuthorityOverlaps({ intended: onToken, existing: [disjoint] })).toEqual([])
  })

  it('skips the rule being installed onto, which is a replacement', () => {
    const self: ObservedRule = {
      id: 1,
      contextType: { kind: 'default' },
      signers: [agent],
      policyAddresses: [],
    }
    expect(findAuthorityOverlaps({ intended: intended([agent]), existing: [self] })).toEqual([])
  })

  it('reports every colliding rule, not just the first', () => {
    const rules: ObservedRule[] = [
      { id: 0, contextType: { kind: 'default' }, signers: [agent], policyAddresses: [] },
      { id: 2, contextType: { kind: 'default' }, signers: [agent], policyAddresses: [OTHER] },
    ]
    const found = findAuthorityOverlaps({ intended: intended([agent]), existing: rules })
    expect(found.map((f) => f.severity).sort()).toEqual(['bypass', 'unknown'])
  })
})
