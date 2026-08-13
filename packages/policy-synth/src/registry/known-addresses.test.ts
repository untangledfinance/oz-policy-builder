import { describe, expect, it } from 'bun:test'
import { addressToProtocol, KNOWN_ADDRESSES } from './known-addresses.ts'

describe('known-addresses registry', () => {
  it('pins at least one Blend mainnet address (pool factory)', () => {
    const blendMainnet = KNOWN_ADDRESSES.mainnet.blend
    expect(blendMainnet.length).toBeGreaterThan(0)
    expect(blendMainnet).toContain('CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU')
  })

  it('pins at least one SoroSwap mainnet address (router + factory)', () => {
    const soroswapMainnet = KNOWN_ADDRESSES.mainnet.soroswap
    expect(soroswapMainnet).toContain('CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH')
    expect(soroswapMainnet).toContain('CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2')
  })

  it('addressToProtocol maps a pinned mainnet address to its protocol', () => {
    expect(
      addressToProtocol('CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU', 'mainnet')
    ).toBe('blend')
    expect(
      addressToProtocol('CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH', 'mainnet')
    ).toBe('soroswap')
  })

  it('addressToProtocol returns null for an unpinned address', () => {
    expect(addressToProtocol('CRANDOMUNCONFIRMED', 'mainnet')).toBeNull()
    expect(addressToProtocol('CRANDOMUNCONFIRMED', 'testnet')).toBeNull()
  })
})
