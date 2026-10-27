// solana_review: the owner's pre-sign check of an unsigned Squads Smart Account transaction. The
// PayFi line's rules come from PayFi's own encoders (fixtures/solana/payfi-golden.json, the vendored
// Squads SDK over payfi `solana/v2/rules.ts`); the Prime shapes of docs/solana.md, and each footgun,
// are built here with a borsh writer that follows the Squads source at `0e51082`.

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import g from '../fixtures/solana/payfi-golden.json'
import { base58, fromBase58, keccak256 } from './bytes.ts'
import { vaultAddress } from './pda.ts'
import { KLEND, OBLIGATION, PROGRAM, reviewSolana, SQUADS_DISC } from './solana.ts'
import { run } from './tools.ts'

const K = g.keys as Record<string, string>

// ---- a borsh writer for the Squads types ----

class W {
  parts: number[] = []
  u8(v: number) {
    this.parts.push(v & 0xff)
    return this
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8)
  }
  u32(v: number) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    this.parts.push(...b)
    return this
  }
  u64(v: bigint | number) {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(v))
    this.parts.push(...b)
    return this
  }
  i64(v: bigint | number) {
    const b = Buffer.alloc(8)
    b.writeBigInt64LE(BigInt(v))
    this.parts.push(...b)
    return this
  }
  key(k: string) {
    this.parts.push(...fromBase58(k, 32))
    return this
  }
  bytes(b: Uint8Array | number[]) {
    this.parts.push(...b)
    return this
  }
  blob(b: Uint8Array | number[]) {
    return this.u32(b.length).bytes(b)
  }
  vec<T>(xs: T[], f: (x: T) => void) {
    this.u32(xs.length)
    for (const x of xs) f(x)
    return this
  }
  none() {
    return this.u8(0)
  }
  get out() {
    return Uint8Array.from(this.parts)
  }
}

const key = (n: number) =>
  base58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (n * 13 + i) & 0xff)))
const hexb = (h: string) => [...Buffer.from(h, 'hex')]
const disc = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex')

type Data = {
  offset: number
  type: 'U8' | 'U64Le' | 'U8Slice'
  value: bigint | number | string
  op: number
}
type Acc = { index: number; keys?: string[]; data?: Data[]; owner?: string }
type Ic = { program: string; accounts: Acc[]; data: Data[] }
type Hook = { program: string }
type Rule = {
  seed?: number
  update?: string
  kind?: 'PI' | 'SettingsChange' | 'SpendingLimit' | 'IFT'
  accountIndex?: number
  constraints?: Ic[]
  limits?: { mint: string; max: bigint }[]
  hook?: Hook
  signers: string[]
  threshold: number
  timeLock?: number
  expires?: number
  destinations?: string[]
}
const EQ = 0
const GT = 2
const LTE = 5

function dataC(w: W, d: Data) {
  w.u64(d.offset)
  if (d.type === 'U8') w.u8(0).u8(Number(d.value))
  else if (d.type === 'U64Le') w.u8(3).u64(BigInt(d.value))
  else w.u8(5).blob(hexb(String(d.value)))
  w.u8(d.op)
}
function accC(w: W, a: Acc) {
  w.u8(a.index)
  if (a.keys) w.u8(0).vec(a.keys, (k) => w.key(k))
  else w.u8(1).vec(a.data ?? [], (d) => dataC(w, d))
  if (a.owner) w.u8(1).key(a.owner)
  else w.none()
}
function payload(w: W, r: Rule) {
  const kind = r.kind ?? 'PI'
  if (kind === 'IFT')
    w.u8(0)
      .blob([0])
      .blob([1])
      .vec([], () => {})
  else if (kind === 'SpendingLimit') {
    w.u8(1).key(key(90)).u8(0).i64(0).none().u8(1).u8(0).u64(1000).u64(0).u8(0).none()
    w.vec(r.destinations ?? [], (k) => w.key(k))
  } else if (kind === 'SettingsChange') w.u8(2).vec([0], () => w.u8(2))
  else {
    w.u8(3).u8(r.accountIndex ?? 0)
    w.vec(r.constraints ?? [], (c) => {
      w.key(c.program)
      w.vec(c.accounts, (a) => accC(w, a))
      w.vec(c.data, (d) => dataC(w, d))
    })
    if (r.hook)
      w.u8(1)
        .u8(0)
        .vec([], () => {})
        .blob([])
        .key(r.hook.program)
        .u8(1)
    else w.none()
    w.none()
    w.vec(r.limits ?? [], (l) => w.key(l.mint).i64(0).none().u8(1).u64(l.max))
  }
}
const signerList = (w: W, keys: string[]) => w.vec(keys, (k) => w.key(k).u8(7))
const expiry = (w: W, r: Rule) => (r.expires ? w.u8(1).u8(0).i64(r.expires) : w.none())

type Action =
  | { rule: Rule }
  | { threshold: number }
  | { timeLock: number }
  | { spendingLimit: string[] }
  | { remove: string }
function action(w: W, a: Action) {
  if ('rule' in a) {
    const r = a.rule
    if (r.update) {
      w.u8(8).key(r.update)
      signerList(w, r.signers)
      w.u16(r.threshold).u32(r.timeLock ?? 0)
      payload(w, r)
      expiry(w, r)
    } else {
      w.u8(7).u64(r.seed ?? 1)
      payload(w, r)
      signerList(w, r.signers)
      w.u16(r.threshold)
        .u32(r.timeLock ?? 0)
        .none()
      expiry(w, r)
    }
  } else if ('threshold' in a) w.u8(2).u16(a.threshold)
  else if ('timeLock' in a) w.u8(3).u32(a.timeLock)
  else if ('remove' in a) w.u8(9).key(a.remove)
  else
    w.u8(4)
      .key(key(91))
      .u8(0)
      .key(key(92))
      .u64(5)
      .u8(1)
      .vec([key(93)], (k) => w.key(k))
      .vec(a.spendingLimit, (k) => w.key(k))
      .i64(0)
}

interface TxIx {
  program: string
  accounts: { key: string; signer?: boolean }[]
  data: Uint8Array
}
/** A legacy transaction: zeroed signature slots for every signer, the fee payer first. */
function tx(ixs: TxIx[], o: { payer?: string; signed?: boolean; noSlots?: boolean } = {}): string {
  const payer = o.payer ?? OWNERS[0]
  const signers = [
    payer,
    ...new Set(ixs.flatMap((x) => x.accounts.filter((a) => a.signer).map((a) => a.key))),
  ]
  const uniq = [...new Set(signers)]
  const rest = [
    ...new Set(ixs.flatMap((x) => [...x.accounts.map((a) => a.key), x.program])),
  ].filter((k) => !uniq.includes(k))
  const keys = [...uniq, ...rest]
  const w = new W()
  if (!o.noSlots) {
    w.u8(uniq.length)
    for (let n = 0; n < uniq.length; n++) w.bytes(new Array(64).fill(o.signed && n === 0 ? 7 : 0))
  }
  w.u8(uniq.length).u8(0).u8(0)
  w.u8(keys.length)
  for (const k of keys) w.key(k)
  w.key(key(99))
  w.u8(ixs.length)
  for (const x of ixs) {
    w.u8(keys.indexOf(x.program))
      .u8(x.accounts.length)
      .bytes(x.accounts.map((a) => keys.indexOf(a.key)))
    if (x.data.length > 127) w.u8((x.data.length & 0x7f) | 0x80).u8(x.data.length >> 7)
    else w.u8(x.data.length)
    w.bytes(x.data)
  }
  return Buffer.from(w.out).toString('base64')
}

const CUSTODY = key(1)
const PRIME = key(2)
const OWNERS = [key(10), key(11), key(12)]
const PRIME_VAULT = key(20)
const RECOVERY_VAULT = key(21)
const RESERVE = key(30)
const CUSTODY_TA = key(31)
const RECOVERY_TA = key(32)
const MINT = key(33)
const CUSTODY_RULE = key(40)
const STRANGER = key(66)

/** `execute_settings_transaction_sync` on `settings`, every owner signing. */
function settingsTx(
  actions: Action[],
  o: { settings?: string; payer?: string; signed?: boolean; extra?: TxIx[] } = {}
) {
  const w = new W().bytes(hexb(SQUADS_DISC.execute_settings_transaction_sync)).u8(OWNERS.length)
  w.vec(actions, (a) => action(w, a)).none()
  const settings = o.settings ?? CUSTODY
  return tx(
    [
      ...(o.extra ?? []),
      {
        program: PROGRAM.smartAccount,
        accounts: [
          { key: settings },
          { key: OWNERS[0] as string, signer: true },
          { key: PROGRAM.system },
          { key: PROGRAM.smartAccount },
          ...OWNERS.map((k) => ({ key: k, signer: true })),
        ],
        data: w.out,
      },
    ],
    o
  )
}

const discData = (name: string): Data => ({ offset: 0, type: 'U8Slice', value: disc(name), op: EQ })
const pin = (index: number, ...keys: string[]): Acc => ({ index, keys })
const hasDebtZero: Acc = {
  index: 1,
  data: [{ offset: OBLIGATION.hasDebt, type: 'U8', value: 0, op: EQ }],
  owner: PROGRAM.klend,
}
const supply = (): Ic => ({
  program: PROGRAM.klend,
  accounts: [pin(4, RESERVE), pin(9, CUSTODY_TA)],
  data: [
    discData('deposit_reserve_liquidity_and_obligation_collateral_v2'),
    { offset: 8, type: 'U64Le', value: 1_000_000n, op: LTE },
  ],
})
const withdraw = (debt = true): Ic => ({
  program: PROGRAM.klend,
  accounts: [pin(4, RESERVE), pin(9, CUSTODY_TA), ...(debt ? [hasDebtZero] : [])],
  data: [discData('withdraw_obligation_collateral_and_redeem_reserve_collateral_v2')],
})
const borrow = (): Ic => ({
  program: PROGRAM.klend,
  accounts: [pin(4, RESERVE), pin(8, CUSTODY_TA)],
  data: [
    discData('borrow_obligation_liquidity_v2'),
    { offset: 8, type: 'U64Le', value: 5n, op: LTE },
  ],
})
const recoveryTransfer = (): Ic => ({
  program: PROGRAM.token,
  accounts: [pin(0, CUSTODY_TA), pin(2, RECOVERY_TA)],
  data: [{ offset: 0, type: 'U8', value: 12, op: EQ }],
})
const custodyRule = (constraints: Ic[], over: Partial<Rule> = {}): Rule => ({
  seed: 1,
  constraints,
  limits: [{ mint: MINT, max: 10_000_000n }],
  signers: [PRIME_VAULT],
  threshold: 1,
  expires: 1_900_000_000,
  ...over,
})
/** docs/solana.md "The custody rules": supply, withdraw, recovery, each listing one Prime vault. */
const goodCustody = () => [
  { rule: custodyRule([supply()]) },
  { rule: custodyRule([withdraw()], { seed: 2, limits: [] }) },
  { rule: custodyRule([recoveryTransfer()], { seed: 3, limits: [], signers: [RECOVERY_VAULT] }) },
]
const review = (b64: string, extra: Partial<Parameters<typeof reviewSolana>[0]> = {}) =>
  reviewSolana({
    transaction: b64,
    role: 'custody',
    account: CUSTODY,
    destinations: [CUSTODY_TA, RECOVERY_TA],
    ...extra,
  })
function caught(r: ReturnType<typeof reviewSolana>, re: RegExp) {
  expect(r.signable).toBe(false)
  expect(r.problems.some((p) => re.test(p))).toBe(true)
  expect(r.reviewTree[0]?.op).toBe('problems')
}

describe('solana_review reads the bytes it is given', () => {
  it('names each instruction by the anchor discriminator sha256 gives it', () => {
    for (const [name, d] of Object.entries(SQUADS_DISC)) expect(disc(name)).toBe(d)
    for (const [d, spec] of Object.entries(KLEND))
      expect(disc(spec.name.replace(' (v1)', ''))).toBe(d)
    expect(base58(fromBase58(PROGRAM.smartAccount, 32))).toBe(PROGRAM.smartAccount)
    expect(keccak256(new Uint8Array()).length).toBe(32)
  })

  it("decodes PayFi's own rule bytes (vendored Squads SDK) to the rules PayFi wrote", () => {
    const r = reviewSolana({ transaction: g.r2b, role: 'custody', account: K.settlement })
    expect(r.instruction).toBe('execute_settings_transaction_sync')
    const a = r.actions?.[0]
    expect(a?.action).toBe('PolicyCreate')
    if (a?.action !== 'PolicyCreate' || a.policy.kind !== 'ProgramInteraction')
      throw new Error('shape')
    expect(a.seed).toBe('3')
    expect(a.signers.map((s) => s.key)).toEqual([K.poOps, K.curatorCredit])
    expect(a.threshold).toBe(2)
    const [w] = a.policy.constraints
    expect(w?.programId).toBe(PROGRAM.klend)
    expect(w?.accounts).toEqual([
      { index: 4, keys: [K.reservePot], owner: null },
      { index: 9, keys: [K.pot], owner: null },
      {
        index: 1,
        data: [{ offset: '2287', value: { type: 'U8', value: '0' }, operator: 'Equals' }],
        owner: PROGRAM.klend,
      },
    ])
    expect(r.signable).toBe(true)
  })

  it("passes PayFi's rules that pin every destination, and flags R4's open payout", () => {
    const at = {
      settlement: K.settlement,
      lp: K.lp,
      market: K.market,
      recovery: K.recovery,
      issuer: K.issuer,
    }
    const ok = (n: keyof typeof g, account: string, role: 'custody' | 'prime' = 'custody') =>
      reviewSolana({ transaction: g[n] as string, role, account })
    for (const n of ['r1', 'r2', 'r2b', 'r3', 'r5', 's1', 'm1'] as const)
      expect(ok(n, at.settlement).problems.filter((p) => !/acts on/.test(p))).toEqual([])
    expect(ok('g1', at.lp, 'prime').signable).toBe(true)
    // R4 pays USDC out to a destination it leaves open (PayFi's receiver allowlist is optional)
    caught(ok('r4', at.settlement), /constraint 0: the destination \(account 2\) is not pinned/)
  })

  it("reads R2's repay pin as PayFi wrote it: the obligation's owner at byte 64, owner klend", () => {
    const r = reviewSolana({ transaction: g.r2, role: 'custody', account: K.settlement })
    const a = r.actions?.[0]
    if (a?.action !== 'PolicyCreate' || a.policy.kind !== 'ProgramInteraction')
      throw new Error('shape')
    const owner = a.policy.constraints[0]?.accounts.find((x) => x.index === 1)
    expect(owner).toEqual({
      index: 1,
      data: [
        {
          offset: String(OBLIGATION.owner),
          value: {
            type: 'U8Slice',
            value: Buffer.from(fromBase58(K.settlementVault as string, 32)).toString('hex'),
          },
          operator: 'Equals',
        },
      ],
      owner: PROGRAM.klend,
    })
  })

  it("reads PayFi's execution through R2b: the withdraw, its amount and where it pays", () => {
    const r = reviewSolana({ transaction: g.r2bWithdraw, role: 'custody', account: K.r2Policy })
    expect(r.execution?.payload).toBe('ProgramInteraction')
    expect(r.execution?.signers).toEqual([K.poOps, K.curatorCredit])
    expect(r.execution?.constraintIndices).toEqual([0])
    const call = r.execution?.instructions[0]
    expect(call?.program).toBe(PROGRAM.klend)
    expect(call?.accounts[9]).toBe(K.pot)
    expect(r.review.join('\n')).toContain('amount 5000000 (collateral tokens)')
    // the policy is R2b (seed 3), not the account named: said, and not signable
    caught(r, /it acts on .*; the account under review is/)
  })

  it('passes the custody rules of docs/solana.md and a Prime band', () => {
    const r = review(settingsTx(goodCustody()))
    expect(r.problems).toEqual([])
    expect(r.signable).toBe(true)
    expect(r.owners).toEqual(OWNERS)
    const band = reviewSolana({
      transaction: settingsTx(
        [
          {
            rule: {
              seed: 1,
              accountIndex: 1,
              constraints: [
                {
                  program: PROGRAM.smartAccount,
                  accounts: [pin(0, CUSTODY_RULE)],
                  data: [discData('execute_transaction_sync_v2')],
                },
              ],
              signers: [OWNERS[2] as string],
              threshold: 1,
              expires: 1_900_000_000,
            },
          },
        ],
        { settings: PRIME }
      ),
      role: 'prime',
      account: PRIME,
      destinations: [CUSTODY_RULE],
    })
    expect(band.problems).toEqual([])
    expect(band.signable).toBe(true)
  })
})

describe('solana_review catches each footgun (problem, signable false)', () => {
  const one = (c: Ic[], over: Partial<Rule> = {}, extra = {}) =>
    review(settingsTx([{ rule: custodyRule(c, over) }]), extra)

  it('E-02: a rule with no instruction constraints admits any instruction', () => {
    caught(one([]), /no instruction constraints, so it admits ANY instruction .*E-02/)
  })

  it('E-03: a SettingsChange policy on the custody account', () => {
    caught(
      one([], { kind: 'SettingsChange' }),
      /SettingsChange policy to the custody account.*3 of 3.*E-03/
    )
  })

  it('E-04: a spending limit with no destinations, as a policy or as a legacy action', () => {
    caught(
      one([], { kind: 'SpendingLimit', destinations: [] }),
      /no destinations: it pays any address \(E-04\)/
    )
    caught(
      review(settingsTx([{ spendingLimit: [] }])),
      /no destinations: it pays any address \(E-04\)/
    )
  })

  it('a destination not pinned, or pinned outside the given destinations', () => {
    const open = withdraw()
    open.accounts = open.accounts.filter((a) => a.index !== 9)
    caught(one([open]), /destination token account \(account 9\) is not pinned/)
    const elsewhere = recoveryTransfer()
    elsewhere.accounts = [pin(0, CUSTODY_TA), pin(2, STRANGER)]
    caught(one([elsewhere]), /may be .*, which is not one of the given destinations/)
    caught(
      reviewSolana({
        transaction: settingsTx(
          [
            {
              rule: {
                seed: 1,
                accountIndex: 1,
                constraints: [
                  {
                    program: PROGRAM.smartAccount,
                    accounts: [],
                    data: [discData('execute_transaction_sync_v2')],
                  },
                ],
                signers: [OWNERS[2] as string],
                threshold: 1,
                expires: 1,
              },
            },
          ],
          { settings: PRIME }
        ),
        role: 'prime',
        account: PRIME,
      }),
      /the rule it calls \(account 0\) is not pinned/
    )
  })

  it('a withdraw without has_debt == 0 where a borrow makes it required, or requireNoDebt asks', () => {
    caught(
      review(
        settingsTx([
          { rule: custodyRule([borrow()]) },
          { rule: custodyRule([withdraw(false)], { seed: 2 }) },
        ])
      ),
      /lacks the has_debt == 0 read .*this change also permits a borrow/
    )
    caught(one([withdraw(false)], {}, { requireNoDebt: true }), /lacks the has_debt == 0 read/)
    // with neither it is a warning only
    const r = one([withdraw(false)])
    expect(r.signable).toBe(true)
    expect(r.warnings.some((w) => /no has_debt == 0 read/.test(w))).toBe(true)
    // a has_debt read with no klend owner does not count
    const unowned = withdraw(false)
    unowned.accounts.push({ ...hasDebtZero, owner: undefined })
    caught(one([unowned]), /has_debt read names no klend owner/)
  })

  it('one rule that admits a borrow and a has_debt-pinned withdraw, or a seize (read before the batch runs)', () => {
    caught(one([borrow(), withdraw()]), /admits both a borrow and a collateral withdraw/)
    const seize: Ic = {
      program: PROGRAM.klend,
      accounts: [
        pin(2, key(50)),
        pin(15, CUSTODY_TA),
        {
          index: 1,
          data: [{ offset: OBLIGATION.markedAt, type: 'U64Le', value: 0n, op: GT }],
          owner: PROGRAM.klend,
        },
      ],
      data: [discData('liquidate_obligation_and_redeem_reserve_collateral_v2')],
    }
    caught(one([borrow(), seize]), /admits both a borrow and a collateral withdraw or seize/)
  })

  it('a liquidation without the marked read, and a repay with an unpinned obligation', () => {
    const liq: Ic = {
      program: PROGRAM.klend,
      accounts: [pin(2, key(50)), pin(15, CUSTODY_TA)],
      data: [discData('liquidate_obligation_and_redeem_reserve_collateral_v2')],
    }
    caught(one([liq]), /lacks the marked read \(U64Le @2336 > 0/)
    liq.accounts.push({
      index: 1,
      data: [{ offset: OBLIGATION.markedAt, type: 'U64Le', value: 0n, op: GT }],
      owner: PROGRAM.klend,
    })
    expect(one([liq]).problems).toEqual([])
    const repay: Ic = {
      program: PROGRAM.klend,
      accounts: [pin(3, RESERVE), pin(6, CUSTODY_TA)],
      data: [discData('repay_obligation_liquidity_v2')],
    }
    caught(one([repay]), /repay's obligation \(account 1\) is not pinned/)
    repay.accounts.push({
      index: 1,
      data: [
        {
          offset: OBLIGATION.owner,
          type: 'U8Slice',
          value: Buffer.from(fromBase58(key(3), 32)).toString('hex'),
          op: EQ,
        },
      ],
      owner: PROGRAM.klend,
    })
    // read, but of another owner: that owner's debt could be paid with the vault's funds
    caught(one([repay]), /the repay's obligation-owner read names .*, not vault 0 of this account/)
    ;(repay.accounts[2]?.data?.[0] as { value: string }).value = Buffer.from(
      fromBase58(vaultAddress(CUSTODY, 0), 32)
    ).toString('hex')
    expect(one([repay]).problems).toEqual([])
  })

  it('a shape the design never makes: no discriminator, another program, klend v1, a hook, a token Approve', () => {
    const bare = supply()
    bare.data = bare.data.filter((d) => d.offset !== 0)
    caught(
      one([bare]),
      /no 8-byte discriminator is pinned, so ANY instruction of Kamino klend passes/
    )
    caught(
      one([
        {
          program: PROGRAM.smartAccount,
          accounts: [],
          data: [discData('execute_transaction_sync_v2')],
        },
      ]),
      /the Smart Account itself/
    )
    caught(one([{ program: PROGRAM.loaderUpgradeable, accounts: [], data: [] }]), /a loader/)
    caught(
      one([
        { ...supply(), data: [discData('deposit_reserve_liquidity_and_obligation_collateral')] },
      ]),
      /klend's v1/
    )
    caught(one([supply()], { hook: { program: STRANGER } }), /pre-hook calling/)
    caught(
      one([
        {
          program: PROGRAM.token,
          accounts: [pin(0, CUSTODY_TA)],
          data: [{ offset: 0, type: 'U8', value: 4, op: EQ }],
        },
      ]),
      /it pins Approve/
    )
    caught(one([], { kind: 'IFT' }), /InternalFundTransfer/)
  })

  it('a rule for another vault, or a signer outside the given list', () => {
    caught(
      one([supply()], { accountIndex: 2 }),
      /acts for vault 2, but custody's funds and position sit in vault 0/
    )
    caught(one([supply()], {}, { signers: [RECOVERY_VAULT] }), /signer .* is not one of the keys/)
  })

  it('a custody threshold below 3, and a time lock below the least the account keeps', () => {
    caught(review(settingsTx([{ threshold: 2 }])), /threshold to 2: the custody account is 3 of 3/)
    caught(
      review(settingsTx([{ timeLock: 0 }]), { minTimeLock: 300 }),
      /below the 300 s this account keeps/
    )
    expect(
      review(settingsTx([{ timeLock: 0 }])).warnings.some((w) => /time lock to 0/.test(w))
    ).toBe(true)
  })

  it('the envelope: a signature, a durable nonce, another top-level instruction, a wrong or missing account', () => {
    caught(review(settingsTx(goodCustody(), { signed: true })), /already carries 1 signature/)
    const nonce = {
      program: PROGRAM.system,
      accounts: [{ key: key(70) }],
      data: Uint8Array.from([4, 0, 0, 0]),
    }
    caught(review(settingsTx(goodCustody(), { extra: [nonce] })), /durable nonce/)
    const pay = {
      program: PROGRAM.system,
      accounts: [{ key: OWNERS[0] as string, signer: true }, { key: STRANGER }],
      data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    }
    caught(review(settingsTx(goodCustody(), { extra: [pay] })), /it also runs System/)
    caught(review(settingsTx(goodCustody()), { account: PRIME }), /the account under review is/)
    caught(review(settingsTx(goodCustody()), { account: undefined }), /no account was given/)
  })

  it('an approval of a stored proposal: what it does is not in the bytes', () => {
    const t = tx([
      {
        program: PROGRAM.smartAccount,
        accounts: [{ key: CUSTODY }, { key: OWNERS[0] as string, signer: true }],
        data: Uint8Array.from([...hexb(SQUADS_DISC.approve_proposal), 0]),
      },
    ])
    caught(review(t), /on a stored proposal: what the proposal does is on chain/)
  })

  it('an execution that approves a delegate as the vault, and one under a SettingsChange rule', () => {
    // execute_transaction_sync_v2, settings-level: a token Approve from custody's account
    // [count 1, program 2 (Token), 2 accounts (custody's account, the stranger), data length 9, Approve 1]
    const inner = Uint8Array.from([1, 2, 2, 0, 1, 9, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0])
    const data = new W()
      .bytes(hexb(SQUADS_DISC.execute_transaction_sync_v2))
      .u8(0)
      .u8(1)
      .u8(0)
      .blob(inner).out
    const exec = tx([
      {
        program: PROGRAM.smartAccount,
        accounts: [
          { key: CUSTODY },
          { key: PROGRAM.smartAccount },
          { key: OWNERS[0] as string, signer: true },
          { key: CUSTODY_TA },
          { key: STRANGER },
          { key: PROGRAM.token },
        ],
        data,
      },
    ])
    const r = review(exec)
    caught(r, /SPL Token Approve, which the design never makes/)
    expect(r.warnings.some((w) => /runs at settings level/.test(w))).toBe(true)
    // a SettingsChange execution: add a signer below the 3 of 3
    const sc = new W()
      .bytes(hexb(SQUADS_DISC.execute_transaction_sync_v2))
      .u8(0)
      .u8(1)
      .u8(1)
      .u8(3)
      .blob([0])
    sc.vec([0], () => sc.u8(0).key(STRANGER).u8(7))
    const r2 = review(
      tx([
        {
          program: PROGRAM.smartAccount,
          accounts: [
            { key: key(41) },
            { key: PROGRAM.smartAccount },
            { key: OWNERS[0] as string, signer: true },
          ],
          data: sc.out,
        },
      ]),
      { account: key(41) }
    )
    caught(r2, /changes custody's settings through a SettingsChange rule/)
  })

  it('warns, without refusing, on an edit that refills limits and drops an expiry', () => {
    const r = review(
      settingsTx([{ rule: custodyRule([supply()], { update: key(42), expires: undefined }) }])
    )
    expect(r.signable).toBe(true)
    expect(r.warnings.some((w) => /refills each of its spending limits/.test(w))).toBe(true)
    expect(r.warnings.some((w) => /any expiry the rule had is removed/.test(w))).toBe(true)
  })
})

describe('solana_review as a tool', () => {
  it('is in the table, answers in the envelope, and refuses bytes that are not a transaction', async () => {
    const ok = (await run('solana_review', {
      transaction: settingsTx(goodCustody()),
      role: 'custody',
      account: CUSTODY,
    })) as {
      ok: true
      data: { signable: boolean }
    }
    expect(ok.ok).toBe(true)
    expect(ok.data.signable).toBe(true)
    const junk = (await run('solana_review', { transaction: 'AAEC', role: 'custody' })) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(junk.ok).toBe(false)
    expect(junk.error.code).toBe('INVALID_INPUT')
    const none = (await run('solana_review', { role: 'custody' })) as {
      ok: false
      error: { message: string }
    }
    expect(none.error.message).toContain('exactly one')
    const notSquads = tx([
      {
        program: PROGRAM.system,
        accounts: [{ key: OWNERS[0] as string, signer: true }],
        data: Uint8Array.from([2, 0, 0, 0]),
      },
    ])
    const r = (await run('solana_review', { transaction: notSquads, role: 'custody' })) as {
      ok: false
      error: { message: string }
    }
    expect(r.error.message).toContain('no Squads Smart Account call')
    // the message alone, without signature slots, reads the same
    const msg = Buffer.from(settingsTx(goodCustody()), 'base64')
      .subarray(1 + 64 * 3)
      .toString('base64')
    const m = (await run('solana_review', { message: msg, role: 'custody', account: CUSTODY })) as {
      ok: true
      data: { signable: boolean }
    }
    expect(m.data.signable).toBe(true)
  })
})
