import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { PASSPHRASE, SPENDING_LIMIT } from './config.ts'
import { buildInstall, buildRevoke, type RuleDraft, ruleArgs } from './install.ts'
import { callExpr } from './intent.ts'
import { encode, hashOf } from './wire.ts'

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
