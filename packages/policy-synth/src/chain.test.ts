import { afterAll, describe, expect, it } from 'bun:test'
import { contract } from '../test/fixtures.ts'
import { fakeInterpreter } from '../test/rpc.ts'
import { connect, ensureInterpreter, fingerprint, interpreterFor } from './chain.ts'
import { INTERPRETER, INTERPRETER_WASM } from './config.ts'
import { run } from './tools.ts'

type Out = { ok: boolean; data?: { results: unknown[] }; error?: { code: string; message: string } }
const OURS = INTERPRETER.testnet?.wasmSha256 as string
const OTHER = 'ab'.repeat(32)
const stops: (() => void)[] = []
afterAll(() => {
  for (const s of stops) s()
})
const net = (address: string, wasm: string, grammar = 7) => {
  const f = fakeInterpreter(address, wasm, grammar)
  stops.push(f.stop)
  return f
}

describe('the interpreter is a build, not an address', () => {
  it('the trusted builds are the reproducible hashes of the pins', () => {
    expect([...INTERPRETER_WASM]).toEqual([OURS])
  })

  it('a contract is the interpreter when it speaks the grammar AND runs a trusted build', async () => {
    const [a, b, c] = [contract(11), contract(12), contract(13)]
    const live = (address: string, wasm: string, grammar?: number) => {
      const f = net(address, wasm, grammar)
      return fingerprint(connect(f.endpoint), 'mainnet', address)
    }
    expect((await live(a, OURS)).matches).toBe(true)
    // Answering grammar_version() = 7 is free: any contract can. The code it runs is not.
    expect(await live(b, OTHER)).toMatchObject({
      matches: false,
      grammarVersion: 7,
      wasmSha256: OTHER,
    })
    expect((await live(c, OURS, 6)).matches).toBe(false)
  })

  it('ensureInterpreter refuses an untrusted build, and does not ask again about a trusted one', async () => {
    const [good, bad] = [contract(14), contract(15)]
    const g = net(good, OURS)
    await ensureInterpreter(connect(g.endpoint), 'mainnet', good)
    await ensureInterpreter(connect(g.endpoint), 'mainnet', good)
    expect(g.asked.filter((m) => m === 'getLedgerEntries')).toHaveLength(1)
    const b = net(bad, OTHER)
    await expect(ensureInterpreter(connect(b.endpoint), 'mainnet', bad)).rejects.toThrow(
      /runs grammar 7 with wasm ab/
    )
    await expect(ensureInterpreter(connect(b.endpoint), 'mainnet', bad)).rejects.toThrow()
    // The pin is trusted without a call.
    await ensureInterpreter(connect(b.endpoint), 'testnet', interpreterFor('testnet'))
  })
})

describe('every tool that asks the interpreter refuses one that is not a trusted build', () => {
  const call = {
    smartAccount: contract(3),
    calls: [{ contract: contract(4), fn: 'pay', args: [] }],
  }
  const expr = ['eq', ['call_fn'], 'pay']

  it('simulate and verify on mainnet name the interpreter, which must be a trusted build', async () => {
    const bad = contract(16)
    const b = net(bad, OTHER)
    for (const tool of ['simulate_policy', 'verify_policy'] as const) {
      const r = (await run(tool, {
        ...b.endpoint,
        interpreterAddress: bad,
        expr,
        calls: call.calls,
        ...(tool === 'verify_policy' ? { call: call.calls[0] } : {}),
      })) as Out
      expect(r.error?.code).toBe('INTERPRETER_MISMATCH')
    }
    // Not one verdict was asked of it.
    expect(b.asked).not.toContain('check')
    const good = contract(17)
    const g = net(good, OURS)
    const r = (await run('simulate_policy', {
      ...g.endpoint,
      interpreterAddress: good,
      expr,
      calls: call.calls,
    })) as Out
    expect(r.ok).toBe(true)
    expect(r.data?.results[0]).toMatchObject({ permitted: true, code: 0 })
  })

  it('install_policy takes no interpreterWasmSha256: the build is not the caller to name', async () => {
    const r = (await run('install_policy', {
      network: 'testnet',
      smartAccount: contract(3),
      sourceAccount: 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB',
      signers: ['GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'],
      intent: { calls: [{ contract: contract(4), fn: 'pay' }] },
      interpreterWasmSha256: OTHER,
    })) as Out
    expect(r.error?.code).toBe('INVALID_INPUT')
    expect(r.error?.message).toMatch(/interpreterWasmSha256/)
  })
})
