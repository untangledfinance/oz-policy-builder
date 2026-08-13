import { describe, expect, it } from 'bun:test'
import { getAbi, PROTOCOL_ABIS } from './protocols.ts'

describe('protocol ABI registry', () => {
  it('exposes sep41 ABI with transfer / mint / burn / approve', () => {
    const abi = PROTOCOL_ABIS.sep41
    expect(Object.keys(abi).sort()).toEqual(['approve', 'burn', 'mint', 'transfer'])
  })

  it('pins sep41.transfer args to (from: address, to: address, amount: i128)', () => {
    const transfer = PROTOCOL_ABIS.sep41.transfer
    expect(transfer.args.map((a) => a.name)).toEqual(['from', 'to', 'amount'])
    expect(transfer.args[0]?.type).toBe('address')
    expect(transfer.args[1]?.type).toBe('address')
    expect(transfer.args[2]?.type).toBe('i128')
  })

  it('exposes blend ABI with submit + claim function names', () => {
    const abi = PROTOCOL_ABIS.blend
    expect(abi.submit).toBeDefined()
    expect(abi.claim).toBeDefined()
  })

  it('exposes soroswap ABI with the standard swap variants', () => {
    const abi = PROTOCOL_ABIS.soroswap
    expect(abi.swap_exact_tokens_for_tokens).toBeDefined()
    expect(abi.swap_tokens_for_exact_tokens).toBeDefined()
    expect(abi.swap_exact_in_for_tokens).toBeDefined()
  })

  it('getAbi returns the matching protocol ABI', () => {
    expect(getAbi('sep41')).toBe(PROTOCOL_ABIS.sep41)
    expect(getAbi('blend')).toBe(PROTOCOL_ABIS.blend)
    expect(getAbi('soroswap')).toBe(PROTOCOL_ABIS.soroswap)
  })
})
