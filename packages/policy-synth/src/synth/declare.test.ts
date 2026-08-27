// Tests for the declarative synthesis front-end.
//
// The declaration path has no transaction to check itself against, so the
// tests carry that weight: they pin the exact predicate shape, the guards
// against a bound that silently constrains nothing, and the warnings that
// name a defaulted argument index.

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import { evaluate } from '../simulate/evaluate.ts'
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

describe('declarePredicate - minOutputRatio (slippage floor)', () => {
  const base = { fn: 'swap_exact_tokens_for_tokens' }
  const ratio = (num: string, den: string, inputArgIndex = 0, outputArgIndex = 1) => ({
    ...base,
    minOutputRatio: { num, den, inputArgIndex, outputArgIndex },
  })

  it('lowers to gte(call_arg(out), call_arg_scaled(in, num, den))', () => {
    const { predicate } = declarePredicate(ratio('99', '100'))
    expect(predicate).toEqual({
      op: 'and',
      children: [
        { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: base.fn } },
        {
          op: 'gte',
          left: { kind: 'call_arg', index: 1 },
          right: { kind: 'call_arg_scaled', index: 0, num: '99', den: '100' },
        },
      ],
    })
  })

  it('refuses a zero denominator', () => {
    expect(() => declarePredicate(ratio('99', '0'))).toThrow()
  })

  it('refuses a zero numerator', () => {
    // A zero floor constrains nothing while looking like protection.
    expect(() => declarePredicate(ratio('0', '100'))).toThrow()
  })

  it('refuses a non-integer ratio', () => {
    expect(() => declarePredicate(ratio('0.99', '1'))).toThrow()
    expect(() => declarePredicate(ratio('-1', '100'))).toThrow()
  })

  it('refuses bounding an argument against itself', () => {
    // `arg[0] >= arg[0] * num/den` is true for every ratio at or below 1 and
    // false above it - never a slippage floor, always a mistake.
    expect(() => declarePredicate(ratio('99', '100', 0, 0))).toThrow()
  })

  it('warns when the ratio exceeds 1', () => {
    // Requires more out than went in: denies every honest trade. Loud beats a
    // policy that silently never permits.
    const { warnings } = declarePredicate(ratio('101', '100'))
    expect(warnings.some((w) => w.includes('above 1'))).toBe(true)
  })

  it('produces a predicate the encoder accepts', () => {
    // The install gate mirror lives in encode; a declared floor must clear it.
    const { predicate } = declarePredicate(ratio('99', '100'))
    expect(() => encodePredicate(predicate)).not.toThrow()
  })
})

// A NESTED AMOUNT is the case a positional bound cannot reach. Blend's
// `submit` carries no top-level amount: it is `requests[i].amount`, inside a
// vec of maps. These tests carry the whole guarantee, because the declaration
// path has no recording to check itself against - and the last three run the
// predicate through the reference evaluator, which is the only thing that
// shows the bound actually binds rather than merely being present.
describe('declarePredicate - a nested amount bound', () => {
  const POOL = Address.contract(Buffer.alloc(32, 0x0c)).toString()
  const PATH = { argIndex: 0, element: 0, field: 'amount' } as const

  /** A Blend-shaped `requests` argument: a vec of maps. */
  const requests = (...amounts: string[]) => ({
    type: 'vec' as const,
    value: amounts.map((value) => ({
      type: 'map' as const,
      value: [
        { key: 'request_type', val: { type: 'u32' as const, value: '2' } },
        { key: 'amount', val: { type: 'i128' as const, value } },
      ],
    })),
  })

  it('binds the field rather than a positional argument', () => {
    const { predicate } = declarePredicate({
      fn: 'submit',
      contract: POOL,
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    const children = predicate.op === 'and' ? predicate.children : []
    const bound = children.find((c) => c.op === 'lte')
    expect(bound).toBeDefined()
    expect((bound as { left: unknown }).left).toEqual({
      kind: 'call_arg_field',
      index: 0,
      element: 0,
      field: 'amount',
    })
  })

  it('pins the vec length alongside the bound', () => {
    // Without this the cap is decorative: element 0 stays under the ceiling
    // while an appended element 1 spends whatever it likes.
    const { predicate } = declarePredicate({
      fn: 'submit',
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    const children = predicate.op === 'and' ? predicate.children : []
    const len = children.find(
      (c) => c.op === 'eq' && (c as { left: { kind: string } }).left.kind === 'call_arg_len'
    )
    expect(len).toBeDefined()
    expect((len as { right: unknown }).right).toEqual({ kind: 'literal_u32', value: 1 })
  })

  it('refuses amountArgIndex and amountPath together', () => {
    expect(() =>
      declarePredicate({ fn: 'submit', maxAmount: '1', amountArgIndex: 2, amountPath: PATH })
    ).toThrow(/exactly one/)
  })

  it('refuses a path with nothing to bound', () => {
    expect(() => declarePredicate({ fn: 'submit', amountPath: PATH })).toThrow(/maxAmount/)
  })

  it('refuses a malformed coordinate rather than guessing', () => {
    expect(() =>
      declarePredicate({
        fn: 'submit',
        maxAmount: '1',
        amountPath: { argIndex: -1, element: 0, field: 'amount' },
      })
    ).toThrow(/argIndex/)
    expect(() =>
      declarePredicate({
        fn: 'submit',
        maxAmount: '1',
        amountPath: { argIndex: 0, element: 0, field: '  ' },
      })
    ).toThrow(/field/)
  })

  it('warns that the vec length is pinned, since that denies a shape the caller may expect to work', () => {
    const { warnings } = declarePredicate({
      fn: 'submit',
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    expect(warnings.some((w) => /pinned to exactly 1 element/.test(w))).toBe(true)
  })

  it('does not emit the SEP-41 positional warning when a path was given', () => {
    // Control: that warning names a DEFAULTED index. Nothing was defaulted
    // here, so repeating it would send the caller looking for a bug.
    const { warnings } = declarePredicate({
      fn: 'submit',
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    expect(warnings.some((w) => /SEP-41/.test(w))).toBe(false)
  })

  it('permits a call under the ceiling', () => {
    const { predicate } = declarePredicate({
      fn: 'submit',
      contract: POOL,
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    expect(
      evaluate(predicate, { contract: POOL, fn: 'submit', args: [requests('900000000')] })
    ).toEqual({ permit: true })
  })

  it('denies a call over the ceiling', () => {
    const { predicate } = declarePredicate({
      fn: 'submit',
      contract: POOL,
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    expect(
      evaluate(predicate, { contract: POOL, fn: 'submit', args: [requests('1000000001')] })
    ).toMatchObject({ permit: false })
  })

  it('denies an appended second request, which is how the cap would be sidestepped', () => {
    // THE ATTACK the length pin exists for: element 0 is under the ceiling and
    // satisfies the bound; element 1 carries the real spend. Without the pin
    // this call permits.
    const { predicate } = declarePredicate({
      fn: 'submit',
      contract: POOL,
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    expect(
      evaluate(predicate, {
        contract: POOL,
        fn: 'submit',
        args: [requests('1', '999999999999')],
      })
    ).toMatchObject({ permit: false })
  })

  it('still encodes', () => {
    const { predicate } = declarePredicate({
      fn: 'submit',
      contract: POOL,
      maxAmount: '1000000000',
      amountPath: PATH,
    })
    expect(() => encodePredicate(predicate)).not.toThrow()
  })
})
