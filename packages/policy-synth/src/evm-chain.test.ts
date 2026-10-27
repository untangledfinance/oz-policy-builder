// evm_review with readChain: the unsigned Safe transaction against the contracts it meets. The
// state is Prime on EVM in the move-timelock shape, set up on a local anvil fork of Base Sepolia by
// scripts/evm-chain/Setup.s.sol (Safe 1.4.1, Roles v2.1.1 proxies, OpenZeppelin TimelockController
// 5.6.0, an ERC-3643 test double), changed per state by test/evm-cases.ts, and every read the review
// made recorded (fixtures/evm/chain-<state>.json, scripts/record-chain.ts evm). A correct live
// state passes; each changed state must be caught.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  A,
  BAND,
  type CaseName,
  call,
  input,
  POOL,
  STATES,
  TRADE,
  USDC,
} from '../test/evm-cases.ts'
import { hex, keccak256 } from './bytes.ts'
import { Refusal } from './envelope.ts'
import { type ConditionFlat, reviewEvm, selectorOf } from './evm.ts'
import {
  type EvmSnapshot,
  header,
  readEvmChain,
  reviewEvmOnChain,
  rolesSlot,
  unpack,
} from './evm-chain.ts'
import type { Rpc } from './jsonrpc.ts'
import { run } from './tools.ts'

const snap = (state: string): EvmSnapshot =>
  // biome-ignore lint/suspicious/noExplicitAny: a JSON fixture
  require(`../fixtures/evm/chain-${state}.json`) as any
const on = (state: string, n: CaseName) => reviewEvmOnChain(input(n), snap(state))
function caught(r: { signable: boolean; problems: string[] }, re: RegExp) {
  expect(r.problems.filter((p) => re.test(p))).not.toEqual([])
  expect(r.signable).toBe(false)
}
const storage = (state: string, at: string, slot: string) => {
  const s = snap(state)
  return s.answers[`eth_getStorageAt:${JSON.stringify([at, slot, s.block])}`]?.result as
    | string
    | undefined
}

describe('readChain reads Roles storage as Roles v2.1.1 lays it out', () => {
  it('finds the role, its target clearance and the packed scoping a live gate holds', () => {
    // TRADE on the pool: Clearance.Function (2), no execution options
    expect(BigInt(storage('good', A.gate, rolesSlot.target(TRADE, POOL)) ?? 0)).toBe(2n)
    const h = header(
      storage(
        'good',
        A.gate,
        rolesSlot.scope(TRADE, POOL, selectorOf('supply(address,uint256,address,uint16)'))
      ) as string
    )
    expect([h.count, h.options, h.wildcarded]).toEqual([5, 0, false])
    const s = snap('good')
    const code = s.answers[`eth_getCode:${JSON.stringify([h.pointer, s.block])}`]?.result as string
    // Setup.s.sol gateConfig() supply: Matches(Calldata) > EqualTo USDC, WithinAllowance custody-daily, EqualToAvatar, Pass
    const word = (a: string) => a.slice(2).padStart(64, '0')
    expect(unpack(code, h.count)).toEqual([
      { parent: 0, paramType: 5, operator: 5, compValue: '' },
      {
        parent: 0,
        paramType: 1,
        operator: 16,
        compValue: hex(keccak256(Buffer.from(word(USDC), 'hex'))),
      },
      {
        parent: 0,
        paramType: 1,
        operator: 28,
        compValue: Buffer.from('custody-daily').toString('hex').padEnd(64, '0'),
      },
      { parent: 0, paramType: 1, operator: 15, compValue: '' },
      { parent: 0, paramType: 1, operator: 0, compValue: '' },
    ] satisfies ConditionFlat[])
    // the move timelock is the trading role's member; the Prime account is not
    expect(BigInt(storage('good', A.gate, rolesSlot.member(TRADE, A.moves)) ?? 0)).toBe(1n)
  })
})

describe('readChain passes a correct live state (the move-timelock setup)', () => {
  it('every case reviews with no problem, and shows what it read', () => {
    for (const n of STATES.good?.cases ?? []) {
      const r = on('good', n)
      expect([n, r.problems]).toEqual([n, []])
      expect(r.signable).toBe(true)
      expect(r.chain.chainId).toBe(84532)
      expect(r.review.join('\n')).toContain('On chain')
    }
    const gate = on('good', 'gateRescope').review.join('\n')
    expect(gate).toMatch(
      /Roles module 0x28cC30…621050: {2}owner 0xc3981E…0BFeAC \[custody Safe\], avatar 0xc3981E…0BFeAC \[custody Safe\], target 0xc3981E…0BFeAC \[custody Safe\], enabled/
    )
    expect(gate).toMatch(/members read: {2}0x4e73a2…dDDCE2/)
    expect(gate).toMatch(/admin: {2}0x4e73a2…dDDCE2\n/)
    expect(gate).toMatch(/executors: {2}anyone \(address 0\)/)
    // the stored EqualTo hashes resolve to the addresses the review knows
    expect(gate).toMatch(/EqualTo \(Static\): {2}0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f/)
    const band = on('good', 'bandRescope').review.join('\n')
    expect(band).toMatch(/stored scoping schedule on 0x4e73a2…dDDCE2/)
    expect(band).toMatch(/proposers: {2}0x3cF98f…3657b6 \[Prime account\]/)
  })

  it('without readChain the review is the bytes-only one, unchanged', () => {
    for (const n of ['gateRescope', 'tokenVenue'] as const) {
      const offline = reviewEvm(input(n))
      const read = on('good', n)
      expect(read.problems).toEqual(offline.problems)
      expect(read.warnings.slice(0, offline.warnings.length)).toEqual(offline.warnings)
      expect('chain' in offline).toBe(false)
    }
  })
})

describe('readChain catches a live mismatch', () => {
  it('a role with an open target already set (allowTarget)', () => {
    caught(
      on('openTarget', 'gateRescope'),
      /role "prime-trading" on 0x28cC30…621050, target 0x8bAB6d…79aE27 is open on chain \(allowTarget\): EVERY function with ANY arguments/
    )
  })
  it('an under-reading live scope beside what the batch writes (allowFunction)', () => {
    caught(
      on('wildcard', 'gateRescope'),
      /target 0xba50Cd…5d4D5f, function transfer \(stored on chain\) allows ANY arguments \(allowFunction\)/
    )
  })
  it('a dormant under-reading scope a scopeTarget brings back', () => {
    caught(
      on('dormant', 'reviveUsdc'),
      /function transfer \(stored on chain\) allows ANY arguments/
    )
    expect(on('good', 'reviveUsdc').signable).toBe(true)
  })
  it("the agent's band opened on the move timelock (allowFunction on schedule)", () => {
    caught(
      on('looseBand', 'bandRescope'),
      /role "agent-low" on 0x02dF58…706A6a, target 0x4e73a2…dDDCE2, function schedule \(stored on chain\) allows ANY arguments/
    )
  })
  it('a module that is not a Roles proxy, and custody no longer 3 of 3', () => {
    const r = on('rogue', 'gateRescope')
    caught(r, /module 0xBEbeBe…Bebebe is enabled on the Safe and is an address with no code/)
    caught(r, /the custody Safe on chain needs 2 of its 3 owners/)
  })
  it('a timelock admin the custody Safe still holds', () => {
    caught(
      on('timelockAdmin', 'gateRescope'),
      /0xc3981E…0BFeAC \[custody Safe\] holds timelock 0x4e73a2…dDDCE2's admin role on chain/
    )
  })
  it('an ERC-3643 token on which custody is frozen and no longer verified', () => {
    const r = on('tokenFrozen', 'tokenVenue')
    caught(r, /the Safe is not verified in token 0x49335e…Bf1450's identity registry/)
    caught(r, /the Safe is FROZEN on token 0x49335e…Bf1450/)
    expect(on('good', 'tokenVenue').review.join('\n')).toMatch(/the Safe: {2}verified/)
  })
  it('a revokeTarget lists the function scopes it leaves stored', () => {
    const r = on('good', 'revokePool')
    expect(r.signable).toBe(true)
    expect(
      r.warnings.some((w) =>
        /after the revokeTarget these function scopes stay stored and come back on a later scopeTarget: supply, withdraw/.test(
          w
        )
      )
    ).toBe(true)
  })
  it('an unwrap adapter other than the Roles MultiSend unwrapper', () => {
    caught(
      on('foreignUnwrapper', 'gateRescope'),
      /unwraps 0x38869b…43B526 \[MultiSend 1\.4\.1\] batches with adapter 0xdededededededededededededededededededede, not the Roles MultiSend unwrapper/
    )
    expect(on('good', 'bandRescope').review.join('\n')).toMatch(
      /unwrapper for 0x9641d7…8102e2 \[MultiSendCallOnly 1\.4\.1\]: {2}0x93B7fC…7427c0 \[Roles MultiSend unwrapper\]/
    )
  })
  it('a gate the Safe has turned off is told', () => {
    const r = on('gateOff', 'gateRescope')
    expect(r.warnings.some((w) => /which the Safe has not enabled/.test(w))).toBe(true)
  })
  it('a read the checks need that is missing', () => {
    const s = snap('good')
    const answers = { ...s.answers }
    delete answers[
      Object.keys(answers).find((k) => k.startsWith('eth_call') && k.includes(A.moves)) as string
    ]
    caught(
      reviewEvmOnChain(input('gateRescope'), { ...s, answers }),
      /the chain read did not answer 1 call/
    )
  })
})

describe('evm_review reads the move-timelock shape from the bytes', () => {
  it('decodes a move the Prime owners schedule on the timelock', () => {
    const r = reviewEvm(input('schedule'))
    expect(r.problems).toEqual([])
    const text = r.review.join('\n')
    expect(text).toMatch(/calls: {2}0x28cC30…621050 execTransactionWithRole/)
    expect(text).toMatch(/move: {2}supply on 0x8bAB6d…79aE27/)
    // a scheduled delegatecall through the gate is a problem
    const bad = call(
      'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
      A.gate,
      0n,
      call(
        'execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)',
        POOL,
        0n,
        '',
        1n,
        TRADE,
        true
      ).slice(2),
      `0x${'0'.repeat(64)}`,
      `0x${'0'.repeat(64)}`,
      3600n
    )
    const r2 = reviewEvm({ ...input('schedule'), safeTx: { to: A.moves, data: bad, nonce: '1' } })
    expect(r2.problems.some((p) => /the scheduled gate call asks for a delegatecall/.test(p))).toBe(
      true
    )
  })

  it('passes the move-timelock setup as primex-evm-refline built it (RefLine.s.sol, independent bytes)', () => {
    const g = require('../fixtures/evm/refline-golden.json') as {
      trustee: string
      primeConfig: { safe: string; calldata: string }
      custodyConfig: { safe: string; calldata: string }
    }
    for (const [k, role] of [
      ['primeConfig', 'prime'],
      ['custodyConfig', 'custody'],
    ] as const) {
      const r = reviewEvm({
        calldata: g[k].calldata,
        nonce: '0',
        safe: g[k].safe,
        role,
        recipients: [g.trustee],
      })
      // the plan's calldata carries the owners' signatures: the only problem
      expect(r.problems.filter((p) => !/already carries .* bytes of signatures/.test(p))).toEqual(
        []
      )
    }
  })

  it('reads a band on the timelock schedule one level down, and catches what it leaves open', () => {
    // the band of Setup.s.sol bandSchedule, as plain conditions (EqualTo values not hashed)
    const w = (v: bigint | string) =>
      typeof v === 'bigint' ? v.toString(16).padStart(64, '0') : v.slice(2).padStart(64, '0')
    const mask = (sel: string) => `0000ffffffff${'0'.repeat(22)}${sel}${'0'.repeat(22)}`
    const c = (
      parent: number,
      paramType: number,
      operator: number,
      compValue = ''
    ): ConditionFlat => ({ parent, paramType, operator, compValue })
    const good = [
      c(0, 5, 5),
      c(0, 1, 16, w(A.gate)),
      c(0, 1, 16, w(0n)),
      c(0, 0, 1),
      c(0, 1, 0),
      c(0, 1, 0),
      c(0, 1, 0),
      c(3, 5, 5),
      c(
        3,
        2,
        21,
        mask(selectorOf('execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)'))
      ),
      c(7, 1, 16, w(POOL)),
      c(7, 1, 16, w(0n)),
      c(7, 0, 1),
      c(7, 1, 16, w(0n)),
      c(7, 1, 16, TRADE.slice(2)),
      c(7, 1, 16, w(1n)),
      c(11, 5, 5),
      c(11, 2, 21, mask(selectorOf('supply(address,uint256,address,uint16)'))),
      c(15, 1, 16, w(USDC)),
      c(15, 0, 1),
      c(15, 1, 0),
      c(15, 1, 0),
      c(18, 1, 18, w(100_000_000n)),
      c(18, 1, 28, BAND.slice(2)),
    ]
    const scope = (tree: ConditionFlat[]) =>
      reviewEvm({
        safeTx: {
          to: A.primeRoles,
          data: call(
            'scopeFunction(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)',
            BAND,
            A.moves,
            `0x${selectorOf('schedule(address,uint256,bytes,bytes32,bytes32,uint256)')}`,
            tree,
            0n
          ),
          nonce: '1',
        },
        safe: A.prime,
        role: 'prime',
      })
    expect(scope(good).problems).toEqual([])
    const without = (k: number, x: ConditionFlat) => good.map((g, j) => (j === k ? x : g))
    expect(scope(without(1, c(0, 1, 0))).problems.join('\n')).toMatch(
      /does not pin the scheduled call's target/
    )
    expect(
      scope(
        without(
          8,
          c(3, 2, 21, mask(selectorOf('execTransactionFromModule(address,uint256,bytes,uint8)')))
        )
      ).problems.join('\n')
    ).toMatch(/does not pin it to the gate's execTransactionWithRole/)
    expect(scope(without(12, c(7, 1, 0))).problems.join('\n')).toMatch(
      /does not hold the operation to a plain call/
    )
    expect(scope(without(16, c(11, 2, 0))).problems.join('\n')).toMatch(
      /the inner call has no Bitmask on its selector/
    )
  })
})

describe('readEvmChain reads at one block, test networks only', () => {
  function replay(s: EvmSnapshot, chainId = s.chainId) {
    const calls: string[] = []
    const rpc: Rpc = async (method, params) => {
      calls.push(method)
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
      if (method === 'eth_blockNumber') return s.block
      const a = s.answers[`${method}:${JSON.stringify(params)}`]
      if (!a) throw new Error(`no answer for ${method}`)
      if (a.error) {
        const { RpcError } = await import('./jsonrpc.ts')
        throw new RpcError(a.error.code, a.error.message)
      }
      return a.result
    }
    return { rpc, calls }
  }
  it('reads in rounds to the same answers, and reviews the same', async () => {
    for (const n of ['gateRescope', 'bandRescope', 'tokenVenue'] as const) {
      const s = snap('good')
      const read = await readEvmChain(input(n), replay(s).rpc)
      expect(read.block).toBe(s.block)
      for (const k of Object.keys(read.answers))
        if (!k.startsWith('eth_chainId')) expect(k.endsWith(`"${s.block}"]`)).toBe(true)
      expect(reviewEvmOnChain(input(n), read).problems).toEqual(
        reviewEvmOnChain(input(n), s).problems
      )
    }
  })
  it('refuses a mainnet, a node on another chain, and a failed read (retryable)', async () => {
    const s = snap('good')
    await expect(
      readEvmChain({ ...input('gateRescope'), chainId: 8453 }, replay(s).rpc)
    ).rejects.toThrow(/not a test network/)
    await expect(readEvmChain(input('gateRescope'), replay(s, 11155111).rpc)).rejects.toThrow(
      /serves chain 11155111, not chain 84532/
    )
    const down: Rpc = async () => {
      throw new Error('connection refused')
    }
    const e = await readEvmChain(input('gateRescope'), down).catch((x) => x)
    expect(e).toBeInstanceOf(Refusal)
    expect(e.extra.retryable).toBe(true)
  })
})

describe('the evm_review tool', () => {
  const before = process.env.POLICY_BUILDER_EVM_RPC_URL
  afterEach(() => {
    if (before === undefined) delete process.env.POLICY_BUILDER_EVM_RPC_URL
    else process.env.POLICY_BUILDER_EVM_RPC_URL = before
  })
  it('reads nothing without readChain, and the operator endpoint with it', async () => {
    const s = snap('openTarget')
    let hits = 0
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        hits++
        const b = (await req.json()) as { id: number; method: string; params: unknown[] }
        if (b.method === 'eth_chainId')
          return Response.json({ jsonrpc: '2.0', id: b.id, result: '0x14a34' })
        if (b.method === 'eth_blockNumber')
          return Response.json({ jsonrpc: '2.0', id: b.id, result: s.block })
        const a = s.answers[`${b.method}:${JSON.stringify(b.params)}`]
        return Response.json({
          jsonrpc: '2.0',
          id: b.id,
          ...(a ?? { error: { code: -1, message: 'not recorded' } }),
        })
      },
    })
    process.env.POLICY_BUILDER_EVM_RPC_URL = `http://127.0.0.1:${server.port}`
    try {
      const i = { ...input('gateRescope') }
      const off = (await run('evm_review', i)) as {
        ok: true
        data: { signable: boolean; chain?: unknown }
      }
      expect(off.ok).toBe(true)
      expect(off.data.signable).toBe(true)
      expect(off.data.chain).toBeUndefined()
      expect(hits).toBe(0)
      const read = (await run('evm_review', { ...i, readChain: true })) as {
        ok: true
        data: { signable: boolean; problems: string[] }
      }
      expect(read.ok).toBe(true)
      expect(read.data.signable).toBe(false)
      expect(read.data.problems.some((p) => /is open on chain \(allowTarget\)/.test(p))).toBe(true)
      expect(hits).toBeGreaterThan(0)
    } finally {
      server.stop(true)
    }
  })
})
