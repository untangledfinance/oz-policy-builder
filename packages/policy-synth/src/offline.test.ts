// synthesize_policy and get_interpreter_info work with no RPC: the pinned instance's deployed
// limits are recorded in config (immutable per instance), the live ones are used when the RPC
// answers. Install, verify and simulate stay strict. Every test starts with a cold limits cache.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { contract } from '../test/fixtures.ts'
import { fakeInterpreter, LIMITS_DEFAULT, pointAt } from '../test/rpc.ts'
import { forgetLimits } from './chain.ts'
import { INTERPRETER } from './config.ts'
import { run } from './tools.ts'
import { DECODE_LIMITS } from './wire.ts'

type Out = { ok: boolean; data?: any; error?: any }
const pin = INTERPRETER.testnet as NonNullable<typeof INTERPRETER.testnet>
const TOKEN = contract(7)
const reads = (k: number) =>
  Array.from({ length: k }, (_, i) => ({
    constraint: 'read',
    contract: contract(80 + i),
    fn: 'price',
    op: 'gte',
    to: { i128: '1' },
  }))
const intent = (k = 0) => ({ calls: [{ contract: TOKEN, fn: 'pay', where: reads(k) }] })

let undo = () => {}
beforeEach(() => {
  forgetLimits()
  undo = pointAt('testnet', 'http://127.0.0.1:9') // a closed port: the network is not there
})
afterEach(() => {
  undo()
  forgetLimits()
})
const tool = (name: string, input: object, network = 'testnet') =>
  run(name, { network, ...input }) as Promise<Out>

describe('with no RPC', () => {
  it('synthesize_policy holds the rule to the limits recorded for the pin and says so', async () => {
    const ok = await tool('synthesize_policy', { intent: intent(8) })
    expect(ok.ok).toBe(true) // eight reads: the pinned instance allows 8, the defaults 4
    expect(ok.data.heldTo).toBe(`the limits recorded for ${pin.address} (the RPC did not answer)`)
    const nine = await tool('synthesize_policy', { intent: intent(9) })
    expect(nine.ok).toBe(false)
    expect(nine.error.code).toBe('MALFORMED_PREDICATE')
    expect(nine.error.message).toMatch(/9 distinct reads, at most 8/)
  })

  it('get_interpreter_info gives the recorded limits and says whose they are', async () => {
    const r = await tool('get_interpreter_info', {})
    expect(r.ok).toBe(true)
    expect(r.data.limits).toEqual(pin.limits)
    expect(r.data.limitsFrom).toBe('recorded')
  })

  it('a network with no pin is held to the defaults, the stricter choice, and says so', async () => {
    const r = await tool('synthesize_policy', { intent: intent(5) }, 'mainnet')
    expect(r.ok).toBe(false)
    expect(r.error.message).toMatch(/5 distinct reads, at most 4/)
    const ok = await tool('synthesize_policy', { intent: intent(4) }, 'mainnet')
    expect(ok.ok).toBe(true)
    expect(ok.data.heldTo).toBe('the default limits (no interpreter is pinned for mainnet)')
    expect(DECODE_LIMITS.max_reads).toBe(4)
  })

  it('simulate, verify and install stay strict: they need the live interpreter', async () => {
    const call = { contract: TOKEN, fn: 'transfer', args: [] }
    const expr = ['eq', ['call_fn'], 'transfer']
    for (const [name, input] of [
      ['simulate_policy', { expr, calls: [call] }],
      ['verify_policy', { expr, call }],
      ['simulate_policy', { expr }],
    ] as const) {
      const r = await tool(name, input)
      expect(r.ok).toBe(false)
    }
    const info = await tool('get_interpreter_info', { verifyLive: true })
    expect(info.ok).toBe(false)
  })
})

describe('with an RPC that answers', () => {
  const serve = (limits: Record<string, number | string> | null) => {
    const fake = fakeInterpreter(pin.address, pin.wasmSha256, 7, 0, limits)
    undo = pointAt('testnet', `http://127.0.0.1:${fake.port}`)
    return fake
  }

  it('synthesize_policy holds the rule to the live limits, which equal the recorded ones', async () => {
    const fake = serve({ ...pin.limits })
    try {
      const r = await tool('synthesize_policy', { intent: intent(8) })
      expect(r.ok).toBe(true)
      expect(r.data.heldTo).toBe(`the limits of ${pin.address} (read live)`)
      expect((await tool('get_interpreter_info', {})).data.limitsFrom).toBe('live')
    } finally {
      fake.stop()
    }
  })

  it('a live answer that is not the recorded limits is refused, never averaged or believed', async () => {
    const fake = serve({ ...LIMITS_DEFAULT })
    try {
      const r = await tool('synthesize_policy', { intent: intent(2) })
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe('INTERPRETER_MISMATCH')
    } finally {
      fake.stop()
    }
  })

  it('a live answer that is nonsense is refused, not replaced by the recorded limits', async () => {
    const fake = serve({ ...pin.limits, max_reads: 99 })
    try {
      const r = await tool('synthesize_policy', { intent: intent(2) })
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe('INTERPRETER_MISMATCH')
    } finally {
      fake.stop()
    }
  })

  it('an RPC that answers an error (no limits()) is the same as none: the recorded limits hold', async () => {
    const fake = serve(null)
    try {
      const r = await tool('synthesize_policy', { intent: intent(8) })
      expect(r.ok).toBe(true)
      expect(r.data.heldTo).toContain('recorded')
    } finally {
      fake.stop()
    }
  })
})
