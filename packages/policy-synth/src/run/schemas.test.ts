// The run-layer Zod schemas mirror the core ScVal type. That mirror is easy to
// let drift: the core gains a variant, the schema does not, and the synthesizer
// then rejects a recording its own recorder produced at full confidence. This
// suite pins the round-trip both ways.

import { describe, expect, it } from 'bun:test'
import type { PredicateLeaf, PredicateNode, ScVal } from '../types.ts'
import {
  PredicateLeafSchema,
  PredicateNodeSchema,
  ScValSchema,
  type SimulatePolicyInput,
  SimulatePolicyInputSchema,
  type VerifyPolicyInput,
  VerifyPolicyInputSchema,
} from './schemas.ts'

describe('ScValSchema mirrors the core ScVal', () => {
  // One value per variant of the core union. Adding a variant to types.ts
  // without adding it here should fail this test rather than surface later as
  // "Invalid input" on a real transaction.
  const oneOfEach: ScVal[] = [
    { type: 'address', value: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' },
    { type: 'i128', value: '4280000000' },
    { type: 'u64', value: '1784764891' },
    { type: 'u32', value: '1' },
    { type: 'symbol', value: 'transfer' },
    { type: 'bytes', value: 'deadbeef' },
    { type: 'vec', value: [{ type: 'u32', value: '1' }] },
    { type: 'map', value: [{ key: 'amount', val: { type: 'i128', value: '7' } }] },
  ]

  for (const value of oneOfEach) {
    it(`accepts a ${value.type}`, () => {
      expect(ScValSchema.safeParse(value).success).toBe(true)
    })
  }

  it('accepts a negative i128, which real fee-adjustment events carry', () => {
    expect(ScValSchema.safeParse({ type: 'i128', value: '-9791' }).success).toBe(true)
  })

  it('accepts the vec-of-map shape a Blend submit request argument uses', () => {
    // Shape taken from a real mainnet Blend `submit`: arg[3] is a vec whose
    // entries are maps. Omitting the map variant made synthesis reject the
    // recording outright.
    const blendRequest: ScVal = {
      type: 'vec',
      value: [
        {
          type: 'map',
          value: [
            {
              key: 'address',
              val: {
                type: 'address',
                value: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
              },
            },
            { key: 'amount', val: { type: 'i128', value: '4280000000' } },
            { key: 'request_type', val: { type: 'u32', value: '2' } },
          ],
        },
      ],
    }
    expect(ScValSchema.safeParse(blendRequest).success).toBe(true)
  })

  it('rejects an unknown variant rather than passing it through', () => {
    expect(ScValSchema.safeParse({ type: 'not_a_scval', value: 'x' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PredicateLeafSchema / PredicateNodeSchema - mirror the predicate grammar
// in types.ts:132-180. The same drift hazard applies: a new leaf kind or
// operator that lands in the core type without extending the schema would
// surface as a generic "Invalid input" only when a real wire call hit it,
// so we pin the mirror here.
// ---------------------------------------------------------------------------

describe('PredicateLeafSchema mirrors the core PredicateLeaf', () => {
  // One value per variant of the core union. Adding a variant to types.ts
  // without adding it here should fail this test rather than surface later.
  const oneOfEach: PredicateLeaf[] = [
    { kind: 'call_contract' },
    { kind: 'call_fn' },
    { kind: 'call_arg', index: 0 },
    { kind: 'call_arg_len', index: 0 },
    { kind: 'call_arg_field', index: 0, element: 0, field: 'amount' },
    { kind: 'literal_address', value: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' },
    { kind: 'literal_i128', value: '1000000000' },
    { kind: 'literal_symbol', value: 'transfer' },
    { kind: 'literal_u32', value: 1 },
    { kind: 'literal_vec', elements: [{ kind: 'literal_address', value: 'C-XLM' }] },
  ]

  for (const leaf of oneOfEach) {
    it(`accepts a ${leaf.kind} leaf`, () => {
      expect(PredicateLeafSchema.safeParse(leaf).success).toBe(true)
    })
  }

  it('accepts a negative i128 literal (signed on chain)', () => {
    expect(PredicateLeafSchema.safeParse({ kind: 'literal_i128', value: '-1' }).success).toBe(true)
  })

  it('rejects a non-integer u32 literal', () => {
    expect(PredicateLeafSchema.safeParse({ kind: 'literal_u32', value: 1.5 }).success).toBe(false)
  })

  it('rejects an unknown leaf kind', () => {
    expect(PredicateLeafSchema.safeParse({ kind: 'not_a_leaf' }).success).toBe(false)
  })
})

describe('PredicateNodeSchema mirrors the core PredicateNode', () => {
  // One value per operator. Mirrors the top-level union in types.ts:132-180.
  const oneOfEach: PredicateNode[] = [
    { op: 'and', children: [] },
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: {
        kind: 'literal_address',
        value: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      },
    },
    {
      op: 'lte',
      left: { kind: 'call_arg', index: 0 },
      right: { kind: 'literal_i128', value: '1000000000' },
    },
    {
      op: 'in',
      needle: { kind: 'call_arg', index: 1 },
      haystack: [
        {
          kind: 'literal_address',
          value: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        },
      ],
    },
  ]

  for (const node of oneOfEach) {
    it(`accepts a ${node.op} node`, () => {
      expect(PredicateNodeSchema.safeParse(node).success).toBe(true)
    })
  }

  it('rejects an unknown op', () => {
    expect(PredicateNodeSchema.safeParse({ op: 'xor', children: [] }).success).toBe(false)
  })

  it('rejects a leaf-shaped payload at the node boundary', () => {
    // The leaf and node schemas are distinct unions; the node schema must
    // refuse a leaf so the engine never sees a malformed tree.
    expect(PredicateNodeSchema.safeParse({ kind: 'call_contract' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SimulatePolicyInputSchema / VerifyPolicyInputSchema - the wire inputs the
// run-layer wrappers re-validate. Mirrors the RecordedTransaction fixture
// shape so the wrappers fail closed at the boundary.
// ---------------------------------------------------------------------------

// Minimal RecordedTransaction fixture. The schema accepts the same shape
// the recorder produces; the engine drives the actual verification.
function recordedTx() {
  return {
    network: 'mainnet' as const,
    signers: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVON'],
    invocations: [
      {
        contract: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        fn: 'transfer',
        args: [
          {
            type: 'address',
            value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVON',
          },
          {
            type: 'address',
            value: 'GBILLERBILLERBILLERBILLERBILLERBILLERBILLERBILLERBILLERBILLERB',
          },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      {
        token: 'CUSDC',
        from: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVON',
        to: 'GBILLERBILLERBILLERBILLERBILLERBILLERBILLERBILLERBILLERBILLERB',
        amount: '1000000000',
      },
    ],
    events: [],
    authEntries: [],
    ledgerSequence: 1_000_000,
    fetchedAt: 1_700_000_000,
    parseConfidence: {
      overall: 1,
      knownContracts: [],
      unknownContracts: [],
      opaqueScVals: [],
      thresholdUsed: 1,
    },
    sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVON',
  }
}

const SAMPLE_PREDICATE: PredicateNode = {
  op: 'and',
  children: [
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: {
        kind: 'literal_address',
        value: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      },
    },
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'transfer' },
    },
  ],
}

describe('SimulatePolicyInputSchema accepts a valid simulate payload', () => {
  it('round-trips a minimal payload (predicate + permitTx)', () => {
    const input: SimulatePolicyInput = {
      predicate: SAMPLE_PREDICATE,
      permitTx: recordedTx(),
    }
    const parsed = SimulatePolicyInputSchema.safeParse(input)
    expect(parsed.success).toBe(true)
  })

  it('accepts the optional validUntilLedger', () => {
    const parsed = SimulatePolicyInputSchema.safeParse({
      predicate: SAMPLE_PREDICATE,
      permitTx: recordedTx(),
      validUntilLedger: 1_200_000,
    })
    expect(parsed.success).toBe(true)
  })
})

describe('SimulatePolicyInputSchema fails closed on bad input', () => {
  it('rejects a malformed predicate (unknown op)', () => {
    const parsed = SimulatePolicyInputSchema.safeParse({
      predicate: { op: 'xor', children: [] },
      permitTx: recordedTx(),
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a missing permitTx', () => {
    const parsed = SimulatePolicyInputSchema.safeParse({ predicate: SAMPLE_PREDICATE })
    expect(parsed.success).toBe(false)
  })

  it('rejects a validUntilLedger above u32', () => {
    const parsed = SimulatePolicyInputSchema.safeParse({
      predicate: SAMPLE_PREDICATE,
      permitTx: recordedTx(),
      validUntilLedger: 4_294_967_296,
    })
    expect(parsed.success).toBe(false)
  })
})

describe('VerifyPolicyInputSchema accepts a valid verify payload', () => {
  it('round-trips a minimal payload (predicate + permitTx)', () => {
    const input: VerifyPolicyInput = { predicate: SAMPLE_PREDICATE, permitTx: recordedTx() }
    const parsed = VerifyPolicyInputSchema.safeParse(input)
    expect(parsed.success).toBe(true)
  })

  it('accepts the optional validUntilLedger', () => {
    const parsed = VerifyPolicyInputSchema.safeParse({
      predicate: SAMPLE_PREDICATE,
      permitTx: recordedTx(),
      validUntilLedger: 1_200_000,
    })
    expect(parsed.success).toBe(true)
  })
})

describe('VerifyPolicyInputSchema fails closed on bad input', () => {
  it('rejects a null predicate (verify_policy requires one)', () => {
    const parsed = VerifyPolicyInputSchema.safeParse({ predicate: null, permitTx: recordedTx() })
    expect(parsed.success).toBe(false)
  })

  it('rejects a missing predicate', () => {
    const parsed = VerifyPolicyInputSchema.safeParse({ permitTx: recordedTx() })
    expect(parsed.success).toBe(false)
  })

  it('rejects a malformed predicate (unknown leaf kind)', () => {
    const parsed = VerifyPolicyInputSchema.safeParse({
      predicate: {
        op: 'eq',
        left: { kind: 'not_a_leaf' },
        right: { kind: 'literal_u32', value: 1 },
      },
      permitTx: recordedTx(),
    })
    expect(parsed.success).toBe(false)
  })
})
