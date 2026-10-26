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

// ---- the operator's bounds on what a wallet signs ----
//
// An install or a removal carries two values the RPC used to choose: how long the signed
// authorisation stays valid and the resource fee. Both are bounded here, from the environment
// only (never from a tool input, so an agent cannot widen them).

/** The authorisation window by default, in ledgers: 300, about 25 to 30 minutes. */
export const AUTH_LEDGERS = 300
/** The most POLICY_BUILDER_AUTH_LEDGERS may ask for: 17,280 ledgers, about one day. */
export const MAX_AUTH_LEDGERS = 17_280
/** Seconds per ledger the transaction's time bound allows for: above the close time, so the
 *  ledger expiry is reached first while ledgers close on time. */
export const LEDGER_SECONDS = 6
/** How far the owner's clock may run behind the builder's before `review_unsigned` reads a fresh
 *  build's time bound as longer than the window: 120 s. Phone and browser clocks drift by seconds to
 *  a minute or two; an owner clock this far off still reads a bound at most 2 minutes too long. */
export const CLOCK_SKEW = 120
/** The resource fee ceiling by default, in stroops: 10 XLM. An install of a 12 KiB predicate asks
 *  about 1.3 XLM on testnet, and the 40 KiB ceiling of any interpreter about 4 XLM. */
export const MAX_RESOURCE_FEE = 100_000_000

const fromEnv = (key: string, fallback: number, max: number): number => {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  if (!/^[1-9]\d*$/.test(v) || Number(v) > max)
    throw new Refusal('INVALID_INPUT', `${key}: "${v}" is not a whole number from 1 to ${max}`)
  return Number(v)
}
/** The window the signed authorisation is valid for, in ledgers (POLICY_BUILDER_AUTH_LEDGERS). */
export const authLedgers = (): number =>
  fromEnv('POLICY_BUILDER_AUTH_LEDGERS', AUTH_LEDGERS, MAX_AUTH_LEDGERS)
/** The highest resource fee a build may carry, in stroops (POLICY_BUILDER_MAX_RESOURCE_FEE). */
export const maxResourceFee = (): number =>
  fromEnv('POLICY_BUILDER_MAX_RESOURCE_FEE', MAX_RESOURCE_FEE, Number.MAX_SAFE_INTEGER)

/** The grammar this package speaks: `SELF_VERSION` in the interpreter. */
export const GRAMMAR_VERSION = 7

/** The pinned interpreter, per network (the wasm is the build with deploy-time `Limits`), with
 *  the limits that instance was deployed with: immutable (no setter, no upgrade), so recorded here
 *  and held equal to `deployments/interpreter-testnet.json`. Only synthesis and the info tool trust
 *  them with no RPC; install, verify and simulate read `limits()` live. Mainnet has none yet:
 *  until one is deployed and pinned here, mainnet installs and checks name their own
 *  interpreter, and it is verified live like the pinned one. */
export const INTERPRETER: Record<
  Network,
  { address: string; wasmSha256: string; limits: Caps } | null
> = {
  testnet: {
    address: 'CDER6P73JWMIVD3X6TGGOQIDAH3DLU7OKRTLT4ULPTZ3QJJ3QUGTK7CM',
    wasmSha256: '6704996f626904a4e33b95bda17b73963fc9cf502ffdfdbe9d85b4b10288e0d4',
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

/** The smart-account builds (OpenZeppelin) whose rules `revoke_policy` will describe, by wasm sha256
 *  (`deployments/oz-accounts.json`): any other contract could answer with whatever rules it likes.
 *  Both builds are trusted: `91a2cd56…`, the 0.7.2-line account every existing Prime runs (the seat
 *  is tied to its digest), and `8286422f…`, OpenZeppelin's 0.8.0 `multisig-account-example`, which
 *  the testnet reference account runs. */
export const OZ_ACCOUNT_WASM: ReadonlySet<string> = new Set([
  '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9',
  '8286422f205951f37f4249401b403471fc432340dde6925432d31bb8a90cce27',
])

/** How a Delegated signer authorises the account's `__check_auth`, per account build:
 *  - `digest` (the 0.7.2-line `91a2cd56…`): `__check_auth(sha256(sha256(signature payload) ‖
 *    XDR(context rule ids)))`, the bytes;
 *  - `preimage` (OpenZeppelin 0.8.0, `8286422f…`): `__check_auth(AuthDigestPreimage { account,
 *    context_rule_ids, signature_payload })`, the struct the account passes to
 *    `require_auth_for_args` (`smart_account/storage.rs`, `authenticate`).
 *  The builder signs only for these builds: for any other code it cannot know the form, and refuses. */
export type AccountAuth = 'digest' | 'preimage'
export const OZ_ACCOUNT_AUTH: Readonly<Record<string, AccountAuth>> = Object.freeze({
  '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9': 'digest',
  '8286422f205951f37f4249401b403471fc432340dde6925432d31bb8a90cce27': 'preimage',
})
/** The authorisation form of an account build, or undefined for a build the package does not know. */
export const accountAuth = (wasmSha256: string | undefined): AccountAuth | undefined =>
  wasmSha256 !== undefined && Object.hasOwn(OZ_ACCOUNT_AUTH, wasmSha256)
    ? OZ_ACCOUNT_AUTH[wasmSha256]
    : undefined

/** The upstream tag the deployed OpenZeppelin policies were built from, per network, so that
 *  `scripts/upstream-drift-check.ts` can compare it with the latest release. Testnet runs the
 *  v0.8.0 builds (`deployments/oz-policies.json`); mainnet still runs the v0.7.2 builds. */
export const OZ_STELLAR_CONTRACTS_TAG: Record<Network, string> = {
  testnet: 'v0.8.0',
  mainnet: 'v0.7.2',
}

/** OpenZeppelin's `spending_limit`, deployed by us: built from stellar-contracts v0.8.0 on
 *  testnet, v0.7.2 on mainnet. An example contract, not audited by us. New rules are capped by
 *  this address; a rule capped by a superseded instance is still read (`SUPERSEDED_OZ_POLICIES`). */
export const SPENDING_LIMIT: Record<Network, string> = {
  testnet: 'CCPZW4322JUETOYDKYUFB2AZ2SZVWFV3IATZ3TG4QXZKQXBEOIQM2JQ4',
  mainnet: 'CA7IBD266HIHFDUIBZLPIAITJUA3DVY4JAG6K3QMGBKLZCXXLP5E2F7A',
}

/** OpenZeppelin policy instances we deployed and have since replaced (`superseded` in
 *  `deployments/oz-policies.json`): the testnet v0.7.2 builds. No new rule attaches them, but the
 *  rules already installed with them stay readable (a review names their cap and threshold), and
 *  no rule may be scoped to them (`POLICY_CONTRACTS`). Their storage is the same as the
 *  current build's: v0.8.0 changed none of the three policies' types. */
export const SUPERSEDED_OZ_POLICIES: Record<
  Network,
  readonly { spending_limit: string; simple_threshold: string; weighted_threshold: string }[]
> = {
  testnet: [
    {
      spending_limit: 'CDH4KOBRUEZI6TTZ72YXR5YUIODB6RH3AF75KX56Z73DELRCA5TWFISP',
      simple_threshold: 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6',
      weighted_threshold: 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2',
    },
  ],
  mainnet: [],
}

/** Every `spending_limit` instance a rule on this network may be capped by, the current first. */
export const spendingLimits = (net: Network): readonly string[] => [
  SPENDING_LIMIT[net],
  ...SUPERSEDED_OZ_POLICIES[net].map((p) => p.spending_limit),
]

/** Every interpreter this project deployed, whatever its grammar. A rule policed by
 *  one of these can only be judged if it is the pinned build this package reads; the
 *  rest are listed so that such a rule is recognised and refused. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  'CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ', // deployed by this project; this build does not trust it
  'CBRRKTVURLAJRPJ3G44AWA5SCGUV47PCYF5CHND5TG3OGTFNXTSLBIJ5', // deployed by this project; this build does not trust it
  'CAOBQ4ZXANKXAGEJWJLIGQJDFCTHMEZVUPLPX277KSDMEU4MEWVVXO2R', // deployed by this project; this build does not trust it
  'CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52', // deployed by this project; this build does not trust it
  'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5', // deployed by this project; this build does not trust it
  'CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB', // deployed by this project; this build does not trust it
  'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV', // deployed by this project; this build does not trust it
  'CAECFZWHHHKJRJHYR3EQHAMYHBQPW7G6BGKYSNJS4KLZAUNLQP7H5L2H', // deployed by this project; this build does not trust it
  'CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT', // deployed by this project; this build does not trust it
  'CD46LN75LITN5INQEW3N3BKUK52IFODGCTJS2RWQ44JM74RH6ILIPBJ2', // deployed by this project; this build does not trust it
  'CDER6P73JWMIVD3X6TGGOQIDAH3DLU7OKRTLT4ULPTZ3QJJ3QUGTK7CM', // testnet, the pinned instance (INTERPRETER.testnet)
])

/** OpenZeppelin's `simple_threshold` and `weighted_threshold`, deployed by us
 *  (`deployments/oz-policies.json`): testnet simple, testnet weighted (built from v0.8.0), mainnet
 *  simple, mainnet weighted (built from v0.7.2). Their admin calls (`set_threshold`, `install`...)
 *  need only the account's own authorisation, so no rule may be scoped to them; a rule that asks
 *  for a threshold gets one. */
export const OZ_THRESHOLD = [
  'CCRCBH3MX43U6WNUL4NSLIAVNISNHSZTZZ7VCQYSGRELZJB67G6JHSWW',
  'CCJXAUHAQ3H7Y7P2OE5J5ODY6HAI4UA6TNV3WOFGFLIJYXIXZOAJ65TL',
  'CDOGPGUFGGUDG25P3TG6XIXJKRRYOZ3PXUZIEPVH74KXRZIDKZ5HYEOS',
  'CDWPZ4YZ3YIJ64XSHRMERRF2L2H7XD6SPUZDP3KI56T7QXQCICC25V3J',
]
/** The threshold policy of a network that new rules attach: simple, or weighted. */
export const thresholdAddress = (net: Network, weighted: boolean): string =>
  OZ_THRESHOLD[(net === 'mainnet' ? 2 : 0) + (weighted ? 1 : 0)] as string
/** Whether `at` is a threshold policy a rule on this network may carry, the current instance or
 *  a superseded one: `weighted` says which kind. */
export const isThreshold = (net: Network, at: string, weighted: boolean): boolean =>
  at === thresholdAddress(net, weighted) ||
  SUPERSEDED_OZ_POLICIES[net].some(
    (p) => at === (weighted ? p.weighted_threshold : p.simple_threshold)
  )

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
  ...Object.values(SUPERSEDED_OZ_POLICIES).flatMap((ps) => ps.flatMap((p) => Object.values(p))),
  ...INTERPRETERS,
])
