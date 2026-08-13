// The slippage floor, IR -> predicate -> wire.
//
// The grammar gained `call_arg_scaled` before anything emitted it, so a swap's
// output stayed unbounded even though the contract could enforce a floor.
// These pin the lowering, and that the floor bounds the OUTPUT against the
// INPUT of the same call rather than against a constant - a constant would tie
// the policy to one trade size.

import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { PolicyIR } from '../../ir/types.ts'
import { decodePredicate } from '../../predicate/decode.ts'
import { createOzAdapter } from '../oz/adapter.ts'
import { createInterpreterAdapter } from './adapter.ts'

const POOL = Address.contract(Buffer.alloc(32, 0x11)).toString()
const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0xee)).toString()

function irWithFloor(): PolicyIR {
  return {
    chain: 'stellar',
    defaultBehavior: 'deny_all',
    rules: [
      {
        roles: [],
        scope: { contract: POOL, method: 'swap_exact_tokens_for_tokens' },
        constraints: [
          { op: 'slippage_floor', outArgIndex: 1, inArgIndex: 0, num: '95', den: '100' },
        ],
      },
    ],
  }
}

describe('slippage floor - interpreter lowering', () => {
  it('lowers to gte(call_arg[out], call_arg_scaled(in, num, den))', () => {
    const adapter = createInterpreterAdapter({
      network: 'testnet',
      installNonce: 1,
      smartAccountAddress: SMART_ACCOUNT,
    })
    const res = adapter.compile(irWithFloor())
    expect(res.covered).toBe(true)
    const doc = res.proposed?.policyDocuments[0]
    expect(doc).toBeDefined()
    if (!doc) return

    // Decode the emitted bytes rather than trusting the tree: this asserts what
    // actually reaches the contract.
    const node = decodePredicate(doc.encodedPredicate)
    const found = JSON.stringify(node)
    expect(found).toContain('call_arg_scaled')
    expect(found).toContain('"num":"95"')
    expect(found).toContain('"den":"100"')
  })

  it('is reported as covered, not as an uncovered warning', () => {
    const adapter = createInterpreterAdapter({
      network: 'testnet',
      installNonce: 1,
      smartAccountAddress: SMART_ACCOUNT,
    })
    expect(adapter.compile(irWithFloor()).uncovered).toEqual([])
  })
})

describe('slippage floor - OZ backend cannot express it', () => {
  it('flags it uncovered rather than dropping it', () => {
    // Silently dropping would leave the output unbounded while the review card
    // implied a floor was in force.
    const oz = createOzAdapter({ network: 'testnet', smartAccountAddress: SMART_ACCOUNT })
    const res = oz.compile(irWithFloor())
    expect(res.covered).toBe(false)
    expect(res.uncovered.join(' ')).toMatch(/slippage floor/i)
  })
})
