import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { PASSPHRASE, SAFE_READS, SPENDING_LIMIT, thresholdAddress } from './config.ts'
import { buildInstall, buildRevoke, type RuleDraft, ruleArgs } from './install.ts'
import { callExpr } from './intent.ts'
import { type Expr, encode, hashOf } from './wire.ts'

const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const TOKEN = contract(7)
const INTERP = interpreterFor('testnet')
const expr = callExpr({
  contract: TOKEN,
  fn: 'transfer',
  where: [{ constraint: 'cap', at: [2], max: '500' }],
})
const encoded = encode(expr)

const draft = (o: Partial<RuleDraft> = {}): RuleDraft => ({
  scope: { kind: 'call_contract', contract: TOKEN },
  name: 'cap-500',
  validUntil: null,
  signers: [SIGNER],
  admins: [SIGNER],
  predicate: { encoded, hash: hashOf(encoded) },
  nonce: 1,
  ...o,
})

describe('ruleArgs: add_context_rule, as wire values', () => {
  it('scope, name, expiry, signers, and the interpreter install parameters', () => {
    const [scope, name, until, signers, policies] = ruleArgs(draft({ validUntil: 123 }), INTERP)
    expect(scope).toEqual(['CallContract', TOKEN])
    expect(name).toEqual({ string: 'cap-500' })
    expect(until).toBe(123)
    expect(signers).toEqual([['Delegated', SIGNER]])
    expect(policies).toEqual({
      map: [
        [
          INTERP,
          {
            map: [
              ['grammar_version', 7],
              ['install_nonce', 1],
              ['policy_admins', [['Delegated', SIGNER]]],
              ['predicate', { bytes: Buffer.from(encoded, 'base64').toString('hex') }],
              ['predicate_hash', { bytes: hashOf(encoded) }],
            ],
          },
        ],
      ],
    })
  })

  it('a rolling total is a second policy on the same rule, with its own parameters', () => {
    const cap = { address: SPENDING_LIMIT.testnet, amount: '900', periodLedgers: 17280 }
    const [, , , , policies] = ruleArgs(draft({ cap }), INTERP) as [
      unknown,
      unknown,
      unknown,
      unknown,
      { map: [string, unknown][] },
    ]
    expect(policies.map).toHaveLength(2)
    const limit = policies.map.find(([a]) => a === cap.address)?.[1]
    expect(limit).toEqual({
      map: [
        ['period_ledgers', 17280],
        ['spending_limit', { i128: '900' }],
      ],
    })
  })

  it('another policy is another entry of the policies map, as given', () => {
    const extra = [[thresholdAddress('testnet', false), { map: [['threshold', 2]] }]]
    const [, , , , policies] = ruleArgs(
      draft({ signers: [SIGNER, account(2)], extra: extra as never }),
      INTERP
    ) as [unknown, unknown, unknown, unknown, { map: [string, unknown][] }]
    expect(policies.map).toHaveLength(2)
    expect(policies.map.find(([a]) => a === extra[0]?.[0])?.[1]).toEqual({
      map: [['threshold', 2]],
    })
  })

  it('other scopes', () => {
    expect(ruleArgs(draft({ scope: { kind: 'default' } }), INTERP)[0]).toEqual(['Default'])
    expect(
      ruleArgs(draft({ scope: { kind: 'create_contract', wasmHash: 'ab'.repeat(32) } }), INTERP)[0]
    ).toEqual(['CreateContract', { bytes: 'ab'.repeat(32) }])
  })

  it.each<[string, Partial<RuleDraft>, RegExp]>([
    ['no signer', { signers: [] }, /no signer/],
    [
      'sixteen signers',
      { signers: Array.from({ length: 16 }, (_, i) => account(i + 1)) },
      /allows 15/,
    ],
    ['no admin', { admins: [] }, /no policy admin/],
  ])('refuses %s before any round trip', (_n, o, msg) =>
    expect(() => ruleArgs(draft(o), INTERP)).toThrow(msg)
  )
})

// ---- built against a live testnet account, recorded ----

const net = recorded('install')
afterAll(() => net.stop())
const server = connect(net.endpoint)
const args = { server, network: 'testnet' as const, smartAccount: ACCOUNT, sourceAccount: SIGNER }

describe('buildInstall and buildRevoke, on a live account', () => {
  it('the interpreter and the account accept the rule; the unsigned bytes say what they call', async () => {
    const built = await buildInstall(args, draft({ name: 'cap-500', nonce: 1 }), INTERP)
    expect(built.describes).toEqual({
      contract: ACCOUNT,
      fn: 'add_context_rule',
      args: ruleArgs(draft(), INTERP),
    })
    expect(built.unsignedXdrLength).toBe(built.unsignedXdr.length)
    expect(built.unsignedXdrSha256).toBe(
      createHash('sha256').update(built.unsignedXdr).digest('hex')
    )
    const tx = TransactionBuilder.fromXDR(built.unsignedXdr, PASSPHRASE.testnet)
    expect(tx.signatures).toHaveLength(0)
    expect(built.authValidUntilLedger).toBeGreaterThan(0)
  })

  it('bids the base fee once beside the resource fee (not twice: assembling adds it and so does build)', async () => {
    const feeOf = async (baseFee?: number) => {
      const built = await buildInstall(
        { ...args, baseFee },
        draft({ name: 'cap-500', nonce: 1 }),
        INTERP
      )
      const tx = TransactionBuilder.fromXDR(built.unsignedXdr, PASSPHRASE.testnet)
      const data = tx.toEnvelope().v1().tx().ext().sorobanData()
      return { fee: Number(tx.fee), resource: Number(data.resourceFee()) }
    }
    const plain = await feeOf()
    expect(plain.resource).toBeGreaterThan(0)
    expect(plain.fee).toBe(100 + plain.resource)
    const high = await feeOf(5000)
    expect(high.fee).toBe(5000 + high.resource)
  })

  it('the interpreter refuses what it refuses, and the code comes back', async () => {
    const def = buildInstall(args, draft({ scope: { kind: 'default' } }), INTERP)
    await expect(def).rejects.toThrow(/#218/)
    const dup = buildInstall(args, draft({ nonce: 5 }), INTERP)
    await expect(dup).rejects.toThrow(/#202/)
  })

  it('a revoke is the account removing a rule it has; one it does not have is refused', async () => {
    const ok = await buildRevoke(args, 1)
    expect(ok.describes).toEqual({ contract: ACCOUNT, fn: 'remove_context_rule', args: [1] })
    await expect(buildRevoke(args, 99)).rejects.toThrow(/#3000/)
  })
})

// ---- every refusal an install can meet, with a chain that answers as told ----

import type { Fingerprint } from './chain.ts'
import { POLICY_CONTRACTS } from './config.ts'
import { Refusal } from './envelope.ts'
import {
  type Chain,
  type Chosen,
  type InstallInput,
  planInstall,
  planRevoke,
  type RevokeChain,
} from './install.ts'
import type { ObservedRule } from './rules.ts'

describe('planInstall: the guards', () => {
  const ours: Fingerprint = {
    address: INTERP,
    grammarVersion: 7,
    wasmSha256: 'a'.repeat(64),
    matches: true,
  }
  const rule: Chosen = { contract: TOKEN, expr, encoded, hash: hashOf(encoded) }
  const input: InstallInput = {
    network: 'testnet',
    smartAccount: ACCOUNT,
    sourceAccount: SIGNER,
    signers: [SIGNER],
  }
  const built = { unsignedXdr: 'AAAA' } as never
  const chain = (
    o: Partial<Chain> & { rules?: ObservedRule[]; complete?: boolean } = {}
  ): Chain => ({
    fingerprint: o.fingerprint ?? (async () => ours),
    readRules:
      o.readRules ??
      (async () => ({ rules: o.rules ?? [], complete: o.complete ?? true, unreadable: [] })),
    build: o.build ?? (async () => built),
    token: o.token ?? (async () => true),
  })
  const refused = async (p: Promise<unknown>, code: string, text?: RegExp) => {
    const e = await p.then(
      () => undefined,
      (x) => x
    )
    expect(e).toBeInstanceOf(Refusal)
    expect((e as Refusal).code).toBe(code)
    if (text) expect((e as Refusal).message).toMatch(text)
  }
  const neighbour = (o: Partial<ObservedRule>): ObservedRule => ({
    id: 4,
    scope: { kind: 'call_contract', contract: TOKEN },
    signers: [SIGNER],
    policies: [INTERP],
    expr: callExpr({ contract: TOKEN, fn: 'transfer' }),
    ...o,
  })

  it('a clean install returns the build, the live interpreter and a complete scan', async () => {
    const r = await planInstall(input, rule, chain())
    expect(r.unsignedXdr).toBe('AAAA')
    expect(r.interpreter).toEqual(ours)
    expect(r.authorityScan).toEqual({ complete: true, overlaps: [] })
    expect(r.rule).toMatchObject({ contract: TOKEN, predicateHash: rule.hash })
  })

  it('an interpreter that does not run a trusted build is refused, and so is one of another grammar', async () => {
    await refused(
      planInstall(
        input,
        rule,
        chain({
          fingerprint: async () => ({ ...ours, matches: false, wasmSha256: 'b'.repeat(64) }),
        })
      ),
      'INTERPRETER_MISMATCH',
      /runs grammar 7 with wasm b+/
    )
    await refused(
      planInstall(
        input,
        rule,
        chain({ fingerprint: async () => ({ ...ours, matches: false, grammarVersion: 6 }) })
      ),
      'INTERPRETER_MISMATCH',
      /grammar 6/
    )
  })

  it('and it is the first thing refused, whatever else went wrong at the same time', async () => {
    const down = async () => {
      throw new Refusal('INSTALL_BUILD_FAILED', 'the build failed')
    }
    await refused(
      planInstall(
        input,
        rule,
        chain({
          fingerprint: async () => ({ ...ours, matches: false }),
          build: down,
          rules: [neighbour({ policies: [] })],
        })
      ),
      'INTERPRETER_MISMATCH'
    )
    // Then the account's rules, then the build.
    await refused(
      planInstall(input, rule, chain({ build: down, rules: [neighbour({ policies: [] })] })),
      'INSTALL_BUILD_FAILED',
      /refused: rule 4: has no policy/
    )
    await refused(
      planInstall(input, rule, chain({ build: down })),
      'INSTALL_BUILD_FAILED',
      /the build failed/
    )
  })

  it('a scan that could not read every rule is refused, unless allowOverlap says so', async () => {
    await refused(
      planInstall(input, rule, chain({ complete: false })),
      'INSTALL_BUILD_FAILED',
      /could not all be read/
    )
    const r = await planInstall({ ...input, allowOverlap: true }, rule, chain({ complete: false }))
    expect(r.authorityScan.complete).toBe(false)
  })

  it('a failure to read the account is a failure, not an empty account', async () => {
    const boom = async () => {
      throw new Refusal('SIMULATION_ERROR', 'get_context_rules_count: Error(WasmVm, MissingValue)')
    }
    await refused(
      planInstall(input, rule, chain({ readRules: boom })),
      'SIMULATION_ERROR',
      /MissingValue/
    )
  })

  it('a rule scoped to any policy contract, or to the account itself, is refused before anything is asked', async () => {
    let asked = 0
    const counting = chain({
      fingerprint: async () => {
        asked++
        return ours
      },
    })
    for (const contract of [...POLICY_CONTRACTS, ACCOUNT])
      await refused(
        planInstall(input, { ...rule, contract }, counting),
        'INSTALL_BUILD_FAILED',
        /admin calls/
      )
    expect(asked).toBe(0)
  })

  it('a least output nobody set is refused, unless allowOpenSlippage (its own flag: the amount one does not waive it)', async () => {
    const open = { ...rule, openSlippage: 'swap: what is the least `amount_out_min` may be?' }
    await refused(
      planInstall(input, open, chain()),
      'INSTALL_BUILD_FAILED',
      /least `amount_out_min`/
    )
    await refused(
      planInstall({ ...input, allowUnboundedAmount: true }, open, chain()),
      'INSTALL_BUILD_FAILED',
      /least/
    )
    expect(
      (await planInstall({ ...input, allowOpenSlippage: true }, open, chain())).unsignedXdr
    ).toBe('AAAA')
  })

  it('an amount nobody capped is refused, unless allowUnboundedAmount', async () => {
    const open = { ...rule, unanswered: 'transfer: what is the most `amount` may be?' }
    await refused(planInstall(input, open, chain()), 'INSTALL_BUILD_FAILED', /most `amount` may be/)
    expect(
      (await planInstall({ ...input, allowUnboundedAmount: true }, open, chain())).unsignedXdr
    ).toBe('AAAA')
  })

  it('a looser neighbour refuses, an unpoliced one refuses, one the scan cannot judge refuses; allowOverlap lets them through and reports them', async () => {
    for (const [n, why] of [
      [neighbour({}), /permits everything the new rule does/],
      [neighbour({ policies: [] }), /has no policy/],
      [
        neighbour({
          policies: ['CBRRKTVURLAJRPJ3G44AWA5SCGUV47PCYF5CHND5TG3OGTFNXTSLBIJ5'],
          expr: undefined,
        }),
        /cannot decode/,
      ],
      [neighbour({ expr: undefined }), /cannot be read/],
    ] as [ObservedRule, RegExp][]) {
      await refused(planInstall(input, rule, chain({ rules: [n] })), 'INSTALL_BUILD_FAILED', why)
      const r = await planInstall({ ...input, allowOverlap: true }, rule, chain({ rules: [n] }))
      expect(r.authorityScan.overlaps).toHaveLength(1)
    }
  })

  it('a rolling total is refused when a neighbour for the same signer has none', async () => {
    const withCap = { ...input, spendingLimit: { amount: '100', periodLedgers: 10 } }
    await refused(
      planInstall(
        withCap,
        rule,
        chain({
          rules: [
            neighbour({
              expr: callExpr({
                contract: TOKEN,
                fn: 'transfer',
                where: [{ constraint: 'cap', at: [2], max: '1' }],
              }),
            }),
          ],
        })
      ),
      'INSTALL_BUILD_FAILED',
      /no spend cap/
    )
  })

  it('more than one signer and no threshold is refused: with a policy on the rule, any ONE of them acts alone', async () => {
    const two = { ...input, signers: [SIGNER, account(2)] }
    await refused(
      planInstall(two, rule, chain()),
      'INSTALL_BUILD_FAILED',
      /any ONE of the 2 signers/
    )
    await refused(planInstall(two, rule, chain()), 'INSTALL_BUILD_FAILED', /threshold|anyOne/)
    // Said on purpose: it installs, and the draft says no threshold.
    let seen: RuleDraft | undefined
    await planInstall(
      { ...two, anyOne: true },
      rule,
      chain({
        build: async (d) => {
          seen = d
          return built
        },
      })
    )
    expect(seen?.threshold).toBeUndefined()
  })

  const policy = async (i: InstallInput) => {
    let seen: RuleDraft | undefined
    await planInstall(
      i,
      rule,
      chain({
        build: async (d) => {
          seen = d
          return built
        },
      })
    )
    return seen?.extra?.[0]
  }
  const two = { ...input, signers: [SIGNER, account(2)] }

  it('a simple threshold attaches OZ simple_threshold with { threshold }; anyOne beside it is a contradiction', async () => {
    expect(await policy({ ...two, threshold: { n: 2 } })).toEqual([
      thresholdAddress('testnet', false),
      { map: [['threshold', 2]] },
    ])
    await refused(
      planInstall({ ...two, threshold: { n: 2 }, anyOne: true }, rule, chain()),
      'INSTALL_BUILD_FAILED',
      /anyOne and a threshold/
    )
  })

  it("a weighted threshold attaches OZ weighted_threshold with signer_weights keyed by the signer enum, at its network's address", async () => {
    const t = { n: 3, weights: { [SIGNER]: 2, [account(2)]: 1 } }
    expect(await policy({ ...two, threshold: t })).toEqual([
      thresholdAddress('testnet', true),
      {
        map: [
          [
            'signer_weights',
            {
              map: [
                [['Delegated', SIGNER], 2],
                [['Delegated', account(2)], 1],
              ],
            },
          ],
          ['threshold', 3],
        ],
      },
    ])
    const main = await policy({
      ...two,
      network: 'mainnet',
      interpreterAddress: INTERP,
      threshold: t,
    })
    expect(main?.[0]).toBe(thresholdAddress('mainnet', true))
  })

  it.each<[string, InstallInput['threshold']]>([
    ['a threshold above the signers', { n: 3 }],
    ['weights for a key that is not a signer', { n: 1, weights: { [SIGNER]: 1, [account(9)]: 1 } }],
    ['a signer with no weight', { n: 1, weights: { [SIGNER]: 1 } }],
    ['weights below the threshold', { n: 3, weights: { [SIGNER]: 1, [account(2)]: 1 } }],
  ])('%s is refused before the network is asked anything', async (_n, threshold) => {
    let asked = 0
    const quiet = chain({
      fingerprint: async () => {
        asked++
        return ours
      },
    })
    await refused(
      planInstall({ ...two, threshold }, rule, quiet),
      'INSTALL_BUILD_FAILED',
      /can never be met/
    )
    expect(asked).toBe(0)
  })

  it('one signer needs no threshold; a threshold of 1 is fine', async () => {
    await planInstall(input, rule, chain())
    await planInstall({ ...input, threshold: { n: 1 } }, rule, chain())
  })

  describe('spendingLimit: OZ spending_limit denies every function but transfer, and runs only on a token', () => {
    const cap = { ...input, spendingLimit: { amount: '100', periodLedgers: 10 } }
    const on = (fn: string): Chosen => {
      const e = callExpr({ contract: TOKEN, fn })
      return { contract: TOKEN, expr: e, encoded: encode(e), hash: hashOf(encode(e)) }
    }
    const either = (...fns: string[]): Chosen => {
      const e: Expr = ['or', fns.map((fn) => callExpr({ contract: TOKEN, fn }))]
      return { contract: TOKEN, expr: e, encoded: encode(e), hash: hashOf(encode(e)) }
    }

    it('a predicate that pins transfer (at the top, or in every branch of an or) installs', async () => {
      await planInstall(cap, on('transfer'), chain())
      await planInstall(cap, either('transfer', 'transfer'), chain())
    })

    it.each<[string, Chosen]>([
      ['another function', on('approve')],
      ['an or with one branch on another function', either('transfer', 'approve')],
      [
        'no function pinned',
        {
          contract: TOKEN,
          expr: ['lte', ['call_arg', 2], { i128: '5' }],
          encoded: encode(['lte', ['call_arg', 2], { i128: '5' }]),
          hash: 'x',
        },
      ],
    ])('%s is refused, saying why', async (_n, chosen) => {
      await refused(
        planInstall(cap, chosen, chain()),
        'INSTALL_BUILD_FAILED',
        /spending_limit.*transfer/s
      )
    })

    it('a scope that is not shown to be a token is refused; it is asked only when there is a total', async () => {
      let asked = 0
      const c = chain({
        token: async () => {
          asked++
          return false
        },
      })
      await refused(planInstall(cap, rule, c), 'INSTALL_BUILD_FAILED', /not shown to be a token/)
      expect(asked).toBe(1)
      await planInstall(input, rule, c)
      expect(asked).toBe(1)
    })

    it('without a total nothing about the function is asked', async () => {
      await planInstall(input, on('approve'), chain())
    })
  })

  describe('a read in the predicate: a live value is movable within one transaction', () => {
    const REFLECTOR = Object.keys(SAFE_READS.testnet)[0] as string
    const readRule = (target: string, fn: string): Chosen => {
      const e: Expr = [
        'and',
        [
          ['eq', ['call_fn'], 'transfer'],
          ['lte', ['call_arg', 2], ['read', target, fn, []]],
        ],
      ]
      return { contract: TOKEN, expr: e, encoded: encode(e), hash: hashOf(encode(e)) }
    }
    const spot = () => {
      const before = process.env.POLICY_BUILDER_ALLOW_SPOT_READS
      const put = (v: string | undefined) => {
        if (v === undefined) delete process.env.POLICY_BUILDER_ALLOW_SPOT_READS
        else process.env.POLICY_BUILDER_ALLOW_SPOT_READS = v
      }
      return { set: put, undo: () => put(before) }
    }

    it('is refused as READ_UNSAFE, naming the target and function, unless the operator allows spot reads', async () => {
      const env = spot()
      try {
        env.set(undefined)
        await refused(
          planInstall(input, readRule(contract(9), 'balance'), chain()),
          'READ_UNSAFE',
          new RegExp(`${contract(9)}.*balance|balance.*${contract(9)}`)
        )
        await refused(
          planInstall(input, readRule(contract(9), 'balance'), chain()),
          'READ_UNSAFE',
          /POLICY_BUILDER_ALLOW_SPOT_READS/
        )
        env.set('0')
        await refused(planInstall(input, readRule(contract(9), 'balance'), chain()), 'READ_UNSAFE')
        env.set('1')
        await planInstall(input, readRule(contract(9), 'balance'), chain())
      } finally {
        env.undo()
      }
    })

    it('an oracle price read on the safe list installs without the operator switch; another function of it does not', async () => {
      const env = spot()
      try {
        env.set(undefined)
        await planInstall(input, readRule(REFLECTOR, 'lastprice'), chain())
        await refused(planInstall(input, readRule(REFLECTOR, 'set_price'), chain()), 'READ_UNSAFE')
        await refused(
          planInstall(
            { ...input, network: 'mainnet', interpreterAddress: INTERP },
            readRule(REFLECTOR, 'lastprice'),
            chain()
          ),
          'READ_UNSAFE'
        )
      } finally {
        env.undo()
      }
    })

    it('an oracle read is safe only with constant arguments: an asset taken from the call is a live value', async () => {
      const env = spot()
      try {
        env.set(undefined)
        const withArgs = (fn: string, args: unknown[]): Chosen => {
          const e = [
            'and',
            [
              ['eq', ['call_fn'], 'transfer'],
              ['lte', ['call_arg', 2], ['read', REFLECTOR, fn, args]],
            ],
          ] as Expr
          return { contract: TOKEN, expr: e, encoded: encode(e), hash: 'x' }
        }
        await planInstall(input, withArgs('lastprice', [{ i128: '1' }]), chain())
        await planInstall(input, withArgs('price', [['lit', 'XLM'], { u64: '5' }]), chain())
        await refused(
          planInstall(input, withArgs('lastprice', [['call_arg', 1]]), chain()),
          'READ_UNSAFE'
        )
        await refused(
          planInstall(input, withArgs('price', [{ i128: '1' }, ['call_arg', 0]]), chain()),
          'READ_UNSAFE'
        )
        await refused(
          planInstall(input, withArgs('price', [['now'], { u64: '5' }]), chain()),
          'READ_UNSAFE'
        )
      } finally {
        env.undo()
      }
    })

    it('an operator-listed read installs without the switch: that function, on that network, constants only', async () => {
      const env = spot()
      process.env.POLICY_BUILDER_SAFE_READS_TESTNET = `${contract(9)}:balance`
      try {
        env.set(undefined)
        await planInstall(input, readRule(contract(9), 'balance'), chain())
        await refused(planInstall(input, readRule(contract(9), 'position'), chain()), 'READ_UNSAFE')
        await refused(
          planInstall(
            { ...input, network: 'mainnet', interpreterAddress: INTERP },
            readRule(contract(9), 'balance'),
            chain()
          ),
          'READ_UNSAFE'
        )
        process.env.POLICY_BUILDER_SAFE_READS_TESTNET = 'junk'
        await refused(
          planInstall(input, readRule(contract(9), 'balance'), chain()),
          'INVALID_INPUT',
          /POLICY_BUILDER_SAFE_READS_TESTNET/
        )
      } finally {
        delete process.env.POLICY_BUILDER_SAFE_READS_TESTNET
        env.undo()
      }
    })

    it('a constant that merely looks like a read is no read: nothing to refuse', async () => {
      const env = spot()
      try {
        env.set(undefined)
        const e = [
          'and',
          [
            ['eq', ['call_fn'], 'transfer'],
            ['ne', ['call_arg', 1], ['lit', ['read', contract(9), 'balance', []]]],
          ],
        ] as Expr
        await planInstall(
          input,
          { contract: TOKEN, expr: e, encoded: encode(e), hash: 'x' },
          chain()
        )
      } finally {
        env.undo()
      }
    })

    it('one unsafe read among safe ones refuses; no read asks nothing', async () => {
      const env = spot()
      try {
        env.set(undefined)
        const e: Expr = [
          'and',
          [
            ['eq', ['call_fn'], 'transfer'],
            ['lte', ['call_arg', 2], ['read', REFLECTOR, 'lastprice', []]],
            ['gte', ['call_arg', 2], ['read', contract(9), 'x', []]],
          ],
        ]
        await refused(
          planInstall(input, { contract: TOKEN, expr: e, encoded: encode(e), hash: 'x' }, chain()),
          'READ_UNSAFE'
        )
        await planInstall(input, rule, chain())
      } finally {
        env.undo()
      }
    })
  })

  it('a threshold that one signer meets alone is 1-of-n too: it needs anyOne, and says so', async () => {
    const heavy = { n: 2, weights: { [SIGNER]: 2, [account(2)]: 1 } }
    for (const threshold of [{ n: 1 }, heavy])
      await refused(
        planInstall({ ...two, threshold }, rule, chain()),
        'INSTALL_BUILD_FAILED',
        /any ONE|alone/
      )
    expect(await policy({ ...two, threshold: { n: 1 }, anyOne: true })).toBeDefined()
    expect(await policy({ ...two, threshold: heavy, anyOne: true })).toBeDefined()
    // A real threshold beside anyOne is still a contradiction.
    await refused(
      planInstall({ ...two, threshold: { n: 2 }, anyOne: true }, rule, chain()),
      'INSTALL_BUILD_FAILED',
      /contradict/
    )
    await policy({ ...two, threshold: { n: 2, weights: { [SIGNER]: 1, [account(2)]: 1 } } })
  })

  it('the refusal names exactly who meets the threshold alone, never claiming any signer can', async () => {
    const three = { ...input, signers: [SIGNER, account(2), account(3)] }
    const t = { n: 3, weights: { [SIGNER]: 3, [account(2)]: 2, [account(3)]: 2 } }
    const e = await planInstall({ ...three, threshold: t }, rule, chain()).then(
      () => undefined,
      (x) => x as Refusal
    )
    expect(e?.message).toContain(`${SIGNER} alone meets the threshold of 3`)
    expect(e?.message).not.toMatch(/any ONE of the 3/)
    expect(e?.message).not.toContain(account(2))
    expect(e?.message).toContain('`anyOne: true` to install it on purpose')
    await refused(
      planInstall({ ...two, threshold: { n: 1 } }, rule, chain()),
      'INSTALL_BUILD_FAILED',
      /any ONE of the 2 signers/
    )
  })

  it('a signer named twice is refused before the network is asked (OZ rejects it as #3007)', async () => {
    let asked = 0
    const quiet = chain({ fingerprint: async () => (asked++, ours) })
    await refused(
      planInstall({ ...input, signers: [SIGNER, SIGNER], anyOne: true }, rule, quiet),
      'INSTALL_BUILD_FAILED',
      /twice|duplicate/
    )
    expect(asked).toBe(0)
  })

  it('the plan carries the authority it grants: signers, rule, admins, expiry, total, interpreter', async () => {
    const r = await planInstall(
      {
        ...two,
        threshold: { n: 2 },
        validUntilLedger: 5_000_100,
        spendingLimit: { amount: '9', periodLedgers: 4 },
      },
      rule,
      chain()
    )
    expect(r.authority).toMatchObject({
      signers: [SIGNER, account(2)],
      threshold: { n: 2, raw: [thresholdAddress('testnet', false), { map: [['threshold', 2]] }] },
      admins: [SIGNER],
      validUntil: 5_000_100,
      total: { amount: '9', periodLedgers: 4 },
      interpreter: INTERP,
    })
    const open = await planInstall(input, rule, chain())
    expect(open.authority).toMatchObject({ validUntil: null, total: null, threshold: undefined })
  })

  it('the draft carries the signers, the admins (the source by default), the nonce and the cap', async () => {
    let seen: RuleDraft | undefined
    await planInstall(
      {
        ...input,
        admins: [account(7)],
        installNonce: 3,
        name: 'n',
        validUntilLedger: 9,
        spendingLimit: { amount: '5', periodLedgers: 2 },
      },
      rule,
      chain({
        build: async (d) => {
          seen = d
          return built
        },
      })
    )
    expect(seen).toMatchObject({
      signers: [SIGNER],
      admins: [account(7)],
      nonce: 3,
      name: 'n',
      validUntil: 9,
    })
    expect(seen?.cap).toEqual({ address: SPENDING_LIMIT.testnet, amount: '5', periodLedgers: 2 })
    await planInstall(
      input,
      rule,
      chain({
        build: async (d) => {
          seen = d
          return built
        },
      })
    )
    expect(seen).toMatchObject({ admins: [SIGNER], nonce: 1, validUntil: null })
  })
})

describe('planRevoke: the only destructive tool reads what it removes', () => {
  const built = { unsignedXdr: 'AAAA' } as never
  const rule = (o: Partial<ObservedRule>): ObservedRule => ({
    id: 3,
    scope: { kind: 'call_contract', contract: TOKEN },
    signers: [SIGNER],
    policies: [INTERP],
    ...o,
  })
  const chain = (r: ObservedRule | undefined, onBuild = () => {}): RevokeChain => ({
    readRule: async () => r,
    build: async () => {
      onBuild()
      return built
    },
  })
  const input = { smartAccount: ACCOUNT, sourceAccount: SIGNER }

  it('describes the rule it would remove, beside the unsigned transaction', async () => {
    const r = await planRevoke({ ...input, ruleId: 3 }, chain(rule({})))
    expect(r.unsignedXdr).toBe('AAAA')
    expect(r.removes).toMatchObject({
      id: 3,
      scope: { kind: 'call_contract' },
      signers: [SIGNER],
      policies: [INTERP],
    })
  })

  it('refuses rule 0 and any Default-scoped rule (the account may be left with no admin rule), unless told', async () => {
    let built = 0
    const count = () => built++
    await expect(
      planRevoke(
        { ...input, ruleId: 0 },
        chain(rule({ id: 0, scope: { kind: 'call_contract', contract: TOKEN } }), count)
      )
    ).rejects.toThrow(/lock/)
    await expect(
      planRevoke({ ...input, ruleId: 5 }, chain(rule({ id: 5, scope: { kind: 'default' } }), count))
    ).rejects.toThrow(/Default/)
    const ok = await planRevoke(
      { ...input, ruleId: 0, allowAdminRule: true },
      chain(rule({ id: 0, scope: { kind: 'default' }, policies: [] }))
    )
    expect(ok.removes.id).toBe(0)
  })

  it('refuses a rule scoped to the account itself too: it authorises add_context_rule, so it is an admin rule', async () => {
    const own = rule({ id: 4, scope: { kind: 'call_contract', contract: ACCOUNT } })
    await expect(planRevoke({ ...input, ruleId: 4 }, chain(own))).rejects.toThrow(
      /scoped to the account/
    )
    const ok = await planRevoke({ ...input, ruleId: 4, allowAdminRule: true }, chain(own))
    expect(ok.removes.id).toBe(4)
    // Scoped to another contract it is an ordinary rule.
    expect((await planRevoke({ ...input, ruleId: 4 }, chain(rule({ id: 4 })))).removes.id).toBe(4)
  })

  it("a rule that is not there is the build's own refusal, not an empty description", async () => {
    const failing: RevokeChain = {
      readRule: async () => undefined,
      build: async () => {
        throw new Refusal('REVOKE_BUILD_FAILED', 'remove_context_rule: Error(Contract, #3000)')
      },
    }
    await expect(planRevoke({ ...input, ruleId: 99 }, failing)).rejects.toThrow(/#3000/)
    await expect(
      planRevoke({ ...input, ruleId: 99 }, { ...failing, build: async () => built })
    ).rejects.toThrow(/no rule 99/)
  })
})
