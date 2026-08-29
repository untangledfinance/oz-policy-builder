// src/install/spending-limit-policy.test.ts - the builder attaches an
// OpenZeppelin `spending_limit` beside the interpreter predicate.
//
// A predicate cannot express a rolling total: the interpreter is handed one
// call and keeps no state, so a per-call cap of N authorises N again on the
// very next call. The total lives in an OZ built-in on the same rule, and
// policies on one rule compose as all-of.
//
// The wire shape is checked against the hand-built map in
// `scripts/oz-policy-composition.ts`, which is the encoding already proven to
// bind on testnet and mainnet (docs/audit/evidence/oz-spending-limit-binding.log).
// A second implementation that merely "looks right" is how a map the contract
// reads differently gets shipped.

import { describe, expect, it } from 'bun:test'
import { Address, xdr } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import type { ContextRuleDraft } from '../types.ts'
import { buildAddContextRuleArgs } from './build-add-context-rule.ts'

const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5'
const SPEND_CAP = 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP'
const SIGNER = 'GDI64EFSV4IVJ53EWNXAPTZG3XR6O5YM4AYR7DI67Z6DRFDU3DHR6TH2'

const pred = encodePredicate({
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'transfer' },
})

const draft: ContextRuleDraft = {
  contextRuleType: { kind: 'call_contract', contract: TOKEN },
  name: 'daily',
  validUntilLedger: null,
  signers: [{ kind: 'delegated', address: SIGNER }],
  policies: [],
}

function build(policies: Parameters<typeof buildAddContextRuleArgs>[1]['policies']) {
  return buildAddContextRuleArgs(draft, {
    signers: [{ kind: 'delegated', address: SIGNER }],
    policies,
    installNonce: 1,
    encodedPredicate: pred.encodedPredicate,
    predicateHash: pred.predicateHash,
  })
}

/** The policies argument is `Map<Address, Val>`; pull one entry's params out. */
function paramsFor(policies: xdr.ScVal, address: string): xdr.ScMapEntry[] {
  const key = Address.fromString(address).toScVal().toXDR('base64')
  const entry = (policies.map() ?? []).find((e) => e.key().toXDR('base64') === key)
  if (!entry) throw new Error(`no policy entry for ${address}`)
  return entry.val().map() ?? []
}

function fields(entries: xdr.ScMapEntry[]): Record<string, xdr.ScVal> {
  const out: Record<string, xdr.ScVal> = {}
  for (const e of entries) out[e.key().sym().toString()] = e.val()
  return out
}

describe('attaching an OpenZeppelin spending_limit', () => {
  const interpreterRef = {
    kind: 'interpreter' as const,
    interpreterAddress: INTERPRETER,
    predicateBlobBase64: pred.encodedPredicate,
  }
  const capRef = {
    kind: 'spending_limit' as const,
    policyAddress: SPEND_CAP,
    periodLedgers: 17280,
    spendingLimit: '153000000',
  }

  it('puts both policies on the rule, because they compose as all-of', () => {
    const [, , , , policies] = build([interpreterRef, capRef])
    expect((policies.map() ?? []).length).toBe(2)
  })

  it('emits period_ledgers as u32 and spending_limit as i128', () => {
    const [, , , , policies] = build([interpreterRef, capRef])
    const f = fields(paramsFor(policies, SPEND_CAP))
    expect(f.period_ledgers?.switch().name).toBe('scvU32')
    expect(f.period_ledgers?.u32()).toBe(17280)
    expect(f.spending_limit?.switch().name).toBe('scvI128')
    expect(f.spending_limit?.i128().lo().toString()).toBe('153000000')
  })

  it('gives each policy its OWN params, not one set copied across the map', () => {
    // The bug this guards: one shared params object meant a second policy
    // received the interpreter's predicate fields and nothing of its own.
    const [, , , , policies] = build([interpreterRef, capRef])
    const cap = fields(paramsFor(policies, SPEND_CAP))
    const interp = fields(paramsFor(policies, INTERPRETER))
    expect(Object.keys(cap).sort()).toEqual(['period_ledgers', 'spending_limit'])
    expect(Object.keys(interp).sort()).toEqual([
      'grammar_version',
      'install_nonce',
      'predicate',
      'predicate_hash',
    ])
  })

  it('matches the hand-built encoding that is proven to bind on chain', () => {
    // Byte-for-byte against scripts/oz-policy-composition.ts's shape.
    const expected = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('period_ledgers'),
        val: xdr.ScVal.scvU32(17280),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('spending_limit'),
        val: xdr.ScVal.scvI128(
          new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(153000000n) })
        ),
      }),
    ])
    const [, , , , policies] = build([capRef])
    const got = (policies.map() ?? [])[0]?.val()
    expect(got?.toXDR('base64')).toBe(expected.toXDR('base64'))
  })

  it('refuses a period in seconds mistaken for ledgers, rather than installing it', () => {
    expect(() => build([{ ...capRef, periodLedgers: 0 }])).toThrow(/periodLedgers/)
    expect(() => build([{ ...capRef, periodLedgers: -1 }])).toThrow(/periodLedgers/)
  })

  it('refuses a non-positive or malformed amount', () => {
    expect(() => build([{ ...capRef, spendingLimit: '0' }])).toThrow(/smallest unit/)
    expect(() => build([{ ...capRef, spendingLimit: '1.5' }])).toThrow(/smallest unit/)
  })

  it('carries an amount above 2^64 without losing the high word', () => {
    const big = (2n ** 70n).toString()
    const [, , , , policies] = build([{ ...capRef, spendingLimit: big }])
    const f = fields(paramsFor(policies, SPEND_CAP))
    const parts = f.spending_limit?.i128()
    const value =
      (BigInt(parts?.hi().toString() ?? '0') << 64n) + BigInt(parts?.lo().toString() ?? '0')
    expect(value.toString()).toBe(big)
  })
})
