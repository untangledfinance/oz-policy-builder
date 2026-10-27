// `solana_review` with `readChain`: the unsigned Squads transaction checked against the accounts it
// meets on devnet, read through the operator's RPC. The bytes-only review runs first and is
// unchanged; this adds what only the chain knows: the rules already on the account (one the change
// duplicates, or a looser one a shared signer could use instead), the account's live owners and
// threshold after the change, whether each pinned destination exists, holds what it should and is
// thawed (on a frozen-by-default Token-2022 mint whose default state was never updated, thawed is
// whitelisted; PayFi's verifier checks that history, this read does not), the mint's extensions, the
// klend reserves a rule pins and their market, and the deploy slots of the Squads and klend
// programs against the build this review was written for.
//
// It follows PayFi's Solana v2 verifier (payfi `solana/v2/verify.ts`: readSnapshot, then a pure
// checkSnapshot): `readSolanaChain` reads the accounts into a snapshot of raw bytes, and
// `reviewSolanaOnChain` checks the review against that snapshot with no network, so a recorded
// snapshot replays offline. A read that fails refuses the review; an account the checks needed and
// the read did not return is a problem. Layouts: Squads `0e51082` (state/settings.rs,
// state/policies/), klend 1.26.0 (`e921c64`, the SDK 13.0.5 layout; 1.27.0 changes LendingMarket only
// past byte 3440, and the devnet build was checked against live bytes) (Reserve, LendingMarket), SPL Token and
// Token-2022 (state.rs, extension/mod.rs).

import { base58, DecodeError, fromBase58, hex, Reader } from './bytes.ts'
import { fact, group, type Node } from './card.ts'
import { messageOf, Refusal } from './envelope.ts'
import { type Rpc, unread } from './jsonrpc.ts'
import { onCurve, policyAddress, programAddress, sha256, te, vaultAddress } from './pda.ts'
import {
  accountConstraint,
  allowedChange,
  checkPolicy,
  type DataConstraint,
  dataConstraint,
  describeData,
  discOf,
  type Execution,
  hook,
  type InstructionConstraint,
  isLut,
  KLEND,
  type Limit,
  OBLIGATION,
  type Period,
  type PolicyPayload,
  PROGRAM,
  PROGRAM_NAME,
  periodName,
  periodV2,
  pinsAt,
  reads,
  reviewSolana,
  type SettingsAction,
  type Signer,
  type SolanaContext,
  type SolanaInput,
  type SolanaReview,
  signer,
  TOKEN_IX,
  TOKENS,
} from './solana.ts'

// ---- the cluster and the builds this review reads ----

export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const

/** The devnet builds the layouts and offsets here were checked against: each program's ProgramData
 *  and its deploy slot, read on 27 October 2026 (payfi `PINNED_PROGRAMS`). A redeploy moves the slot,
 *  and the review then refuses to vouch for offsets 64, 2287 and 2336 until someone re-checks them. */
export const DEPLOYED: Record<string, { programData: string; slot: string }> = {
  [PROGRAM.smartAccount]: {
    programData: '2g3u9qgz4adKQVN1TUoh7bbBKqaSsjXtz1yX2ptagW5T',
    slot: '425429201',
  },
  [PROGRAM.klend]: {
    programData: '9uSbGW1y9H5Av6H5TKxQ1wnFApSq2t3oEpfF2YfjDQGA',
    slot: '491561420',
  },
}

export const SOLANA_RPC_DEVNET = 'https://api.devnet.solana.com'
/** The operator's devnet endpoint (`POLICY_BUILDER_SOLANA_RPC_URL`), else the public one. */
export const solanaRpcUrl = (): string =>
  process.env.POLICY_BUILDER_SOLANA_RPC_URL ?? SOLANA_RPC_DEVNET

// ---- program addresses (pda.ts) ----

export { onCurve, policyAddress, programAddress, vaultAddress }

// ---- the snapshot ----

/** An account as `getMultipleAccounts` returns it, data in base64. */
export interface RawAccount {
  owner: string
  lamports: number
  executable: boolean
  data: string
}
export interface SolanaSnapshot {
  genesisHash: string
  /** The slot the accounts were read at. */
  slot: number
  /** Every account read, by address: `null` when it does not exist. */
  accounts: Record<string, RawAccount | null>
  /** The endpoint is a loopback host (a local validator): the devnet build pins may not hold. */
  local?: boolean
}

const anchor = (kind: 'account' | 'global', name: string) =>
  hex(sha256(te(`${kind}:${name}`)).subarray(0, 8))
const DISC = {
  settings: anchor('account', 'Settings'),
  policy: anchor('account', 'Policy'),
  reserve: anchor('account', 'Reserve'),
  market: anchor('account', 'LendingMarket'),
}
const DEFAULT_KEY = '11111111111111111111111111111111'

// ---- decoders (each one reads exactly what the Rust layout says, or throws) ----

export interface LiveSettings {
  settingsAuthority: string
  threshold: number
  timeLock: number
  archivalAuthority: string | null
  signers: Signer[]
  policySeed: string | null
}
export function settingsOf(data: Uint8Array): LiveSettings {
  if (hex(data.subarray(0, 8)) !== DISC.settings)
    throw new DecodeError('not a Squads Settings account')
  const r = new Reader(data.subarray(8), 'the Settings account')
  r.u128() // seed
  const settingsAuthority = r.key()
  const threshold = r.u16()
  const timeLock = r.u32()
  r.u64() // transaction_index
  r.u64() // stale_transaction_index
  const archivalAuthority = r.option(() => r.key())
  r.u64() // archivable_after
  r.u8() // bump
  const signers = r.vec(() => signer(r), 33)
  r.u8() // account_utilization
  const policySeed = r.option(() => r.u64().toString())
  return { settingsAuthority, threshold, timeLock, archivalAuthority, signers, policySeed }
}

export interface LiveRule {
  address: string
  settings: string
  seed: string
  signers: Signer[]
  threshold: number
  timeLock: number
  policy: PolicyPayload
  start: string
  expiration: { timestamp: string } | 'SettingsState' | null
}
/** A stored `SpendingLimitV2` (utils/spending_limit_v2.rs): mint, time and quantity constraints, usage. */
function storedLimit(r: Reader): Limit {
  const mint = r.key()
  const start = r.i64().toString()
  const expiration = r.option(() => r.i64().toString())
  const period: Period = periodV2(r)
  r.bool() // accumulate_unused
  const maxPerPeriod = r.u64().toString()
  r.u64() // max_per_use
  r.bool() // enforce_exact_quantity
  r.u64() // remaining_in_period
  r.i64() // last_reset
  return { mint, start, expiration, period, maxPerPeriod }
}
/** A stored `PolicyState` (policy_core/policy.rs:226-235): the payload shapes the bytes review reads. */
function storedState(r: Reader): PolicyPayload {
  const t = r.u8()
  if (t === 0) {
    const indices = (mask: Uint8Array) =>
      [...mask].flatMap((b, k) =>
        [0, 1, 2, 3, 4, 5, 6, 7].filter((j) => b & (1 << j)).map((j) => k * 8 + j)
      )
    return {
      kind: 'InternalFundTransfer',
      sources: indices(r.bytes(32)),
      destinations: indices(r.bytes(32)),
      mints: r.vec(() => r.key(), 32),
    }
  }
  if (t === 1) {
    const sourceAccountIndex = r.u8()
    const destinations = r.vec(() => r.key(), 32)
    const l = storedLimit(r)
    return {
      kind: 'SpendingLimit',
      mint: l.mint,
      sourceAccountIndex,
      maxPerPeriod: l.maxPerPeriod,
      period: l.period,
      destinations,
    }
  }
  if (t === 2) return { kind: 'SettingsChange', allowed: r.vec(() => allowedChange(r)) }
  if (t === 3)
    return {
      kind: 'ProgramInteraction',
      accountIndex: r.u8(),
      constraints: r.vec(
        () => ({
          programId: r.key(),
          accounts: r.vec(() => accountConstraint(r), 3),
          data: r.vec(() => dataConstraint(r), 10),
        }),
        40
      ),
      preHook: r.option(() => hook(r)),
      postHook: r.option(() => hook(r)),
      limits: r.vec(() => storedLimit(r), 50),
    }
  throw new DecodeError(`a policy state: unknown variant ${t}`)
}
export function ruleOf(address: string, data: Uint8Array): LiveRule {
  if (hex(data.subarray(0, 8)) !== DISC.policy) throw new DecodeError('not a Squads Policy account')
  const r = new Reader(data.subarray(8), 'the Policy account')
  const settings = r.key()
  const seed = r.u64().toString()
  r.u8() // bump
  r.u64() // transaction_index
  r.u64() // stale_transaction_index
  const signers = r.vec(() => signer(r), 33)
  const threshold = r.u16()
  const timeLock = r.u32()
  const policy = storedState(r)
  const start = r.i64().toString()
  const expiration = r.option(() => {
    const t = r.u8()
    if (t === 0) return { timestamp: r.i64().toString() }
    if (t === 1) {
      r.bytes(32)
      return 'SettingsState' as const
    }
    throw new DecodeError(`a policy expiration: unknown variant ${t}`)
  })
  r.key() // rent_collector
  return { address, settings, seed, signers, threshold, timeLock, policy, start, expiration }
}

/** An SPL Token or Token-2022 account (state.rs `Account`, 165 bytes before any extension). */
export interface TokenAccount {
  mint: string
  owner: string
  amount: string
  delegate: string | null
  delegatedAmount: string
  /** 0 uninitialized, 1 initialized, 2 frozen. */
  state: number
  closeAuthority: string | null
}
const cOption = (b: Uint8Array, at: number) =>
  Buffer.from(b).readUInt32LE(at) === 1 ? base58(b.subarray(at + 4, at + 36)) : null
export function tokenAccountOf(data: Uint8Array): TokenAccount {
  if (data.length < 165 || (data.length > 165 && data[165] !== 2))
    throw new DecodeError('not a token account')
  const b = Buffer.from(data)
  return {
    mint: base58(data.subarray(0, 32)),
    owner: base58(data.subarray(32, 64)),
    amount: b.readBigUInt64LE(64).toString(),
    delegate: cOption(data, 72),
    delegatedAmount: b.readBigUInt64LE(121).toString(),
    state: data[108] as number,
    closeAuthority: cOption(data, 129),
  }
}

export const EXTENSION: Record<number, string> = {
  1: 'TransferFeeConfig',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  6: 'DefaultAccountState',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  12: 'PermanentDelegate',
  14: 'TransferHook',
  16: 'ConfidentialTransferFeeConfig',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmountConfig',
  26: 'PausableConfig',
  28: 'PermissionedBurn',
}
export interface Mint {
  mintAuthority: string | null
  freezeAuthority: string | null
  supply: string
  decimals: number
  extensions: { type: number; name: string; value: Uint8Array }[]
}
export function mintOf(data: Uint8Array): Mint {
  if (data.length < 82 || (data.length > 82 && (data.length < 166 || data[165] !== 1)))
    throw new DecodeError('not a mint')
  if (data[45] !== 1) throw new DecodeError('an uninitialized mint')
  const extensions: Mint['extensions'] = []
  if (data.length > 82) {
    const r = new Reader(data.subarray(166), 'the mint extensions')
    while (r.left >= 4) {
      const type = r.u16()
      const len = r.u16()
      if (type === 0) break
      extensions.push({ type, name: EXTENSION[type] ?? `extension ${type}`, value: r.bytes(len) })
    }
  }
  return {
    mintAuthority: cOption(data, 0),
    supply: Buffer.from(data).readBigUInt64LE(36).toString(),
    decimals: data[44] as number,
    freezeAuthority: cOption(data, 46),
    extensions,
  }
}
const nonZeroKey = (b: Uint8Array) => (b.length === 32 && b.some((x) => x !== 0) ? base58(b) : null)

/** klend `Reserve` (state/reserve.rs at 1.26.0 `e921c64`, zero-copy; offsets from klend SDK
 *  13.0.5's layout, account bytes with the discriminator; unchanged in 1.27.0). */
export interface Reserve {
  market: string
  liquidityMint: string
  supplyVault: string
  feeVault: string
  collateralMint: string
  status: number
  ltvPct: number
  liquidationThresholdPct: number
  depositLimit: string
  borrowLimit: string
  priceFeed: string
  permissionedOps: string
}
export function reserveOf(data: Uint8Array): Reserve {
  if (hex(data.subarray(0, 8)) !== DISC.reserve || data.length < 5808)
    throw new DecodeError('not a klend Reserve')
  const b = Buffer.from(data)
  const k = (at: number) => base58(data.subarray(at, at + 32))
  return {
    market: k(32),
    liquidityMint: k(128),
    supplyVault: k(160),
    feeVault: k(192),
    collateralMint: k(2560),
    status: data[4856] as number,
    ltvPct: data[4872] as number,
    liquidationThresholdPct: data[4873] as number,
    depositLimit: b.readBigUInt64LE(5016).toString(),
    borrowLimit: b.readBigUInt64LE(5024).toString(),
    priceFeed: k(5112),
    permissionedOps: b.readBigUInt64LE(5800).toString(),
  }
}
/** klend `LendingMarket` (state/lending_market.rs), the fields a review shows. */
export interface Market {
  owner: string
  ownerCached: string
  emergencyCouncil: string
  permissioningAuthority: string
  permissionedOps: string
}
export function marketOf(data: Uint8Array): Market {
  if (hex(data.subarray(0, 8)) !== DISC.market || data.length < 3440)
    throw new DecodeError('not a klend LendingMarket')
  const k = (at: number) => base58(data.subarray(at, at + 32))
  return {
    owner: k(24),
    ownerCached: k(56),
    emergencyCouncil: k(160),
    permissioningAuthority: k(3400),
    permissionedOps: Buffer.from(data).readBigUInt64LE(3432).toString(),
  }
}
/** An upgradeable program (UpgradeableLoaderState::Program) and its ProgramData. */
export function programDataOf(program: Uint8Array): string {
  if (program.length < 36 || Buffer.from(program).readUInt32LE(0) !== 2)
    throw new DecodeError('not an upgradeable program')
  return base58(program.subarray(4, 36))
}
export function deployOf(data: Uint8Array): { slot: string; authority: string | null } {
  if (data.length < 45 || Buffer.from(data).readUInt32LE(0) !== 3)
    throw new DecodeError('not a ProgramData account')
  return {
    slot: Buffer.from(data).readBigUInt64LE(4).toString(),
    authority: data[12] === 1 ? base58(data.subarray(13, 45)) : null,
  }
}

// ---- the checks ----

/** The most rules the review walks on one account (seeds 1..policy_seed). */
export const MAX_RULES = 128

type Got = RawAccount | null | undefined
const bytesOf = (a: RawAccount) => new Uint8Array(Buffer.from(a.data, 'base64'))

/** A borrow anywhere in a rule. */
const borrowsIn = (p: PolicyPayload) =>
  p.kind === 'ProgramInteraction' &&
  p.constraints.some(
    (c) => c.programId === PROGRAM.klend && KLEND[discOf(c, 8) ?? '']?.kind === 'borrow'
  )

/** The instruction a constraint stands for: program and pinned discriminator (or token tag). */
function instructionOf(c: InstructionConstraint): string | null {
  const d = TOKENS.has(c.programId) ? discOf(c, 1)?.slice(0, 2) : discOf(c, 8)
  return d === undefined ? null : `${c.programId}:${d}`
}
function instructionName(c: InstructionConstraint): string {
  const program = PROGRAM_NAME[c.programId] ?? c.programId
  if (c.programId === PROGRAM.klend)
    return `${program} ${KLEND[discOf(c, 8) ?? '']?.name ?? discOf(c, 8) ?? 'any instruction'}`
  if (TOKENS.has(c.programId)) {
    const t = discOf(c, 1)
    return `${program} ${t === undefined ? 'any instruction' : (TOKEN_IX[Number.parseInt(t.slice(0, 2), 16)]?.name ?? `instruction ${t.slice(0, 2)}`)}`
  }
  return program
}
const sameData = (a: DataConstraint, b: DataConstraint) =>
  a.offset === b.offset &&
  a.operator === b.operator &&
  a.value.type === b.value.type &&
  a.value.value === b.value.value
const isCap = (d: DataConstraint) =>
  d.offset === '8' &&
  d.value.type === 'U64Le' &&
  (d.operator === 'LessThan' || d.operator === 'LessThanOrEqualTo')
const capOf = (d: DataConstraint) => BigInt(d.value.value) - (d.operator === 'LessThan' ? 1n : 0n)

/** Where live constraint `l` admits more than `c` for the same instruction: each position `c` pins
 *  that `l` leaves open, each account read `c` makes that `l` lacks, and each data pin or ceiling `c`
 *  holds that `l` lacks or loosens. Empty when `l` is as tight or tighter; `null` when the two admit
 *  no call in common (a position each pins to keys the other does not list, or a data value each
 *  pins differently). */
export function looser(l: InstructionConstraint, c: InstructionConstraint): string[] | null {
  const out: string[] = []
  for (const index of [...new Set([...c.accounts, ...l.accounts].map((a) => a.index))]) {
    const mine = pinsAt(c, index)
    const theirs = pinsAt(l, index)
    if (mine.pinned && theirs.pinned && !theirs.keys.some((k) => mine.keys.includes(k))) return null
    if (mine.pinned && !theirs.pinned) out.push(`account ${index} open`)
    for (const { d, owner } of mine.data)
      if (!theirs.data.some((x) => x.owner === owner && sameData(x.d, d)))
        out.push(`no read ${describeData(d)} on account ${index}`)
  }
  for (const d of c.data) {
    if (l.data.some((x) => sameData(x, d))) continue
    const other = l.data.find(
      (x) => x.offset === d.offset && x.operator === 'Equals' && d.operator === 'Equals'
    )
    if (other) return null
    if (d.offset === '0') continue
    if (isCap(d)) {
      const theirs = l.data.filter(isCap)
      if (theirs.length === 0) out.push('no ceiling on the amount')
      else if (theirs.every((x) => capOf(x) > capOf(d)))
        out.push(
          `a higher ceiling (${theirs.map(describeData).join(', ')} against ${describeData(d)})`
        )
    } else out.push(`no ${describeData(d)}`)
  }
  return out
}
const limitsKey = (p: Extract<PolicyPayload, { kind: 'ProgramInteraction' }>) =>
  JSON.stringify(p.limits.map((l) => [l.mint, l.maxPerPeriod, periodName(l.period)]).sort())
const constraintsKey = (p: Extract<PolicyPayload, { kind: 'ProgramInteraction' }>) =>
  JSON.stringify(p.constraints)

interface Ctx extends SolanaContext {
  snap: SolanaSnapshot
  /** An account, or its first `head` bytes (a ProgramData account is the program's whole binary). */
  get: (k: string, head?: number) => Got
  facts: Node[]
}
/** What the checks wanted and the snapshot lacked: address to the bytes wanted (0: all of it). */
type Misses = Map<string, number>

/** The checks against the chain, as the "On chain" node; `miss` collects what was not read. */
function chainChecks(c: SolanaContext, snap: SolanaSnapshot, miss: Misses): Node {
  const get = (k: string, head = 0): Got => {
    if (isLut(k)) return undefined
    if (k in snap.accounts) return snap.accounts[k]
    miss.set(k, head)
    return undefined
  }
  const x: Ctx = { ...c, snap, get, facts: [] }
  const cluster =
    snap.genesisHash === GENESIS.devnet
      ? 'devnet'
      : snap.local
        ? `a local validator (genesis ${snap.genesisHash})`
        : snap.genesisHash
  x.facts.push(fact('cluster', `${cluster}, slot ${snap.slot}`))
  if (snap.genesisHash === GENESIS.mainnet)
    c.flag('the chain read reached mainnet: this review reads devnet only')
  else if (snap.genesisHash !== GENESIS.devnet && !snap.local)
    c.flag(`the chain read reached a cluster that is not devnet (genesis ${snap.genesisHash})`)

  builds(x)
  if (c.actions) settingsChange(x, c.actions)
  if (c.execution) execution(x, c.execution, c.i.role, 'the execution')
  return group('On chain', 'chain', x.facts)
}

/** The Squads and klend builds: the deploy slot each program's ProgramData records. */
function builds(x: Ctx) {
  for (const program of [PROGRAM.smartAccount, PROGRAM.klend]) {
    const pin = DEPLOYED[program] as { programData: string; slot: string }
    const what = PROGRAM_NAME[program] as string
    const p = x.get(program)
    if (p === undefined) continue
    let pd: string
    try {
      if (p === null || p.owner !== PROGRAM.loaderUpgradeable)
        throw new DecodeError('no upgradeable program there')
      pd = programDataOf(bytesOf(p))
    } catch (e) {
      x.flag(`${what} (${program}) is not an upgradeable program on this cluster: ${messageOf(e)}`)
      continue
    }
    const d = x.get(pd, 45)
    if (d === undefined) continue
    let dep: ReturnType<typeof deployOf>
    try {
      if (d === null) throw new DecodeError('missing')
      dep = deployOf(bytesOf(d))
    } catch (e) {
      x.flag(`${what}'s ProgramData ${pd} does not read: ${messageOf(e)}`)
      continue
    }
    x.facts.push(
      fact(
        `${what} build`,
        `deployed at slot ${dep.slot} (pinned ${pin.slot}), upgrade authority ${dep.authority ?? 'none'}`
      )
    )
    if (dep.slot !== pin.slot || pd !== pin.programData) {
      const msg = `${what} was deployed at slot ${dep.slot}, not the build this review was checked against (slot ${pin.slot}, ProgramData ${pin.programData}): its account layouts and the offsets the rules read (obligation owner @${OBLIGATION.owner}, has_debt @${OBLIGATION.hasDebt}, marked @${OBLIGATION.markedAt}) must be checked again before a rule that relies on them is trusted`
      if (x.snap.local) x.warn(msg)
      else x.flag(msg)
    }
  }
}

function liveSettings(x: Ctx, k: string, what: string): LiveSettings | null | undefined {
  const a = x.get(k)
  if (a === undefined) return undefined
  if (a === null) {
    x.flag(`${what} ${k} is not on chain`)
    return null
  }
  try {
    if (a.owner !== PROGRAM.smartAccount)
      throw new DecodeError(`owned by ${a.owner}, not the Smart Account program`)
    return settingsOf(bytesOf(a))
  } catch (e) {
    x.flag(`${what} ${k} is not a Squads settings account: ${messageOf(e)}`)
    return null
  }
}
function liveRule(x: Ctx, k: string, what: string): LiveRule | null | undefined {
  const a = x.get(k)
  if (a === undefined) return undefined
  if (a === null) {
    x.flag(`${what} ${k} is not on chain`)
    return null
  }
  try {
    if (a.owner !== PROGRAM.smartAccount)
      throw new DecodeError(`owned by ${a.owner}, not the Smart Account program`)
    return ruleOf(k, bytesOf(a))
  } catch (e) {
    x.flag(`${what} ${k} is not a Squads rule: ${messageOf(e)}`)
    return null
  }
}

/** The structural problems of a live rule, by the same checks the bytes review makes of a new one. */
function ruleProblems(
  x: Ctx,
  r: LiveRule,
  role: SolanaInput['role'],
  noDebt: boolean,
  strangers: boolean
): string[] {
  const out: string[] = []
  // the rule's own account: a repay's owner read is checked against its vault
  const i = {
    ...(strangers ? x.i : { ...x.i, destinations: undefined, signers: undefined }),
    account: r.settings,
  }
  checkPolicy(
    {
      action: 'PolicyCreate',
      seed: r.seed,
      policy: r.policy,
      signers: r.signers,
      threshold: r.threshold,
      timeLock: r.timeLock,
      start: r.start,
      expiration: r.expiration,
    },
    `live rule ${r.seed}`,
    { ...i, role },
    noDebt,
    (p) => out.push(p),
    () => {},
    x.tag
  )
  return out
}
const describeRule = (x: Ctx, r: LiveRule) =>
  fact(
    `live rule ${r.seed}`,
    `${x.tag(r.address)}: ${r.policy.kind}, ${r.threshold} of ${r.signers.map((s) => x.tag(s.key)).join(', ')}${
      r.policy.kind === 'ProgramInteraction'
        ? `, vault ${r.policy.accountIndex}, ${r.policy.constraints.map(instructionName).join('; ') || 'ANY instruction'}`
        : ''
    }`
  )

function settingsChange(x: Ctx, actions: SettingsAction[]) {
  const custody = x.i.role === 'custody'
  const s = liveSettings(x, x.account, 'the account')
  if (!s) return
  x.label(vaultAddress(x.account, x.i.vaultIndex ?? 0), `vault ${x.i.vaultIndex ?? 0}`)
  x.facts.push(
    fact(
      'owners now',
      `${s.signers.map((v) => x.tag(v.key)).join(', ')}; threshold ${s.threshold}, time lock ${s.timeLock} s`
    )
  )
  if (s.settingsAuthority !== DEFAULT_KEY)
    x.flag(
      `the account is controlled: its settings authority ${s.settingsAuthority} changes owners, threshold and rules alone, without the owners' vote (state/settings.rs:30-39)`
    )
  if (s.archivalAuthority && s.archivalAuthority !== DEFAULT_KEY)
    x.warn(
      `the account names ${s.archivalAuthority} as its archival authority, a key outside the owners' vote`
    )

  // Who signs, against the owners on chain.
  const live = new Map(s.signers.map((v) => [v.key, v.permissions]))
  const named = x.owners.filter((o) => live.has(o))
  for (const o of x.owners)
    if (!live.has(o))
      x.warn(
        `it names ${o} as a signing owner, but ${o} is not an owner of the account on chain: it would fail`
      )
  if (x.instruction === 'execute_settings_transaction_sync') {
    const votes = named.filter((o) => ((live.get(o) as number) & 2) !== 0).length
    if (votes < s.threshold)
      x.warn(
        `${votes} of the signing owners can vote, below the account's threshold ${s.threshold}: it would fail`
      )
  }

  // The settings after the change.
  const after = new Map(live)
  let threshold = s.threshold
  let timeLock = s.timeLock
  let seed = BigInt(s.policySeed ?? 0)
  const created: {
    address: string
    action: Extract<SettingsAction, { action: 'PolicyCreate' }>
  }[] = []
  for (const a of actions) {
    if (a.action === 'AddSigner') after.set(a.signer.key, a.signer.permissions)
    else if (a.action === 'RemoveSigner') after.delete(a.signer)
    else if (a.action === 'ChangeThreshold') threshold = a.threshold
    else if (a.action === 'SetTimeLock') timeLock = a.timeLock
    else if (a.action === 'PolicyCreate') {
      seed += 1n
      const address = policyAddress(x.account, seed)
      x.label(address, `new rule ${seed}`)
      created.push({ address, action: a })
    }
  }
  const voting = [...after.values()].filter((p) => p & 2).length
  const changes = actions.some((a) =>
    ['AddSigner', 'RemoveSigner', 'ChangeThreshold', 'SetTimeLock'].includes(a.action)
  )
  if (changes)
    x.facts.push(
      fact(
        'owners after',
        `${[...after.keys()].map(x.tag).join(', ')}; threshold ${threshold}, time lock ${timeLock} s`
      )
    )
  const now = changes ? 'after the change' : 'on chain'
  if (custody && threshold < voting)
    x.flag(
      `custody ${now} needs ${threshold} of its ${voting} voting owners: one party can be left out, the trustee included; custody's threshold equals its owners`
    )
  if (custody && voting < 3)
    x.warn(
      `custody ${now} has ${voting} voting owner(s); the design's custody is 3 of 3 (the MPC key, a second signer and the trustee)`
    )
  if (!custody && threshold < 2)
    x.flag(`the Prime account ${now} lets one owner act alone (threshold ${threshold})`)
  if (x.i.minTimeLock !== undefined && timeLock < x.i.minTimeLock)
    x.flag(
      `the account's settings time lock ${now} is ${timeLock} s, below the ${x.i.minTimeLock} s it keeps`
    )

  // The rules on the account now: seeds 1..policy_seed, each at its program address.
  const count = BigInt(s.policySeed ?? 0)
  if (count > BigInt(MAX_RULES)) {
    x.flag(
      `the account has created ${count} rules, more than the ${MAX_RULES} this review reads; check them another way`
    )
    return
  }
  const rules: LiveRule[] = []
  let unknown = false
  for (let n = 1n; n <= count; n++) {
    const k = policyAddress(x.account, n)
    x.label(k, `live rule ${n}`)
    const a = x.get(k)
    if (a === undefined) unknown = true
    else if (a !== null) {
      const r = liveRule(x, k, `rule ${n} of the account`)
      if (r) rules.push(r)
    }
  }
  if (unknown) return
  x.facts.push(
    rules.length
      ? group(
          `Rules on the account now: ${rules.length} (of ${count} ever created)`,
          'rules',
          rules.map((r) => describeRule(x, r))
        )
      : fact('rules on the account now', `none (${count} ever created)`)
  )

  const touched = new Set(
    actions.flatMap((a) =>
      a.action === 'PolicyUpdate' || a.action === 'PolicyRemove' ? [a.policyAccount] : []
    )
  )
  for (const k of touched)
    if (!rules.some((r) => r.address === k))
      x.flag(
        `it edits or removes ${k}, which is not a live rule of this account (seeds 1..${count}): it would fail, or it names another account's rule`
      )
  const staying = rules.filter((r) => !touched.has(r.address))
  const changed: {
    where: string
    address: string
    signers: Signer[]
    threshold: number
    policy: PolicyPayload
    old?: LiveRule
  }[] = [
    ...created.map(({ address, action }) => ({
      where: `the new rule ${x.tag(address)}`,
      address,
      signers: action.signers,
      threshold: action.threshold,
      policy: action.policy,
    })),
    ...actions.flatMap((a) =>
      a.action === 'PolicyUpdate'
        ? [
            {
              where: `the edit of ${x.tag(a.policyAccount)}`,
              address: a.policyAccount,
              signers: a.signers,
              threshold: a.threshold,
              policy: a.policy,
              old: rules.find((r) => r.address === a.policyAccount),
            },
          ]
        : []
    ),
  ]

  // A borrow anywhere on the account after the change means every collateral withdraw needs its has_debt read.
  const borrowing = staying.filter((r) => borrowsIn(r.policy))
  const noDebt =
    x.i.requireNoDebt === true || borrowing.length > 0 || changed.some((r) => borrowsIn(r.policy))
  for (const r of changed) {
    if (r.policy.kind !== 'ProgramInteraction' || borrowing.length === 0) continue
    r.policy.constraints.forEach((cn, k) => {
      if (cn.programId !== PROGRAM.klend || KLEND[discOf(cn, 8) ?? '']?.kind !== 'withdraw') return
      const ok = reads(
        cn,
        1,
        OBLIGATION.hasDebt,
        (d) => d.operator === 'Equals' && d.value.type === 'U8' && d.value.value === '0'
      ).some(({ owner }) => owner === PROGRAM.klend)
      if (!ok)
        x.flag(
          `${r.where}, constraint ${k}: the withdraw lacks the has_debt == 0 read, and ${borrowing.map((b) => x.tag(b.address)).join(', ')} on chain lets this account borrow: collateral could leave while the position owes`
        )
    })
  }

  // Live rules a signer of a new rule also holds: a looser one makes the new pins moot for that signer.
  const newSigners = new Set(changed.flatMap((r) => r.signers.map((v) => v.key)))
  for (const r of staying) {
    const problems = ruleProblems(x, r, x.i.role, noDebt, true)
    if (problems.length === 0) continue
    const shared = r.signers.map((v) => v.key).filter((k) => newSigners.has(k))
    // A warning: the live rule is the owners' earlier choice and this change grants nothing
    // through it; the bypass of this change's own pins is the same-instruction check below.
    if (shared.length)
      x.warn(
        `${shared.map(x.tag).join(', ')} also sign(s) ${x.tag(r.address)} (seed ${r.seed}), a live rule looser than the design: ${problems.join('; ')}. The change leaves it in place, so its signers keep that path`
      )
    else
      x.warn(
        `${x.tag(r.address)} (seed ${r.seed}) stays on the account as it is: ${problems.join('; ')}`
      )
  }

  for (const r of changed) {
    if (r.policy.kind !== 'ProgramInteraction') continue
    const p = r.policy
    // The same rule twice: removing one leaves the other.
    for (const l of staying) {
      if (l.address === r.address || l.policy.kind !== 'ProgramInteraction') continue
      if (
        l.policy.accountIndex === p.accountIndex &&
        constraintsKey(l.policy) === constraintsKey(p) &&
        limitsKey(l.policy) === limitsKey(p)
      )
        x.warn(
          `${r.where} duplicates ${x.tag(l.address)} (seed ${l.seed}): two rules grant the same calls, and removing one leaves the other`
        )
    }
    // A live rule a shared signer can use for the same instruction, with fewer pins.
    p.constraints.forEach((cn, k) => {
      const id = instructionOf(cn)
      for (const l of staying) {
        if (l.policy.kind !== 'ProgramInteraction' || l.policy.accountIndex !== p.accountIndex)
          continue
        const shared = l.signers.map((v) => v.key).filter((s) => r.signers.some((v) => v.key === s))
        if (shared.length === 0) continue
        l.policy.constraints.forEach((lc, m) => {
          if (lc.programId !== cn.programId) return
          const theirs = instructionOf(lc)
          if (theirs !== null && theirs !== id) return
          const why = theirs === null ? ['no instruction pinned'] : looser(lc, cn)
          if (why === null || constraintsKey(l.policy as typeof p) === constraintsKey(p)) return
          const lim = (l.policy as typeof p).limits
          const limitGap = p.limits.filter(
            (pl) =>
              !lim.some(
                (ll) => ll.mint === pl.mint && BigInt(ll.maxPerPeriod) <= BigInt(pl.maxPerPeriod)
              )
          )
          const reasons = [
            ...why,
            ...limitGap.map(
              (pl) =>
                `no spending limit on ${x.tag(pl.mint)} as tight as ${pl.maxPerPeriod} per ${periodName(pl.period)}`
            ),
          ]
          if (reasons.length)
            x.flag(
              `${r.where}, constraint ${k} (${instructionName(cn)}): ${shared.map(x.tag).join(', ')} also sign(s) ${x.tag(l.address)} (seed ${l.seed}), whose constraint ${m} admits the same instruction with ${reasons.join('; ')}: those signers can use that rule instead, so these pins do not bind them`
            )
          else
            x.warn(
              `${r.where}, constraint ${k} (${instructionName(cn)}) overlaps ${x.tag(l.address)} (seed ${l.seed}) constraint ${m} for ${shared.map(x.tag).join(', ')}`
            )
        })
      }
    })
    // An edit that admits more than the rule it replaces.
    if (r.old && r.old.policy.kind === 'ProgramInteraction') {
      const old = r.old.policy
      const wider: string[] = []
      p.constraints.forEach((cn, k) => {
        const same = old.constraints
          .filter((o) => o.programId === cn.programId && instructionOf(o) === instructionOf(cn))
          .map((o) => looser(cn, o))
          .filter((w): w is string[] => w !== null)
        if (same.length === 0)
          wider.push(`constraint ${k} (${instructionName(cn)}) admits calls the rule did not`)
        else if (same.every((w) => w.length > 0))
          wider.push(
            `constraint ${k} (${instructionName(cn)}) drops ${(same[0] as string[]).join('; ')}`
          )
      })
      if (r.threshold < r.old.threshold)
        wider.push(`the threshold drops from ${r.old.threshold} to ${r.threshold}`)
      const added = r.signers.filter((v) => !r.old?.signers.some((o) => o.key === v.key))
      if (added.length) wider.push(`it adds signer(s) ${added.map((v) => x.tag(v.key)).join(', ')}`)
      if (wider.length) x.warn(`${r.where} loosens the live rule: ${wider.join('; ')}`)
    }
  }

  // What the new rules pin: destinations, reserves, and for a band the custody rule it calls.
  for (const r of changed)
    if (r.policy.kind === 'ProgramInteraction')
      r.policy.constraints.forEach((cn, k) => {
        pinned(
          x,
          cn,
          `${r.where}, constraint ${k}`,
          (r.policy as { accountIndex: number }).accountIndex
        )
      })
}

/** The accounts a constraint pins, read: token accounts and their mints, reserves, a band's rule. */
function pinned(x: Ctx, cn: InstructionConstraint, where: string, accountIndex: number) {
  if (cn.programId === PROGRAM.klend) {
    const spec = KLEND[discOf(cn, 8) ?? '']
    if (!spec?.pins) return
    const reserves: Reserve[] = []
    let tokens: { k: string; t: TokenAccount }[] = []
    for (const [index, what] of spec.pins) {
      const keys = pinsAt(cn, index).keys
      if (what === 'reserve')
        for (const k of keys) {
          const r = reserve(x, k, `${where}: the reserve`)
          if (r) reserves.push(r)
        }
      else if (what.endsWith('token account'))
        tokens = [
          ...tokens,
          ...keys.flatMap((k) => {
            const t = token(x, k, `${where}: the ${what}`, index === spec.destination)
            return t ? [{ k, t }] : []
          }),
        ]
    }
    mintsMatch(x, where, reserves, tokens)
  } else if (TOKENS.has(cn.programId)) {
    const t = discOf(cn, 1)
    const spec = t === undefined ? undefined : TOKEN_IX[Number.parseInt(t.slice(0, 2), 16)]
    if (spec?.destination !== undefined)
      for (const k of pinsAt(cn, spec.destination).keys)
        token(x, k, `${where}: the destination`, true)
  } else if (cn.programId === PROGRAM.smartAccount && x.i.role === 'prime') {
    for (const k of pinsAt(cn, 0).keys) bandTarget(x, k, where, accountIndex)
  }
}

/** A reserve and the token accounts beside it must hold the reserve's liquidity mint. */
function mintsMatch(
  x: Ctx,
  where: string,
  reserves: Reserve[],
  tokens: { k: string; t: TokenAccount }[]
) {
  if (reserves.length === 0) return
  const mints = new Set(reserves.map((r) => r.liquidityMint))
  for (const { k, t } of tokens)
    if (!mints.has(t.mint))
      x.flag(
        `${where}: token account ${x.tag(k)} holds mint ${t.mint}, which no pinned reserve lends (${[...mints].join(', ')}): the pins do not describe one market position`
      )
}

function token(x: Ctx, k: string, where: string, destination: boolean): TokenAccount | null {
  if (isLut(k)) return null
  const a = x.get(k)
  if (a === undefined) return null
  if (a === null) {
    ;(destination ? x.flag : x.warn)(
      `${where} ${k} is not on chain: ${destination ? 'it is not a thawed holder of anything, and ' : ''}whoever creates an account at that address decides its owner`
    )
    return null
  }
  if (!TOKENS.has(a.owner)) {
    x.flag(`${where} ${k} is not a token account (owned by ${PROGRAM_NAME[a.owner] ?? a.owner})`)
    return null
  }
  let t: TokenAccount
  try {
    t = tokenAccountOf(bytesOf(a))
  } catch (e) {
    x.flag(`${where} ${k} does not read as a token account: ${messageOf(e)}`)
    return null
  }
  const state = ['uninitialized', 'thawed', 'FROZEN'][t.state] ?? `state ${t.state}`
  x.facts.push(
    fact(
      `token account ${x.tag(k)}`,
      `${PROGRAM_NAME[a.owner]}, mint ${x.tag(t.mint)}, owner ${x.tag(t.owner)}, ${state}${t.delegate ? `, delegate ${t.delegate}` : ''}`
    )
  )
  if (t.state === 0) x.flag(`${where} ${k} is an uninitialized token account`)
  if (t.state === 2)
    x.flag(
      destination
        ? `${where} ${k} is FROZEN, so nothing can be paid into it (the token program refuses a frozen destination): on a frozen-by-default mint it is not thawed, so not on the thaw list; the issuer thaws an approved holder first`
        : `${where} ${k} is FROZEN: nothing can leave it until the issuer thaws it`
    )
  if (t.delegate)
    x.warn(
      `${where} ${x.tag(k)} has a delegate ${x.tag(t.delegate)} that may move up to ${t.delegatedAmount} of it without its owner ${x.tag(t.owner)}`
    )
  if (t.closeAuthority && t.closeAuthority !== t.owner)
    x.warn(`${where} ${k} has a close authority ${t.closeAuthority} other than its owner`)
  mint(x, t.mint, a.owner)
  return t
}

function mint(x: Ctx, k: string, program: string) {
  const a = x.get(k)
  if (a === undefined || x.facts.some((f) => f.label === `mint ${x.tag(k)}`)) return
  if (a === null || a.owner !== program) {
    x.flag(`mint ${k} is not on chain under ${PROGRAM_NAME[program]}`)
    return
  }
  let m: Mint
  try {
    m = mintOf(bytesOf(a))
  } catch (e) {
    x.flag(`mint ${k} does not read: ${messageOf(e)}`)
    return
  }
  const ext = (n: number) => m.extensions.find((e) => e.type === n)
  const frozenByDefault = ext(6)?.value[0] === 2
  x.facts.push(
    fact(
      `mint ${x.tag(k)}`,
      `${PROGRAM_NAME[program]}, mint authority ${m.mintAuthority ? x.tag(m.mintAuthority) : 'none'}, freeze authority ${m.freezeAuthority ? x.tag(m.freezeAuthority) : 'none'}${
        m.extensions.length ? `, extensions ${m.extensions.map((e) => e.name).join(', ')}` : ''
      }${frozenByDefault ? ' (frozen by default: a holder needs a thaw)' : ''}`
    )
  )
  const pd = ext(12)
  if (pd && nonZeroKey(pd.value))
    x.warn(
      `mint ${k} has a permanent delegate ${nonZeroKey(pd.value)}: it can move or burn the token from every account, custody's included`
    )
  const hookExt = ext(14)
  if (hookExt) {
    const programId = nonZeroKey(hookExt.value.subarray(32, 64))
    if (programId)
      x.warn(
        `mint ${k} runs transfer hook program ${programId} on every transfer: that program can refuse a move`
      )
  }
  if (ext(26))
    x.warn(`mint ${k} is pausable (PausableConfig): its authority can stop every transfer`)
  if (ext(1)) x.warn(`mint ${k} charges a transfer fee: an amount sent arrives smaller`)
  if (ext(9)) x.warn(`mint ${k} is non-transferable`)
  if (program === PROGRAM.token2022 && m.freezeAuthority && !frozenByDefault)
    x.warn(
      `mint ${k} does not open accounts frozen (DefaultAccountState), so its thaw list is no whitelist: any account can hold it until frozen`
    )
}

function reserve(x: Ctx, k: string, where: string): Reserve | null {
  if (isLut(k)) return null
  const a = x.get(k)
  if (a === undefined) return null
  if (a === null) {
    x.flag(`${where} ${k} is not on chain`)
    return null
  }
  let r: Reserve
  try {
    if (a.owner !== PROGRAM.klend)
      throw new DecodeError(`owned by ${PROGRAM_NAME[a.owner] ?? a.owner}, not klend`)
    r = reserveOf(bytesOf(a))
  } catch (e) {
    x.flag(`${where} ${k} is not a klend reserve: ${messageOf(e)}`)
    return null
  }
  const label = `reserve ${x.tag(k)}`
  if (!x.facts.some((f) => f.label === label)) {
    x.facts.push(
      fact(
        label,
        `market ${x.tag(r.market)}, lends ${x.tag(r.liquidityMint)}, LTV ${r.ltvPct}% / liquidation ${r.liquidationThresholdPct}%, deposit limit ${r.depositLimit}, borrow limit ${r.borrowLimit}, permissioned ops ${r.permissionedOps}, price feed ${x.tag(r.priceFeed)}${r.status ? `, status ${['active', 'obsolete', 'hidden'][r.status] ?? r.status}` : ''}`
      )
    )
    if (r.status !== 0)
      x.warn(
        `${where} ${k} is not active (status ${['active', 'obsolete', 'hidden'][r.status] ?? r.status})`
      )
    if (x.i.market !== undefined && r.market !== x.i.market)
      x.flag(
        `${where} ${k} belongs to market ${r.market}, not the market under review ${x.i.market}`
      )
    market(x, r.market)
  }
  return r
}

function market(x: Ctx, k: string) {
  const label = `market ${x.tag(k)}`
  if (x.facts.some((f) => f.label === label)) return
  const a = x.get(k)
  if (a === undefined) return
  try {
    if (a === null || a.owner !== PROGRAM.klend) throw new DecodeError('not a klend account')
    const m = marketOf(bytesOf(a))
    x.facts.push(
      fact(
        label,
        `owner ${x.tag(m.owner)}, permissioning authority ${m.permissioningAuthority === DEFAULT_KEY ? 'none' : x.tag(m.permissioningAuthority)}, market-wide permissioned ops ${m.permissionedOps}, emergency council ${m.emergencyCouncil === DEFAULT_KEY ? 'none' : x.tag(m.emergencyCouncil)}`
      )
    )
  } catch (e) {
    x.flag(`market ${k} is not a klend lending market: ${messageOf(e)}`)
  }
}

/** A band's call target: the custody rule, live, structurally sound, and listing this Prime vault. */
function bandTarget(x: Ctx, k: string, where: string, accountIndex: number) {
  x.label(k, 'custody rule')
  const r = liveRule(x, k, `${where}: the custody rule the band calls`)
  if (!r) return
  x.facts.push(
    fact(
      `custody rule ${x.tag(k)}`,
      `of ${x.tag(r.settings)}, ${r.threshold} of ${r.signers.map((s) => x.tag(s.key)).join(', ')}`
    )
  )
  const vault = vaultAddress(x.account, accountIndex)
  x.label(vault, `Prime vault ${accountIndex}`)
  if (!r.signers.some((s) => s.key === vault))
    x.warn(
      `${where}: the custody rule ${x.tag(k)} does not list this account's vault ${accountIndex} (${vault}) as a signer, so the band cannot run it`
    )
  const problems = ruleProblems(
    x,
    r,
    'custody',
    x.i.requireNoDebt === true || borrowsIn(r.policy),
    false
  )
  if (problems.length)
    x.flag(
      `${where}: the band calls ${x.tag(k)}, a live custody rule looser than the design: ${problems.join('; ')}`
    )
}

function execution(x: Ctx, e: Execution, role: SolanaInput['role'], where: string) {
  if (e.payload === 'settings-level') {
    const s = liveSettings(x, e.consensusAccount, `${where}'s account`)
    if (s)
      for (const o of e.signers)
        if (!s.signers.some((v) => v.key === o))
          x.warn(
            `${where} names ${o}, who is not an owner of ${e.consensusAccount} on chain: it would fail`
          )
  } else {
    const r = liveRule(x, e.consensusAccount, `the rule ${where} runs under,`)
    if (r) {
      x.facts.push(describeRule(x, r))
      const s = liveSettings(x, r.settings, `the rule's account`)
      if (s) x.label(vaultAddress(r.settings, e.accountIndex), `vault ${e.accountIndex}`)
      const problems = ruleProblems(
        x,
        r,
        role,
        x.i.requireNoDebt === true || borrowsIn(r.policy),
        role === x.i.role
      )
      // A warning: the calls this execution makes are read and checked from its bytes; the rule's
      // looseness is the owners' earlier choice.
      if (problems.length)
        x.warn(
          `${where} runs under ${e.consensusAccount}, a live rule looser than the design: ${problems.join('; ')}`
        )
      if (r.timeLock > 0)
        x.warn(
          `${where}'s rule has a ${r.timeLock} s time lock, so it cannot run synchronously: it would fail`
        )
      const signers = new Map(r.signers.map((v) => [v.key, v.permissions]))
      for (const o of e.signers)
        if (!signers.has(o))
          x.warn(`${where} names ${o}, who does not sign the rule on chain: it would fail`)
      const votes = e.signers.filter((o) => ((signers.get(o) ?? 0) & 2) !== 0).length
      if (votes < r.threshold)
        x.warn(
          `${where} carries ${votes} voting signer(s) for the rule's threshold ${r.threshold}: it would fail`
        )
      if (r.policy.kind === 'ProgramInteraction') {
        const p = r.policy
        if (p.accountIndex !== e.accountIndex)
          x.warn(
            `${where} acts as vault ${e.accountIndex}, but the rule acts for vault ${p.accountIndex}: it would fail`
          )
        e.constraintIndices?.forEach((n, k) => {
          const cn = p.constraints[n]
          const call = e.instructions[k]
          if (!cn)
            x.warn(
              `${where} claims constraint ${n}, which the live rule does not have: it would fail`
            )
          else if (
            call &&
            (call.program !== cn.programId ||
              (instructionOf(cn) !== null &&
                !hex(call.data).startsWith((instructionOf(cn) as string).split(':')[1] as string)))
          )
            x.warn(
              `${where}: inner call ${k} does not match the constraint ${n} it claims (${instructionName(cn)}): it would fail`
            )
        })
      } else if (r.policy.kind !== e.payload)
        x.warn(
          `${where} asks a ${e.payload} rule, but the rule on chain is a ${r.policy.kind}: it would fail`
        )
    }
  }
  e.instructions.forEach((call, n) => {
    const w = `${where}, inner call ${n}`
    if (call.program === PROGRAM.klend) {
      const spec = KLEND[hex(call.data.subarray(0, 8))]
      const reserves: Reserve[] = []
      const tokens: { k: string; t: TokenAccount }[] = []
      for (const [index, what] of spec?.pins ?? []) {
        const k = call.accounts[index]
        if (!k) continue
        if (what === 'reserve') {
          const r = reserve(x, k, `${w}: the reserve`)
          if (r) reserves.push(r)
        } else if (what.endsWith('token account')) {
          const t = token(x, k, `${w}: the ${what}`, index === spec?.destination)
          if (t) tokens.push({ k, t })
        }
      }
      mintsMatch(x, w, reserves, tokens)
    } else if (TOKENS.has(call.program)) {
      const spec = TOKEN_IX[call.data[0] ?? -1]
      const k = spec?.destination !== undefined ? call.accounts[spec.destination] : undefined
      if (k) token(x, k, `${w}: the destination`, true)
    }
    if (call.nested) execution(x, call.nested, 'custody', `${where}'s nested execution`)
  })
}

// ---- the review with the chain, and the read ----

/** `reviewSolana`, then the checks against `snap`. Pure: an account the checks need that `snap`
 *  lacks is a problem (`needs` says which to read). */
export function reviewSolanaOnChain(
  i: SolanaInput,
  snap: SolanaSnapshot
): SolanaReview & { chain: { cluster: string; slot: number; accounts: number } } {
  const miss: Misses = new Map()
  const r = reviewSolana(i, (c) => {
    const node = chainChecks(c, snap, miss)
    if (miss.size)
      c.flag(
        `the chain read did not return ${[...miss.keys()].join(', ')}, so the checks that need it were not made`
      )
    return node
  })
  return {
    ...r,
    chain: {
      cluster: snap.genesisHash === GENESIS.devnet ? 'devnet' : snap.genesisHash,
      slot: snap.slot,
      accounts: Object.keys(snap.accounts).length,
    },
  }
}

/** The accounts the checks would read that `snap` does not hold yet, each with the bytes wanted
 *  (0: all of it). */
export function needs(i: SolanaInput, snap: SolanaSnapshot): Misses {
  const miss: Misses = new Map()
  reviewSolana(i, (c) => {
    chainChecks(c, snap, miss)
    return null
  })
  return miss
}

/** Read what the review of `i` needs from the chain, in rounds (a rule's settings, then its rules,
 *  then their pins), into a snapshot. Refuses mainnet, and a failed read refuses the review. */
export async function readSolanaChain(
  i: SolanaInput,
  rpc: Rpc,
  o: { local?: boolean } = {}
): Promise<SolanaSnapshot> {
  // Bytes the decoder refuses are refused before any read.
  reviewSolana(i)
  let genesisHash: string
  try {
    genesisHash = String(await rpc('getGenesisHash', []))
  } catch (e) {
    throw unread('the cluster', e)
  }
  if (genesisHash === GENESIS.mainnet)
    throw new Refusal(
      'INVALID_INPUT',
      'the Solana RPC endpoint serves mainnet; readChain reads devnet only'
    )
  if (genesisHash !== GENESIS.devnet && !o.local)
    throw new Refusal(
      'INVALID_INPUT',
      `the Solana RPC endpoint serves a cluster that is not devnet (genesis ${genesisHash})`
    )
  const snap: SolanaSnapshot = {
    genesisHash,
    slot: 0,
    accounts: {},
    ...(o.local ? { local: true } : {}),
  }
  for (let round = 0; round < 8; round++) {
    const want = needs(i, snap)
    if (want.size === 0) return snap
    const batches: [string[], number][] = []
    for (const head of new Set(want.values())) {
      const all = [...want].filter(([, h]) => h === head).map(([k]) => k)
      for (let k = 0; k < all.length; k += 100) batches.push([all.slice(k, k + 100), head])
    }
    for (const [batch, head] of batches) {
      let res: { context?: { slot?: number }; value?: unknown[] }
      const slice = head ? { dataSlice: { offset: 0, length: head } } : {}
      try {
        res = (await rpc('getMultipleAccounts', [
          batch,
          { encoding: 'base64', commitment: 'confirmed', ...slice },
        ])) as typeof res
      } catch (e) {
        throw unread(`${batch.length} account(s)`, e)
      }
      if (!Array.isArray(res?.value) || res.value.length !== batch.length)
        throw unread(
          'the accounts',
          new Error('getMultipleAccounts answered a different number of accounts')
        )
      snap.slot = Math.max(snap.slot, Number(res.context?.slot ?? 0))
      batch.forEach((addr, n) => {
        const v = (res.value as unknown[])[n] as {
          owner?: string
          lamports?: number
          executable?: boolean
          data?: [string, string]
        } | null
        snap.accounts[addr] =
          v === null
            ? null
            : {
                owner: String(v.owner),
                lamports: Number(v.lamports ?? 0),
                executable: v.executable === true,
                data: Array.isArray(v.data) ? String(v.data[0]) : '',
              }
      })
    }
  }
  return snap
}

export { fromBase58 }
