// The names behind a review: a contract's interface from its wasm, a token's decimals and
// symbol, both through a local JSON-RPC server that answers like the network (and fails,
// stalls or lies on demand). Display help only, so the tests that matter are the failures:
// whatever goes wrong, `infoFor` answers with what it has and never throws.

import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Address, StrKey, xdr } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import { TOKENS } from './config.ts'
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

  it('a function or parameter named like a value (true, false, null) is not used', () => {
    for (const bad of ['true', 'false', 'null']) {
      expect(interfaceOf(wasmWith([fn(bad, [['a', Z()]])]))).toEqual({})
      expect(interfaceOf(wasmWith([fn('f', [[bad, Z()]])]))).toEqual({})
    }
    expect(Object.keys(interfaceOf(wasmWith([fn('nullable', [['trueish', Z()]])])) ?? {})).toEqual([
      'nullable',
    ])
    expect(interfaceOf(wasmWith([fn('f', [['1a', Z()]])]))).toEqual({})
  })

  it('a name used twice makes two arguments alike, so none of it is used', () => {
    // pay(amount, amount, to, to): `lte(arg0)` and `lte(arg1)` would read the same.
    expect(
      interfaceOf(
        wasmWith([
          fn('pay', [
            ['amount', I()],
            ['amount', I()],
            ['to', Z()],
          ]),
          fn('ok', [['a', Z()]]),
        ])
      )
    ).toEqual({ ok: [['a', 'address']] })
    // The same function twice: the last one would silently win.
    expect(
      interfaceOf(wasmWith([fn('pay', [['a', Z()]]), fn('pay', [['b', Z()]]), fn('ok', [])]))
    ).toEqual({ ok: [] })
    // A struct with a field twice is not walked.
    expect(
      interfaceOf(
        wasmWith([
          struct('S', [
            ['x', I()],
            ['x', Z()],
          ]),
          fn('f', [['s', udt('S')]]),
        ])
      )?.f
    ).toEqual([['s', 'udt']])
  })

  it('two types of one name (another library, another kind) are not told apart, so neither is walked', () => {
    const lib = (name: string, l: string) =>
      xdr.ScSpecEntry.scSpecEntryUdtStructV0(
        new xdr.ScSpecUdtStructV0({
          doc: '',
          lib: l,
          name,
          fields: [new xdr.ScSpecUdtStructFieldV0({ doc: '', name: 'x', type: I() })],
        })
      )
    expect(
      interfaceOf(wasmWith([lib('T', 'a'), lib('T', 'b'), fn('f', [['t', udt('T')]])]))?.f
    ).toEqual([['t', 'udt']])
    expect(
      interfaceOf(wasmWith([lib('T', 'a'), enumeration('T'), fn('f', [['t', udt('T')]])]))?.f
    ).toEqual([['t', 'udt']])
    expect(interfaceOf(wasmWith([lib('T', 'a'), fn('f', [['t', udt('T')]])]))?.f).toEqual([
      ['t', { fields: { x: 'i128' } }],
    ])
  })

  it('a hostile wasm of thousands of structs parses in about linear time: entries are looked at a bounded number of times each', () => {
    const n = 2_000
    const wasm = wasmWith([
      ...Array.from({ length: n }, (_, i) =>
        struct(`S${i}`, [['next', i + 1 < n ? udt(`S${i + 1}`) : I()]])
      ),
      fn('f', [['s', udt('S0')]]),
    ])
    // Count how often an entry of the spec is inspected. A scan per type would be n*n/2.
    const proto = xdr.ScSpecEntry.prototype as unknown as { switch: () => unknown }
    const original = proto.switch
    let looks = 0
    proto.switch = function (this: unknown) {
      looks++
      return original.call(this)
    }
    try {
      expect(interfaceOf(wasm)?.f).toBeDefined()
    } finally {
      proto.switch = original
    }
    expect(looks).toBeGreaterThan(n) // it does look
    expect(looks).toBeLessThan(6 * n)
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
    expect(pad(131_072)).toHaveLength(131_072)
    expect(interfaceOf(pad(131_072))).not.toBeNull()
    expect(interfaceOf(pad(131_073))).toBeNull()
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
    expect(interfaceOf(Buffer.alloc(140_000))).toBeNull()
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
  /** contract -> what its `name()` answers: a string, a number (a wrong type), `'fail'` for a
   *  dropped connection; absent for a contract error. */
  names?: Record<string, string | number>
  /** What to do with the next getLedgerEntries: fail, or hang. */
  mode?: 'fail' | 'hang' | undefined
  /** Milliseconds each simulation takes. */
  delay?: number
  /** Milliseconds each read of a wasm takes. */
  codeDelay?: number
}

function network(f: Fake) {
  const calls = { instances: 0, codes: 0, sims: 0, keys: 0, running: 0, peak: 0, codeRunning: 0 }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params: any }
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
      if (f.mode === 'hang') return new Promise<Response>(() => undefined)
      if (f.mode === 'fail')
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: 'down' } })
      if (body.method === 'getLedgerEntries') {
        const reads = xdr.LedgerKey.fromXDR((body.params.keys as string[])[0] as string, 'base64')
        if (f.codeDelay && reads.switch().name === 'contractCode') {
          calls.peak = Math.max(calls.peak, ++calls.codeRunning)
          await Bun.sleep(f.codeDelay)
          calls.codeRunning--
        }
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
        const answer = f.names?.[id]
        if (answer === 'fail') return new Response('', { status: 503 })
        if (answer === undefined)
          return reply({ latestLedger: 1, error: 'HostError: Error(Contract, #1)' })
        const val =
          typeof answer === 'number' ? xdr.ScVal.scvU32(answer) : xdr.ScVal.scvString(answer)
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

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const circle = `USDC:${ISSUER}`
const short = `USDC:${ISSUER}`

describe('what is known of a contract', () => {
  // Contracts and wasm hashes are distinct per test: the caches live as long as the process.
  it('a wasm contract: its interface, and no token unit it only claims for itself', async () => {
    const [tok, other] = [contract(21), contract(22)]
    const n = open({
      instances: { [tok]: hashOf(21), [other]: hashOf(22) },
      wasms: { [hashOf(21)]: wasmWith(spec), [hashOf(22)]: wasmWith([fn('f', [['a', Z()]])]) },
      names: { [tok]: 'USDC', [other]: 'X' },
    })
    const got = await infoFor(n.endpoint, [tok, other, tok])
    // `tok` has decimals() and symbol() in its spec: it would say whatever it likes.
    expect(got[tok]?.token).toBeUndefined()
    expect(got[tok]?.fns?.pay?.[0]?.[0]).toBe('payments')
    expect(got[other]).toEqual({ fns: { f: [['a', 'address']] }, token: undefined })
    expect(n.calls).toMatchObject({ instances: 2, codes: 2, sims: 0 })
  })

  it('a wasm token the package lists is in its listed unit; nothing else is asked of it', async () => {
    const tok = unique(5000)
    TOKENS.testnet[tok] = { decimals: 6, symbol: 'LISTED' }
    try {
      const n = open({ instances: { [tok]: hashOf(23) }, wasms: { [hashOf(23)]: wasmWith(spec) } })
      expect((await infoFor(n.endpoint, [tok]))[tok]?.token).toEqual({
        decimals: 6,
        symbol: 'LISTED',
      })
      expect(n.calls.sims).toBe(0)
      expect(TOKENS.mainnet).toEqual({})
    } finally {
      delete TOKENS.testnet[tok]
    }
  })

  it('a Stellar Asset Contract: the SEP-41 table, 7 decimals, named CODE:ISSUER by name()', async () => {
    const sac = unique(5001)
    const n = open({ instances: { [sac]: '' }, wasms: {}, names: { [sac]: circle } })
    const got = await infoFor(n.endpoint, [sac])
    expect(got[sac]).toEqual({ fns: SAC, token: { decimals: 7, symbol: short } })
    expect(n.calls).toMatchObject({ codes: 0, sims: 1 }) // one read: name(), not decimals()
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

  it('an asset code may hold digits', async () => {
    const sac = unique(5004)
    const n = open({ instances: { [sac]: '' }, wasms: {}, names: { [sac]: `Z9X25:${ISSUER}` } })
    expect((await infoFor(n.endpoint, [sac]))[sac]?.token?.symbol).toBe(`Z9X25:${ISSUER}`)
  })

  it('a one-character asset code is a code', async () => {
    const sac = unique(5003)
    const n = open({ instances: { [sac]: '' }, wasms: {}, names: { [sac]: `A:${ISSUER}` } })
    expect((await infoFor(n.endpoint, [sac]))[sac]?.token?.symbol).toBe(`A:${ISSUER}`)
  })

  it('the native asset is `native`', async () => {
    const xlm = unique(5002)
    const n = open({ instances: { [xlm]: '' }, wasms: {}, names: { [xlm]: 'native' } })
    expect((await infoFor(n.endpoint, [xlm]))[xlm]?.token).toEqual({
      decimals: 7,
      symbol: 'native',
    })
  })

  const odd: [string, string | number][] = [
    ['a name that is not CODE:ISSUER', 'USDC'],
    ['a code that is too long', `ABCDEFGHIJKLM:${ISSUER}`],
    [
      'an issuer with a character that is not base32',
      `USDC:${ISSUER.slice(0, 10)}8${ISSUER.slice(11)}`,
    ],
    [
      'an issuer that is not an account',
      'USDC:CBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    ],
    ['a line break', `US\nDC:${ISSUER}`],
    ['a wrong type', 7],
  ]
  for (const [i, [what, name]] of odd.entries())
    it(`${what}: the amounts stay raw`, async () => {
      const c = unique(5100 + i)
      const n = open({ instances: { [c]: '' }, wasms: {}, names: { [c]: name } })
      expect((await infoFor(n.endpoint, [c]))[c]).toEqual({ fns: SAC, token: undefined })
    })

  it('a wrong-typed answer is an answer: kept, not asked again', async () => {
    const c = unique(5150)
    const n = open({ instances: { [c]: '' }, wasms: {}, names: { [c]: 7 } })
    await infoFor(n.endpoint, [c])
    await infoFor(n.endpoint, [c])
    expect(n.calls.sims).toBe(1)
  })

  it('a token is known per network: the same address on another network is asked again', async () => {
    const c = unique(5151)
    const [test, main] = [
      open({ instances: { [c]: '' }, wasms: {}, names: { [c]: circle } }),
      open({ instances: { [c]: '' }, wasms: {}, names: { [c]: 'native' } }),
    ]
    const there = { network: 'mainnet' as const, rpcUrl: main.endpoint.rpcUrl }
    expect((await infoFor(test.endpoint, [c]))[c]?.token?.symbol).toBe(short)
    expect((await infoFor(there, [c]))[c]?.token?.symbol).toBe('native')
    expect((await infoFor(test.endpoint, [c]))[c]?.token?.symbol).toBe(short)
  })

  it('one contract that answers wrongly or fails does not take the names of the others', async () => {
    const ids = [unique(5200), unique(5201), unique(5202), unique(5203)]
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      names: { [ids[0] as string]: 7, [ids[1] as string]: 'fail', [ids[3] as string]: circle },
    })
    const got = await infoFor(n.endpoint, ids)
    expect(ids.map((c) => got[c]?.fns === SAC)).toEqual([true, true, true, true])
    expect(got[ids[3] as string]?.token?.symbol).toBe(short)
    expect(got[ids[0] as string]?.token).toBeUndefined()
  })

  it('a refusal is an answer and is kept; a dropped connection is not, and is asked again', async () => {
    const [refused, flaky] = [unique(5300), unique(5301)]
    const n = open({
      instances: { [refused]: '', [flaky]: '' },
      wasms: {},
      names: { [flaky]: 'fail' },
    })
    await infoFor(n.endpoint, [refused, flaky])
    await infoFor(n.endpoint, [refused, flaky])
    expect(n.calls.sims).toBe(3) // refused once, flaky twice
    const again = open({ instances: { [flaky]: '' }, wasms: {}, names: { [flaky]: circle } })
    expect((await infoFor(again.endpoint, [flaky]))[flaky]?.token?.symbol).toBe(short)
  })

  it('a spec is read once per wasm, a token once, for the life of the process', async () => {
    const [a, b, s] = [contract(24), contract(25), unique(5400)]
    const n = open({
      instances: { [a]: hashOf(24), [b]: hashOf(24), [s]: '' },
      wasms: { [hashOf(24)]: wasmWith(spec) },
      names: { [s]: circle },
    })
    await infoFor(n.endpoint, [a, s])
    await infoFor(n.endpoint, [a, b, s])
    expect(n.calls.codes).toBe(1)
    expect(n.calls.sims).toBe(1)
  })

  it('a contract that is not there, a wasm that is not there, a wasm too big: names missing, nothing thrown', async () => {
    const [gone, nocode, big] = [contract(29), contract(30), contract(31)]
    const n = open({
      instances: { [nocode]: hashOf(30), [big]: hashOf(31) },
      wasms: { [hashOf(31)]: Buffer.alloc(140_000) },
    })
    const got = await infoFor(n.endpoint, [gone, nocode, big])
    expect(got[gone]).toBeUndefined()
    expect(got[nocode]?.fns).toBeUndefined()
    expect(got[big]?.fns).toBeUndefined()
  })

  it('at most sixteen contracts, and none at all costs nothing', async () => {
    const all = Array.from({ length: 20 }, (_, i) => unique(5500 + i))
    const n = open({ instances: Object.fromEntries(all.map((c) => [c, ''])), wasms: {} })
    const got = await infoFor(n.endpoint, all)
    expect(Object.keys(got)).toHaveLength(16)
    expect(n.calls.instances).toBe(16)
    expect(await infoFor(n.endpoint, [])).toEqual({})
  })

  it('the token cache is bounded: the oldest goes first', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => unique(6000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      names: Object.fromEntries(ids.map((c) => [c, circle])),
    })
    for (let i = 0; i < ids.length; i += 16) await infoFor(n.endpoint, ids.slice(i, i + 16))
    expect(n.calls.sims).toBe(80)
    await infoFor(n.endpoint, ids.slice(-1)) // the newest is still known
    await infoFor(n.endpoint, ids.slice(16, 17)) // so is the 64th from the end
    expect(n.calls.sims).toBe(80)
    await infoFor(n.endpoint, ids.slice(15, 16)) // the one before it was dropped
    expect(n.calls.sims).toBe(81)
  })

  it('reads go a few at a time, never all at once', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => unique(7000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      names: Object.fromEntries(ids.map((c) => [c, circle])),
      delay: 20,
    })
    await infoFor(n.endpoint, ids)
    expect(n.calls.sims).toBe(12)
    expect(n.calls.peak).toBeLessThanOrEqual(4)
  })

  it('wasm reads go a few at a time too', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => unique(9000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c, i) => [c, hashOf(60 + i)])),
      wasms: Object.fromEntries(ids.map((_, i) => [hashOf(60 + i), wasmWith([fn(`f${i}`, [])])])),
      codeDelay: 30,
    })
    const got = await infoFor(n.endpoint, ids)
    expect(Object.keys(got)).toHaveLength(10)
    expect(n.calls.codes).toBe(10)
    expect(n.calls.peak).toBeLessThanOrEqual(4)
    expect(n.calls.peak).toBeGreaterThan(1)
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

  it('an abort stops the reads that have not started', async () => {
    const ids = Array.from({ length: 16 }, (_, i) => unique(8000 + i))
    const n = open({
      instances: Object.fromEntries(ids.map((c) => [c, ''])),
      wasms: {},
      names: Object.fromEntries(ids.map((c) => [c, circle])),
      delay: 150,
    })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 60)
    await infoFor(n.endpoint, ids, ctl.signal)
    await Bun.sleep(400)
    expect(n.calls.sims).toBeLessThanOrEqual(4) // the first four were under way; no more start
  })

  it('a hung server costs no more than the wait (2 s)', async () => {
    const c = contract(72)
    const hung = open({ instances: { [c]: '' }, wasms: {}, mode: 'hang' })
    const t = Date.now()
    expect(await infoFor(hung.endpoint, [c])).toEqual({})
    expect(Date.now() - t).toBeGreaterThanOrEqual(1_900)
    expect(Date.now() - t).toBeLessThan(3_000)
  })
})
