import { describe, test, expect } from 'bun:test'
import { Keypair, StrKey, xdr, scValToNative } from '@stellar/stellar-sdk'
import { buildScopedBlendExecutionPolicy, encodeExecutionDocument } from './scoped-execution'
const c = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n))
const p = {
  prime: c(1),
  executor: c(2),
  token: c(3),
  pool: c(4),
  custody: Keypair.random().publicKey(),
  maxAmountBaseUnits: '20000000',
}
describe('scoped execution documents', () => {
  test('supply requires two ordered steps, one exact auth node, and equal amounts', () => {
    const d = buildScopedBlendExecutionPolicy(p)
    expect(d.grammarVersion).toBe(6)
    const wire = scValToNative(xdr.ScVal.fromXDR(d.encodedPredicate, 'base64')) as any
    expect(wire[0]).toBe('execution_v1')
    expect(wire[1].plans[0].steps.length).toBe(2)
    expect(wire[1].plans[0].steps[0].authorizations.length).toBe(0)
    expect(wire[1].plans[0].steps[1].authorizations.length).toBe(1)
    expect(wire[1].plans[0].equalities.length).toBe(2)
    expect(wire[1].plans[1].steps.length).toBe(1)
    expect(wire[1].plans[1].steps[0].authorizations.length).toBe(0)
    expect(d.predicateHash).toHaveLength(64)
  })
  test('malformed or unbounded configuration is rejected', () => {
    expect(() => encodeExecutionDocument({ executor: p.executor, plans: [] })).toThrow()
    expect(() => buildScopedBlendExecutionPolicy({ ...p, maxAmountBaseUnits: '0' })).toThrow()
    expect(() => buildScopedBlendExecutionPolicy({ ...p, executor: p.custody })).toThrow()
  })
})
