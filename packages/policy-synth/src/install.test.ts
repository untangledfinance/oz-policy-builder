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
  where: [{ rule: 'cap', at: [2], max: '500' }],
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
