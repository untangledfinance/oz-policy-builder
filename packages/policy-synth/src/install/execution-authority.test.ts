import { describe, expect, test } from 'bun:test'
import { Address, Keypair, xdr } from '@stellar/stellar-sdk'
import { encodeExecutionDocument, scopedBlendExecutionPlans } from './scoped-execution.ts'
import { decodeExecutionDocument } from './decode-execution-document.ts'
import { analyzeExecutionAuthority } from './execution-authority.ts'
import { findAuthorityOverlaps, type ObservedRule } from './authority-overlap.ts'
import { authorityBypassRefusal } from '../run/index.ts'

const c = (n: number) => Address.contract(Buffer.alloc(32, n)).toString()
const signer = { kind: 'delegated' as const, address: Keypair.random().publicKey() }
const params = {
  prime: c(1),
  executor: c(2),
  token: c(3),
  pool: c(4),
  custody: signer.address,
  maxAmountBaseUnits: '100',
}
const document = { executor: params.executor, plans: scopedBlendExecutionPlans(params) }
const encoded = encodeExecutionDocument(document).encodedPredicate
const predicate = document.plans[0]!.steps[0]!.predicate
const rule = (fields: Partial<ObservedRule> = {}): ObservedRule => ({
  id: 3,
  contextType: { kind: 'default' },
  signers: [signer],
  policyAddresses: [],
  ...fields,
})
const scan = (existing: ObservedRule[], incomplete = false) =>
  analyzeExecutionAuthority({ intended: { signers: [signer], document }, existing, incomplete })

describe('bounded execution decoding', () => {
  test('round trips ordered plans, auth and equality paths', () => {
    expect(encodeExecutionDocument(decodeExecutionDocument(encoded)).encodedPredicate).toBe(encoded)
  })
  test('rejects oversized, malformed, wrong envelope and unknown struct fields', () => {
    for (const input of [Buffer.alloc(32769), Buffer.from([1, 2]), '!', encoded + 'AA']) {
      expect(() => decodeExecutionDocument(input)).toThrow()
    }
    const wire = xdr.ScVal.fromXDR(encoded, 'base64')
    const fields = wire.vec()![1]!.map()!
    fields.push(
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('unknown'), val: xdr.ScVal.scvU32(1) })
    )
    expect(() => decodeExecutionDocument(wire.toXDR())).toThrow()
  })
  test('rejects duplicate fields and empty plan vectors', () => {
    const wire = xdr.ScVal.fromXDR(encoded, 'base64')
    const fields = wire.vec()![1]!.map()!
    fields.push(fields[0]!)
    expect(() => decodeExecutionDocument(wire.toXDR())).toThrow()
    const empty = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('execution_v1'),
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('executor'),
          val: new Address(c(2)).toScVal(),
        }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('plans'), val: xdr.ScVal.scvVec([]) }),
      ]),
    ])
    expect(() => decodeExecutionDocument(empty.toXDR())).toThrow()
  })
})

describe('execution authority gate', () => {
  test('empty complete account and another signer are safe', () => {
    expect(scan([]).safe).toBe(true)
    expect(
      scan([rule({ signers: [{ kind: 'delegated', address: Keypair.random().publicKey() }] })]).safe
    ).toBe(true)
  })
  test('direct and default authority block with IDs and reasons', () => {
    const result = scan([rule(), rule({ id: 4, predicate, policyAddresses: [c(8)] })])
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((c) => c.ruleId)).toEqual([3, 4])
    expect(result.conflicts[0]!.reason).toContain('direct')
  })
  test('unknown, unreadable and incomplete fail closed', () => {
    expect(scan([rule({ policyAddresses: [c(8)] })]).conflicts[0]!.kind).toBe('unknown-authority')
    expect(scan([rule({ unreadableAuthority: true, signers: [] })]).safe).toBe(false)
    expect(scan([], true).safe).toBe(false)
  })
  test('disjoint contract is safe; step and nested auth targets are governed', () => {
    expect(scan([rule({ contextType: { kind: 'call_contract', contract: c(9) } })]).safe).toBe(true)
    expect(scan([]).governedSelectors).toContainEqual({ contract: c(3), fn: 'transfer' })
    expect(scan([rule({ contextType: { kind: 'call_contract', contract: c(2) } })]).safe).toBe(
      false
    )
  })
  test('same executor documents stay conservatively blocking', () => {
    const result = scan([rule({ executionDocument: document, policyAddresses: [c(8)] })])
    expect(result.conflicts[0]!.kind).toBe('execution-overlap')
    expect(result.safe).toBe(false)
  })
  test('a new direct rule cannot bypass an existing scoped document, including opt-in', () => {
    const overlaps = findAuthorityOverlaps({
      intended: { ruleId: -1, contextType: { kind: 'default' }, signers: [signer], predicate },
      existing: [rule({ executionDocument: document, policyAddresses: [c(8)] })],
    })
    expect(overlaps[0]!.ruleClass).toBe('execution')
    expect(overlaps[0]!.mandatoryBlock).toBe(true)
    expect(authorityBypassRefusal(overlaps, true)).toContain('execution')
  })
})

describe('decoder structural limits and selector relationships', () => {
  const field = (value: xdr.ScVal, name: string) =>
    value.map()!.find((e) => e.key().sym().toString() === name)!
  function mutated(change: (config: xdr.ScVal) => void) {
    const wire = xdr.ScVal.fromXDR(encoded, 'base64')
    change(wire.vec()![1]!)
    return wire.toXDR()
  }
  test('bounds plan, step, equality and path counts on wire input', () => {
    for (const [name, count] of [
      ['plans', 9],
      ['steps', 9],
      ['equalities', 33],
    ] as const) {
      expect(() =>
        decodeExecutionDocument(
          mutated((config) => {
            const container = name === 'plans' ? config : field(config, 'plans').val().vec()![0]!
            const target = field(container, name)
            target.val(xdr.ScVal.scvVec(Array(count).fill(target.val().vec()![0]!)))
          })
        )
      ).toThrow()
    }
    expect(() =>
      decodeExecutionDocument(
        mutated((config) => {
          const eq = field(field(config, 'plans').val().vec()![0]!, 'equalities').val().vec()![0]!
          const left = field(eq, 'left')
          left.val(xdr.ScVal.scvVec(Array(17).fill(left.val().vec()![0]!)))
        })
      )
    ).toThrow()
  })
  test('validates nested predicate byte type, grammar and limits', () => {
    const changes = [xdr.ScVal.scvSymbol('not_bytes'), xdr.ScVal.scvBytes(Buffer.from([1, 2]))]
    let deep = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('eq'),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('call_fn')]),
      xdr.ScVal.scvSymbol('submit'),
    ])
    for (let i = 0; i < 6; i++)
      deep = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('and'), xdr.ScVal.scvVec([deep])])
    changes.push(xdr.ScVal.scvBytes(deep.toXDR()))
    for (const value of changes)
      expect(() =>
        decodeExecutionDocument(
          mutated((config) => {
            const step = field(field(config, 'plans').val().vec()![0]!, 'steps').val().vec()![0]!
            field(step, 'predicate').val(value)
          })
        )
      ).toThrow()
  })
  test('auth depth and aggregate count are enforced before traversing children', () => {
    for (const mode of ['count', 'depth'])
      expect(() =>
        decodeExecutionDocument(
          mutated((config) => {
            const step = field(field(config, 'plans').val().vec()![0]!, 'steps').val().vec()![1]!
            const auth = field(step, 'authorizations')
            const original = auth.val().vec()![0]!
            if (mode === 'count') auth.val(xdr.ScVal.scvVec(Array(33).fill(original)))
            else {
              let child = original
              for (let i = 0; i < 5; i++)
                child = xdr.ScVal.scvMap([
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol('children'),
                    val: xdr.ScVal.scvVec([child]),
                  }),
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol('predicate'),
                    val: field(original, 'predicate').val(),
                  }),
                ])
              auth.val(xdr.ScVal.scvVec([child]))
            }
          })
        )
      ).toThrow()
  })
  test('different executor and wider or-branch sibling cannot hide governed authority', () => {
    const other = { ...document, executor: c(9) }
    expect(scan([rule({ executionDocument: other, policyAddresses: [c(8)] })]).safe).toBe(false)
    const orPredicate = {
      op: 'or' as const,
      children: [
        predicate,
        {
          op: 'eq' as const,
          left: { kind: 'call_fn' as const },
          right: { kind: 'literal_symbol' as const, value: 'anything' },
        },
      ],
    }
    expect(scan([rule({ predicate: orPredicate, policyAddresses: [c(8)] })]).safe).toBe(false)
    expect(
      scan([
        rule({
          executionDocument: document,
          policyAddresses: [c(8)],
          signers: [{ kind: 'delegated', address: c(12) }],
        }),
      ]).safe
    ).toBe(true)
  })
})
