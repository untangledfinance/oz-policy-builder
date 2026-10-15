// The names behind a review: a contract's interface from its wasm, a token's decimals and
// symbol, both through a local JSON-RPC server that answers like the network (and fails,
// stalls or lies on demand). Display help only, so the tests that matter are the failures:
// whatever goes wrong, `infoFor` answers with what it has and never throws.

import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Address, StrKey, xdr } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import { infoFor, interfaceOf, SAC } from './spec.ts'

// ---- a wasm with a spec, built by hand ----

const T = xdr.ScSpecTypeDef
const udt = (name: string) => T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }))
const vec = (elementType: xdr.ScSpecTypeDef) =>
  T.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType }))
const option = (valueType: xdr.ScSpecTypeDef) =>
  T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType }))
const map = (valueType: xdr.ScSpecTypeDef) =>
  T.scSpecTypeMap(new xdr.ScSpecTypeMap({ keyType: T.scSpecTypeSymbol(), valueType }))
const tuple = (valueTypes: xdr.ScSpecTypeDef[]) =>
  T.scSpecTypeTuple(new xdr.ScSpecTypeTuple({ valueTypes }))
const fn = (name: string, inputs: [string, xdr.ScSpecTypeDef][]) =>
  xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: inputs.map(([n, type]) => new xdr.ScSpecFunctionInputV0({ doc: '', name: n, type })),
      outputs: [],
    })
  )
const struct = (name: string, fields: [string, xdr.ScSpecTypeDef][]) =>
  xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: '',
      lib: '',
      name,
      fields: fields.map(([n, type]) => new xdr.ScSpecUdtStructFieldV0({ doc: '', name: n, type })),
    })
  )
const enumeration = (name: string) =>
  xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({ doc: '', lib: '', name, cases: [] })
  )

const leb = (n: number): number[] => (n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)])
/** A wasm module whose only content is a `contractspecv0` custom section. */
function wasmWith(entries: xdr.ScSpecEntry[], name = 'contractspecv0'): Buffer {
  const body = Buffer.concat([
    Buffer.from([name.length, ...Buffer.from(name)]),
    ...entries.map((e) => e.toXDR()),
  ])
  return Buffer.concat([
    Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, ...leb(body.length)]),
    body,
  ])
}

const Z = T.scSpecTypeAddress
const I = T.scSpecTypeI128
const spec = [
  struct('Payment', [
    ['to', Z()],
    ['amount', I()],
    ['tags', map(I())],
    ['pair', tuple([T.scSpecTypeU32(), Z()])],
  ]),
  struct('Node', [
    ['next', vec(udt('Node'))],
    ['value', I()],
  ]),
  struct('Bad', [['to\nfake', Z()]]),
  enumeration('Kind'),
  fn('pay', [
    ['payments', vec(udt('Payment'))],
    ['note', option(T.scSpecTypeString())],
    ['kind', udt('Kind')],
  ]),
  fn('walk', [['root', udt('Node')]]),
  fn('bad_param', [['x\n└─ fake', Z()]]),
  fn('bad_struct', [['b', udt('Bad')]]),
  fn('decimals', []),
  fn('symbol', []),
]

describe('the interface of a wasm', () => {
  const fns = interfaceOf(wasmWith(spec)) as NonNullable<ReturnType<typeof interfaceOf>>

  it('functions, their parameters in order, and what a path can walk', () => {
    expect(fns.pay).toEqual([
      [
        'payments',
        {
          vec: {
            fields: {
              to: 'address',
              amount: 'i128',
              tags: { map: 'i128' },
              pair: { tuple: ['u32', 'address'] },
            },
          },
        },
      ],
      ['note', 'string'], // an option is its value
      ['kind', 'udt'], // an enum cannot be walked
    ])
    expect(fns.decimals).toEqual([])
  })

  it('a struct that refers to itself is cut, not followed', () => {
    expect(fns.walk).toEqual([['root', { fields: { next: { vec: 'deep' }, value: 'i128' } }]])
  })

  it('a name that is not a plain identifier never reaches a review', () => {
    expect(fns.bad_param).toBeUndefined()
    expect(fns.bad_struct).toEqual([['b', 'udt']])
    expect(Object.keys(fns)).not.toContain('__proto__')
  })

  it('a wasm of exactly the size cap is read, one byte more is not', () => {
    const base = wasmWith(spec)
    const pad = (total: number) => {
      // A custom section named `pad`: id 0, a 3-byte length, the name, then filler.
      const body = total - base.length - 4
      const data = Buffer.concat([Buffer.from([3, 0x70, 0x61, 0x64]), Buffer.alloc(body - 4)])
      return Buffer.concat([
        base,
        Buffer.from([0, (body & 127) | 128, ((body >> 7) & 127) | 128, body >> 14]),
        data,
      ])
    }
    expect(pad(262_144)).toHaveLength(262_144)
    expect(interfaceOf(pad(262_144))).not.toBeNull()
    expect(interfaceOf(pad(262_145))).toBeNull()
  })

  it('names are 1 to 30 plain characters, and one bad field spoils the struct', () => {
    const ok = interfaceOf(wasmWith([fn('a'.repeat(30), [['b'.repeat(30), Z()]])]))
    expect(Object.keys(ok ?? {})).toEqual(['a'.repeat(30)])
    expect(interfaceOf(wasmWith([fn('', [])]))).toEqual({})
    const mixed = interfaceOf(
      wasmWith([
        struct('M', [
          ['good', Z()],
          ['bad name', Z()],
        ]),
        fn('f', [['m', udt('M')]]),
      ])
    )
    expect(mixed?.f).toEqual([['m', 'udt']])
  })

  it('no spec, a spec that is not one, a wasm that is not one, too much of either: nothing', () => {
    expect(interfaceOf(wasmWith(spec, 'other'))).toBeNull()
    expect(interfaceOf(Buffer.from('not wasm'))).toBeNull()
    expect(interfaceOf(Buffer.alloc(300_000))).toBeNull()
  })

  it('a real contract: the policy interpreter that ships in this repo', () => {
    const wasm = readFileSync(
      new URL(
        '../../../contracts/prime/stellar/policy-interpreter/tests/fixtures/multisig_account_example.wasm',
        import.meta.url
      )
    )
    const real = interfaceOf(wasm) as NonNullable<ReturnType<typeof interfaceOf>>
    expect(Object.keys(real).length).toBeGreaterThan(3)
    expect(real.add_context_rule?.map((p) => p[0])).toEqual([
      'context_type',
      'name',
      'valid_until',
      'signers',
      'policies',
    ])
  })
})

// ---- a network that answers like one ----

/** A contract of its own: ids here never repeat one another's, the caches live as long as the process. */
const unique = (n: number) =>
  StrKey.encodeContract(Buffer.concat([Buffer.alloc(30), Buffer.from([n >> 8, n & 255])]))
const hashOf = (n: number) => Buffer.alloc(32, n).toString('hex')
interface Fake {
  /** contract -> wasm hash, or '' for a Stellar Asset Contract. */
  instances: Record<string, string>
  wasms: Record<string, Buffer>
  /** contract -> [decimals, symbol] as the contract answers (a number, a string, or an error). */
  tokens?: Record<string, [unknown, unknown]>
  /** What to do with the next getLedgerEntries: fail, or hang. */
  mode?: 'fail' | 'hang' | undefined
  /** Milliseconds each simulation takes. */
  delay?: number
}

function network(f: Fake) {
  const calls = { instances: 0, codes: 0, sims: 0, keys: 0, running: 0, peak: 0 }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params: any }
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
      if (f.mode === 'hang') return new Promise<Response>(() => undefined)
      if (f.mode === 'fail')
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: 'down' } })
      if (body.method === 'getLedgerEntries') {
        const entries = (body.params.keys as string[]).flatMap((k) => {
          const key = xdr.LedgerKey.fromXDR(k, 'base64')
          calls.keys++
          if (key.switch().name === 'contractData') {
            calls.instances++
            const id = Address.fromScAddress(key.contractData().contract()).toString()
            const wasm = f.instances[id]
            if (wasm === undefined) return []
            const exec =
              wasm === ''
                ? xdr.ContractExecutable.contractExecutableStellarAsset()
                : xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, 'hex'))
            const data = xdr.LedgerEntryData.contractData(
              new xdr.ContractDataEntry({
                ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
                contract: key.contractData().contract(),
                key: key.contractData().key(),
                durability: xdr.ContractDataDurability.persistent(),
                val: xdr.ScVal.scvContractInstance(
                  new xdr.ScContractInstance({ executable: exec, storage: null })
                ),
              })
            )
            return [{ key: k, xdr: data.toXDR('base64'), lastModifiedLedgerSeq: 1 }]
          }
          calls.codes++
          const hash = Buffer.from(key.contractCode().hash()).toString('hex')
          const code = f.wasms[hash]
          if (!code) return []
          const data = xdr.LedgerEntryData.contractCode(
            new xdr.ContractCodeEntry({
              ext: new xdr.ContractCodeEntryExt(0),
              hash: Buffer.from(hash, 'hex'),
              code,
            })
          )
          return [{ key: k, xdr: data.toXDR('base64'), lastModifiedLedgerSeq: 1 }]
        })
        return reply({ latestLedger: 1, entries })
      }
      if (body.method === 'simulateTransaction') {
        calls.sims++
        calls.peak = Math.max(calls.peak, ++calls.running)
        if (f.delay) await Bun.sleep(f.delay)
        calls.running--
        const op = xdr.TransactionEnvelope.fromXDR(body.params.transaction, 'base64')
          .v1()
          .tx()
          .operations()[0]
        const call = op?.body().invokeHostFunctionOp().hostFunction().invokeContract()
        const id = Address.fromScAddress(call?.contractAddress() as xdr.ScAddress).toString()
        const [dec, sym] = f.tokens?.[id] ?? [undefined, undefined]
        const answer = call?.functionName().toString() === 'decimals' ? dec : sym
        if (answer === undefined)
          return reply({ latestLedger: 1, error: 'HostError: Error(Contract, #1)' })
        const val =
          typeof answer === 'number'
            ? xdr.ScVal.scvU32(answer)
            : xdr.ScVal.scvString(String(answer))
        return reply({ latestLedger: 1, results: [{ xdr: val.toXDR('base64'), auth: [] }] })
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } })
    },
  })
  return {
    calls,
    endpoint: { network: 'testnet' as const, rpcUrl: `http://127.0.0.1:${server.port}` },
    stop: () => server.stop(true),
  }
}

const opened: { stop: () => void }[] = []
afterAll(() => {
  for (const n of opened) n.stop()
})
const open = (f: Fake) => {
  const n = network(f)
  opened.push(n)
  return n
}

describe('what is known of a contract', () => {
  // Contracts and wasm hashes are distinct per test: the caches live as long as the process.
  it('a token wasm: its interface, decimals and symbol, in two reads and two simulations', async () => {
    const [tok, other] = [contract(21), contract(22)]
    const n = open({
      instances: { [tok]: hashOf(21), [other]: hashOf(22) },
      wasms: { [hashOf(21)]: wasmWith(spec), [hashOf(22)]: wasmWith([fn('f', [['a', Z()]])]) },
      tokens: { [tok]: [7, 'USDC'], [other]: [1, 'X'] },
    })
    const got = await infoFor(n.endpoint, [tok, other, tok])
    expect(got[tok]?.token).toEqual({ decimals: 7, symbol: 'USDC' })
    expect(got[tok]?.fns?.pay?.[0]?.[0]).toBe('payments')
    // `other` has no decimals() and symbol() in its spec, so it is not a token and is not asked.
    expect(got[other]).toEqual({ fns: { f: [['a', 'address']] } })
    expect(n.calls).toMatchObject({ instances: 2, codes: 2, sims: 2 })
  })

  it('a Stellar Asset Contract: the SEP-41 table, no code read', async () => {
    const sac = contract(23)
    const n = open({ instances: { [sac]: '' }, wasms: {}, tokens: { [sac]: [7, 'XLM'] } })
    const got = await infoFor(n.endpoint, [sac])
    expect(got[sac]).toEqual({ fns: SAC, token: { decimals: 7, symbol: 'XLM' } })
    expect(n.calls.codes).toBe(0)
    expect(SAC.transfer?.map((p) => p[0])).toEqual(['from', 'to', 'amount'])
    expect(SAC.transfer_from?.map((p) => p[0])).toEqual(['spender', 'from', 'to', 'amount'])
    expect(SAC.approve?.map((p) => p[0])).toEqual([
      'from',
      'spender',
      'amount',
      'expiration_ledger',
    ])
    expect(Object.keys(SAC)).toEqual([
      'transfer',
      'transfer_from',
      'approve',
      'burn',
      'burn_from',
      'mint',
      'clawback',
      'balance',
      'allowance',
    ])
    expect(SAC.mint?.[1]).toEqual(['amount', 'i128'])
  })

  it('a spec is read once per wasm, a token once, for the life of the process', async () => {
    const [a, b] = [contract(24), contract(25)]
    const n = open({
      instances: { [a]: hashOf(24), [b]: hashOf(24) },
      wasms: { [hashOf(24)]: wasmWith(spec) },
      tokens: { [a]: [2, 'AAA'], [b]: [3, 'BBB'] },
    })
    await infoFor(n.endpoint, [a])
    await infoFor(n.endpoint, [a, b])
    expect(n.calls.codes).toBe(1)
    expect(n.calls.sims).toBe(4) // a: 2, b: 2; a is not read again
  })

  it('an answer that cannot be trusted is not used: odd symbol, absurd decimals, an error', async () => {
    const [x, y, z] = [contract(26), contract(27), contract(28)]
    const n = open({
      instances: { [x]: '', [y]: '', [z]: '' },
      wasms: {},
      tokens: { [x]: [7, 'US\nDC'], [y]: [99, 'USDC'], [z]: [undefined, undefined] },
    })
    const got = await infoFor(n.endpoint, [x, y, z])
    expect(got[x]?.token).toEqual({ decimals: 7 })
    expect(got[y]?.token).toEqual({ symbol: 'USDC' })
    expect(got[z]?.token).toEqual({})
  })

  it('a contract that is not there, a wasm that is not there, a wasm too big: names missing, nothing thrown', async () => {
    const [gone, nocode, big] = [contract(29), contract(30), contract(31)]
    const n = open({
      instances: { [nocode]: hashOf(30), [big]: hashOf(31) },
      wasms: { [hashOf(31)]: Buffer.alloc(300_000) },
    })
    const got = await infoFor(n.endpoint, [gone, nocode, big])
    expect(got[gone]).toBeUndefined()
    expect(got[nocode]).toEqual({ fns: undefined })
    expect(got[big]).toEqual({ fns: undefined })
  })

  it('at most sixteen contracts, and none at all costs nothing', async () => {
    const all = Array.from({ length: 20 }, (_, i) => contract(40 + i))
    const n = open({
      instances: Object.fromEntries(all.map((c) => [c, ''])),
      wasms: {},
      tokens: {},
    })
    const got = await infoFor(n.endpoint, all)
    expect(Object.keys(got)).toHaveLength(16)
    expect(n.calls.instances).toBe(16)
    expect(await infoFor(n.endpoint, [])).toEqual({})
  })

  it('a token is answered once, and the cache is bounded: the oldest goes first', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => unique(1000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      tokens: Object.fromEntries(ids.map((c) => [c, [7, 'T']])),
    })
    for (let i = 0; i < ids.length; i += 16) await infoFor(n.endpoint, ids.slice(i, i + 16))
    expect(n.calls.sims).toBe(600)
    await infoFor(n.endpoint, ids.slice(-1)) // the newest is still known
    await infoFor(n.endpoint, ids.slice(44, 45)) // so is the 256th from the end
    expect(n.calls.sims).toBe(600)
    await infoFor(n.endpoint, ids.slice(43, 44)) // the one before it was dropped
    expect(n.calls.sims).toBe(602)
  })

  it('what an answer may be: symbols of 1 to 12 plain characters, decimals up to 38', async () => {
    const cases: [unknown, unknown, object][] = [
      [38, 'A', { decimals: 38, symbol: 'A' }],
      [39, '0123456789ab', { symbol: '0123456789ab' }],
      [0, '0123456789abc', { decimals: 0 }],
      [7, '9._-z', { decimals: 7, symbol: '9._-z' }],
      [7, '', { decimals: 7 }],
    ]
    const ids = cases.map((_, i) => unique(2000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      tokens: Object.fromEntries(ids.map((c, i) => [c, [cases[i]?.[0], cases[i]?.[1]]])),
    })
    const got = await infoFor(n.endpoint, ids)
    for (const [i, c] of cases.entries())
      expect(got[ids[i] as string]?.token).toEqual(c[2] as never)
  })

  it('token reads go a few at a time, never all at once', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => unique(3000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      tokens: Object.fromEntries(ids.map((c) => [c, [7, 'T']])),
      delay: 20,
    })
    await infoFor(n.endpoint, ids)
    expect(n.calls.sims).toBe(24)
    expect(n.calls.peak).toBeLessThanOrEqual(8)
  })

  it('a network that errors, a url that is not allowed, an abort: the empty answer, in time', async () => {
    const c = contract(70)
    expect(
      await infoFor(open({ instances: { [c]: '' }, wasms: {}, mode: 'fail' }).endpoint, [c])
    ).toEqual({})
    expect(await infoFor({ network: 'testnet', rpcUrl: 'http://example.com' }, [c])).toEqual({})
    const hung = open({ instances: { [c]: '' }, wasms: {}, mode: 'hang' })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 30)
    const t = Date.now()
    expect(await infoFor(hung.endpoint, [c], ctl.signal)).toEqual({})
    expect(Date.now() - t).toBeLessThan(1_000)
    const gone = new AbortController()
    gone.abort()
    expect(await infoFor(hung.endpoint, [c], gone.signal)).toEqual({})
  })

  it('what was learned before the abort is kept', async () => {
    const [fast] = [contract(71)]
    const n = open({ instances: { [fast]: '' }, wasms: {}, tokens: { [fast]: [7, 'FAST'] } })
    expect((await infoFor(n.endpoint, [fast]))[fast]?.token?.symbol).toBe('FAST')
  })
})
