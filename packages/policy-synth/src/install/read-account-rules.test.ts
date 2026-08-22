// src/install/read-account-rules.test.ts
//
// The decoders are pure and the collector takes an injected reader, so the
// whole module is testable without a network. The cases that matter are the
// ones where being wrong reports a safety that does not exist: non-contiguous
// rule ids, and a predicate that cannot be read.

import { describe, expect, it } from 'bun:test'
import { Address, xdr } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import type { PredicateNode } from '../types.ts'
import {
  type AccountRuleReader,
  collectObservedRules,
  decodeContextRule,
  decodeContextType,
  decodeSigner,
  decodeStoredPredicateBytes,
} from './read-account-rules.ts'

const ACCOUNT = Address.contract(Buffer.alloc(32, 0xaa)).toString()
const INTERPRETER = Address.contract(Buffer.alloc(32, 0xbb)).toString()
const OTHER_POLICY = Address.contract(Buffer.alloc(32, 0xcc)).toString()
const TOKEN = Address.contract(Buffer.alloc(32, 0xdd)).toString()

function sym(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s)
}

function addr(a: string): xdr.ScVal {
  return new Address(a).toScVal()
}

/** An OZ `ContextRule` as the host encodes a `#[contracttype]` struct: a map
 *  keyed by field-name symbol. */
function contextRuleScVal(args: {
  id: number
  policies?: string[]
  signers?: string[]
  contextContract?: string
}): xdr.ScVal {
  const entries: Array<[string, xdr.ScVal]> = [
    ['id', xdr.ScVal.scvU32(args.id)],
    [
      'context_type',
      args.contextContract
        ? xdr.ScVal.scvVec([sym('CallContract'), addr(args.contextContract)])
        : xdr.ScVal.scvVec([sym('Default')]),
    ],
    ['policies', xdr.ScVal.scvVec((args.policies ?? []).map((p) => addr(p)))],
    [
      'signers',
      xdr.ScVal.scvVec(
        (args.signers ?? []).map((s) => xdr.ScVal.scvVec([sym('Delegated'), addr(s)]))
      ),
    ],
  ]
  return xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })))
}

function storedDocScVal(predicate: PredicateNode): xdr.ScVal {
  const { encodedPredicate } = encodePredicate(predicate)
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: sym('predicate_bytes'),
      val: xdr.ScVal.scvBytes(Buffer.from(encodedPredicate, 'base64')),
    }),
  ])
}

const samplePredicate: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_contract' },
  right: { kind: 'literal_address', value: TOKEN },
}

/** Reader over a fixed id -> rule map, so a test can create gaps. */
function readerOver(
  rulesById: Record<number, xdr.ScVal>,
  docsById: Record<number, xdr.ScVal> = {},
  countOverride?: number
): AccountRuleReader {
  return {
    async getContextRuleCount() {
      return countOverride ?? Object.keys(rulesById).length
    },
    async getContextRule(_account, id) {
      return rulesById[id]
    },
    async getStoredDoc(_interp, _account, id) {
      return docsById[id]
    },
  }
}

describe('decoders', () => {
  it('reads a context rule with policies and signers', () => {
    const rule = decodeContextRule(
      contextRuleScVal({ id: 7, policies: [INTERPRETER], signers: [ACCOUNT] })
    )
    expect(rule).toEqual({
      id: 7,
      contextType: { kind: 'default' },
      signers: [{ kind: 'delegated', address: ACCOUNT }],
      policyAddresses: [INTERPRETER],
    })
  })

  it('reads a call_contract context type', () => {
    const t = decodeContextType(xdr.ScVal.scvVec([sym('CallContract'), addr(TOKEN)]))
    expect(t).toEqual({ kind: 'call_contract', contract: TOKEN })
  })

  it('widens an unrecognised context type to default', () => {
    // The safe direction: `default` looks like it could serve any call, so
    // overlap is over-reported rather than missed.
    expect(decodeContextType(xdr.ScVal.scvVec([sym('SomethingNew')]))).toEqual({ kind: 'default' })
    expect(decodeContextType(undefined)).toEqual({ kind: 'default' })
  })

  it('reads both signer variants and rejects anything else', () => {
    expect(decodeSigner(xdr.ScVal.scvVec([sym('Delegated'), addr(ACCOUNT)]))).toEqual({
      kind: 'delegated',
      address: ACCOUNT,
    })
    expect(decodeSigner(xdr.ScVal.scvVec([sym('Nonsense')]))).toBeUndefined()
  })

  it('reads the stored predicate bytes', () => {
    const bytes = decodeStoredPredicateBytes(storedDocScVal(samplePredicate))
    expect(bytes).toBeInstanceOf(Buffer)
    expect((bytes as Buffer).length).toBeGreaterThan(0)
  })

  it('returns undefined for a doc without predicate_bytes', () => {
    expect(decodeStoredPredicateBytes(xdr.ScVal.scvMap([]))).toBeUndefined()
  })
})

describe('collectObservedRules', () => {
  it('decodes the predicate for rules our interpreter polices', async () => {
    const res = await collectObservedRules({
      reader: readerOver(
        { 0: contextRuleScVal({ id: 0, policies: [INTERPRETER] }) },
        { 0: storedDocScVal(samplePredicate) }
      ),
      smartAccount: ACCOUNT,
      interpreterAddress: INTERPRETER,
    })
    expect(res.incomplete).toBe(false)
    expect(res.unreadablePredicateRuleIds).toEqual([])
    expect(res.rules[0]?.predicate).toEqual(samplePredicate)
  })

  it('leaves a foreign-policed rule without a predicate', async () => {
    // No predicate means the overlap scan classifies it as opaque rather than
    // as safely narrow, which is the fail-safe reading.
    const res = await collectObservedRules({
      reader: readerOver({ 0: contextRuleScVal({ id: 0, policies: [OTHER_POLICY] }) }),
      smartAccount: ACCOUNT,
      interpreterAddress: INTERPRETER,
    })
    expect(res.rules[0]?.predicate).toBeUndefined()
    expect(res.unreadablePredicateRuleIds).toEqual([])
  })

  it('walks past id gaps instead of stopping at Count', async () => {
    // OZ never reuses an id, so after a removal the live ids have holes and
    // Count is lower than the highest id. Iterating 0..Count-1 would skip the
    // rule at id 5 - and a skipped rule is a missed overlap, the one error
    // that reports safety which does not exist.
    const res = await collectObservedRules({
      reader: readerOver({
        0: contextRuleScVal({ id: 0, policies: [] }),
        5: contextRuleScVal({ id: 5, policies: [OTHER_POLICY] }),
      }),
      smartAccount: ACCOUNT,
      interpreterAddress: INTERPRETER,
    })
    expect(res.incomplete).toBe(false)
    expect(res.rules.map((r) => r.id).sort()).toEqual([0, 5])
  })

  it('reports incomplete when the scan limit is hit before Count is met', async () => {
    // Count claims 2, but only one rule is reachable within the probe limit.
    // The caller must see `incomplete` so it does not read the short list as
    // a clean bill of health.
    const res = await collectObservedRules({
      reader: readerOver({ 0: contextRuleScVal({ id: 0, policies: [] }) }, {}, 2),
      smartAccount: ACCOUNT,
      interpreterAddress: INTERPRETER,
      maxRuleIdScan: 3,
    })
    expect(res.incomplete).toBe(true)
  })

  it('flags a policed rule whose stored document is missing', async () => {
    const res = await collectObservedRules({
      reader: readerOver({ 0: contextRuleScVal({ id: 0, policies: [INTERPRETER] }) }, {}),
      smartAccount: ACCOUNT,
      interpreterAddress: INTERPRETER,
    })
    expect(res.unreadablePredicateRuleIds).toEqual([0])
    expect(res.rules[0]?.predicate).toBeUndefined()
  })

  it('flags a policed rule whose stored document does not decode', async () => {
    const garbage = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: sym('predicate_bytes'),
        val: xdr.ScVal.scvBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
      }),
    ])
    const res = await collectObservedRules({
      reader: readerOver(
        { 0: contextRuleScVal({ id: 0, policies: [INTERPRETER] }) },
        { 0: garbage }
      ),
      smartAccount: ACCOUNT,
      interpreterAddress: INTERPRETER,
    })
    expect(res.unreadablePredicateRuleIds).toEqual([0])
    expect(res.rules[0]?.predicate).toBeUndefined()
  })
})
