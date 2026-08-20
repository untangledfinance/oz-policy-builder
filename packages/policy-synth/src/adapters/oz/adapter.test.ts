import { describe, expect, it } from 'bun:test'
import type { PolicyIR } from '../../ir/types.ts'
import { createOzAdapter, placeholderOzConfig } from './adapter.ts'

const adapter = createOzAdapter(placeholderOzConfig('testnet'))

function spendingLimitIr(): PolicyIR {
  return {
    chain: 'stellar',
    defaultBehavior: 'deny_all',
    rules: [
      {
        roles: [],
        scope: { contract: 'CTOKEN' },
        constraints: [
          {
            op: 'compare',
            compare: {
              selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 2592000 },
              operator: 'lte',
              value: '5000000',
            },
          },
        ],
        expiry: { validUntilLedger: 1000000 },
      },
    ],
  }
}

describe('OZ adapter identity + capabilities', () => {
  it('exposes name / mode / documented capability flags', () => {
    expect(adapter.name).toBe('oz-accounts')
    expect(adapter.mode).toBe('enforce')
    expect(adapter.capabilities()).toEqual({
      supportsSpendWindow: true,
      supportsThreshold: true,
      supportsTimeExpiry: true,
      supportsGeneralPredicate: false,
    })
  })
})

describe('OZ adapter compile - spending limit (Path A)', () => {
  it('lowers window_spent <= L to a spending_limit primitive with CallContract scope + validUntil', () => {
    const res = adapter.compile(spendingLimitIr())
    expect(res.covered).toBe(true)
    expect(res.uncovered).toEqual([])
    const proposed = res.proposed
    expect(proposed).toBeDefined()
    if (!proposed) return
    expect(proposed.contextRule.contextRuleType).toEqual({
      kind: 'call_contract',
      contract: 'CTOKEN',
    })
    expect(proposed.contextRule.validUntilLedger).toBe(1000000)
    expect(proposed.policyDocuments).toEqual([])
    expect(proposed.policyRefs.length).toBe(1)
    const ref = proposed.policyRefs[0]
    expect(ref).toEqual({
      kind: 'oz_builtin',
      primitive: {
        primitive: 'spending_limit',
        // OZ SpendingLimitAccountParams: no token (the token IS the CallContract
        // target), window in ledgers (2592000s / 5s-per-ledger = 518400).
        params: { spending_limit: '5000000', period_ledgers: 518400 },
      },
      instanceAddress: 'VERIFY-oz-spending-limit-instance-address',
    })
  })

  it('refuses a spending_limit whose token is not the CallContract scope (OZ pins to the context)', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CROUTER' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 2592000 },
                operator: 'lte',
                value: '5000000',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.proposed?.policyRefs.length ?? 0).toBe(0)
    expect(res.uncovered.some((u) => u.includes('CallContract context scoped to that token'))).toBe(
      true
    )
  })
})

describe('OZ adapter compile - threshold (Path A)', () => {
  it('lowers approval.threshold (no weights) to simple_threshold', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [],
          approval: { kind: 'threshold', threshold: 2 },
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(true)
    expect(res.proposed?.policyRefs[0]).toEqual({
      kind: 'oz_builtin',
      primitive: { primitive: 'simple_threshold', params: { threshold: 2 } },
      instanceAddress: 'VERIFY-oz-simple-threshold-instance-address',
    })
  })

  it('refuses a threshold < 1 (0 approvals is not an M-of-N gate) and flags it Path-B', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [],
          approval: { kind: 'threshold', threshold: 0 },
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.proposed?.policyRefs.length ?? 0).toBe(0)
    expect(res.uncovered.some((u) => u.includes('approval threshold 0'))).toBe(true)
  })

  it('refuses a negative or non-integer approval threshold', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const ir: PolicyIR = {
        chain: 'stellar',
        defaultBehavior: 'deny_all',
        rules: [
          {
            roles: [],
            scope: { contract: 'CX' },
            constraints: [],
            approval: { kind: 'threshold', threshold: bad },
          },
        ],
      }
      const res = adapter.compile(ir)
      expect(res.proposed?.policyRefs.length ?? 0).toBe(0)
      expect(res.uncovered.some((u) => u.includes('approval threshold'))).toBe(true)
    }
  })

  it('lowers approval.threshold with weights to weighted_threshold', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [],
          approval: { kind: 'threshold', threshold: 2, weights: { GA: 1, GB: 2 } },
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.proposed?.policyRefs[0]).toEqual({
      kind: 'oz_builtin',
      primitive: {
        primitive: 'weighted_threshold',
        params: { threshold: 2, weights: { GA: 1, GB: 2 } },
      },
      instanceAddress: 'VERIFY-oz-weighted-threshold-instance-address',
    })
  })
})

describe('OZ adapter compile - absent scope -> default context rule', () => {
  it('uses ContextRuleType.default when no contract is scoped', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: {},
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '1',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.proposed?.contextRule.contextRuleType).toEqual({ kind: 'default' })
    expect(res.proposed?.contextRule.validUntilLedger).toBeNull()
  })
})

describe('OZ adapter compile - unsupported constructs flagged Path B', () => {
  it('flags an `in` arg allowlist as uncovered', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CTOKEN' },
          constraints: [
            {
              op: 'in',
              selector: { kind: 'arg', argIndex: 1, scalarType: 'address' },
              values: ['GA'],
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('allowlist'))).toBe(true)
  })

  it('keeps the covered spending_limit while flagging a co-located recipient allowlist and per-method scoping', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '10',
              },
            },
            {
              op: 'in',
              selector: { kind: 'arg', argIndex: 1, scalarType: 'address' },
              values: ['GA'],
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.proposed?.policyRefs.length).toBe(1)
    expect(res.proposed?.policyRefs[0]?.kind).toBe('oz_builtin')
    expect(res.uncovered.some((u) => u.includes('allowlist'))).toBe(true)
    expect(res.uncovered.some((u) => u.includes('per-method scoping'))).toBe(true)
  })

  it('flags a guard as Path-B (applicability predicate)', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CX', windowSeconds: 86400 },
                operator: 'lte',
                value: '1',
              },
            },
          ],
          guard: {
            op: 'compare',
            compare: {
              selector: { kind: 'arg', argIndex: 0, scalarType: 'i128' },
              operator: 'gte',
              value: '100',
            },
          },
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.startsWith('guard:'))).toBe(true)
    expect(res.proposed?.policyRefs.length).toBe(1)
  })

  it('flags a window_spent compare with a non-lte operator as Path-B', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CX', windowSeconds: 86400 },
                operator: 'gte',
                value: '1',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(
      res.uncovered.some((u) => u.includes('spend-window comparison') && u.includes("'gte'"))
    ).toBe(true)
  })

  it('flags a per-call amount compare as Path-B', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'amount', token: 'CX' },
                operator: 'lte',
                value: '100',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('per-call amount comparison'))).toBe(true)
  })

  it('flags EVM calldata and value compares as Path-B', () => {
    const irCalldata: PolicyIR = {
      chain: 'evm',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: '0xCX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'calldata', offset: 0, length: 4 },
                operator: 'eq',
                value: 'a9059cbb',
              },
            },
          ],
        },
      ],
    }
    const resCalldata = adapter.compile(irCalldata)
    expect(resCalldata.covered).toBe(false)
    expect(resCalldata.uncovered.some((u) => u.includes('EVM calldata'))).toBe(true)

    const irValue: PolicyIR = {
      chain: 'evm',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: '0xCX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'value' },
                operator: 'lte',
                value: '1000',
              },
            },
          ],
        },
      ],
    }
    const resValue = adapter.compile(irValue)
    expect(resValue.covered).toBe(false)
    expect(resValue.uncovered.some((u) => u.includes('tx.value'))).toBe(true)
  })

  it('flags a now / valid_until time compare as Path-B', () => {
    const irNow: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'now' },
                operator: 'gte',
                value: '1700000000',
              },
            },
          ],
        },
      ],
    }
    const resNow = adapter.compile(irNow)
    expect(resNow.covered).toBe(false)
    expect(resNow.uncovered.some((u) => u.includes('time comparison'))).toBe(true)

    const irUntil: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'valid_until' },
                operator: 'lte',
                value: '1700000000',
              },
            },
          ],
        },
      ],
    }
    const resUntil = adapter.compile(irUntil)
    expect(resUntil.covered).toBe(false)
    expect(resUntil.uncovered.some((u) => u.includes('time comparison'))).toBe(true)
  })

  it('flags a `not` condition as Path-B', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'not',
              child: {
                op: 'in',
                selector: { kind: 'arg', argIndex: 1, scalarType: 'address' },
                values: ['GBAD'],
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('negated condition'))).toBe(true)
  })

  it('flags a nested and/or condition as Path-B', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints: [
            {
              op: 'or',
              children: [
                {
                  op: 'in',
                  selector: { kind: 'arg', argIndex: 1, scalarType: 'address' },
                  values: ['GA'],
                },
                {
                  op: 'compare',
                  compare: {
                    selector: { kind: 'amount', token: 'CX' },
                    operator: 'lte',
                    value: '10',
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('nested or condition'))).toBe(true)
  })

  it('flags unix-timestamp expiry as Path-B (OZ context rules expire by ledger sequence)', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '10',
              },
            },
          ],
          expiry: { validUntilUnixSeconds: 1700000000 },
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('unix timestamp'))).toBe(true)
    expect(res.proposed?.contextRule.validUntilLedger).toBeNull()
  })

  it('flags policy-count exceeding maxPoliciesPerRule as Path-B', () => {
    // Each spending_limit must be scoped to the CallContract target, so use the
    // scope contract as the token to produce > 5 emittable policyRefs.
    const constraints = Array.from({ length: 6 }, (_, i) => ({
      op: 'compare',
      compare: {
        selector: { kind: 'window_spent', token: 'CX', windowSeconds: 60 + i },
        operator: 'lte' as const,
        value: '1',
      },
    }))
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CX' },
          constraints,
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('exceeds OZ maxPoliciesPerRule'))).toBe(true)
    expect(res.proposed).toBeUndefined()
  })

  it('flags a multi-rule IR (only the first rule is compiled)', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '10',
              },
            },
          ],
        },
        {
          roles: [],
          scope: { contract: 'COTHER' },
          constraints: [],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('multi-rule PolicyIR'))).toBe(true)
    expect(res.uncovered.some((u) => u.includes('per-method scoping'))).toBe(true)
  })

  it('flags per-method scoping when scope has both contract and method', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '10',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('per-method scoping to `transfer`'))).toBe(true)
    expect(res.proposed?.policyRefs.length).toBe(1)
    expect(res.proposed?.policyRefs[0]?.kind).toBe('oz_builtin')
  })

  it('flags dropped roles as Path-B (role-to-signer mapping deferred)', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: ['treasury'],
          scope: { contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '10',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('roles [treasury] dropped'))).toBe(true)
    expect(res.proposed?.contextRule.signers).toEqual([])
  })

  it('flags scope.chainId on a Stellar IR as Path-B', () => {
    const ir: PolicyIR = {
      chain: 'stellar',
      defaultBehavior: 'deny_all',
      rules: [
        {
          roles: [],
          scope: { chainId: 1, contract: 'CTOKEN', method: 'transfer' },
          constraints: [
            {
              op: 'compare',
              compare: {
                selector: { kind: 'window_spent', token: 'CTOKEN', windowSeconds: 86400 },
                operator: 'lte',
                value: '10',
              },
            },
          ],
        },
      ],
    }
    const res = adapter.compile(ir)
    expect(res.covered).toBe(false)
    expect(res.uncovered.some((u) => u.includes('chainId `1` not bindable'))).toBe(true)
  })
})

describe('OZ adapter export + simulate', () => {
  it('export is canonical (stable key order, deterministic)', () => {
    const ir = spendingLimitIr()
    const a = adapter.export(ir)
    const b = adapter.export(ir)
    expect(a).toBe(b)
    expect(a).toContain('"chain":"stellar"')
    // sorted keys: `chain` precedes `defaultBehavior` precedes `rules`.
    expect(a.indexOf('"chain"')).toBeLessThan(a.indexOf('"defaultBehavior"'))
    expect(a.indexOf('"defaultBehavior"')).toBeLessThan(a.indexOf('"rules"'))
  })

  it('simulate returns a clearly-marked ts-model stub', () => {
    const res = adapter.simulate(spendingLimitIr(), {
      network: 'testnet',
      signers: [],
      invocations: [],
      tokenMovements: [],
      events: [],
      authEntries: [],
      ledgerSequence: 0,
      fetchedAt: 0,
      parseConfidence: {
        overall: 1,
        knownContracts: [],
        unknownContracts: [],
        opaqueScVals: [],
        thresholdUsed: 1,
      },
      sourceAccount: 'GABC',
    })
    expect(res.backend).toBe('ts-model')
    expect(res.permitted).toBeNull()
    expect(res.evaluations).toEqual([])
    expect(res.notes.length).toBeGreaterThan(0)
  })
})
