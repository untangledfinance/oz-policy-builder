import { describe, expect, it } from 'bun:test'
import { createOzAdapter, placeholderOzConfig } from '../adapters/oz/adapter.ts'
import { recordTransaction } from '../record/index.ts'
import type { CustodyAdapter, PolicySource } from './types.ts'

describe('custody seams', () => {
  it('the OZ adapter satisfies the CustodyAdapter contract', () => {
    const adapter: CustodyAdapter = createOzAdapter(placeholderOzConfig('testnet'))
    expect(adapter.name).toBe('oz-accounts')
    expect(typeof adapter.compile).toBe('function')
    expect(typeof adapter.capabilities).toBe('function')
    expect(typeof adapter.export).toBe('function')
    expect(typeof adapter.simulate).toBe('function')
  })

  it('recordTransaction can be wrapped as a PolicySource', () => {
    const source: PolicySource = {
      name: 'soroban-recorder',
      capture: (input) => recordTransaction(input),
    }
    expect(source.name).toBe('soroban-recorder')
    expect(typeof source.capture).toBe('function')
  })
})
