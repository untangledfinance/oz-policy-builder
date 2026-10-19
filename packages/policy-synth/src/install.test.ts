import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  Address,
  nativeToScVal,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
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

  // The account signs `rootInvocation` as the simulation reported it, so an RPC that adds a call
  // (a token transfer under the install) or swaps the call would have it signed under the review
  // of `add_context_rule`. The build compares the reported tree with the call it built.
  describe('the authorised call is the call that was built', () => {
    const tampered = (
      edit: (root: xdr.SorobanAuthorizedInvocation) => xdr.SorobanAuthorizedInvocation
    ) =>
      new Proxy(server, {
        get(target, prop, receiver) {
          if (prop !== 'simulateTransaction') return Reflect.get(target, prop, receiver)
          return async (t: Parameters<typeof server.simulateTransaction>[0]) => {
            const sim = await target.simulateTransaction(t)
            const auth = 'result' in sim ? sim.result?.auth : undefined
            const e = auth?.find(
              (x) => x.credentials().switch().name === 'sorobanCredentialsAddress'
            )
            if (e) e.rootInvocation(edit(e.rootInvocation()))
            return sim
          }
        },
      })
    const transfer = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TOKEN).toScAddress(),
          functionName: 'transfer',
          args: [
            new Address(ACCOUNT).toScVal(),
            new Address(SIGNER).toScVal(),
            nativeToScVal(10n ** 12n, { type: 'i128' }),
          ],
        })
      ),
      subInvocations: [],
    })

    it('refuses a sub-invocation the simulation adds under the call', async () => {
      const lying = tampered(
        (root) =>
          new xdr.SorobanAuthorizedInvocation({
            function: root.function(),
            subInvocations: [transfer],
          })
      )
      await expect(
        buildInstall({ ...args, server: lying }, draft({ name: 'cap-500', nonce: 1 }), INTERP)
      ).rejects.toThrow(/authorise.*other than|sub-invocation/)
    })

    it('refuses a root invocation that is another call', async () => {
      const lying = tampered(() => transfer)
      await expect(
        buildInstall({ ...args, server: lying }, draft({ name: 'cap-500', nonce: 1 }), INTERP)
      ).rejects.toThrow(/authorise.*other than/)
    })

    it('refuses the same function with other arguments (a different rule)', async () => {
      const lying = tampered((root) => {
        const f = root.function().contractFn()
        const other = new xdr.InvokeContractArgs({
          contractAddress: f.contractAddress(),
          functionName: f.functionName(),
          args: [...f.args().slice(0, 1), xdr.ScVal.scvString('other'), ...f.args().slice(2)],
        })
        return new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(other),
          subInvocations: [],
        })
      })
      await expect(
        buildInstall({ ...args, server: lying }, draft({ name: 'cap-500', nonce: 1 }), INTERP)
      ).rejects.toThrow(/authorise.*other than/)
    })

    it('refuses the same function and arguments on another contract', async () => {
      const lying = tampered((root) => {
        const f = root.function().contractFn()
        const other = new xdr.InvokeContractArgs({
          contractAddress: new Address(TOKEN).toScAddress(),
          functionName: f.functionName(),
          args: f.args(),
        })
        return new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(other),
          subInvocations: [],
        })
      })
      await expect(
        buildInstall({ ...args, server: lying }, draft({ name: 'cap-500', nonce: 1 }), INTERP)
      ).rejects.toThrow(/authorise.*other than.*another call/)
    })
  })

  // Two more values the wallet signs came from the RPC: the auth expiry (the ledger a simulation
  // reports, plus the window) and the resource fee. The builder bounds both itself.
  describe("the expiry and the fee are the builder's, not the RPC's", () => {
    type Sim = Awaited<ReturnType<typeof server.simulateTransaction>>
    /** The RPC edits its answer to one simulation: 1 the recording pass, 2 the enforcing pass. */
    const lyingPass = (pass: 1 | 2, edit: (sim: Sim & { latestLedger: number }) => void) => {
      let k = 0
      return new Proxy(server, {
        get(target, prop, receiver) {
          if (prop !== 'simulateTransaction') return Reflect.get(target, prop, receiver)
          return async (t: Parameters<typeof server.simulateTransaction>[0]) => {
            const sim = await target.simulateTransaction(t)
            if (++k === pass) edit(sim)
            return sim
          }
        },
      })
    }
    const withEnv = async <T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> => {
      const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
      Object.assign(process.env, env)
      try {
        return await f()
      } finally {
        for (const [k, v] of Object.entries(before)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    }
    const shape = (b: Awaited<ReturnType<typeof buildInstall>>) => {
      const tx = TransactionBuilder.fromXDR(b.unsignedXdr, PASSPHRASE.testnet)
      const data = tx.toEnvelope().v1().tx().ext().sorobanData()
      return { tx, resource: Number(data.resourceFee()) }
    }
    const now = () => Math.floor(Date.now() / 1000)

    it("the signed transaction lapses with its authorisation, by the builder's own clock", async () => {
      const t0 = now()
      const built = await buildInstall(args, draft(), INTERP)
      const { tx, resource } = shape(built)
      const latest = (await server.getLatestLedger()).sequence
      // 300 ledgers past the ledger the simulation ran at, and the time bound at 6 s a ledger.
      expect(built.authValidUntilLedger - latest).toBeGreaterThan(290)
      expect(built.authValidUntilLedger - latest).toBeLessThanOrEqual(300)
      expect(tx.timeBounds?.minTime).toBe('0')
      const max = Number(tx.timeBounds?.maxTime)
      expect(max).toBeGreaterThanOrEqual(t0 + 1800)
      expect(max).toBeLessThanOrEqual(now() + 1800)
      expect(built.validBefore).toBe(max)
      expect(built.fee).toEqual({ base: 100, resource, total: 100 + resource })
    })

    it('the operator sets the window with POLICY_BUILDER_AUTH_LEDGERS; a bad value refuses before the network is asked', async () => {
      const t0 = now()
      const built = await withEnv({ POLICY_BUILDER_AUTH_LEDGERS: '100' }, () =>
        buildInstall(args, draft(), INTERP)
      )
      const latest = (await server.getLatestLedger()).sequence
      expect(built.authValidUntilLedger - latest).toBeGreaterThan(90)
      expect(built.authValidUntilLedger - latest).toBeLessThanOrEqual(100)
      expect(built.validBefore).toBeGreaterThanOrEqual(t0 + 600)
      expect(built.validBefore).toBeLessThanOrEqual(now() + 600)
      const asked = { n: 0 }
      const counting = new Proxy(server, {
        get(target, prop, receiver) {
          asked.n++
          return Reflect.get(target, prop, receiver)
        },
      })
      for (const bad of ['0', '-5', 'abc', '17281', '1e3']) {
        await expect(
          withEnv({ POLICY_BUILDER_AUTH_LEDGERS: bad }, () =>
            buildInstall({ ...args, server: counting }, draft(), INTERP)
          )
        ).rejects.toThrow(/POLICY_BUILDER_AUTH_LEDGERS/)
      }
      expect(asked.n).toBe(0)
    })

    it.each([
      ['the recording pass reports a ledger 2,000,000 ahead', 1, 2_000_000],
      ['the enforcing pass reports a ledger 2,000,000 ahead', 2, 2_000_000],
      ['the enforcing pass reports a ledger 2,000,000 behind', 2, -2_000_000],
    ] as const)(
      'refuses an RPC whose two simulations disagree on the ledger: %s',
      async (_n, pass, by) => {
        const lying = lyingPass(pass, (sim) => {
          sim.latestLedger += by
        })
        await expect(buildInstall({ ...args, server: lying }, draft(), INTERP)).rejects.toThrow(
          /ledger.*apart.*not trusted/
        )
      }
    )

    it('the limit is 20 ledgers: an enforcing pass 20 off builds, 21 off is refused, either way', async () => {
      const shifted = (by: number) =>
        lyingPass(2, (sim) => {
          sim.latestLedger += by
        })
      for (const by of [20, -20]) {
        const b = await buildInstall({ ...args, server: shifted(by) }, draft(), INTERP)
        expect(b.unsignedXdr.length).toBeGreaterThan(0)
      }
      for (const by of [21, -21])
        await expect(
          buildInstall({ ...args, server: shifted(by) }, draft(), INTERP)
        ).rejects.toThrow(/21 apart; the RPC answer is not trusted/)
    })

    it('an empty value is the default, as if unset', async () => {
      const b = await withEnv(
        { POLICY_BUILDER_AUTH_LEDGERS: '', POLICY_BUILDER_MAX_RESOURCE_FEE: '' },
        () => buildInstall(args, draft(), INTERP)
      )
      expect(b.validBefore).toBeGreaterThan(Math.floor(Date.now() / 1000) + 1790)
    })

    it.each([
      ['a negative resource fee', -1n, /negative resource fee \(-1 stroops\)/],
      ['the largest int64 resource fee', 2n ** 63n - 1n, /above this builder's ceiling of 10 XLM/],
    ] as const)('refuses %s with its own message', async (_n, fee, why) => {
      const lying = lyingPass(2, (sim) => {
        if (!('transactionData' in sim)) return
        const d = sim.transactionData.build()
        d.resourceFee(new xdr.Int64(fee))
        sim.transactionData = new SorobanDataBuilder(d)
      })
      await expect(buildInstall({ ...args, server: lying }, draft(), INTERP)).rejects.toThrow(why)
    })

    it('refuses a resource fee above the ceiling, whatever the RPC asks (an enforcing pass that asks 200 XLM)', async () => {
      const lying = lyingPass(2, (sim) => {
        if (!('transactionData' in sim)) return
        const d = sim.transactionData.build()
        d.resourceFee(new xdr.Int64(2_000_000_000n))
        sim.transactionData = new SorobanDataBuilder(d)
        sim.minResourceFee = '2000000000'
      })
      const r = buildInstall({ ...args, server: lying }, draft(), INTERP)
      await expect(r).rejects.toThrow(
        /resource fee of 200 XLM.*ceiling of 10 XLM.*POLICY_BUILDER_MAX_RESOURCE_FEE/
      )
      await expect(r).rejects.toMatchObject({ code: 'INSTALL_BUILD_FAILED' })
      const revoke = buildRevoke(
        {
          ...args,
          server: lyingPass(2, (sim) => {
            if (!('transactionData' in sim)) return
            const d = sim.transactionData.build()
            d.resourceFee(new xdr.Int64(2_000_000_000n))
            sim.transactionData = new SorobanDataBuilder(d)
          }),
        },
        1
      )
      await expect(revoke).rejects.toMatchObject({ code: 'REVOKE_BUILD_FAILED' })
    })

    it('the operator sets the ceiling with POLICY_BUILDER_MAX_RESOURCE_FEE, in stroops', async () => {
      const honest = shape(await buildInstall(args, draft(), INTERP)).resource
      await expect(
        withEnv({ POLICY_BUILDER_MAX_RESOURCE_FEE: String(honest - 1) }, () =>
          buildInstall(args, draft(), INTERP)
        )
      ).rejects.toThrow(/above this builder's ceiling/)
      const at = await withEnv({ POLICY_BUILDER_MAX_RESOURCE_FEE: String(honest + 1000) }, () =>
        buildInstall(args, draft(), INTERP)
      )
      expect(at.fee.resource).toBeLessThanOrEqual(honest + 1000)
      for (const bad of ['0', 'ten', '1.5', '-1'])
        await expect(
          withEnv({ POLICY_BUILDER_MAX_RESOURCE_FEE: bad }, () =>
            buildInstall(args, draft(), INTERP)
          )
        ).rejects.toThrow(/POLICY_BUILDER_MAX_RESOURCE_FEE/)
    })
  })
})

// ---- every refusal an install can meet, with a chain that answers as told ----

import type { ContractKind, Fingerprint } from './chain.ts'
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
    contracts: o.contracts ?? (async (a) => Object.fromEntries(a.map((x) => [x, 'contract']))),
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
    // Like every override, the refusal does not name `anyOne`: it asks for a threshold.
    const e = await planInstall(two, rule, chain()).then(
      () => undefined,
      (x) => x as Refusal
    )
    expect(e?.message).toMatch(/Give a threshold that needs more/)
    expect(e?.message).not.toMatch(/anyOne|override/i)
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
    expect(e?.message).not.toContain('anyOne')
    await refused(
      planInstall({ ...two, threshold: { n: 1 } }, rule, chain()),
      'INSTALL_BUILD_FAILED',
      /any ONE of the 2 signers/
    )
  })

  describe('a contract signer is read off the chain (review of #26: a null-gate adapter signing a rule)', () => {
    const ADAPTER = contract(21)
    const kinds =
      (k: Record<string, ContractKind>, seen: string[][] = []) =>
      async (a: string[]) => {
        seen.push(a)
        return Object.fromEntries(a.map((x) => [x, k[x] ?? 'contract']))
      }

    it('an execution adapter bound to no gate is refused as a signer, with or without other signers', async () => {
      for (const signers of [[ADAPTER], [SIGNER, ADAPTER]])
        await refused(
          planInstall(
            { ...input, signers, anyOne: true },
            rule,
            chain({ contracts: kinds({ [ADAPTER]: 'null-gate adapter' }) })
          ),
          'INSTALL_BUILD_FAILED',
          new RegExp(`${ADAPTER} is an execution adapter bound to no gate`)
        )
    })

    it('a null-gate adapter is refused wherever it stands among contract signers', async () => {
      const OK = contract(22)
      for (const signers of [
        [OK, ADAPTER],
        [ADAPTER, OK],
      ])
        await refused(
          planInstall(
            { ...input, signers, anyOne: true },
            rule,
            chain({ contracts: kinds({ [ADAPTER]: 'null-gate adapter' }) })
          ),
          'INSTALL_BUILD_FAILED',
          /bound to no gate/
        )
    })

    it('no override waives it: not allowOverlap, not anyOne, not POLICY_BUILDER_ALLOW_OVERRIDES', async () => {
      process.env.POLICY_BUILDER_ALLOW_OVERRIDES = '1'
      try {
        await refused(
          planInstall(
            {
              ...input,
              signers: [ADAPTER],
              allowOverlap: true,
              allowUnboundedAmount: true,
              allowOpenSlippage: true,
            },
            rule,
            chain({ contracts: kinds({ [ADAPTER]: 'null-gate adapter' }) })
          ),
          'INSTALL_BUILD_FAILED',
          /bound to no gate/
        )
      } finally {
        delete process.env.POLICY_BUILDER_ALLOW_OVERRIDES
      }
    })

    it('a contract signer that is not deployed is refused: what it will run cannot be checked', async () => {
      await refused(
        planInstall(
          { ...input, signers: [ADAPTER] },
          rule,
          chain({ contracts: kinds({ [ADAPTER]: 'absent' }) })
        ),
        'INSTALL_BUILD_FAILED',
        new RegExp(`${ADAPTER} is not deployed`)
      )
    })

    it('only contract signers are asked about; any other contract, a gated adapter among them, installs', async () => {
      const seen: string[][] = []
      const r = await planInstall(
        { ...input, signers: [SIGNER, ADAPTER], anyOne: true },
        rule,
        chain({ contracts: kinds({}, seen) })
      )
      expect(r.unsignedXdr).toBe('AAAA')
      expect(seen).toEqual([[ADAPTER]])
      await planInstall(input, rule, chain({ contracts: kinds({}, seen) }))
      expect(seen).toEqual([[ADAPTER], []])
    })

    describe('an execution adapter signing a rule scoped to itself (review-opb28 L1, testnet 25ef231e)', () => {
      const GATED = contract(23)
      const on = (fn: string, more: Expr[] = []): Chosen => {
        const e = (
          more.length
            ? ['or', [callExpr({ contract: GATED, fn }), ...more]]
            : callExpr({ contract: GATED, fn })
        ) as Expr
        const enc = encode(e)
        return { contract: GATED, expr: e, encoded: enc, hash: hashOf(enc) }
      }
      const adapter = chain({ contracts: kinds({ [GATED]: 'gated adapter' }) })

      it('a rule that does not pin call_fn = run is refused, alone and beside a key, and no override waives it', async () => {
        process.env.POLICY_BUILDER_ALLOW_OVERRIDES = '1'
        try {
          for (const r of [
            on('execute'),
            on('cancel'),
            on('run', [callExpr({ contract: GATED, fn: 'execute' })]),
            { ...on('run'), expr: ['eq', ['call_contract'], GATED] as Expr },
          ])
            for (const signers of [[GATED], [SIGNER, GATED]])
              await refused(
                planInstall({ ...input, signers, anyOne: true, allowOverlap: true }, r, adapter),
                'INSTALL_BUILD_FAILED',
                new RegExp(`${GATED} is an execution adapter, and this rule is scoped to it`)
              )
        } finally {
          delete process.env.POLICY_BUILDER_ALLOW_OVERRIDES
        }
      })

      it('the run rule installs, and so do its band rules and an agent rule on it', async () => {
        for (const [r, signers] of [
          [on('run'), [GATED]],
          [rule, [GATED]],
          [on('execute'), [SIGNER]],
        ] as const)
          expect(
            (await planInstall({ ...input, signers: [...signers] }, r, adapter)).unsignedXdr
          ).toBe('AAAA')
      })

      it('only the adapter the rule is scoped to counts: another adapter as signer is P0-5', async () => {
        const OTHER = contract(24)
        const r = await planInstall(
          { ...input, signers: [OTHER] },
          on('execute'),
          chain({ contracts: kinds({ [GATED]: 'gated adapter', [OTHER]: 'gated adapter' }) })
        )
        expect(r.unsignedXdr).toBe('AAAA')
      })
    })

    it('a failure to read the signer is a failure, never a pass', async () => {
      const failing = chain({
        contracts: async () => {
          throw new Refusal('SIMULATION_ERROR', 'getLedgerEntries: 503', { retryable: true })
        },
      })
      await refused(
        planInstall({ ...input, signers: [ADAPTER] }, rule, failing),
        'SIMULATION_ERROR',
        /503/
      )
    })
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

  // P0-4: an agent read the flag off the refusal, set it, and the answer did not say so.
  describe('overrides: never hinted, always echoed, on mainnet only with the operator switch', () => {
    const unanswered = { ...rule, unanswered: 'transfer: what is the most `amount` may be?' }
    const slippage = { ...rule, openSlippage: 'swap: what is the least `amount_out_min` may be?' }
    const MAIN = 'CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT'
    const mainnet: InstallInput = { ...input, network: 'mainnet', interpreterAddress: MAIN }
    const onMainnet = { ...ours, address: MAIN }
    const withSwitch = async <T>(v: string | undefined, f: () => Promise<T>) => {
      const before = process.env.POLICY_BUILDER_ALLOW_OVERRIDES
      if (v === undefined) delete process.env.POLICY_BUILDER_ALLOW_OVERRIDES
      else process.env.POLICY_BUILDER_ALLOW_OVERRIDES = v
      try {
        return await f()
      } finally {
        if (before === undefined) delete process.env.POLICY_BUILDER_ALLOW_OVERRIDES
        else process.env.POLICY_BUILDER_ALLOW_OVERRIDES = before
      }
    }

    it('a refusal an override would waive does not name the override', async () => {
      const cases: [Promise<unknown>, RegExp][] = [
        [planInstall(input, unanswered, chain()), /most `amount`/],
        [planInstall(input, slippage, chain()), /least `amount_out_min`/],
        [planInstall(input, rule, chain({ rules: [neighbour({})] })), /refused: rule 4/],
        [planInstall(input, rule, chain({ complete: false })), /could not all be read/],
      ]
      for (const [p, why] of cases) {
        const e = (await p.then(
          () => undefined,
          (x) => x
        )) as Refusal
        expect(e.message).toMatch(why)
        expect(e.message).not.toMatch(/allow[A-Z]|override/i)
      }
    })

    it('every override set is echoed with the refusal it waived, or with null when nothing needed it', async () => {
      expect((await planInstall(input, rule, chain())).overrides).toEqual([])
      const none = { allowOverlap: false, allowUnboundedAmount: false, allowOpenSlippage: false }
      expect((await planInstall({ ...input, ...none }, rule, chain())).overrides).toEqual([])
      const all = { allowOverlap: true, allowUnboundedAmount: true, allowOpenSlippage: true }
      const open = { ...unanswered, openSlippage: slippage.openSlippage }
      const r = await planInstall(
        { ...input, ...all },
        open,
        chain({ rules: [neighbour({})], complete: false })
      )
      expect(r.overrides.map((o) => o.flag)).toEqual([
        'allowUnboundedAmount',
        'allowOpenSlippage',
        'allowOverlap',
      ])
      expect(r.overrides[0]?.waived).toBe(unanswered.unanswered)
      expect(r.overrides[1]?.waived).toBe(slippage.openSlippage)
      expect(r.overrides[2]?.waived).toMatch(/refused: rule 4.*could not all be read/)
      const idle = await planInstall({ ...input, ...all }, rule, chain())
      expect(idle.overrides).toEqual([
        { flag: 'allowUnboundedAmount', waived: null },
        { flag: 'allowOpenSlippage', waived: null },
        { flag: 'allowOverlap', waived: null },
      ])
    })

    it('anyOne is an override like the others: echoed with the 1-of-n refusal it waived, gated on mainnet', async () => {
      const two = { ...input, signers: [SIGNER, account(2)], anyOne: true }
      const r = await planInstall(two, rule, chain())
      expect(r.overrides).toEqual([
        { flag: 'anyOne', waived: expect.stringMatching(/any ONE of the 2 signers acts alone/) },
      ])
      const one = await planInstall({ ...input, anyOne: true }, rule, chain())
      expect(one.overrides).toEqual([{ flag: 'anyOne', waived: null }])
      await withSwitch(undefined, () =>
        refused(
          planInstall({ ...mainnet, signers: [SIGNER, account(2)], anyOne: true }, rule, chain()),
          'INSTALL_BUILD_FAILED',
          /anyOne is set, and on mainnet .*POLICY_BUILDER_ALLOW_OVERRIDES=1/
        )
      )
    })

    it('on mainnet an override is refused before anything is asked, unless the operator sets POLICY_BUILDER_ALLOW_OVERRIDES=1', async () => {
      let asked = 0
      const counted = chain({
        fingerprint: async () => {
          asked++
          return onMainnet
        },
        build: async () => {
          asked++
          return built
        },
      })
      for (const flag of ['allowOverlap', 'allowUnboundedAmount', 'allowOpenSlippage'])
        for (const v of [undefined, '0', 'true', 'yes'])
          await withSwitch(v, () =>
            refused(
              planInstall({ ...mainnet, [flag]: true }, rule, counted),
              'INSTALL_BUILD_FAILED',
              new RegExp(`${flag}.*mainnet.*POLICY_BUILDER_ALLOW_OVERRIDES=1`)
            )
          )
      expect(asked).toBe(0)
      // No override, or an override set to false, needs no switch; the switch lets it through, echoed.
      const clean = chain({ fingerprint: async () => onMainnet })
      expect((await planInstall(mainnet, rule, clean)).overrides).toEqual([])
      expect(
        (await planInstall({ ...mainnet, allowOverlap: false }, rule, clean)).overrides
      ).toEqual([])
      const on = await withSwitch('1', () =>
        planInstall({ ...mainnet, allowUnboundedAmount: true }, unanswered, clean)
      )
      expect(on.overrides).toEqual([
        { flag: 'allowUnboundedAmount', waived: unanswered.unanswered },
      ])
      // Testnet honours an override without the switch, and echoes it all the same.
      const t = await planInstall({ ...input, allowUnboundedAmount: true }, unanswered, chain())
      expect(t.overrides).toEqual([{ flag: 'allowUnboundedAmount', waived: unanswered.unanswered }])
    })
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
  const input = { network: 'testnet' as const, smartAccount: ACCOUNT, sourceAccount: SIGNER }

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

  it('allowAdminRule is never hinted, always echoed, and on mainnet needs the operator switch', async () => {
    const zero = rule({ id: 0, scope: { kind: 'default' }, policies: [] })
    const e = await planRevoke({ ...input, ruleId: 0 }, chain(zero)).then(
      () => undefined,
      (x) => x as Refusal
    )
    expect(e?.message).toMatch(/lock the account out/)
    expect(e?.message).not.toMatch(/allow[A-Z]|override/i)
    expect((await planRevoke({ ...input, ruleId: 3 }, chain(rule({})))).overrides).toEqual([])
    const ok = await planRevoke({ ...input, ruleId: 0, allowAdminRule: true }, chain(zero))
    expect(ok.overrides).toEqual([{ flag: 'allowAdminRule', waived: e?.message }])
    const idle = await planRevoke({ ...input, ruleId: 3, allowAdminRule: true }, chain(rule({})))
    expect(idle.overrides).toEqual([{ flag: 'allowAdminRule', waived: null }])
    let built = 0
    const main = { ...input, network: 'mainnet' as const, ruleId: 0, allowAdminRule: true }
    await expect(
      planRevoke(
        main,
        chain(zero, () => built++)
      )
    ).rejects.toThrow(/allowAdminRule.*mainnet.*POLICY_BUILDER_ALLOW_OVERRIDES=1/)
    expect(built).toBe(0)
    process.env.POLICY_BUILDER_ALLOW_OVERRIDES = '1'
    try {
      expect((await planRevoke(main, chain(zero))).overrides[0]?.flag).toBe('allowAdminRule')
    } finally {
      delete process.env.POLICY_BUILDER_ALLOW_OVERRIDES
    }
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
