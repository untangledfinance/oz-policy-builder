// The owner's side of the review on Solana: what an unsigned Squads Smart Account transaction
// does, read out of its bytes alone. Like `review_unsigned` for Stellar, it asks no RPC and takes
// nothing from the agent but the bytes, so a wallet or the Prime app can run it on the transaction
// it is about to sign. It decodes a settings change (`execute_settings_transaction_sync`,
// `create_settings_transaction`) into the rules it installs, edits or removes, and an execution
// (`execute_transaction_sync_v2`) into the calls it makes, and checks them against the
// configuration-only design (docs/solana.md; the PayFi line's rules, payfi `solana/v2/rules.ts`).
// It cannot tell a consistent rewrite from the owner's intent, so the review shows the authority
// the bytes grant for the owner to read.
//
// Sources: Squads Smart Account `0e51082` (paths under programs/squads_smart_account_program/src/),
// Kamino klend `e921c64` (programs/klend/src/), SPL Token and Token-2022.

import { base58, DecodeError, fromBase58, hex, Reader } from './bytes.ts'
import { fact, group, lines, type Node, warned } from './card.ts'
import { messageOf, Refusal } from './envelope.ts'

// ---- programs and instructions ----

export const PROGRAM = {
  smartAccount: 'SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG',
  klend: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  /** Kamino Scope on devnet (the only cluster this package reviews for). */
  scope: '3Vw8Ngkh1MVJTPHthmUbmU2XKtFEkjYvJzMqrv2rh9yX',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  loaderUpgradeable: 'BPFLoaderUpgradeab1e11111111111111111111111',
  loader2: 'BPFLoader2111111111111111111111111111111111',
  loader4: 'LoaderV411111111111111111111111111111111111',
} as const

export const PROGRAM_NAME: Record<string, string> = {
  [PROGRAM.smartAccount]: 'Squads Smart Account',
  [PROGRAM.klend]: 'Kamino klend',
  [PROGRAM.token]: 'SPL Token',
  [PROGRAM.token2022]: 'Token-2022',
  [PROGRAM.system]: 'System',
  [PROGRAM.computeBudget]: 'Compute Budget',
  [PROGRAM.scope]: 'Kamino Scope (devnet)',
  [PROGRAM.ata]: 'Associated Token Account',
  [PROGRAM.loaderUpgradeable]: 'BPF upgradeable loader',
  [PROGRAM.loader2]: 'BPF loader',
  [PROGRAM.loader4]: 'Loader v4',
}
const LOADERS = new Set<string>([PROGRAM.loaderUpgradeable, PROGRAM.loader2, PROGRAM.loader4])
export const TOKENS = new Set<string>([PROGRAM.token, PROGRAM.token2022])

/** Anchor discriminators: sha256("global:<name>")[0..8], as hex. Checked against node's sha256 in the tests. */
export const SQUADS_DISC = {
  execute_settings_transaction_sync: '8ad140a34f43e94c',
  create_settings_transaction: '65a8fecbde665fc0',
  execute_transaction_sync_v2: '5a51bb512746804e',
  execute_transaction_sync: '2b66f859e7616886',
  create_proposal: '847444aed8a0c616',
  approve_proposal: '886c665562720793',
  execute_settings_transaction: '83d21b581bcc8fbd',
  create_transaction: 'e3c135ef377e7069',
  execute_transaction: 'e7ad315beb184413',
} as const

/** klend instructions by discriminator, with the account positions the rules pin (klend SDK
 *  13.0.5 builders for klend 1.26, as payfi `solana/v2/rules.ts` POS). */
export const KLEND: Record<
  string,
  {
    name: string
    kind:
      | 'deposit'
      | 'borrow'
      | 'repay'
      | 'withdraw'
      | 'liquidate'
      | 'refresh'
      | 'init'
      | 'mark'
      | 'v1'
    /** Positions that must be pinned, and what each is. */
    pins?: [number, string][]
    /** The position whose key is where the funds arrive. */
    destination?: number
  }
> = {
  d8e0bf1bcc9766af: {
    name: 'deposit_reserve_liquidity_and_obligation_collateral_v2',
    kind: 'deposit',
    pins: [
      [4, 'reserve'],
      [9, 'source token account'],
    ],
  },
  a1808ff5abc7c206: {
    name: 'borrow_obligation_liquidity_v2',
    kind: 'borrow',
    pins: [
      [4, 'reserve'],
      [8, 'destination token account'],
    ],
    destination: 8,
  },
  '74aed54cb435d290': {
    name: 'repay_obligation_liquidity_v2',
    kind: 'repay',
    pins: [
      [3, 'reserve'],
      [6, 'source token account'],
    ],
  },
  eb34779895c51407: {
    name: 'withdraw_obligation_collateral_and_redeem_reserve_collateral_v2',
    kind: 'withdraw',
    pins: [
      [4, 'reserve'],
      [9, 'destination token account'],
    ],
    destination: 9,
  },
  a2a1238f1ebbb967: {
    name: 'liquidate_obligation_and_redeem_reserve_collateral_v2',
    kind: 'liquidate',
    pins: [
      [2, 'market'],
      [15, 'destination token account'],
    ],
    destination: 15,
  },
  '02da8aeb4fc91966': { name: 'refresh_reserve', kind: 'refresh' },
  '218493e497c04859': { name: 'refresh_obligation', kind: 'refresh' },
  fb0ae74c1b0b9f60: { name: 'init_obligation', kind: 'init' },
  '75a9b045c5170fa2': { name: 'init_user_metadata', kind: 'init' },
  a423b6130074f37f: { name: 'mark_obligation_for_deleveraging', kind: 'mark' },
  '81c70402de271a2e': {
    name: 'deposit_reserve_liquidity_and_obligation_collateral (v1)',
    kind: 'v1',
  },
  '797f12cc49f5e141': { name: 'borrow_obligation_liquidity (v1)', kind: 'v1' },
  '91b20de14cf09348': { name: 'repay_obligation_liquidity (v1)', kind: 'v1' },
  '4b5d5ddc2296dac4': {
    name: 'withdraw_obligation_collateral_and_redeem_reserve_collateral (v1)',
    kind: 'v1',
  },
  b1479abce2854a37: {
    name: 'liquidate_obligation_and_redeem_reserve_collateral (v1)',
    kind: 'v1',
  },
}
/** Scope's `refresh_price_list`. */
const SCOPE_REFRESH = '53bacf83cbfec682'

/** klend 1.26 Obligation fields a rule reads (state/obligation.rs at e921c64; account data with
 *  its 8-byte discriminator). `has_debt` u8; `owner` Pubkey (8 + tag 8 + LastUpdate 16 + market
 *  32); the margin-call start u64, non-zero exactly while the obligation is marked. */
export const OBLIGATION = { hasDebt: 2287, owner: 64, markedAt: 2336 } as const

/** SPL Token / Token-2022 instructions by tag: the ones a rule may pin, with the destination's
 *  position; any other tag is one the design never pins. */
export const TOKEN_IX: Record<number, { name: string; destination?: number }> = {
  3: { name: 'Transfer', destination: 1 },
  12: { name: 'TransferChecked', destination: 2 },
  7: { name: 'MintTo', destination: 1 },
  14: { name: 'MintToChecked', destination: 1 },
  8: { name: 'Burn' },
  15: { name: 'BurnChecked' },
}
const TOKEN_OTHER: Record<number, string> = {
  4: 'Approve',
  13: 'ApproveChecked',
  5: 'Revoke',
  6: 'SetAuthority',
  9: 'CloseAccount',
  10: 'FreezeAccount',
  11: 'ThawAccount',
}

// ---- the Squads types, decoded (state/settings_transaction.rs, policies/) ----

export interface Signer {
  key: string
  /** Initiate 1, Vote 2, Execute 4 (state/settings.rs:735-738). */
  permissions: number
}
export type DataValue =
  | { type: 'U8' | 'U16Le' | 'U32Le' | 'U64Le' | 'U128Le'; value: string }
  | { type: 'U8Slice'; value: string }
export interface DataConstraint {
  offset: string
  value: DataValue
  operator: (typeof OPERATORS)[number]
}
export interface AccountConstraint {
  index: number
  keys?: string[]
  data?: DataConstraint[]
  owner: string | null
}
export interface InstructionConstraint {
  programId: string
  accounts: AccountConstraint[]
  data: DataConstraint[]
}
export interface Hook {
  numExtraAccounts: number
  accounts: AccountConstraint[]
  instructionData: string
  programId: string
  passInnerInstructions: boolean
}
export type Period = 'OneTime' | 'Daily' | 'Weekly' | 'Monthly' | { customSeconds: string }
export interface Limit {
  mint: string
  start: string
  expiration: string | null
  period: Period
  maxPerPeriod: string
}
export type PolicyPayload =
  | {
      kind: 'ProgramInteraction'
      accountIndex: number
      constraints: InstructionConstraint[]
      preHook: Hook | null
      postHook: Hook | null
      limits: Limit[]
    }
  | {
      kind: 'SpendingLimit'
      mint: string
      sourceAccountIndex: number
      maxPerPeriod: string
      period: Period
      destinations: string[]
    }
  | { kind: 'SettingsChange'; allowed: string[] }
  | { kind: 'InternalFundTransfer'; sources: number[]; destinations: number[]; mints: string[] }
export type Expiration = { timestamp: string } | 'SettingsState'
export type SettingsAction =
  | { action: 'AddSigner'; signer: Signer }
  | { action: 'RemoveSigner'; signer: string }
  | { action: 'ChangeThreshold'; threshold: number }
  | { action: 'SetTimeLock'; timeLock: number }
  | {
      action: 'AddSpendingLimit'
      seed: string
      accountIndex: number
      mint: string
      amount: string
      period: string
      signers: string[]
      destinations: string[]
      expiration: string
    }
  | { action: 'RemoveSpendingLimit'; spendingLimit: string }
  | { action: 'SetArchivalAuthority'; authority: string | null }
  | {
      action: 'PolicyCreate'
      seed: string
      policy: PolicyPayload
      signers: Signer[]
      threshold: number
      timeLock: number
      start: string | null
      expiration: Expiration | null
    }
  | {
      action: 'PolicyUpdate'
      policyAccount: string
      policy: PolicyPayload
      signers: Signer[]
      threshold: number
      timeLock: number
      expiration: Expiration | null
    }
  | { action: 'PolicyRemove'; policyAccount: string }

const OPERATORS = [
  'Equals',
  'NotEquals',
  'GreaterThan',
  'GreaterThanOrEqualTo',
  'LessThan',
  'LessThanOrEqualTo',
] as const

function tagOf<T>(r: Reader, what: string, names: readonly T[]): T {
  const t = r.u8()
  const v = names[t]
  if (v === undefined) throw new DecodeError(`${what}: unknown variant ${t}`)
  return v
}

export function dataConstraint(r: Reader): DataConstraint {
  const offset = r.u64().toString()
  const t = r.u8()
  let value: DataValue
  if (t === 0) value = { type: 'U8', value: String(r.u8()) }
  else if (t === 1) value = { type: 'U16Le', value: String(r.u16()) }
  else if (t === 2) value = { type: 'U32Le', value: String(r.u32()) }
  else if (t === 3) value = { type: 'U64Le', value: r.u64().toString() }
  else if (t === 4) value = { type: 'U128Le', value: r.u128().toString() }
  else if (t === 5) value = { type: 'U8Slice', value: hex(r.blob()) }
  else throw new DecodeError(`a data value: unknown variant ${t}`)
  return { offset, value, operator: tagOf(r, 'a data operator', OPERATORS) }
}

export function accountConstraint(r: Reader): AccountConstraint {
  const index = r.u8()
  const t = r.u8()
  const c: AccountConstraint =
    t === 0
      ? { index, keys: r.vec(() => r.key(), 32), owner: null }
      : t === 1
        ? { index, data: r.vec(() => dataConstraint(r), 10), owner: null }
        : (() => {
            throw new DecodeError(`an account constraint: unknown variant ${t}`)
          })()
  c.owner = r.option(() => r.key())
  return c
}

export function hook(r: Reader): Hook {
  return {
    numExtraAccounts: r.u8(),
    accounts: r.vec(() => accountConstraint(r), 3),
    instructionData: hex(r.blob()),
    programId: r.key(),
    passInnerInstructions: r.bool(),
  }
}

export function periodV2(r: Reader): Period {
  const t = r.u8()
  if (t === 4) return { customSeconds: r.i64().toString() }
  const v = (['OneTime', 'Daily', 'Weekly', 'Monthly'] as const)[t]
  if (v === undefined) throw new DecodeError(`a period: unknown variant ${t}`)
  return v
}

/** One `AllowedSettingsChange` (implementations/settings_change.rs), as words. */
export function allowedChange(r: Reader): string {
  const a = r.u8()
  if (a === 0) {
    const who = r.option(() => r.key())
    const perms = r.option(() => r.u8())
    return `add ${who ?? 'any signer'}${perms === null ? ' with any permissions' : ` with permissions ${perms}`}`
  }
  if (a === 1) return `remove ${r.option(() => r.key()) ?? 'any signer'}`
  if (a === 2) return 'change the threshold to any value'
  if (a === 3) {
    const v = r.option(() => r.u32())
    return `change the time lock to ${v === null ? 'any value' : `${v} s`}`
  }
  throw new DecodeError(`an allowed settings change: unknown variant ${a}`)
}

export function policyPayload(r: Reader): PolicyPayload {
  const t = r.u8()
  if (t === 0)
    return {
      kind: 'InternalFundTransfer',
      sources: [...r.blob()],
      destinations: [...r.blob()],
      mints: r.vec(() => r.key(), 32),
    }
  if (t === 1) {
    const mint = r.key()
    const sourceAccountIndex = r.u8()
    r.i64() // start
    r.option(() => r.i64()) // expiration
    const period = periodV2(r)
    r.bool() // accumulate_unused
    const maxPerPeriod = r.u64().toString()
    r.u64() // max_per_use
    r.bool() // enforce_exact_quantity
    r.option(() => [r.u64(), r.i64()]) // usage_state
    return {
      kind: 'SpendingLimit',
      mint,
      sourceAccountIndex,
      maxPerPeriod,
      period,
      destinations: r.vec(() => r.key(), 32),
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
      limits: r.vec(() => {
        const mint = r.key()
        const start = r.i64().toString()
        const expiration = r.option(() => r.i64().toString())
        const period = periodV2(r)
        return { mint, start, expiration, period, maxPerPeriod: r.u64().toString() }
      }, 50),
    }
  throw new DecodeError(`a policy payload: unknown variant ${t}`)
}

export const signer = (r: Reader): Signer => ({ key: r.key(), permissions: r.u8() })
function expiration(r: Reader): Expiration | null {
  return r.option(() => {
    const t = r.u8()
    if (t === 0) return { timestamp: r.i64().toString() }
    if (t === 1) return 'SettingsState' as const
    throw new DecodeError(`a policy expiration: unknown variant ${t}`)
  })
}

export function settingsAction(r: Reader): SettingsAction {
  const t = r.u8()
  switch (t) {
    case 0:
      return { action: 'AddSigner', signer: signer(r) }
    case 1:
      return { action: 'RemoveSigner', signer: r.key() }
    case 2:
      return { action: 'ChangeThreshold', threshold: r.u16() }
    case 3:
      return { action: 'SetTimeLock', timeLock: r.u32() }
    case 4:
      return {
        action: 'AddSpendingLimit',
        seed: r.key(),
        accountIndex: r.u8(),
        mint: r.key(),
        amount: r.u64().toString(),
        period: tagOf(r, 'a period', ['OneTime', 'Day', 'Week', 'Month'] as const),
        signers: r.vec(() => r.key(), 32),
        destinations: r.vec(() => r.key(), 32),
        expiration: r.i64().toString(),
      }
    case 5:
      return { action: 'RemoveSpendingLimit', spendingLimit: r.key() }
    case 6:
      return { action: 'SetArchivalAuthority', authority: r.option(() => r.key()) }
    case 7:
      return {
        action: 'PolicyCreate',
        seed: r.u64().toString(),
        policy: policyPayload(r),
        signers: r.vec(() => signer(r), 33),
        threshold: r.u16(),
        timeLock: r.u32(),
        start: r.option(() => r.i64().toString()),
        expiration: expiration(r),
      }
    case 8: {
      const policyAccount = r.key()
      const signers = r.vec(() => signer(r), 33)
      const threshold = r.u16()
      const timeLock = r.u32()
      return {
        action: 'PolicyUpdate',
        policyAccount,
        signers,
        threshold,
        timeLock,
        policy: policyPayload(r),
        expiration: expiration(r),
      }
    }
    case 9:
      return { action: 'PolicyRemove', policyAccount: r.key() }
    default:
      throw new DecodeError(`a settings action: unknown variant ${t}`)
  }
}

// ---- the transaction ----

/** An account of the message: a static key, or a lookup-table entry the bytes do not resolve. */
const lut = (table: string, i: number) => `lookup table ${table} #${i}`
export const isLut = (k: string) => k.startsWith('lookup table ')

interface Ix {
  program: string
  accounts: string[]
  data: Uint8Array
}
interface Message {
  version: 'legacy' | 0
  requiredSignatures: number
  keys: string[]
  blockhash: string
  instructions: Ix[]
}

function message(r: Reader): Message {
  const first = r.u8()
  const version = first & 0x80 ? first & 0x7f : 'legacy'
  if (version !== 'legacy' && version !== 0)
    throw new DecodeError(`message version ${version} is not one Solana defines`)
  const requiredSignatures = version === 'legacy' ? first : r.u8()
  r.u8() // read-only signed
  r.u8() // read-only unsigned
  const statics = Array.from({ length: r.compact() }, () => r.key())
  const blockhash = r.key()
  const raw = Array.from({ length: r.compact() }, () => ({
    program: r.u8(),
    accounts: [...r.bytes(r.compact())],
    data: r.bytes(r.compact()),
  }))
  const writable: string[] = []
  const readonly: string[] = []
  if (version === 0)
    for (let n = r.compact(); n > 0; n--) {
      const table = r.key()
      for (const i of r.bytes(r.compact())) writable.push(lut(table, i))
      for (const i of r.bytes(r.compact())) readonly.push(lut(table, i))
    }
  r.end()
  if (requiredSignatures === 0 || requiredSignatures > statics.length)
    throw new DecodeError('the message header names no fee payer')
  const keys = [...statics, ...writable, ...readonly]
  const at = (i: number) => {
    const k = keys[i]
    if (k === undefined) throw new DecodeError(`account index ${i} is out of range`)
    return k
  }
  return {
    version,
    requiredSignatures,
    keys,
    blockhash,
    instructions: raw.map((x) => ({
      program: at(x.program),
      accounts: x.accounts.map(at),
      data: x.data,
    })),
  }
}

// ---- inner instructions of an execution ----

interface Inner {
  program: string
  accounts: string[]
  data: Uint8Array
  /** A nested Squads execution (a Prime band calling a custody rule), decoded. */
  nested?: Execution
}
export interface Execution {
  consensusAccount: string
  accountIndex: number
  signers: string[]
  payload:
    | 'settings-level'
    | 'ProgramInteraction'
    | 'SpendingLimit'
    | 'SettingsChange'
    | 'InternalFundTransfer'
  constraintIndices: number[] | null
  instructions: Inner[]
  /** What a SpendingLimit, SettingsChange or InternalFundTransfer execution asks of its rule. */
  asks?: string[]
}

/** A `SmallVec<u8, CompiledInstruction>` whose indexes point into `accounts`. */
function compiled(bytes: Uint8Array, accounts: string[], depth: number): Inner[] {
  const r = new Reader(bytes, 'the inner instructions')
  const out: Inner[] = []
  for (let n = r.u8(); n > 0; n--) {
    const at = (i: number) => {
      const k = accounts[i]
      if (k === undefined) throw new DecodeError(`inner account index ${i} is out of range`)
      return k
    }
    const program = at(r.u8())
    const accs = [...r.bytes(r.u8())].map(at)
    const data = r.bytes(r.u16())
    const inner: Inner = { program, accounts: accs, data }
    if (
      program === PROGRAM.smartAccount &&
      hex(data.subarray(0, 8)) === SQUADS_DISC.execute_transaction_sync_v2 &&
      depth < 2
    )
      inner.nested = execution(accs, data, depth + 1)
    out.push(inner)
  }
  r.end()
  return out
}

/** `execute_transaction_sync_v2`: accounts [consensus, program, signers..., inner accounts...]
 *  (transaction_execute_sync.rs:38-52); a rule with a hook puts its accounts before the inner ones,
 *  and this design's rules carry none. */
function execution(keys: string[], data: Uint8Array, depth = 0): Execution {
  const r = new Reader(data.subarray(8), 'execute_transaction_sync_v2')
  const accountIndex = r.u8()
  const numSigners = r.u8()
  const consensusAccount = keys[0] ?? ''
  const signers = keys.slice(2, 2 + numSigners)
  if (signers.length !== numSigners) throw new DecodeError('it names more signers than accounts')
  const accounts = keys.slice(2 + numSigners)
  const kind = r.u8()
  let e: Execution
  if (kind === 0) {
    e = {
      consensusAccount,
      accountIndex,
      signers,
      payload: 'settings-level',
      constraintIndices: null,
      instructions: compiled(r.blob(), accounts, depth),
    }
  } else if (kind === 1) {
    const p = r.u8()
    if (p === 1) {
      const indices = r.option(() => [...r.blob()])
      const t = r.u8()
      if (t !== 1)
        throw new DecodeError(
          'a rule execution that carries a stored transaction, not a synchronous one'
        )
      const inner = r.u8()
      if (inner !== accountIndex) throw new DecodeError('the execution names two vaults')
      e = {
        consensusAccount,
        accountIndex,
        signers,
        payload: 'ProgramInteraction',
        constraintIndices: indices,
        instructions: compiled(r.blob(), accounts, depth),
      }
    } else {
      // An execution under a rule whose kind and limits are on chain, not in these bytes
      // (payloads.rs:37-42): what it asks is shown.
      let payload: Execution['payload']
      let asks: string[]
      if (p === 0) {
        payload = 'InternalFundTransfer'
        const from = r.u8()
        const to = r.u8()
        const mint = r.key()
        const decimals = r.u8()
        asks = [
          `move ${r.u64()} (decimals ${decimals}) of mint ${mint} from vault ${from} to vault ${to}`,
        ]
      } else if (p === 2) {
        payload = 'SpendingLimit'
        const amount = r.u64()
        const destination = r.key()
        asks = [`pay ${amount} (decimals ${r.u8()}) to ${destination}`]
      } else if (p === 3) {
        payload = 'SettingsChange'
        r.blob() // action indices
        asks = r.vec(() => {
          const t = r.u8()
          if (t === 0) {
            const s = signer(r)
            return `add owner ${s.key} (permissions ${s.permissions})`
          }
          if (t === 1) return `remove owner ${r.key()}`
          if (t === 2) return `set the threshold to ${r.u16()}`
          if (t === 3) return `set the time lock to ${r.u32()} s`
          throw new DecodeError(`a settings change: unknown variant ${t}`)
        })
      } else throw new DecodeError(`a policy payload: unknown variant ${p}`)
      e = {
        consensusAccount,
        accountIndex,
        signers,
        payload,
        constraintIndices: null,
        instructions: [],
        asks,
      }
    }
  } else throw new DecodeError(`a sync payload: unknown variant ${kind}`)
  r.end()
  return e
}

// ---- the review ----

export type SolanaRole = 'custody' | 'prime'

export interface SolanaReview {
  role: SolanaRole
  /** The Squads account the transaction acts on: the settings account, or a rule's policy account. */
  account: string
  feePayer: string
  recentBlockhash: string
  /** The keys the transaction needs signatures from, and how many of those slots are filled. */
  signers: string[]
  signatures: { required: number; filled: number }
  /** The Squads instruction it makes. */
  instruction: string
  /** The account's owners the instruction names as signing (synchronous consensus). */
  owners: string[]
  actions?: SettingsAction[]
  execution?: Execution
  problems: string[]
  warnings: string[]
  signable: boolean
  review: string[]
  reviewTree: Node[]
}

const notOurs = (why: string) =>
  new Refusal('INVALID_INPUT', `not a Squads Smart Account transaction this review reads: ${why}`)

export const short = (k: string, raw?: boolean) =>
  raw || isLut(k) || k.length < 16 ? k : `${k.slice(0, 6)}…${k.slice(-6)}`

/** Decode the bytes: a whole transaction (signature slots first) or its message alone. */
function parse(i: { transaction?: string | undefined; message?: string | undefined }) {
  const b64 = i.transaction ?? i.message ?? ''
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== b64.replace(/\s/g, ''))
    throw new Refusal('INVALID_INPUT', 'the bytes are not base64')
  try {
    const r = new Reader(bytes, i.transaction !== undefined ? 'the transaction' : 'the message')
    let slots: Uint8Array[] = []
    if (i.transaction !== undefined) slots = Array.from({ length: r.compact() }, () => r.bytes(64))
    const m = message(r)
    if (i.transaction !== undefined && slots.length !== m.requiredSignatures)
      throw new DecodeError(
        `it carries ${slots.length} signature slot(s) for ${m.requiredSignatures} required signature(s)`
      )
    return { m, filled: slots.filter((s) => s.some((x) => x !== 0)).length }
  } catch (e) {
    throw new Refusal('INVALID_INPUT', `the bytes are not a Solana transaction: ${messageOf(e)}`)
  }
}

/** Review an unsigned Squads Smart Account transaction from its bytes alone. */
/** What an on-chain read sees of the review in progress (`readSolanaChain` supplies it). */
export interface SolanaContext {
  i: SolanaInput
  account: string
  /** The Squads instruction, by name. */
  instruction: string
  owners: string[]
  actions: SettingsAction[] | undefined
  execution: Execution | undefined
  flag: (p: string) => void
  warn: (w: string) => void
  tag: (k: string) => string
  name: (k: string) => string
  /** Name an address for the review (a vault, a live rule), unless it already has a name. */
  label: (k: string, n: string) => void
}

export type SolanaInput = Parameters<typeof reviewSolana>[0]

export function reviewSolana(
  i: {
    transaction?: string | undefined
    message?: string | undefined
    role: SolanaRole
    /** The Squads account the owner means to act on (settings, or a rule's policy account). */
    account?: string | undefined
    /** The only keys a pinned destination may be: custody's token accounts, the recovery address,
     *  for a band the custody rules. Without it each pin is shown for the owner to read. */
    destinations?: string[] | undefined
    /** The only keys a rule may list as its signers (for custody: the Prime vaults). */
    signers?: string[] | undefined
    /** Every collateral withdraw must carry the `has_debt == 0` read, borrow or not. */
    requireNoDebt?: boolean | undefined
    /** The least settings time lock (seconds) the account must keep. */
    minTimeLock?: number | undefined
    /** The vault custody's funds and position sit in (default 0): every custody rule acts for it. */
    vaultIndex?: number | undefined
    raw?: boolean | undefined
    /** With `readChain`: the klend market every reserve must belong to. */
    market?: string | undefined
  },
  onChain?: (c: SolanaContext) => Node | null
): SolanaReview {
  const { m, filled } = parse(i)
  const problems: string[] = []
  const warnings: string[] = []
  const flag = (p: string) => problems.push(p)
  const warn = (w: string) => warnings.push(w)
  const name = (k: string) => {
    const known = PROGRAM_NAME[k]
    return known ? `${known} (${short(k, i.raw)})` : short(k, i.raw)
  }
  const feePayer = m.keys[0] as string
  const signers = m.keys.slice(0, m.requiredSignatures)
  if (filled > 0)
    flag(
      `it already carries ${filled} signature(s): this is a review of unsigned bytes, and a signed transaction can be submitted by whoever holds it`
    )

  // The one Squads instruction, and what else rides with it.
  const squads = m.instructions.filter((x) => x.program === PROGRAM.smartAccount)
  if (squads.length === 0) throw notOurs('it makes no Squads Smart Account call')
  if (squads.length > 1)
    flag(`it makes ${squads.length} Squads calls; this review reads a transaction that makes one`)
  const ix = squads[0] as Ix
  const others: Node[] = []
  m.instructions.forEach((x, n) => {
    if (x.program === PROGRAM.smartAccount) return
    const disc = hex(x.data.subarray(0, 8))
    if (n === 0 && x.program === PROGRAM.system && Buffer.from(x.data).readUInt32LE(0) === 4) {
      flag(
        'it uses a durable nonce (AdvanceNonceAccount first): once signed it stays valid until the nonce advances, with no expiry'
      )
      others.push(fact('durable nonce', short(x.accounts[0] ?? '', i.raw)))
      return
    }
    const fine =
      x.program === PROGRAM.computeBudget ||
      (x.program === PROGRAM.scope && disc === SCOPE_REFRESH) ||
      (x.program === PROGRAM.klend && KLEND[disc]?.kind === 'refresh')
    if (fine) others.push(fact('also runs', `${name(x.program)} ${KLEND[disc]?.name ?? ''}`.trim()))
    else {
      flag(
        `it also runs ${name(x.program)} (instruction ${n}), signed by the same keys: only compute-budget, Scope and klend refreshes ride beside the Squads call`
      )
      others.push(fact('also runs', `${name(x.program)}, ${x.data.length} bytes of data`))
    }
  })

  const disc = hex(ix.data.subarray(0, 8))
  const ixName =
    (Object.entries(SQUADS_DISC).find(([, d]) => d === disc)?.[0] as string | undefined) ??
    `an instruction with discriminator ${disc}`
  const account = ix.accounts[0] ?? ''
  if (isLut(account))
    flag(
      `the Squads account it acts on is loaded from a lookup table (${account}), which the bytes do not resolve`
    )
  if (i.account === undefined)
    flag(
      `no account was given, so whether ${account} is the Squads account the owner means cannot be checked`
    )
  else if (i.account !== account)
    flag(`it acts on ${account}; the account under review is ${i.account}`)

  const roles: Record<string, string> = { [feePayer]: 'fee payer' }
  if (account) roles[account] = i.role === 'custody' ? 'custody account' : 'Prime account'
  const tag = (k: string) => {
    const n = roles[k] ?? PROGRAM_NAME[k]
    return n ? `${short(k, i.raw)} [${n}]` : short(k, i.raw)
  }

  let owners: string[] = []
  let actions: SettingsAction[] | undefined
  let exec: Execution | undefined
  const body: Node[] = []
  try {
    if (
      disc === SQUADS_DISC.execute_settings_transaction_sync ||
      disc === SQUADS_DISC.create_settings_transaction
    ) {
      const r = new Reader(ix.data.subarray(8), ixName)
      const sync = disc === SQUADS_DISC.execute_settings_transaction_sync
      const n = sync ? r.u8() : 0
      actions = r.vec(() => settingsAction(r), 1)
      const memo = r.option(() => r.string())
      r.end()
      // [consensus, rent payer|program, system|program, program, signers...] (the Squads SDK's
      // executeSettingsTransactionSync); a stored change is created by one `creator` (account 2).
      owners = sync ? ix.accounts.slice(4, 4 + n) : ix.accounts.slice(2, 3)
      if (sync && owners.length !== n) flag('it names more owners than it passes accounts')
      for (const o of owners) {
        roles[o] ??= 'owner'
        if (!signers.includes(o))
          flag(`it names ${o} as a signing owner, but the transaction asks no signature of it`)
      }
      if (memo) body.push(fact('memo', JSON.stringify(memo)))
      if (actions.length === 0) flag('it changes nothing: a settings change with no action')
      body.push(...checkActions(actions, i, flag, warn, tag))
    } else if (disc === SQUADS_DISC.execute_transaction_sync_v2) {
      exec = execution(ix.accounts, ix.data)
      owners = exec.signers
      for (const o of owners) {
        roles[o] ??= 'rule signer'
        if (!signers.includes(o))
          flag(
            `it names ${o} as a signer of the execution, but the transaction asks no signature of it`
          )
      }
      body.push(...checkExecution(exec, i, flag, warn, tag, name))
    } else {
      flag(
        disc === SQUADS_DISC.approve_proposal || disc === SQUADS_DISC.execute_settings_transaction
          ? `it calls ${ixName} on a stored proposal: what the proposal does is on chain, not in these bytes; review the create_settings_transaction that made it`
          : `it calls ${ixName}; this review reads execute_settings_transaction_sync, create_settings_transaction and execute_transaction_sync_v2`
      )
    }
  } catch (e) {
    flag(`its ${ixName} arguments do not decode: ${messageOf(e)}`)
  }

  // The chain, when a reader supplies it: what the bytes meet on the account as it stands.
  const chainNode = onChain
    ? onChain({
        i,
        account,
        instruction: ixName,
        owners,
        actions,
        execution: exec,
        flag,
        warn,
        tag,
        name,
        label: (k, n) => {
          roles[k] ??= n
        },
      })
    : null

  const head = group('Transaction', 'transaction', [
    fact(
      'fee payer',
      `${tag(feePayer)} (its signature reaches every inner call: it must hold nothing)`
    ),
    fact('signed by', signers.map(tag).join(', ')),
    fact('signatures', `${filled} of ${m.requiredSignatures} filled`),
    fact('recent blockhash', m.blockhash),
    fact('message', m.version === 'legacy' ? 'legacy' : 'v0'),
    ...others,
    fact('calls', `${name(PROGRAM.smartAccount)} ${ixName}`),
    fact('on', tag(account)),
    ...(owners.length ? [fact('owners signing', owners.map(tag).join(', '))] : []),
  ])
  const reviewTree = [
    ...(problems.length
      ? [
          group(
            `Do not sign: ${problems.length} problem(s)`,
            'problems',
            problems.map((p) => fact('problem', p))
          ),
        ]
      : []),
    ...(warnings.length ? [warned(warnings)] : []),
    head,
    ...(chainNode ? [chainNode] : []),
    ...body,
  ]
  return {
    role: i.role,
    account,
    feePayer,
    recentBlockhash: m.blockhash,
    signers,
    signatures: { required: m.requiredSignatures, filled },
    instruction: ixName,
    owners,
    ...(actions ? { actions } : {}),
    ...(exec ? { execution: exec } : {}),
    problems,
    warnings,
    signable: problems.length === 0,
    review: lines(reviewTree),
    reviewTree,
  }
}

// ---- the checks on a settings change ----

export const PERMS = (p: number) =>
  [p & 1 ? 'initiate' : '', p & 2 ? 'vote' : '', p & 4 ? 'execute' : '']
    .filter(Boolean)
    .join('+') || 'none'
export const periodName = (p: Period) => (typeof p === 'string' ? p : `every ${p.customSeconds} s`)
/** A pin on the first `len` bytes of the data (a longer slice from offset 0 pins them too). */
const isDisc = (d: DataConstraint, len: number) =>
  d.offset === '0' &&
  d.operator === 'Equals' &&
  ((d.value.type === 'U8Slice' && d.value.value.length >= len * 2) ||
    (len === 1 && d.value.type === 'U8'))
/** The pinned discriminator (8 bytes) or token tag (1 byte), as hex. */
export const discOf = (c: InstructionConstraint, len: number) => {
  const d = c.data.find((x) => isDisc(x, len))
  if (!d) return undefined
  return d.value.type === 'U8'
    ? Number(d.value.value).toString(16).padStart(2, '0')
    : d.value.value.slice(0, len * 2)
}

export function describeData(d: DataConstraint): string {
  const op = {
    Equals: '=',
    NotEquals: '≠',
    GreaterThan: '>',
    GreaterThanOrEqualTo: '≥',
    LessThan: '<',
    LessThanOrEqualTo: '≤',
  }[d.operator]
  return `${d.value.type} @${d.offset} ${op} ${d.value.type === 'U8Slice' ? `0x${d.value.value}` : d.value.value}`
}

/** The pins a constraint holds on one account position. */
export function pinsAt(c: InstructionConstraint, index: number) {
  const at = c.accounts.filter((a) => a.index === index)
  const keys = at.flatMap((a) => a.keys ?? [])
  const data = at.flatMap((a) => (a.data ?? []).map((d) => ({ d, owner: a.owner })))
  return { keys, data, pinned: at.some((a) => a.keys !== undefined && a.keys.length > 0) }
}
export const reads = (
  c: InstructionConstraint,
  index: number,
  offset: number,
  ok: (d: DataConstraint) => boolean
) => pinsAt(c, index).data.filter(({ d }) => d.offset === String(offset) && ok(d))

function checkActions(
  actions: SettingsAction[],
  i: Parameters<typeof reviewSolana>[0],
  flag: (p: string) => void,
  warn: (w: string) => void,
  tag: (k: string) => string
): Node[] {
  const custody = i.role === 'custody'
  // A borrow anywhere in the change means a position that can owe: every collateral withdraw then
  // needs the has_debt read (payfi rules.ts, R2 and R2b).
  const borrows = actions.some(
    (a) =>
      (a.action === 'PolicyCreate' || a.action === 'PolicyUpdate') &&
      a.policy.kind === 'ProgramInteraction' &&
      a.policy.constraints.some(
        (c) => c.programId === PROGRAM.klend && KLEND[discOf(c, 8) ?? '']?.kind === 'borrow'
      )
  )
  const noDebt = i.requireNoDebt === true || borrows
  return actions.map((a, n) => {
    const where = `action ${n + 1} (${a.action})`
    switch (a.action) {
      case 'AddSigner':
        if (custody)
          warn(
            `${where} adds ${a.signer.key} to custody's owners: the threshold must still equal the number of owners, or one party can be left out`
          )
        return group(`Adds owner`, 'action', [
          fact('owner', tag(a.signer.key)),
          fact('permissions', PERMS(a.signer.permissions)),
        ])
      case 'RemoveSigner':
        if (custody)
          warn(
            `${where} removes ${a.signer} from custody's owners: check the threshold still needs every one`
          )
        return group('Removes owner', 'action', [fact('owner', tag(a.signer))])
      case 'ChangeThreshold': {
        const least = custody ? 3 : 2
        if (a.threshold < least)
          flag(
            `${where} sets the threshold to ${a.threshold}: the ${custody ? 'custody account is 3 of 3, so no setting changes without the trustee' : 'Prime account is 2 of 3, so no owner acts alone'}`
          )
        return group('Changes the threshold', 'action', [fact('threshold', String(a.threshold))])
      }
      case 'SetTimeLock':
        if (i.minTimeLock !== undefined && a.timeLock < i.minTimeLock)
          flag(
            `${where} sets the settings time lock to ${a.timeLock} s, below the ${i.minTimeLock} s this account keeps: the owners' full-power path would run sooner than it can be seen`
          )
        else if (a.timeLock === 0)
          warn(
            `${where} drops the settings time lock to 0: the owners' full-power path runs at once`
          )
        return group('Sets the settings time lock', 'action', [
          fact('time lock', `${a.timeLock} s`),
        ])
      case 'AddSpendingLimit':
        flag(
          a.destinations.length === 0
            ? `${where} adds a spending limit with no destinations: it pays any address (E-04)`
            : `${where} adds a legacy spending limit, a payment path the design never makes: funds move only through pinned rules`
        )
        return group('Adds a legacy spending limit', 'action', [
          fact('vault', String(a.accountIndex)),
          fact('mint', tag(a.mint)),
          fact('amount', `${a.amount} per ${a.period}`),
          fact('signers', a.signers.map(tag).join(', ') || 'none'),
          fact('destinations', a.destinations.map(tag).join(', ') || 'ANY address'),
        ])
      case 'RemoveSpendingLimit':
        return group('Removes a legacy spending limit', 'action', [
          fact('account', tag(a.spendingLimit)),
        ])
      case 'SetArchivalAuthority':
        if (a.authority)
          warn(
            `${where} names ${a.authority} as the archival authority, a key outside the owners' vote`
          )
        return group('Sets the archival authority', 'action', [
          fact('authority', a.authority ? tag(a.authority) : 'none'),
        ])
      case 'PolicyRemove':
        return group('Removes rule', 'action', [fact('rule', tag(a.policyAccount))])
      default:
        return checkPolicy(a, where, i, noDebt, flag, warn, tag)
    }
  })
}

export function checkPolicy(
  a: Extract<SettingsAction, { action: 'PolicyCreate' | 'PolicyUpdate' }>,
  where: string,
  i: Parameters<typeof reviewSolana>[0],
  noDebt: boolean,
  flag: (p: string) => void,
  warn: (w: string) => void,
  tag: (k: string) => string
): Node {
  const custody = i.role === 'custody'
  const p = a.policy
  const head: Node[] = [
    a.action === 'PolicyCreate'
      ? fact('rule', `seed ${a.seed} (a new policy account)`)
      : fact('rule', tag(a.policyAccount)),
    fact('kind', p.kind),
    fact(
      'signers',
      a.signers.map((s) => `${tag(s.key)} (${PERMS(s.permissions)})`).join(', ') || 'none'
    ),
    fact(
      'who can act',
      a.threshold === 1
        ? `any ONE signer alone`
        : `any ${a.threshold} of the ${a.signers.length} signers together`
    ),
    fact('time lock', `${a.timeLock} s`),
    ...(a.action === 'PolicyCreate' && a.start ? [fact('starts', a.start)] : []),
    fact(
      'expires',
      a.expiration === null
        ? 'never'
        : a.expiration === 'SettingsState'
          ? "when the account's settings change"
          : `at ${a.expiration.timestamp}`
    ),
  ]
  if (a.signers.length === 0) flag(`${where}: the rule has no signer`)
  if (a.threshold < 1 || a.threshold > a.signers.length)
    flag(
      `${where}: threshold ${a.threshold} of ${a.signers.length} signer(s) is not one a rule can hold`
    )
  if (new Set(a.signers.map((s) => s.key)).size !== a.signers.length)
    flag(`${where}: a signer is listed twice`)
  if (i.signers)
    for (const s of a.signers)
      if (!i.signers.includes(s.key))
        flag(`${where}: signer ${s.key} is not one of the keys this account's rules may list`)
  if (a.expiration === null && p.kind === 'ProgramInteraction')
    warn(
      a.action === 'PolicyUpdate'
        ? `${where}: the edit sets no expiry, so any expiry the rule had is removed (an update replaces signers, threshold, time lock, constraints and expiry)`
        : `${where}: the rule never expires; set an expiry so an approval lapses (S-04)`
    )

  if (p.kind === 'SettingsChange') {
    flag(
      custody
        ? `${where} adds a SettingsChange policy to the custody account: its signers could change custody's owners, threshold or time lock without the full 3 of 3, the trustee included (E-03)`
        : `${where} adds a SettingsChange policy: its signers could change the account's owners, threshold or time lock below the owners' threshold, a shape the design never makes`
    )
    return group(`${a.action === 'PolicyCreate' ? 'Adds' : 'Edits'} rule: SettingsChange`, 'rule', [
      ...head,
      fact('lets its signers', p.allowed.join('; ') || 'nothing'),
    ])
  }
  if (p.kind === 'SpendingLimit') {
    flag(
      p.destinations.length === 0
        ? `${where} adds a SpendingLimit policy with no destinations: it pays any address (E-04)`
        : `${where} adds a SpendingLimit policy, a payment path the design never makes: funds move only through ProgramInteraction rules with pinned calls`
    )
    return group(`${a.action === 'PolicyCreate' ? 'Adds' : 'Edits'} rule: SpendingLimit`, 'rule', [
      ...head,
      fact('pays from', `vault ${p.sourceAccountIndex}`),
      fact('mint', tag(p.mint)),
      fact('up to', `${p.maxPerPeriod} per ${periodName(p.period)}`),
      fact('to', p.destinations.map(tag).join(', ') || 'ANY address'),
    ])
  }
  if (p.kind === 'InternalFundTransfer') {
    flag(`${where} adds an InternalFundTransfer policy, a shape the design never makes`)
    return group(
      `${a.action === 'PolicyCreate' ? 'Adds' : 'Edits'} rule: InternalFundTransfer`,
      'rule',
      [
        ...head,
        fact('from vaults', p.sources.join(', ')),
        fact('to vaults', p.destinations.join(', ')),
        fact('mints', p.mints.map(tag).join(', ') || 'any'),
      ]
    )
  }

  // ProgramInteraction: the rule that pins calls.
  if (custody && a.timeLock > 0)
    warn(`${where}: a custody rule with a time lock cannot run synchronously from a Prime band`)
  const vault = i.vaultIndex ?? 0
  if (custody && p.accountIndex !== vault)
    flag(
      `${where}: the rule acts for vault ${p.accountIndex}, but custody's funds and position sit in vault ${vault}: it would sign for another vault`
    )
  const kinds = new Set(
    p.constraints.map((c) =>
      c.programId === PROGRAM.klend ? KLEND[discOf(c, 8) ?? '']?.kind : undefined
    )
  )
  if (kinds.has('borrow') && (kinds.has('withdraw') || kinds.has('liquidate')))
    flag(
      `${where}: one rule admits both a borrow and a collateral withdraw or seize; Squads reads every constraint before any inner instruction runs (program_interaction.rs:1071-1114), so a has_debt == 0 or marked read cannot stop both in one execution: give them separate rules`
    )
  if (p.limits.length > 0)
    warn(
      `${where}: its spending limits count the NET decrease of each tracked token account over the batch (account_tracking.rs), so an inflow in the same batch offsets an outflow; there is no per-use ceiling`
    )
  if (a.action === 'PolicyUpdate' && p.limits.length > 0)
    warn(
      `${where}: editing a rule refills each of its spending limits to a full period (program_interaction.rs:638-654), so a mid-period edit allows up to a second period's amount`
    )
  if (p.constraints.length === 0)
    flag(
      `${where}: the rule has no instruction constraints, so it admits ANY instruction its signers send as vault ${p.accountIndex} (E-02, program_interaction.rs:859)`
    )
  for (const [h, which] of [
    [p.preHook, 'pre'],
    [p.postHook, 'post'],
  ] as const)
    if (h)
      flag(
        `${where}: the rule carries a ${which}-hook calling ${h.programId}, a program that sees and can veto the execution; the design runs no hook`
      )

  const shown = p.constraints.map((c, k) =>
    checkConstraint(c, k, `${where}, constraint ${k}`, i, noDebt, flag, warn, tag)
  )
  const limits = p.limits.map((l) =>
    fact(
      'spending limit',
      `${tag(l.mint)}: ${l.maxPerPeriod} per ${periodName(l.period)}${l.expiration ? `, until ${l.expiration}` : ''}`
    )
  )
  return group(
    `${a.action === 'PolicyCreate' ? 'Adds' : 'Edits'} rule: ProgramInteraction`,
    'rule',
    [
      ...head,
      fact('acts as', `vault ${p.accountIndex}`),
      group(
        p.constraints.length
          ? `May run, each inner instruction matching one of ${p.constraints.length}`
          : 'May run ANY instruction',
        'constraints',
        shown
      ),
      ...(limits.length ? limits : [fact('spending limits', 'none (no balance is tracked)')]),
      ...(p.preHook ? [fact('pre-hook', tag(p.preHook.programId))] : []),
      ...(p.postHook ? [fact('post-hook', tag(p.postHook.programId))] : []),
    ]
  )
}

function checkConstraint(
  c: InstructionConstraint,
  k: number,
  where: string,
  i: Parameters<typeof reviewSolana>[0],
  noDebt: boolean,
  flag: (p: string) => void,
  warn: (w: string) => void,
  tag: (k: string) => string
): Node {
  const custody = i.role === 'custody'
  const facts: Node[] = []
  const program = c.programId
  let label = `${k}: ${tag(program)}`
  /** A position must be pinned to keys; a destination's keys must be on the caller's list. */
  const need = (index: number, what: string, destination: boolean) => {
    const { keys, pinned } = pinsAt(c, index)
    if (!pinned) {
      flag(`${where}: the ${what} (account ${index}) is not pinned, so any account passes there`)
      return
    }
    if (destination && i.destinations)
      for (const x of keys)
        if (!i.destinations.includes(x))
          flag(
            `${where}: the ${what} (account ${index}) may be ${x}, which is not one of the given destinations`
          )
  }

  const allowed = custody
    ? program === PROGRAM.klend || TOKENS.has(program)
    : program === PROGRAM.smartAccount
  if (!allowed)
    flag(
      `${where} pins ${PROGRAM_NAME[program] ?? program}${LOADERS.has(program) ? ' (a loader: it could change a program)' : ''}${program === PROGRAM.smartAccount ? ' (the Smart Account itself: a rule could reach its own account)' : ''}, a program the ${custody ? 'custody' : 'Prime'} rules never pin (${custody ? 'klend and the token programs' : "Squads' execute_transaction_sync_v2"})`
    )

  if (program === PROGRAM.klend || program === PROGRAM.smartAccount) {
    const d = discOf(c, 8)
    if (!d)
      flag(
        `${where}: no 8-byte discriminator is pinned, so ANY instruction of ${PROGRAM_NAME[program]} passes`
      )
    else if (program === PROGRAM.smartAccount) {
      label +=
        d === SQUADS_DISC.execute_transaction_sync_v2 ? ' execute_transaction_sync_v2' : ` ${d}`
      if (d !== SQUADS_DISC.execute_transaction_sync_v2)
        flag(
          `${where}: it pins Squads instruction ${d}; a band pins only execute_transaction_sync_v2`
        )
      else need(0, 'rule it calls', true)
    } else {
      const spec = KLEND[d]
      label += ` ${spec?.name ?? d}`
      if (!spec) flag(`${where}: it pins klend instruction ${d}, one the design never pins`)
      else if (spec.kind === 'v1')
        flag(
          `${where}: it pins klend's v1 ${spec.name}, which klend refuses from a program (CpiDisabled); the design pins the _v2 instructions`
        )
      else {
        for (const [index, what] of spec.pins ?? []) need(index, what, index === spec.destination)
        if (spec.kind === 'deposit' || spec.kind === 'borrow') {
          const cap = c.data.find(
            (x) =>
              x.offset === '8' &&
              x.value.type === 'U64Le' &&
              (x.operator === 'LessThan' || x.operator === 'LessThanOrEqualTo')
          )
          if (!cap)
            warn(`${where}: the ${spec.kind} carries no per-call ceiling on its amount (U64Le @8)`)
        }
        if (spec.kind === 'repay') {
          const owned = reads(
            c,
            1,
            OBLIGATION.owner,
            (x) =>
              x.operator === 'Equals' && x.value.type === 'U8Slice' && x.value.value.length === 64
          )
          if (!pinsAt(c, 1).pinned && owned.length === 0)
            flag(
              `${where}: the repay's obligation (account 1) is not pinned, and klend binds a repay to no owner (handler_repay_obligation_liquidity.rs:115-146): a signer could pay down ANY obligation of the market with the vault's funds; pin it, or read its owner (U8Slice @${OBLIGATION.owner} = the vault, owner klend)`
            )
          for (const { owner } of owned)
            if (owner !== PROGRAM.klend)
              flag(
                `${where}: the obligation-owner read names no klend owner, so another account could answer it`
              )
        }
        if (spec.kind === 'withdraw') {
          const debt = reads(
            c,
            1,
            OBLIGATION.hasDebt,
            (x) => x.operator === 'Equals' && x.value.type === 'U8' && x.value.value === '0'
          )
          const good = debt.some(({ owner }) => owner === PROGRAM.klend)
          if (debt.length > 0 && !good)
            flag(
              `${where}: the has_debt read names no klend owner, so another account could answer it`
            )
          else if (!good && noDebt)
            flag(
              `${where}: the withdraw lacks the has_debt == 0 read (U8 @${OBLIGATION.hasDebt} = 0 on the obligation, owner klend), so collateral could leave while the position owes${i.requireNoDebt ? '' : ' (this change also permits a borrow)'}`
            )
          else if (!good)
            warn(
              `${where}: the withdraw carries no has_debt == 0 read; if this position can borrow, collateral can leave while it owes`
            )
        }
        if (spec.kind === 'liquidate') {
          const marked = reads(
            c,
            1,
            OBLIGATION.markedAt,
            (x) =>
              x.value.type === 'U64Le' &&
              x.value.value === '0' &&
              (x.operator === 'GreaterThan' || x.operator === 'NotEquals')
          )
          if (!marked.some(({ owner }) => owner === PROGRAM.klend))
            flag(
              `${where}: the liquidation lacks the marked read (U64Le @${OBLIGATION.markedAt} > 0 on the obligation, owner klend), so its signers could take collateral from any unhealthy obligation with no notice`
            )
        }
        if (spec.kind === 'mark' && !pinsAt(c, 2).pinned)
          warn(`${where}: the mark does not pin the market (account 2)`)
      }
    }
  } else if (TOKENS.has(program)) {
    const t = discOf(c, 1)
    if (t === undefined)
      flag(
        `${where}: no instruction tag is pinned, so ANY ${PROGRAM_NAME[program]} instruction passes`
      )
    else {
      const n = Number.parseInt(t.slice(0, 2), 16)
      const spec = TOKEN_IX[n]
      label += ` ${spec?.name ?? TOKEN_OTHER[n] ?? `instruction ${n}`}`
      if (!spec)
        flag(
          `${where}: it pins ${TOKEN_OTHER[n] ?? `token instruction ${n}`}, which the design never pins (a delegate, authority, closing or freeze change)`
        )
      else if (spec.destination !== undefined) need(spec.destination, 'destination', true)
    }
  }
  for (const a of c.accounts) {
    const what =
      a.keys !== undefined
        ? `must be ${a.keys.map(tag).join(' or ') || '(an empty list: nothing passes)'}`
        : `its data: ${(a.data ?? []).map(describeData).join(' and ')}`
    facts.push(fact(`account ${a.index}`, `${what}${a.owner ? `, owned by ${tag(a.owner)}` : ''}`))
  }
  for (const d of c.data) facts.push(fact('data', describeData(d)))
  return group(label, 'constraint', facts)
}

// ---- the checks on an execution ----

function checkExecution(
  e: Execution,
  i: Parameters<typeof reviewSolana>[0],
  flag: (p: string) => void,
  warn: (w: string) => void,
  tag: (k: string) => string,
  name: (k: string) => string,
  depth = 0
): Node[] {
  const where = depth ? 'the nested execution' : 'the execution'
  const facts: Node[] = [
    fact('as', `vault ${e.accountIndex} of ${tag(e.consensusAccount)}`),
    fact('signed by', e.signers.map(tag).join(', ') || 'none'),
    fact('payload', e.payload),
    ...(e.asks ?? []).map((x) => fact('asks', x)),
  ]
  if (e.payload === 'settings-level')
    warn(`${where} runs at settings level: no rule constrains it, the owners' threshold signs it`)
  if (e.payload === 'SettingsChange')
    flag(
      i.role === 'custody'
        ? `${where} changes custody's settings through a SettingsChange rule, below the 3 of 3 and without the trustee (E-03)`
        : `${where} changes the account's settings through a SettingsChange rule, a path the design never makes`
    )
  if (e.payload === 'SpendingLimit' || e.payload === 'InternalFundTransfer')
    flag(`${where} moves funds through a ${e.payload} rule, a path the design never makes`)
  if (e.constraintIndices) facts.push(fact('claims constraints', e.constraintIndices.join(', ')))
  /** Where funds arrive must be readable, and on the caller's list when one is given. */
  const arrives = (n: number, k: string) => {
    if (isLut(k))
      flag(
        `inner call ${n} pays an account loaded from a lookup table (${k}), which the bytes do not resolve`
      )
    else if (i.destinations && !i.destinations.includes(k))
      flag(`inner call ${n} pays ${k}, which is not one of the given destinations`)
  }
  const calls = e.instructions.map((x, n) => {
    const d = hex(x.data.subarray(0, 8))
    let what = name(x.program)
    if (x.program === PROGRAM.klend) {
      const spec = KLEND[d]
      what += ` ${spec?.name ?? d}`
      if (!spec || spec.kind === 'v1')
        flag(`inner call ${n} is klend ${spec?.name ?? d}, an instruction the design never makes`)
      if (
        spec &&
        ['deposit', 'borrow', 'repay', 'withdraw', 'liquidate'].includes(spec.kind) &&
        x.data.length >= 16
      )
        what += `, amount ${Buffer.from(x.data).readBigUInt64LE(8)}${spec.kind === 'withdraw' ? ' (collateral tokens)' : ''}`
      const to = spec?.destination !== undefined ? x.accounts[spec.destination] : undefined
      if (to) {
        what += `, to ${tag(to)}`
        arrives(n, to)
      }
    } else if (TOKENS.has(x.program)) {
      const t = x.data[0] ?? -1
      const spec = TOKEN_IX[t]
      what += ` ${spec?.name ?? TOKEN_OTHER[t] ?? `instruction ${t}`}`
      if (!spec)
        flag(
          `inner call ${n} is ${PROGRAM_NAME[x.program]} ${TOKEN_OTHER[t] ?? `instruction ${t}`}, which the design never makes (a delegate, authority, closing, freeze or extension change)`
        )
      if (spec && x.data.length >= 9) what += `, amount ${Buffer.from(x.data).readBigUInt64LE(1)}`
      const to = spec?.destination !== undefined ? x.accounts[spec.destination] : undefined
      if (to) {
        what += `, to ${tag(to)}`
        arrives(n, to)
      }
    } else if (x.program === PROGRAM.smartAccount) {
      what += x.nested ? ' execute_transaction_sync_v2' : ` ${d}`
      if (!x.nested || i.role !== 'prime' || depth > 0)
        flag(
          `inner call ${n} reaches the Smart Account program itself${x.nested ? ' below a rule that is not a Prime band' : ` (${d})`}: the design nests one Squads execution, from a Prime band into a custody rule`
        )
    } else if (LOADERS.has(x.program)) {
      flag(`inner call ${n} reaches ${PROGRAM_NAME[x.program]}, which can change a program`)
    } else if (x.program === PROGRAM.system && e.payload === 'settings-level') {
      flag(
        `inner call ${n} runs the System program as the vault (a SOL transfer, an assign or an allocate), which the design never makes`
      )
    }
    const kids: Node[] = [fact('accounts', x.accounts.map(tag).join(', ') || 'none')]
    if (x.nested) kids.push(...checkExecution(x.nested, i, flag, warn, tag, name, depth + 1))
    return group(`${n}: ${what}`, 'call', kids)
  })
  return [
    group(depth ? 'Nested execution' : 'Execution', 'execution', [
      ...facts,
      ...(calls.length ? [group('Calls', 'calls', calls)] : []),
    ]),
  ]
}

/** Re-exported for the tests' fixtures. */
export { base58, fromBase58 }
