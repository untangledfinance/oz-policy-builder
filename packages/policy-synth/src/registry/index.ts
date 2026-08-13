// src/registry/index.ts - re-export the protocol adjacency registry.

export {
  type IdentifiedProtocol,
  identifyProtocol,
} from './identify.ts'

export {
  addressToProtocol,
  KNOWN_ADDRESSES,
  type KnownAddressesByNetwork,
  type KnownAddressesByProtocol,
} from './known-addresses.ts'
export {
  type AbiArg,
  type AbiEntry,
  BLEND_ABI,
  getAbi,
  PROTOCOL_ABIS,
  type ProtocolAbi,
  type ProtocolId,
  SEP41_ABI,
  SOROSWAP_ABI,
} from './protocols.ts'
