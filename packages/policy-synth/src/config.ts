// Networks, RPC endpoints and the pins every install is checked against.

import { StrKey } from '@stellar/stellar-sdk'
import { Refusal } from './envelope.ts'
import { type Caps, isConstant, type Val } from './wire.ts'

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

/** The grammar-7 interpreter, per network (the wasm is the build with deploy-time `Limits`), with
 *  the limits that instance was deployed with: immutable (no setter, no upgrade), so recorded here
 *  and held equal to `deployments/grammar7-testnet.json`. Only synthesis and the info tool trust
 *  them with no RPC; install, verify and simulate read `limits()` live. Mainnet has none yet:
 *  until one is deployed and pinned here, mainnet installs and checks name their own
 *  interpreter, and it is verified live like the pinned one. */
export const INTERPRETER: Record<
  Network,
  { address: string; wasmSha256: string; limits: Caps } | null
> = {
  testnet: {
    address: 'CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT',
    wasmSha256: '69cad1d5ce9aeaa0dad6980fd030e528935a0ebdd290111f393e9fd0564a68b0',
    limits: Object.freeze({
      max_reads: 8,
      max_leaves: 400,
      max_predicate_bytes: 24576,
      max_elems: 32,
      max_in_operands: 32,
      max_depth: 5,
    }),
  },
  mainnet: null,
}

/** The interpreter builds this package will talk to, by the sha256 of their code
 *  (the reproducible `build-wasm.sh` output). It is the trust anchor on every
 *  network: whatever address a caller names, its LIVE code hash must be in this
 *  set, because any contract can answer `grammar_version() = 7`. */
export const INTERPRETER_WASM: ReadonlySet<string> = new Set(
  Object.values(INTERPRETER).flatMap((p) => (p ? [p.wasmSha256] : []))
)

/** The smart-account builds (OpenZeppelin) whose rules `explainAccount` will read, by wasm sha256
 *  (`deployments/oz-accounts.json`): any other contract could answer with whatever rules it likes. */
export const OZ_ACCOUNT_WASM: ReadonlySet<string> = new Set([
  '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9',
])

/** Tokens that are not Stellar Asset Contracts, whose amounts a review may show in their own
 *  unit: by address, per network. A wasm token chooses its own `decimals()` and `symbol()`, so
 *  none is believed until it is listed here (a Stellar Asset Contract is named by its `name()`). */
export const TOKENS: Record<Network, Record<string, { decimals: number; symbol: string }>> = {
  testnet: {},
  mainnet: {},
}

/** The upstream tag the deployed OpenZeppelin policies were built from, so that
 *  `scripts/upstream-drift-check.ts` can compare it with the latest release. */
export const OZ_STELLAR_CONTRACTS_TAG = 'v0.7.2'

/** OpenZeppelin's `spending_limit`, built from stellar-contracts v0.7.2 and
 *  deployed by us. An example contract, not audited by us. */
export const SPENDING_LIMIT: Record<Network, string> = {
  testnet: 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP',
  mainnet: 'CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A',
}

/** Every interpreter this project deployed, whatever its grammar. A rule policed by
 *  one of these can only be judged if it is the grammar-7 build this package reads. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  'CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ', // grammar 6, testnet
  'CBRRKTVURLAJRPJ3G44AWA5SCGUV47PCYF5CHND5TG3OGTFNXTSLBIJ5', // grammar 6, testnet rehearsal
  'CAOBQ4ZXANKXAGEJWJLIGQJDFCTHMEZVUPLPX277KSDMEU4MEWVVXO2R', // grammar 6, mainnet (Prime)
  'CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52', // grammar 4, mainnet
  'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5', // grammar 4, testnet
  'CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB', // grammar 7, testnet, first build (its check could commit a read)
  'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV', // grammar 7, testnet, limits hard-coded (superseded: no limits())
  'CAECFZWHHHKJRJHYR3EQHAMYHBQPW7G6BGKYSNJS4KLZAUNLQP7H5L2H', // grammar 7, testnet, deploy-time limits (superseded: max_elems could be 1, 48 KiB ceiling)
  'CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT', // grammar 7, testnet, deploy-time limits, floors, 40 KiB ceiling
])

/** OpenZeppelin's `simple_threshold` and `weighted_threshold`, built from v0.7.2 and deployed by us
 *  (`deployments/oz-policies.json`): testnet simple, testnet weighted, mainnet simple, mainnet
 *  weighted. Their admin calls (`set_threshold`, `install`...) need only the account's own
 *  authorisation, so no rule may be scoped to them; a rule that asks for a threshold gets one. */
export const OZ_THRESHOLD = [
  'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6',
  'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2',
  'CDOGPGUFGGUDG25P3TG6XIXJKRRYOZ3PXUZIEPVH74KXRZIDKZ5HYEOS',
  'CDWPZ4YZ3YIJ64XSHRMERRF2L2H7XD6SPUZDP3KI56T7QXQCICC25V3J',
]
/** The threshold policy of a network: simple, or weighted. */
export const thresholdAddress = (net: Network, weighted: boolean): string =>
  OZ_THRESHOLD[(net === 'mainnet' ? 2 : 0) + (weighted ? 1 : 0)] as string

/** `read` targets whose answer cannot be moved within one transaction (an oracle's own price feed),
 *  by network: contract -> functions. Any other read is a live value an agent can move with a
 *  call of its own just before the one the rule judges, so an install of it is refused unless the
 *  operator sets POLICY_BUILDER_ALLOW_SPOT_READS=1. A listed oracle is itself upgradable by its admin: the
 *  list trusts that admin. Testnet: the Reflector oracles (their spec was
 *  read on chain: `lastprice(asset)`, `price(asset, timestamp)`). Mainnet: empty until an address is
 *  verified the same way. */
export const SAFE_READS: Record<Network, Record<string, string[]>> = {
  testnet: Object.fromEntries(
    [
      'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
      'CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP',
      'CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W',
    ].map((a) => [a, ['lastprice', 'price']])
  ),
  mainnet: {},
}
/** The operator's own entries, from POLICY_BUILDER_SAFE_READS_<NET>: `C…:fn,C…:fn`. Read from the
 *  environment only, never from an input. One bad entry refuses the whole value. */
const operatorReads = (net: Network): string[] => {
  const key = `POLICY_BUILDER_SAFE_READS_${net.toUpperCase()}`
  return (process.env[key] ? (process.env[key] as string).split(',') : []).map((e) => {
    const [c = '', fn = '', ...x] = e.split(':')
    if (x.length || !StrKey.isValidContract(c) || !/^[A-Za-z_]\w{0,31}$/.test(fn))
      throw new Refusal('INVALID_INPUT', `${key}: bad entry "${e}", want C…:function,C…:function`)
    return e
  })
}
/** Safe only for a listed contract and function (built in, or the operator's), and only with arguments
 *  fixed in the rule: an asset or a timestamp taken from the call is a choice the caller makes. */
export const safeRead = (net: Network, contract: string, fn: string, args: Val[]): boolean =>
  (operatorReads(net).includes(`${contract}:${fn}`) ||
    (Object.hasOwn(SAFE_READS[net], contract) &&
      (SAFE_READS[net][contract] as string[]).includes(fn))) &&
  args.every(isConstant)

/** Policy contracts a rule must never be scoped to: scoping a rule to one
 *  exposes that contract's own admin calls (the interpreter does not refuse it). */
export const POLICY_CONTRACTS: ReadonlySet<string> = new Set([
  ...Object.values(SPENDING_LIMIT),
  ...OZ_THRESHOLD,
  ...INTERPRETERS,
])
