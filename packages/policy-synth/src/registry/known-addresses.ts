// src/registry/known-addresses.ts - pinned real protocol contract addresses.
//
// Addresses here are fetched from authoritative public sources:
//   - Blend mainnet: docs.blend.capital/mainnet-deployments
//     https://docs.blend.capital/mainnet-deployments
//   - SoroSwap mainnet: github.com/soroswap (organisation README)
//     https://github.com/soroswap
//
// Testnet addresses are intentionally NOT pinned: the public docs do not
// publish them, and per the task brief, unconfirmed addresses are marked
// [VERIFY] and excluded from the active set rather than invented.
//
// SEP-41 is recognised by interface (any token), so no address list is needed
// for it - see identify.ts.

import type { ProtocolId } from './protocols.ts'

/** Pinned contract addresses per (network, protocol). Empty list = no
 *  addresses pinned for that cell. */
export interface KnownAddressesByProtocol {
  blend: string[]
  soroswap: string[]
}

export interface KnownAddressesByNetwork {
  mainnet: KnownAddressesByProtocol
  testnet: KnownAddressesByProtocol
}

// Source: https://docs.blend.capital/mainnet-deployments (Blend Pool Factory
// mainnet deployment, fetched 2026-07-23).
const BLEND_MAINNET_POOL_FACTORY = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'

// Source: https://github.com/soroswap (organisation README, fetched 2026-07-23)
// SoroswapRouter mainnet deployment.
const SOROSWAP_MAINNET_ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'

// Source: https://github.com/soroswap (organisation README, fetched 2026-07-23)
// SoroswapFactory mainnet deployment.
const SOROSWAP_MAINNET_FACTORY = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'

export const KNOWN_ADDRESSES: KnownAddressesByNetwork = {
  mainnet: {
    blend: [BLEND_MAINNET_POOL_FACTORY],
    soroswap: [SOROSWAP_MAINNET_ROUTER, SOROSWAP_MAINNET_FACTORY],
  },
  testnet: {
    // [VERIFY] Blend testnet pool factory address: not published in the
    // public docs as of 2026-07-23. Excluded from the active set until an
    // authoritative source is found.
    blend: [],
    // [VERIFY] SoroSwap testnet router / factory addresses: not published in
    // the public docs as of 2026-07-23. Excluded from the active set.
    soroswap: [],
  },
}

/** Map a (contract, network) pair to its pinned protocol id. Returns null
 *  when the address is not pinned for that network - callers MUST preserve
 *  the fail-closed posture for unpinned contracts. */
export function addressToProtocol(
  contract: string,
  network: 'mainnet' | 'testnet'
): ProtocolId | null {
  for (const protocol of ['blend', 'soroswap'] as const) {
    if (KNOWN_ADDRESSES[network][protocol].includes(contract)) {
      return protocol
    }
  }
  return null
}
