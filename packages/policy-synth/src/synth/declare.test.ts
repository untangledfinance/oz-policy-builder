// Tests for the declarative synthesis front-end.
//
// The declaration path has no transaction to check itself against, so the
// tests carry that weight: they pin the exact predicate shape, the guards
// against a bound that silently constrains nothing, and the warnings that
// name a defaulted argument index.

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import { declarePredicate } from './declare.ts'

const TOKEN = Address.contract(Buffer.alloc(32, 0x0b)).toString()
const ALICE = Address.account(Buffer.alloc(32, 0xa1)).toString()
const BOB = Address.account(Buffer.alloc(32, 0xb2)).toString()

describe('declarePredicate', () => {
  it('pins the method alone when nothing else is declared', () => {
    const { predicate, warnings } = declarePredicate({ fn: 'transfer' })
    // One conjunct is emitted BARE. `and` with a single child encodes to
    // different bytes for the same meaning.
    expect(predicate).toEqual({
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'transfer' },
    })
    expect(warnings).toEqual([])
  })

  it('builds contract, recipients and cap as one conjunction', () => {
    const { predicate } = declarePredicate({
      fn: 'transfer',
      contract: TOKEN,
      recipients: [ALICE, BOB],
      maxAmount: '250000000',
    })
    expect(predicate.op).toBe('and')
    const kinds = (predicate as { children: Array<{ op: string }> }).children.map((c) => c.op)
    expect(kinds).toEqual(['eq', 'eq', 'in', 'lte'])
  })

  it('is pure: the same declaration encodes to the same bytes', () => {
    const d = { fn: 'transfer', contract: TOKEN, maxAmount: '5' } as const
    const a = encodePredicate(declarePredicate(d).predicate)
    const b = encodePredicate(declarePredicate(d).predicate)
    expect(a.predicateHash).toBe(b.predicateHash)
    expect(a.encodedPredicate).toBe(b.encodedPredicate)
  })

  it('produces a predicate the encoder accepts', () => {
    const { predicate } = declarePredicate({
      fn: 'transfer',
      contract: TOKEN,
      recipients: [ALICE],
      maxAmount: '1',
    })
    const encoded = encodePredicate(predicate)
    expect(encoded.predicateHash).toMatch(/^[0-9a-f]{64}$/)
  })

  describe('warns when it has to guess an argument position', () => {
    // A cap on the wrong argument constrains something the user did not mean
    // and never announces itself, so a defaulted index has to be visible.
    it('warns for a defaulted amount index and names it', () => {
      const { warnings } = declarePredicate({ fn: 'swap', maxAmount: '5' })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('call_arg(2)')
      expect(warnings[0]).toContain('swap')
    })

    it('warns for a defaulted recipient index and names it', () => {
      const { warnings } = declarePredicate({ fn: 'swap', recipients: [ALICE] })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('call_arg(1)')
    })

    it('stays silent when the caller supplied both indices', () => {
      const { warnings } = declarePredicate({
        fn: 'swap',
        maxAmount: '5',
        amountArgIndex: 4,
        recipients: [ALICE],
        recipientArgIndex: 3,
      })
      expect(warnings).toEqual([])
    })

    it('binds the supplied index rather than the default', () => {
      const { predicate } = declarePredicate({ fn: 'swap', maxAmount: '5', amountArgIndex: 7 })
      expect(predicate).toEqual({
        op: 'and',
        children: [
          { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'swap' } },
          {
            op: 'lte',
            left: { kind: 'call_arg', index: 7 },
            right: { kind: 'literal_i128', value: '5' },
          },
        ],
      })
    })
  })

  describe('refuses declarations that would constrain nothing', () => {
    it('refuses a missing fn', () => {
      expect(() => declarePredicate({ fn: '' })).toThrow(/needs `fn`/)
    })

    it('refuses an empty recipient allowlist rather than emitting an empty haystack', () => {
      expect(() => declarePredicate({ fn: 'transfer', recipients: [] })).toThrow(/empty/)
    })

    it('refuses a non-integer amount', () => {
      expect(() => declarePredicate({ fn: 'transfer', maxAmount: '1.5' })).toThrow(/smallest unit/)
    })

    it('refuses a zero cap unless it is asked for', () => {
      // "0" is a deny-everything rule: no amount is <= 0 for a positive
      // transfer. Plausible to want, implausible to want by accident.
      expect(() => declarePredicate({ fn: 'transfer', maxAmount: '0' })).toThrow(
        /denies every call/
      )
      const ok = declarePredicate({ fn: 'transfer', maxAmount: '0', allowZeroCap: true })
      expect(ok.predicate.op).toBe('and')
    })

    it('refuses a contract that is not a C-address', () => {
      expect(() => declarePredicate({ fn: 'transfer', contract: ALICE })).toThrow(/C\.\.\./)
    })

    it('refuses a recipient that is not a Stellar address', () => {
      expect(() => declarePredicate({ fn: 'transfer', recipients: ['GBILLER'] })).toThrow(
        /not a Stellar address/
      )
    })
  })

  describe('does not resurrect the removed mandate fields', () => {
    // `spendingLimit` lowered to a `window_spent` compare the interpreter
    // cannot evaluate, and `approvalThreshold` needed OZ primitives that were
    // never deployed. Neither is expressible, and the per-call cap must not
    // quietly stand in for a rolling one.
    it('emits a per-call arg bound, never a window_spent leaf', () => {
      const { predicate } = declarePredicate({ fn: 'transfer', maxAmount: '250000000' })
      const json = JSON.stringify(predicate)
      expect(json).toContain('call_arg')
      expect(json).not.toContain('window_spent')
      expect(json).not.toContain('amount')
    })
  })
})
