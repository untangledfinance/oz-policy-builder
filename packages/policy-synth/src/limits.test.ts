// The interpreter's limits are the instance's: read from it, held to the ceilings, cached per
// address, and what every predicate is validated against. Hermetic: a fake interpreter answers.

import { afterAll, describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { fakeInterpreter, LIMITS_DEFAULT } from '../test/rpc.ts'
import { authority, lines } from './card.ts'
import { capsFor, connect, fingerprint, limitsOf } from './chain.ts'
import { INTERPRETER, INTERPRETER_WASM, INTERPRETERS } from './config.ts'
import { run } from './tools.ts'
import { type Caps, CEILINGS, DECODE_LIMITS, encode, validate, WireError } from './wire.ts'

const OURS = INTERPRETER.testnet?.wasmSha256 as string
const stops: (() => void)[] = []
afterAll(() => {
  for (const s of stops) s()
})
let n = 100
/** A mainnet whose only contract is an interpreter (a fresh address each time, so the cache is not shared). */
const net = (limits: Record<string, number | string> | null = LIMITS_DEFAULT, wasm = OURS) => {
  const address = contract(n++)
  const f = fakeInterpreter(address, wasm, 7, 0, limits)
  stops.push(f.stop)
  return { ...f, address, server: connect(f.endpoint) }
}

// The values differ in every field, so a field read under the wrong name changes the answer.
const CUSTOM = {
  max_reads: 6,
  max_leaves: 300,
  max_predicate_bytes: 40_000,
  max_elems: 50,
  max_in_operands: 40,
  max_depth: 7,
}
const CUSTOM_CAPS: Caps = {
  reads: 6,
  leaves: 300,
  bytes: 40_000,
  elems: 50,
  entries: 40,
  depth: 7,
  steps: 8,
}

describe('the ceilings are the contract’s', () => {
  it('say what Limits::in_range says', () => {
    expect(CEILINGS).toEqual({
      reads: 8,
      leaves: 400,
      bytes: 49_152,
      elems: 64,
      entries: 64,
      depth: 8,
      steps: 8,
    })
  })
  it('and the defaults are what grammar 7 first shipped with', () => {
    expect(DECODE_LIMITS).toEqual({
      reads: 4,
      leaves: 200,
      bytes: 32_768,
      elems: 32,
      entries: 32,
      depth: 5,
      steps: 8,
    })
  })
})

describe('limitsOf: what the instance says, and nothing it should not', () => {
  it('maps each field of limits() to its cap', async () => {
    const f = net(CUSTOM)
    expect(await limitsOf(f.server, 'mainnet', f.address)).toEqual(CUSTOM_CAPS)
  })

  it('accepts exactly the ceilings and exactly 1', async () => {
    const top = net({
      max_reads: 8,
      max_leaves: 400,
      max_predicate_bytes: 49_152,
      max_elems: 64,
      max_in_operands: 64,
      max_depth: 8,
    })
    expect(await limitsOf(top.server, 'mainnet', top.address)).toEqual(CEILINGS)
    const low = net(Object.fromEntries(Object.keys(LIMITS_DEFAULT).map((k) => [k, 1])))
    expect(await limitsOf(low.server, 'mainnet', low.address)).toMatchObject({
      reads: 1,
      leaves: 1,
      bytes: 1,
      elems: 1,
      entries: 1,
      depth: 1,
    })
  })

  const bad: [string, number | string][] = Object.keys(LIMITS_DEFAULT).flatMap((k) => [
    [k, 0],
    [k, 'x'],
  ])
  it.each(bad)('refuses %s = %p', async (field, value) => {
    const f = net({ ...LIMITS_DEFAULT, [field]: value })
    await expect(limitsOf(f.server, 'mainnet', f.address)).rejects.toThrow(
      new RegExp(`${field} = ${value}`)
    )
  })

  const ceilingOf: Record<string, number> = {
    max_reads: 8,
    max_leaves: 400,
    max_predicate_bytes: 49_152,
    max_elems: 64,
    max_in_operands: 64,
    max_depth: 8,
  }
  it.each(Object.entries(ceilingOf))('refuses %s above its ceiling (%d)', async (field, top) => {
    const f = net({ ...LIMITS_DEFAULT, [field]: top + 1 })
    await expect(limitsOf(f.server, 'mainnet', f.address)).rejects.toThrow(
      new RegExp(`${field} = ${top + 1}`)
    )
  })

  it('refuses an instance that leaves a field out, or does not answer', async () => {
    const { max_depth: _, ...short } = LIMITS_DEFAULT
    const missing = net(short)
    await expect(limitsOf(missing.server, 'mainnet', missing.address)).rejects.toThrow(
      /max_depth = undefined/
    )
    const silent = net(null)
    await expect(limitsOf(silent.server, 'mainnet', silent.address)).rejects.toThrow(/limits/)
  })

  it('asks an address once: an instance cannot change its limits', async () => {
    const f = net(CUSTOM)
    await limitsOf(f.server, 'mainnet', f.address)
    await limitsOf(f.server, 'mainnet', f.address)
    expect(f.asked.filter((m) => m === 'simulate limits')).toHaveLength(1)
    const g = net(CUSTOM)
    await limitsOf(g.server, 'mainnet', g.address)
    expect(g.asked.filter((m) => m === 'simulate limits')).toHaveLength(1)
  })

  it('does not remember a refusal', async () => {
    const f = net({ ...LIMITS_DEFAULT, max_reads: 0 })
    await expect(limitsOf(f.server, 'mainnet', f.address)).rejects.toThrow()
    await expect(limitsOf(f.server, 'mainnet', f.address)).rejects.toThrow()
    expect(f.asked.filter((m) => m === 'simulate limits')).toHaveLength(2)
  })

  it('capsFor trusts the code first: an untrusted build is not asked what its limits are', async () => {
    const f = net(CUSTOM, 'ab'.repeat(32))
    await expect(capsFor(f.server, 'mainnet', f.address)).rejects.toThrow(
      /runs grammar 7 with wasm ab/
    )
    expect(f.asked).not.toContain('simulate limits')
  })

  it('the live fingerprint carries the limits of a trusted build, and none of any other', async () => {
    const good = net(CUSTOM)
    expect(await fingerprint(good.server, 'mainnet', good.address)).toMatchObject({
      matches: true,
      limits: CUSTOM_CAPS,
    })
    const other = net(CUSTOM, 'ab'.repeat(32))
    const live = await fingerprint(other.server, 'mainnet', other.address)
    expect(live.matches).toBe(false)
    expect(live.limits).toBeUndefined()
    expect(other.asked).not.toContain('simulate limits')
  })
})

describe('validate holds a predicate to the caps it is given', () => {
  const sel = ['eq', ['call_fn'], 'pay']
  const readOf = (i: number) => ['gte', ['read', contract(40 + i), 'price', []], { i128: '0' }]
  const reads = (k: number) => ['and', [sel, ...Array.from({ length: k }, (_, i) => readOf(i))]]
  const caps = (over: Partial<Caps>): Caps => ({ ...DECODE_LIMITS, ...over })

  it('reads', () => {
    expect(() => validate(reads(4))).not.toThrow()
    expect(() => validate(reads(5))).toThrow(/5 distinct reads, at most 4/)
    expect(() => validate(reads(5), caps({ reads: 5 }))).not.toThrow()
    expect(() => validate(reads(6), caps({ reads: 5 }))).toThrow(/at most 5/)
    expect(() => validate(reads(3), caps({ reads: 2 }))).toThrow(/at most 2/)
  })

  it('leaves', () => {
    const many = (k: number) => ['and', [sel, ...Array.from({ length: k }, () => sel)]]
    // 2 leaves a compare
    expect(() => validate(many(99))).not.toThrow()
    expect(() => validate(many(100))).toThrow(/202 leaves, at most 200/)
    expect(() => validate(many(100), caps({ leaves: 202 }))).not.toThrow()
    expect(() => validate(many(100), caps({ leaves: 201 }))).toThrow(/at most 201/)
  })

  it('a quantifier body and a sum weigh the caps’ elems', () => {
    const body = (k: number) => [
      'all',
      ['call_path', 0],
      ['and', Array.from({ length: k }, () => ['gte', ['elem'], { i128: '0' }])],
    ]
    // one compare is 2 leaves a body leaf, plus the vector: 2 * elems + 1
    expect(() => validate(body(1), caps({ elems: 10, leaves: 21 }))).not.toThrow()
    expect(() => validate(body(1), caps({ elems: 10, leaves: 20 }))).toThrow(/21 leaves/)
    expect(() => validate(body(1), caps({ elems: 64, leaves: 129 }))).not.toThrow()
    expect(() => validate(body(1), caps({ elems: 64, leaves: 128 }))).toThrow(/129 leaves/)
    // gte(sum(call_path 0), 0): elems + the source + the constant + the call_path
    const total = ['gte', ['sum', ['call_path', 0]], { i128: '0' }]
    expect(() => validate(total, caps({ elems: 20, leaves: 22 }))).not.toThrow()
    expect(() => validate(total, caps({ elems: 20, leaves: 21 }))).toThrow(/22 leaves/)
  })

  it('in and nin entries', () => {
    const inList = (op: string, k: number) => [
      op,
      ['call_arg', 0],
      Array.from({ length: k }, (_, i) => ({ i128: String(i) })),
    ]
    for (const op of ['in', 'nin']) {
      expect(() => validate(inList(op, 32))).not.toThrow()
      expect(() => validate(inList(op, 33))).toThrow(/more than 32 entries/)
      expect(() => validate(inList(op, 33), caps({ entries: 33, leaves: 400 }))).not.toThrow()
      expect(() => validate(inList(op, 34), caps({ entries: 33, leaves: 400 }))).toThrow(
        /more than 33/
      )
    }
  })

  it('node depth and leaf nesting', () => {
    const chain = (k: number): unknown => (k === 0 ? sel : ['and', [chain(k - 1)]])
    // k `and`s around a compare: k + 1 levels
    expect(() => validate(chain(4))).not.toThrow()
    expect(() => validate(chain(5))).toThrow(/nested deeper than 5/)
    expect(() => validate(chain(5), caps({ depth: 6 }))).not.toThrow()
    expect(() => validate(chain(6), caps({ depth: 6 }))).toThrow(/deeper than 6/)
    const scaled = (k: number): unknown =>
      k === 0
        ? { i128: '1' }
        : ['scaled', scaled(k - 1), { i128: '1' }, { i128: '1' }, { i128: '0' }]
    const nested = (k: number) => ['gte', ['call_arg', 0], scaled(k)]
    expect(() => validate(nested(4))).not.toThrow()
    expect(() => validate(nested(5))).toThrow(/leaf nested deeper than 5/)
    expect(() => validate(nested(5), caps({ depth: 6 }))).not.toThrow()
    expect(() => validate(nested(6), caps({ depth: 6 }))).toThrow(/deeper than 6/)
    // a bare constant nests as deep
    const vec = (k: number): unknown => (k === 0 ? 1 : [vec(k - 1)])
    expect(() => validate(['eq', ['call_arg', 0], vec(3)])).not.toThrow()
    expect(() => validate(['eq', ['call_arg', 0], vec(5)])).toThrow(/too deep/)
    expect(() => validate(['eq', ['call_arg', 0], vec(5)], caps({ depth: 6 }))).not.toThrow()
    // and so does a path step's constant key
    expect(() => validate(['eq', ['call_path', 0, vec(5)], 1])).toThrow(/too deep/)
    expect(() => validate(['eq', ['call_path', 0, vec(5)], 1], caps({ depth: 6 }))).not.toThrow()
  })

  it('bytes', () => {
    const blob = (k: number) => ['eq', ['call_arg', 0], { bytes: 'ab'.repeat(k) }]
    expect(() => validate(blob(100))).not.toThrow()
    expect(() => validate(blob(100), caps({ bytes: 100 }))).toThrow(/over 100 bytes/)
    expect(() => validate(blob(100), caps({ bytes: 200 }))).not.toThrow()
    expect(() => validate(blob(33_000))).toThrow(/over 32768 bytes/)
    expect(() => validate(blob(33_000), CEILINGS)).not.toThrow()
    expect(() => validate(blob(50_000), CEILINGS)).toThrow(WireError)
  })

  it('the steps of a path stay 8 whatever the instance', () => {
    const path = (k: number) => ['eq', ['call_path', ...Array.from({ length: k }, () => 0)], 1]
    expect(() => validate(path(8), CEILINGS)).not.toThrow()
    expect(() => validate(path(9), CEILINGS)).toThrow(/at most 8 steps/)
  })
})

describe('the tools use the instance’s limits', () => {
  type Out = {
    ok: boolean
    data?: Record<string, unknown>
    error?: { code: string; message: string }
  }
  const sel = ['eq', ['call_fn'], 'pay']
  const six = [
    'and',
    [
      sel,
      ...Array.from({ length: 6 }, (_, i) => [
        'gte',
        ['read', contract(60 + i), 'price', []],
        { i128: '0' },
      ]),
    ],
  ]
  const calls = [{ contract: contract(4), fn: 'pay', args: [] }]

  it('six reads are refused under reads 4, and checked under reads 8', async () => {
    const small = net()
    small.use()
    const no = (await run('simulate_policy', {
      network: 'mainnet',
      interpreterAddress: small.address,
      expr: six,
      calls,
    })) as Out
    expect(no.error?.code).toBe('MALFORMED_PREDICATE')
    expect(no.error?.message).toMatch(/6 distinct reads, at most 4/)
    expect(small.asked).not.toContain('check')

    const wide = net({ ...LIMITS_DEFAULT, max_reads: 8 })
    wide.use()
    const yes = (await run('simulate_policy', {
      network: 'mainnet',
      interpreterAddress: wide.address,
      expr: six,
      calls,
    })) as Out
    expect(yes.ok).toBe(true)
    expect(wide.asked).toContain('check')
  })

  it('an encoded predicate is held to them too', async () => {
    const { encode } = await import('./wire.ts')
    const wide = net({ ...LIMITS_DEFAULT, max_reads: 8 })
    wide.use()
    const ok = (await run('simulate_policy', {
      network: 'mainnet',
      interpreterAddress: wide.address,
      encodedPredicate: encode(six as never),
      calls,
    })) as Out
    expect(ok.ok).toBe(true)
  })

  it('an instance whose limits() is out of range is refused, and no verdict is asked of it', async () => {
    const f = net({ ...LIMITS_DEFAULT, max_reads: 9 })
    f.use()
    const r = (await run('simulate_policy', {
      network: 'mainnet',
      interpreterAddress: f.address,
      expr: sel,
      calls,
    })) as Out
    expect(r.error?.code).toBe('INTERPRETER_MISMATCH')
    expect(r.error?.message).toMatch(/max_reads = 9/)
    expect(f.asked).not.toContain('check')
  })

  it('get_interpreter_info shows the limits and the ceilings', async () => {
    const f = net(CUSTOM)
    f.use()
    const r = (await run('get_interpreter_info', {
      network: 'mainnet',
      interpreterAddress: f.address,
    })) as Out
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ limits: CUSTOM_CAPS, ceilings: CEILINGS })
  })

  it('get_interpreter_info with verifyLive carries them in the fingerprint, and shows none for an untrusted build', async () => {
    const f = net(CUSTOM)
    f.use()
    const r = (await run('get_interpreter_info', {
      network: 'mainnet',
      interpreterAddress: f.address,
      verifyLive: true,
    })) as Out
    expect(r.data).toMatchObject({
      limits: CUSTOM_CAPS,
      live: { matches: true, limits: CUSTOM_CAPS },
    })
    const bad = net(CUSTOM, 'ab'.repeat(32))
    bad.use()
    const b = (await run('get_interpreter_info', {
      network: 'mainnet',
      interpreterAddress: bad.address,
      verifyLive: true,
    })) as Out
    expect(b.data).toMatchObject({ limits: null, live: { matches: false } })
  })

  it('get_interpreter_info refuses an interpreter whose limits it cannot read', async () => {
    const f = net(null)
    f.use()
    const r = (await run('get_interpreter_info', {
      network: 'mainnet',
      interpreterAddress: f.address,
    })) as Out
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/limits/)
  })
})

describe('every tool that builds or installs a rule holds it to the interpreter it is for', () => {
  type Out = { ok: boolean; data?: unknown; error?: { code: string; message: string } }
  const reads = (k: number) =>
    Array.from({ length: k }, (_, i) => ({
      constraint: 'read',
      contract: contract(80 + i),
      fn: 'price',
      op: 'gte',
      to: { i128: '1' },
    }))
  const intent = { calls: [{ contract: contract(5), fn: 'pay', where: reads(6) }] }

  it('a network that pins no interpreter has none to ask: the defaults apply, and nothing is asked', async () => {
    const f = net()
    f.use()
    const r = (await run('synthesize_policy', { network: 'mainnet', intent })) as Out
    expect(r.error?.code).toBe('MALFORMED_PREDICATE')
    expect(r.error?.message).toMatch(/6 distinct reads, at most 4/)
    expect(f.asked).not.toContain('simulate limits')
  })

  it('install_policy holds an encoded predicate to the named interpreter’s limits', async () => {
    const six = encode([
      'and',
      [
        ['eq', ['call_fn'], 'pay'],
        ...Array.from({ length: 6 }, (_, i) => [
          'gte',
          ['read', contract(60 + i), 'price', []],
          { i128: '0' },
        ]),
      ],
    ] as never)
    const base = {
      network: 'mainnet',
      smartAccount: contract(3),
      sourceAccount: account(1),
      signers: [account(1)],
      encodedPredicate: six,
      contract: contract(5),
    }
    const small = net()
    small.use()
    const no = (await run('install_policy', { ...base, interpreterAddress: small.address })) as Out
    expect(no.error?.code).toBe('MALFORMED_PREDICATE')
    expect(no.error?.message).toMatch(/6 distinct reads, at most 4/)
    const wide = net({ ...LIMITS_DEFAULT, max_reads: 8 })
    wide.use()
    const yes = (await run('install_policy', { ...base, interpreterAddress: wide.address })) as Out
    // It goes on to read the account (which this network is not): not a refusal of the rule.
    expect(yes.error?.message ?? '').not.toMatch(/distinct reads/)
  })
})

describe('the install review says what the interpreter allows', () => {
  const G = account(7)
  const INT = contract(9)
  const text = (limits?: Caps) =>
    lines([authority({ signers: [G], interpreter: INT, ...(limits ? { limits } : {}) }, {})])
  const line = (t: string[]) => t.find((l) => l.includes('interpreter:')) as string

  it('names each limit beside the interpreter', () => {
    expect(line(text(CUSTOM_CAPS))).toBe(
      `└─ interpreter:  ${INT.slice(0, 6)}…${INT.slice(-6)} (reads ≤ 6, leaves ≤ 300, bytes ≤ 40000, elems ≤ 50, in ≤ 40, depth ≤ 7)`
    )
  })

  it('and, with no limits to name, is the address alone', () => {
    expect(line(text())).toBe(`└─ interpreter:  ${INT.slice(0, 6)}…${INT.slice(-6)}`)
  })
})

describe('the pins', () => {
  it('are the deployment record', async () => {
    const rec = (await Bun.file(
      new URL('../../../deployments/grammar7-testnet.json', import.meta.url)
    ).json()) as {
      interpreter: string
      wasmHashes: { interpreter: string }
      interpreterSource: { reproducibleWasmSha256: string }
      limits: Record<string, number>
    }
    expect(INTERPRETER.testnet).toEqual({
      address: rec.interpreter,
      wasmSha256: rec.wasmHashes.interpreter,
    })
    expect(rec.interpreterSource.reproducibleWasmSha256).toBe(rec.wasmHashes.interpreter)
    // limits() as the instance answered when it was deployed: what get_interpreter_info shows
    expect(rec.limits).toEqual({
      max_reads: 8,
      max_leaves: 400,
      max_predicate_bytes: 49_152,
      max_elems: 32,
      max_in_operands: 32,
      max_depth: 5,
    })
  })

  it('trust one build of the interpreter, the one this source builds', () => {
    expect([...INTERPRETER_WASM]).toEqual([OURS])
    expect(OURS).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuse the build before limits (it has no limits(), so none of its rules can be judged)', () => {
    const old = 'a975353d1c3fe5bb096c4c2bf90c7c96932df10b95c9bcfa0adbb1d2146773f1'
    expect(INTERPRETER_WASM.has(old)).toBe(false)
    expect(INTERPRETERS.has('CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV')).toBe(true)
    expect(INTERPRETER.testnet?.address).not.toBe(
      'CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV'
    )
    expect(INTERPRETERS.has(INTERPRETER.testnet?.address as string)).toBe(true)
  })
})
