// evm_review: the owner's pre-sign check of an unsigned Safe transaction. The good shapes are the
// fork check's own (scripts/evm-config-check/test/ConfigOnly.t.sol), reproduced byte for byte from
// fixtures/evm/configonly-golden.json (written on a Base Sepolia fork, with each hash from the live
// Safe 1.4.1 `getTransactionHash`); every footgun is the same batch with one thing changed.

import { describe, expect, it } from 'bun:test'
import g from '../fixtures/evm/configonly-golden.json'
import { hex, keccak256 } from './bytes.ts'
import {
  type ConditionFlat,
  checksum,
  EVM,
  encodeArgs,
  ROLES_PROXY_CODE,
  reviewEvm,
  selectorOf,
  type T,
  type V,
} from './evm.ts'
import { run } from './tools.ts'

const lower = (a: string) => a.toLowerCase()
const CUSTODY = lower(g.custody)
const PRIME = lower(g.prime)
const GATE = lower(g.gate)
const PRIME_ROLES = lower(g.primeRoles)
const TIMELOCK = lower(g.timelock)
const TRUSTEE = lower(g.trustee)
const AGENT = lower(g.agent)
const POOL = '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27'
const USDC = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f'
const AUSDC = '0x10f1a9d11cdf50041f3f8cb7191cbe2f31750acc'
const STRANGER = `0x${'57'.repeat(20)}`

/** A function call: selector ‖ canonical arguments. */
function call(sig: string, ...args: V[]): string {
  const inner = sig.slice(sig.indexOf('(') + 1, -1)
  const types = (
    inner ? inner.replace('(uint8,uint8,uint8,bytes)[]', 'conditions').split(',') : []
  ) as T[]
  return `0x${selectorOf(sig)}${hex(encodeArgs(types, args))}`
}
const word = (v: bigint | string) =>
  typeof v === 'bigint' ? v.toString(16).padStart(64, '0') : v.slice(2).padStart(64, '0')
const key = (s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`
const c = (parent: number, paramType: number, operator: number, compValue = ''): ConditionFlat => ({
  parent,
  paramType,
  operator,
  compValue,
})
const [NONE, STATIC, DYNAMIC, CALLDATA] = [0, 1, 2, 5]
const [PASS, AND, MATCHES, AVATAR, EQ, LT, BITMASK, CUSTOM, ALLOWANCE] = [
  0, 1, 5, 15, 16, 18, 21, 22, 28,
]
const selectorMask = (sel: string) => `0000ffffffff${'0'.repeat(22)}${sel}${'0'.repeat(22)}`

const TRADE = key('prime-trading')
const RECOVER = key('recovery')
const BAND = key('agent-low')
const CUSTODY_BUDGET = key('custody-daily')
const AGENT_DAILY = key('agent-daily')
const SEL = {
  approve: selectorOf('approve(address,uint256)'),
  supply: selectorOf('supply(address,uint256,address,uint16)'),
  withdraw: selectorOf('withdraw(address,uint256,address)'),
  transfer: selectorOf('transfer(address,uint256)'),
  borrow: selectorOf('borrow(address,uint256,uint256,uint16,address)'),
  withRole: selectorOf('execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)'),
  withRoleData: selectorOf(
    'execTransactionWithRoleReturnData(address,uint256,bytes,uint8,bytes32,bool)'
  ),
  fromModule: selectorOf('execTransactionFromModule(address,uint256,bytes,uint8)'),
  multiSend: selectorOf('multiSend(bytes)'),
}

interface Entry {
  op: number
  to: string
  data: string
  value?: bigint
}
const entry = (op: number, to: string, data: string, value = 0n): Entry => ({ op, to, data, value })
function pack(entries: Entry[]): string {
  return `0x${entries
    .map(
      (e) =>
        `${e.op.toString(16).padStart(2, '0')}${e.to.slice(2)}${word(e.value ?? 0n)}${word(BigInt((e.data.length - 2) / 2))}${e.data.slice(2)}`
    )
    .join('')}`
}
const multiSend = (entries: Entry[]) => call('multiSend(bytes)', pack(entries).slice(2))

/** The first entries of a Safe's own configuration batch (ConfigOnly.t.sol `deployRoles`). */
function deployRoles(safe: string, roles: string, salt: string): Entry[] {
  return [
    entry(
      1,
      EVM.createCall,
      call('performCreate2(uint256,bytes,bytes32)', 0n, ROLES_PROXY_CODE, key(salt))
    ),
    entry(
      0,
      roles,
      call('setUp(bytes)', hex(encodeArgs(['address', 'address', 'address'], [safe, safe, safe])))
    ),
    entry(0, safe, call('enableModule(address)', roles)),
  ]
}
const scopeFunction = (
  roles: string,
  role: string,
  target: string,
  sel: string,
  conds: ConditionFlat[],
  options = 0n
) =>
  entry(
    0,
    roles,
    call(
      'scopeFunction(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)',
      role,
      target,
      `0x${sel}`,
      conds,
      options
    )
  )
const scopeTarget = (roles: string, role: string, target: string) =>
  entry(0, roles, call('scopeTarget(bytes32,address)', role, target))

// ConfigOnly.t.sol gateConfig(): the custody gate's trading and recovery roles.
const approveConds = () => [
  c(0, CALLDATA, MATCHES),
  c(0, STATIC, EQ, word(POOL)),
  c(0, STATIC, LT, word(1_000_000_001n)),
]
const supplyConds = () => [
  c(0, CALLDATA, MATCHES),
  c(0, STATIC, EQ, word(USDC)),
  c(0, STATIC, ALLOWANCE, CUSTODY_BUDGET.slice(2)),
  c(0, STATIC, AVATAR),
  c(0, STATIC, PASS),
]
const withdrawConds = () => [
  c(0, CALLDATA, MATCHES),
  c(0, STATIC, EQ, word(USDC)),
  c(0, STATIC, PASS),
  c(0, STATIC, AVATAR),
]
const toTrustee = () => [
  c(0, CALLDATA, MATCHES),
  c(0, STATIC, EQ, word(TRUSTEE)),
  c(0, STATIC, PASS),
]
const withdrawToTrustee = () => [
  c(0, CALLDATA, MATCHES),
  c(0, STATIC, PASS),
  c(0, STATIC, PASS),
  c(0, STATIC, EQ, word(TRUSTEE)),
]
function custodyBatch(over: { trading?: Entry[] } = {}): Entry[] {
  return [
    ...deployRoles(CUSTODY, GATE, 'custody-gate'),
    ...(over.trading ?? [
      scopeTarget(GATE, TRADE, USDC),
      scopeFunction(GATE, TRADE, USDC, SEL.approve, approveConds()),
      scopeTarget(GATE, TRADE, POOL),
      scopeFunction(GATE, TRADE, POOL, SEL.supply, supplyConds()),
      scopeFunction(GATE, TRADE, POOL, SEL.withdraw, withdrawConds()),
    ]),
    entry(
      0,
      GATE,
      call(
        'setAllowance(bytes32,uint128,uint128,uint128,uint64,uint64)',
        CUSTODY_BUDGET,
        200_000_000n,
        200_000_000n,
        200_000_000n,
        86_400n,
        0n
      )
    ),
    entry(0, GATE, call('assignRoles(address,bytes32[],bool[])', PRIME, [TRADE], [true])),
    scopeTarget(GATE, RECOVER, USDC),
    scopeFunction(GATE, RECOVER, USDC, SEL.transfer, toTrustee()),
    scopeTarget(GATE, RECOVER, AUSDC),
    scopeFunction(GATE, RECOVER, AUSDC, SEL.transfer, toTrustee()),
    scopeTarget(GATE, RECOVER, POOL),
    scopeFunction(GATE, RECOVER, POOL, SEL.withdraw, withdrawToTrustee()),
    entry(0, GATE, call('assignRoles(address,bytes32[],bool[])', TIMELOCK, [RECOVER], [true])),
    entry(
      0,
      TIMELOCK,
      call(
        'grantRole(bytes32,address)',
        `0x${hex(keccak256(Buffer.from('CANCELLER_ROLE')))}`,
        CUSTODY
      )
    ),
    entry(0, TIMELOCK, call('renounceRole(bytes32,address)', `0x${'0'.repeat(64)}`, CUSTODY)),
  ]
}

// ConfigOnly.t.sol bandSupply() / bandApprove(): the agent's low band on the Prime account.
function bandSupply(
  o: { mask?: boolean; maskValue?: string; revert?: boolean; op?: boolean } = {}
) {
  const b = [
    c(0, CALLDATA, MATCHES),
    c(0, STATIC, EQ, word(POOL)),
    c(0, STATIC, EQ, word(0n)),
    c(0, NONE, AND),
    o.op === false ? c(0, STATIC, PASS) : c(0, STATIC, EQ, word(0n)),
    c(0, STATIC, EQ, TRADE.slice(2)),
    o.revert === false ? c(0, STATIC, PASS) : c(0, STATIC, EQ, word(1n)),
    c(3, CALLDATA, MATCHES),
    c(3, DYNAMIC, BITMASK, o.maskValue ?? selectorMask(SEL.supply)),
    c(7, STATIC, EQ, word(USDC)),
    c(7, NONE, AND),
    c(7, STATIC, PASS),
    c(7, STATIC, PASS),
    c(10, STATIC, LT, word(100_000_000n)),
    c(10, STATIC, ALLOWANCE, AGENT_DAILY.slice(2)),
  ]
  if (o.mask === false) {
    // the Bitmask goes; its children's parents shift down by one
    b.splice(8, 1)
    return b.map((x, k) => (k >= 8 && x.parent > 8 ? { ...x, parent: x.parent - 1 } : x))
  }
  return b
}
const bandApprove = () => [
  c(0, CALLDATA, MATCHES),
  c(0, STATIC, EQ, word(USDC)),
  c(0, STATIC, EQ, word(0n)),
  c(0, NONE, AND),
  c(0, STATIC, EQ, word(0n)),
  c(0, STATIC, EQ, TRADE.slice(2)),
  c(0, STATIC, EQ, word(1n)),
  c(3, CALLDATA, MATCHES),
  c(3, DYNAMIC, BITMASK, selectorMask(SEL.approve)),
  c(7, STATIC, EQ, word(POOL)),
  c(7, STATIC, LT, word(100_000_000n)),
]
function primeBatch(band = bandSupply()): Entry[] {
  return [
    ...deployRoles(PRIME, PRIME_ROLES, 'prime-roles'),
    entry(
      0,
      PRIME_ROLES,
      call(
        'setTransactionUnwrapper(address,bytes4,address)',
        EVM.multiSendCallOnly,
        `0x${SEL.multiSend}`,
        EVM.unwrapper
      )
    ),
    scopeTarget(PRIME_ROLES, BAND, GATE),
    scopeFunction(PRIME_ROLES, BAND, GATE, SEL.withRole, band),
    scopeFunction(PRIME_ROLES, BAND, GATE, SEL.withRoleData, bandApprove()),
    entry(
      0,
      PRIME_ROLES,
      call(
        'setAllowance(bytes32,uint128,uint128,uint128,uint64,uint64)',
        AGENT_DAILY,
        50_000_000n,
        50_000_000n,
        50_000_000n,
        86_400n,
        0n
      )
    ),
    entry(0, PRIME_ROLES, call('assignRoles(address,bytes32[],bool[])', AGENT, [BAND], [true])),
  ]
}

const custody = (entries: Entry[], extra: Partial<Parameters<typeof reviewEvm>[0]> = {}) =>
  reviewEvm({
    safeTx: { to: EVM.multiSend, data: multiSend(entries), operation: 1, nonce: '0' },
    safe: CUSTODY,
    role: 'custody',
    recipients: [TRUSTEE],
    ...extra,
  })
const prime = (entries: Entry[]) =>
  reviewEvm({
    safeTx: { to: EVM.multiSend, data: multiSend(entries), operation: 1, nonce: '0' },
    safe: PRIME,
    role: 'prime',
  })
/** One problem matching `re`, and nothing signable. */
function caught(r: ReturnType<typeof reviewEvm>, re: RegExp) {
  expect(r.signable).toBe(false)
  expect(r.problems.some((p) => re.test(p))).toBe(true)
  expect(r.reviewTree[0]?.op).toBe('problems')
}

describe('evm_review reads the bytes it is given', () => {
  it('computes selectors and keccak-256 as Ethereum does', () => {
    expect(hex(keccak256(new Uint8Array()))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    )
    // each from `cast sig`
    expect(
      selectorOf('scopeFunction(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)')
    ).toBe('7508dd98')
    expect(SEL.withRole).toBe('c6fe8747')
    expect(SEL.supply).toBe('617ba037')
    expect(selectorOf('revokeTarget(bytes32,address)')).toBe('0172a43a')
    expect(SEL.multiSend).toBe('8d80ff0a')
    expect(checksum(POOL)).toBe('0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27')
  })

  it("rebuilds the fork check's two configuration batches byte for byte", () => {
    expect(multiSend(custodyBatch())).toBe(g.custodyConfig)
    expect(multiSend(primeBatch())).toBe(g.primeConfig)
  })

  it("passes the fork check's custody gate, with the hash the live Safe 1.4.1 computed", () => {
    const r = custody(custodyBatch())
    expect(r.problems).toEqual([])
    expect(r.signable).toBe(true)
    expect(r.safeTxHash).toBe(g.custodyConfigHash)
    expect(r.calls).toHaveLength(19)
    expect(r.review.join('\n')).toContain('EqualToAvatar (Static):  the avatar')
  })

  it("passes the fork check's Prime bands, with the live Safe's hash", () => {
    const r = prime(primeBatch())
    expect(r.problems).toEqual([])
    expect(r.signable).toBe(true)
    expect(r.safeTxHash).toBe(g.primeConfigHash)
    // the band leaves onBehalfOf for the gate to pin: said, not refused
    expect(r.warnings.some((w) => /onBehalfOf is left open/.test(w))).toBe(true)
    expect(r.review.join('\n')).toContain('(selector 0x617ba037, supply)')
  })

  it('reads the same Safe transaction from execTransaction calldata, with the nonce given', () => {
    const data = call(
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
      EVM.multiSend,
      0n,
      g.custodyConfig.slice(2),
      1n,
      0n,
      0n,
      0n,
      `0x${'0'.repeat(40)}`,
      `0x${'0'.repeat(40)}`,
      ''
    )
    const r = reviewEvm({
      calldata: data,
      nonce: '0',
      safe: CUSTODY,
      role: 'custody',
      recipients: [TRUSTEE],
    })
    expect(r.signable).toBe(true)
    expect(r.safeTxHash).toBe(g.custodyConfigHash)
  })
})

describe('evm_review catches each footgun (problem, signable false)', () => {
  const trading = (fn: Entry) =>
    custody(custodyBatch({ trading: [scopeTarget(GATE, TRADE, POOL), fn] }))

  it('an open target (allowTarget)', () => {
    caught(
      custody(
        custodyBatch({
          trading: [entry(0, GATE, call('allowTarget(bytes32,address,uint8)', TRADE, POOL, 0n))],
        })
      ),
      /EVERY function and argument/
    )
  })

  it('a function open to any arguments (allowFunction)', () => {
    caught(
      custody(
        custodyBatch({
          trading: [
            scopeTarget(GATE, TRADE, POOL),
            entry(
              0,
              GATE,
              call(
                'allowFunction(bytes32,address,bytes4,uint8)',
                TRADE,
                POOL,
                `0x${SEL.withdraw}`,
                0n
              )
            ),
          ],
        })
      ),
      /ANY arguments \(allowFunction\).*to included/
    )
  })

  it('an empty parameter condition (a tree of Pass)', () => {
    const r = trading(
      scopeFunction(GATE, TRADE, POOL, SEL.withdraw, [
        c(0, CALLDATA, MATCHES),
        c(0, STATIC, PASS),
        c(0, STATIC, PASS),
        c(0, STATIC, PASS),
      ])
    )
    caught(r, /constrains nothing/)
    caught(r, /to is not pinned \(not EqualToAvatar\)/)
  })

  it('an Or with one open branch is as open as that branch', () => {
    const r = trading(
      scopeFunction(GATE, TRADE, POOL, SEL.withdraw, [
        c(0, NONE, 2),
        c(0, CALLDATA, MATCHES),
        c(0, CALLDATA, MATCHES),
        c(1, STATIC, EQ, word(USDC)),
        c(1, STATIC, PASS),
        c(1, STATIC, AVATAR),
        c(2, STATIC, PASS),
        c(2, STATIC, PASS),
        c(2, STATIC, PASS),
      ])
    )
    caught(r, /constrains nothing/)
    caught(r, /to is not pinned/)
  })

  it('a wrong layout: a Matches that stops before the last argument (trailing arguments unread)', () => {
    caught(
      trading(scopeFunction(GATE, TRADE, POOL, SEL.supply, supplyConds().slice(0, 3))),
      /reads 2 of supply's 4 arguments, so onBehalfOf, referralCode pass\(es\) unread/
    )
  })

  it('a wrong layout: an argument read as another type', () => {
    const conds = withdrawConds()
    conds[2] = c(0, DYNAMIC, PASS)
    caught(
      trading(scopeFunction(GATE, TRADE, POOL, SEL.withdraw, conds)),
      /argument 1 \(amount\) is read as Dynamic.*wrong layout/
    )
  })

  it('a wrong layout: a band whose inner call has no Bitmask on its selector', () => {
    caught(prime(primeBatch(bandSupply({ mask: false }))), /no Bitmask on its selector/)
  })

  it('a wrong layout: a Bitmask that pins only part of the selector', () => {
    caught(
      prime(
        primeBatch(
          bandSupply({ maskValue: `0000ffff0000${'0'.repeat(22)}${SEL.supply}${'0'.repeat(22)}` })
        )
      ),
      /does not pin exactly the four selector bytes/
    )
  })

  it('an unpinned onBehalfOf (not EqualToAvatar)', () => {
    const conds = supplyConds()
    conds[3] = c(0, STATIC, PASS)
    caught(
      trading(scopeFunction(GATE, TRADE, POOL, SEL.supply, conds)),
      /onBehalfOf is not pinned \(not EqualToAvatar\)/
    )
  })

  it('an unpinned to on withdraw, and one pinned to a stranger', () => {
    const open = withdrawConds()
    open[3] = c(0, STATIC, PASS)
    caught(trading(scopeFunction(GATE, TRADE, POOL, SEL.withdraw, open)), /to is not pinned/)
    const stranger = withdrawConds()
    stranger[3] = c(0, STATIC, EQ, word(STRANGER))
    caught(
      trading(scopeFunction(GATE, TRADE, POOL, SEL.withdraw, stranger)),
      /to may be 0x5757.*neither the avatar \(EqualToAvatar\) nor one of the given recipients/
    )
  })

  it('a trustee pin passes only when the trustee is a given recipient', () => {
    expect(custody(custodyBatch()).signable).toBe(true)
    caught(
      custody(custodyBatch(), { recipients: undefined }),
      /to may be 0x0000.*7157ee.*neither the avatar/
    )
  })

  it('trailing calldata past the last argument of a decoded call', () => {
    const t = scopeTarget(GATE, TRADE, POOL)
    caught(
      custody([{ ...t, data: `${t.data}${'00'.repeat(31)}01` }]),
      /carries calldata past its last argument/
    )
    // and on the Safe transaction's own call
    const r = reviewEvm({
      safeTx: { to: GATE, data: `${t.data}dead`, nonce: '0' },
      safe: CUSTODY,
      role: 'custody',
    })
    caught(r, /past its last argument/)
  })

  it('a band that leaves shouldRevert or the operation open', () => {
    caught(prime(primeBatch(bandSupply({ revert: false }))), /does not pin shouldRevert = true/)
    caught(prime(primeBatch(bandSupply({ op: false }))), /could ask for a delegatecall/)
  })

  it('a band that reaches the gate through the default role', () => {
    caught(
      prime([
        scopeTarget(PRIME_ROLES, BAND, GATE),
        scopeFunction(PRIME_ROLES, BAND, GATE, SEL.fromModule, [
          c(0, CALLDATA, MATCHES),
          c(0, STATIC, EQ, word(POOL)),
          c(0, STATIC, PASS),
          c(0, DYNAMIC, PASS),
          c(0, STATIC, PASS),
        ]),
      ]),
      /default role/
    )
  })

  it('a Custom condition, a DelegateCall option, a borrow and Permit2 on the gate', () => {
    const conds = withdrawConds()
    conds[2] = c(0, STATIC, CUSTOM, word(STRANGER))
    caught(trading(scopeFunction(GATE, TRADE, POOL, SEL.withdraw, conds)), /Custom condition/)
    caught(
      trading(scopeFunction(GATE, TRADE, POOL, SEL.withdraw, withdrawConds(), 2n)),
      /DELEGATECALL/
    )
    const borrow = [
      c(0, CALLDATA, MATCHES),
      c(0, STATIC, EQ, word(USDC)),
      c(0, STATIC, LT, word(10n)),
      c(0, STATIC, PASS),
      c(0, STATIC, PASS),
      c(0, STATIC, AVATAR),
    ]
    caught(trading(scopeFunction(GATE, TRADE, POOL, SEL.borrow, borrow)), /borrow against custody/)
    const permit2 = selectorOf('approve(address,address,uint160,uint48)')
    const p2 = [
      c(0, CALLDATA, MATCHES),
      c(0, STATIC, EQ, word(USDC)),
      c(0, STATIC, EQ, word(POOL)),
      c(0, STATIC, LT, word(10n)),
      c(0, STATIC, PASS),
    ]
    caught(trading(scopeFunction(GATE, TRADE, STRANGER, permit2, p2)), /Permit2/)
  })

  it('an unwrap adapter other than the Roles MultiSend unwrapper', () => {
    caught(
      custody([
        entry(
          0,
          GATE,
          call('setTransactionUnwrapper(address,bytes4,address)', POOL, `0x${SEL.supply}`, STRANGER)
        ),
      ]),
      /registers unwrap adapter/
    )
  })

  it('a Roles module set up for someone else, or re-pointed', () => {
    const batch = custodyBatch()
    batch[1] = entry(
      0,
      GATE,
      call(
        'setUp(bytes)',
        hex(encodeArgs(['address', 'address', 'address'], [STRANGER, CUSTODY, CUSTODY]))
      )
    )
    caught(custody(batch), /all three must be the Safe itself/)
    caught(
      custody([entry(0, GATE, call('setAvatar(address)', STRANGER))]),
      /a new avatar moves every custody pin/
    )
  })

  it('the Safe delegatecalling anything but MultiSend, or a batch delegatecalling anything but CreateCall', () => {
    caught(
      reviewEvm({
        safeTx: { to: STRANGER, data: '0x', operation: 1, nonce: '0' },
        safe: CUSTODY,
        role: 'custody',
      }),
      /delegatecalls 0x5757/
    )
    const batch = custodyBatch()
    batch[2] = { ...(batch[2] as Entry), op: 1 }
    caught(custody(batch), /delegatecalls .*only CreateCall/)
  })

  it('a refund, value, signatures, a missing safe, a guard, a lower threshold, the Safe paying out itself', () => {
    caught(
      reviewEvm({
        safeTx: { to: GATE, data: '0x', gasPrice: '1', nonce: '0' },
        safe: CUSTODY,
        role: 'custody',
      }),
      /gas refund/
    )
    caught(
      reviewEvm({
        safeTx: { to: STRANGER, value: '1', nonce: '0' },
        safe: CUSTODY,
        role: 'custody',
      }),
      /sends 1 wei/
    )
    const signed = call(
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
      GATE,
      0n,
      '',
      0n,
      0n,
      0n,
      0n,
      `0x${'0'.repeat(40)}`,
      `0x${'0'.repeat(40)}`,
      'ab'.repeat(65)
    )
    caught(
      reviewEvm({ calldata: signed, nonce: '0', safe: CUSTODY, role: 'custody' }),
      /already carries 65 bytes of signatures/
    )
    caught(reviewEvm({ safeTx: { to: GATE, nonce: '0' }, role: 'custody' }), /no safe was given/)
    caught(custody([entry(0, CUSTODY, call('setGuard(address)', STRANGER))]), /sets a Guard/)
    caught(custody([entry(0, CUSTODY, call('changeThreshold(uint256)', 2n))]), /threshold to 2/)
    caught(prime([entry(0, PRIME, call('changeThreshold(uint256)', 1n))]), /no owner acts alone/)
    caught(
      custody([entry(0, USDC, call('transfer(address,uint256)', STRANGER, 5n))]),
      /makes the Safe itself call transfer/
    )
  })
})

describe('evm_review warns on the revokeTarget gap (allowed, signable true)', () => {
  const revoke = entry(0, GATE, call('revokeTarget(bytes32,address)', TRADE, POOL))
  const fns = [SEL.supply, SEL.withdraw].map((s) =>
    entry(0, GATE, call('revokeFunction(bytes32,address,bytes4)', TRADE, POOL, `0x${s}`))
  )

  it('a revokeTarget without revoking its functions is a warning, not a problem', () => {
    const r = custody([revoke])
    expect(r.problems).toEqual([])
    expect(r.signable).toBe(true)
    expect(
      r.warnings.some((w) =>
        /without revoking its functions in the same batch: the target is closed at once, but every function scope on it stays stored and comes back as it was if the target is scoped again.*revokeFunction each of its functions too/.test(
          w
        )
      )
    ).toBe(true)
    expect(r.reviewTree[0]?.op).toBe('warnings')
  })

  it('with its functions revoked in the same batch, in any order, the warning asks to check the rest', () => {
    for (const batch of [
      [revoke, ...fns],
      [...fns, revoke],
    ]) {
      const r = custody(batch)
      expect(r.problems).toEqual([])
      expect(r.signable).toBe(true)
      expect(r.warnings.some((w) => /without revoking its functions/.test(w))).toBe(false)
      expect(r.warnings.some((w) => /check every function scoped on it is revoked/.test(w))).toBe(
        true
      )
    }
  })
})

describe('evm_review as a tool', () => {
  it('is in the table, answers in the envelope, and refuses what is not a Safe transaction', async () => {
    const ok = (await run('evm_review', {
      safeTx: { to: EVM.multiSend, data: g.custodyConfig, operation: 1, nonce: '0' },
      safe: g.custody,
      role: 'custody',
      recipients: [g.trustee],
    })) as { ok: true; data: { signable: boolean; safeTxHash: string } }
    expect(ok.ok).toBe(true)
    expect(ok.data.signable).toBe(true)
    expect(ok.data.safeTxHash).toBe(g.custodyConfigHash)
    const both = (await run('evm_review', {
      safeTx: { to: GATE },
      calldata: '0x',
      role: 'custody',
    })) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(both.ok).toBe(false)
    expect(both.error.message).toContain('exactly one')
    const junk = (await run('evm_review', { calldata: '0x12345678', role: 'custody' })) as {
      ok: false
      error: { code: string }
    }
    expect(junk.ok).toBe(false)
    expect(junk.error.code).toBe('INVALID_INPUT')
    const short = (await run('evm_review', {
      safeTx: { to: EVM.multiSend, data: g.custodyConfig.slice(0, 200), operation: 1 },
      safe: g.custody,
      role: 'custody',
    })) as { ok: true; data: { signable: boolean; problems: string[] } }
    expect(short.data.signable).toBe(false)
    expect(short.data.problems.join(' ')).toMatch(/does not decode/)
  })
})
