// Networks, RPC endpoints and the pins every install is checked against.

export type Network = 'mainnet' | 'testnet'

export const PASSPHRASE: Record<Network, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
}

export const RPC_URL: Record<Network, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://mainnet.sorobanrpc.com',
}

/** The grammar this package speaks: `SELF_VERSION` in the interpreter. */
export const GRAMMAR_VERSION = 7

/** The grammar-7 interpreter, per network. Mainnet has none yet: until one is
 *  deployed and pinned here, mainnet installs and checks name their own
 *  interpreter, and it is verified live like the pinned one. */
export const INTERPRETER: Record<Network, { address: string; wasmSha256: string } | null> = {
  testnet: {
    address: 'CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB',
    wasmSha256: 'eb1ec6ee8dca82622b9e70a04599b7ceeea9dc89f5917293ca76fb2c51af37b3',
  },
  mainnet: null,
}

/** OpenZeppelin's `spending_limit`, built from stellar-contracts v0.7.2 and
 *  deployed by us. An example contract, not audited by us. */
export const SPENDING_LIMIT: Record<Network, string> = {
  testnet: 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP',
  mainnet: 'CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A',
}

/** Policy contracts a rule must never be scoped to: scoping a rule to one
 *  exposes that contract's own admin calls (the interpreter does not refuse it). */
export const POLICY_CONTRACTS = new Set([
  ...Object.values(SPENDING_LIMIT),
  'CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ', // grammar 6, testnet
  'CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52', // grammar 4, mainnet
  'CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB', // grammar 7, testnet
])
