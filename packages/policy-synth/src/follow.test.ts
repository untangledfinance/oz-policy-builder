// A rule that follows another rule's predicate: the payload the interpreter reads as a reference,
// the stored record read back (the followed rule's predicate now, one level only, never a guess),
// the authority scan around such a rule, and the install that emits one.

import { describe, expect, it } from 'bun:test'
import { Address, type rpc, xdr } from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import { followed, lines } from './card.ts'
import type { Fingerprint } from './chain.ts'
import { INTERPRETER } from './config.ts'
import { Refusal } from './envelope.ts'
import { type Chain, type Chosen, planInstall, type RuleDraft, ruleArgs } from './install.ts'
import { callExpr } from './intent.ts'
import { type ObservedRule, overlaps, readFollowed, readPredicates } from './rules.ts'
import { run } from './tools.ts'
import {
  CEILINGS,
  type Expr,
  encode,
  encodeReference,
  hashOf,
  MAX_REFERENCE_BYTES,
  referenceOf,
  toScVal,
  type Val,
} from './wire.ts'

const INTERP = (INTERPRETER.testnet as { address: string }).address
const A = contract(11)
const B = contract(12)
const SIGNER = account(3)
const TOKEN = contract(7)
const capped = (max: string) =>
  callExpr({ contract: TOKEN, fn: 'transfer', where: [{ constraint: 'cap', at: [2], max }] })
const hex = (e: Expr) => Buffer.from(encode(e), 'base64').toString('hex')

// ---- the payload ----

describe('a reference payload, read as the interpreter reads it', () => {
  it('round-trips (account, rule id), fits the 128-byte window and is no predicate node', () => {
    const b64 = encodeReference({ account: A, ruleId: 5 })
    expect(referenceOf(b64)).toEqual({ account: A, ruleId: 5 })
    expect(Buffer.from(b64, 'base64').length).toBeLessThanOrEqual(MAX_REFERENCE_BYTES)
    // Its XDR is a vector of an address and a u32: no symbol head, so no node has this shape.
    expect(xdr.ScVal.fromXDR(b64, 'base64').vec()?.[0]?.switch().name).toBe('scvAddress')
    expect(referenceOf(encodeReference({ account: account(4), ruleId: 0 }))).toEqual({
      account: account(4),
      ruleId: 0,
    })
  })

  it('near misses are not references: reversed, three long, another integer type, a symbol, a node', () => {
    const near: Val[] = [
      [5, A],
      [A, 5, 6],
      [A],
      [A, { i32: 5 }],
      [A, { u64: '5' }],
      ['eq', 5],
      ['and', [['eq', ['call_fn'], 'pay']]],
      [[A], 5],
    ]
    for (const v of near) expect(referenceOf(encode(v))).toBeUndefined()
    // A small real predicate is never one either.
    expect(referenceOf(encode(capped('1')))).toBeUndefined()
    expect(referenceOf('not base64 xdr')).toBeUndefined()
  })

  it('a payload past 128 bytes is not tried, as the interpreter does not', () => {
    // Pad a valid pair past the window with trailing bytes: refused by size before any decode.
    const big = Buffer.concat([
      Buffer.from(encodeReference({ account: A, ruleId: 1 }), 'base64'),
      Buffer.alloc(MAX_REFERENCE_BYTES),
    ]).toString('base64')
    expect(referenceOf(big)).toBeUndefined()
  })
})

// ---- the stored records ----

const docVal = (o: { bytes?: string; nonce?: number; source?: Val | undefined }): Val => ({
  map: [
    ['executor', null],
    ['master_set', []],
    ['nonce', o.nonce ?? 1],
    ['predicate_bytes', { bytes: o.bytes ?? '' }],
    ['scope', null],
    ['signers_hash', { bytes: '00'.repeat(32) }],
    ...(o.source === undefined ? [] : [['source', o.source] as [Val, Val]]),
  ],
})
const inline = (e: Expr, nonce = 1) => docVal({ bytes: hex(e), nonce, source: ['Inline'] })
const follows = (account: string, id: number) => docVal({ source: ['Rule', account, id] })

/** The interpreter's storage: (account, rule id) -> stored record. Counts the ledger reads. */
const store = (docs: Record<string, Val>) => {
  const batches: number[] = []
  const server = {
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      batches.push(keys.length)
      return {
        entries: keys.flatMap((k) => {
          const d = k.contractData()
          const [acct, id] = d.key().vec() ?? []
          const name = acct && id ? `${Address.fromScVal(acct).toString()}:${id.u32()}` : ''
          const v = docs[name]
          if (v === undefined) return []
          const data = xdr.LedgerEntryData.contractData(
            new xdr.ContractDataEntry({
              ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
              contract: d.contract(),
              key: d.key(),
              durability: d.durability(),
              val: toScVal(v),
            })
          )
          return [{ key: k, val: data }]
        }),
      }
    },
  }
  return { server: server as unknown as rpc.Server, batches }
}
const ruleOn = (id: number, policies = [INTERP]): ObservedRule => ({
  id,
  scope: { kind: 'call_contract', contract: TOKEN },
  signers: [SIGNER],
  policies,
})

describe('readPredicates: a rule that follows another reads that rule now, one level only', () => {
  it('in two batches: own records, then every followed record; inline, legacy and followed rules', async () => {
    const theirs = capped('500')
    const { server, batches } = store({
      [`${A}:2`]: inline(theirs, 4),
      [`${B}:1`]: inline(capped('7')),
      [`${B}:3`]: docVal({ bytes: hex(capped('9')) }), // a build with no source field: inline
      [`${B}:5`]: follows(A, 2),
    })
    const rules = [ruleOn(1), ruleOn(3), ruleOn(5), ruleOn(6, [])]
    expect(await readPredicates(server, INTERP, B, rules)).toEqual([])
    expect(batches).toEqual([3, 1])
    expect(rules[0]?.expr).toEqual(capped('7'))
    expect(rules[1]?.expr).toEqual(capped('9'))
    expect(rules[2]).toMatchObject({
      expr: theirs,
      follows: { account: A, ruleId: 2, nonce: 4, predicateHash: hashOf(encode(theirs)) },
    })
    expect(rules[3]?.expr).toBeUndefined()
  })

  it('a followed rule missing, itself following, a self-loop or undecodable: unread, never its own empty bytes', async () => {
    const { server } = store({
      [`${A}:2`]: follows(A, 9), // a chain
      [`${A}:9`]: inline(capped('1')),
      [`${A}:3`]: docVal({ bytes: 'deadbeef', source: ['Inline'] }), // junk bytes
      [`${B}:1`]: follows(A, 7), // missing
      [`${B}:2`]: follows(A, 2), // chain
      [`${B}:3`]: follows(B, 3), // self-loop
      [`${B}:4`]: follows(A, 3), // undecodable
      [`${B}:5`]: docVal({ source: ['Elsewhere', A, 1] }), // a source this package does not know
      // A followed record that is a reference AND carries bytes: still a chain, its bytes unused.
      [`${A}:4`]: docVal({ bytes: hex(capped('1')), source: ['Rule', A, 9] }),
      [`${B}:6`]: follows(A, 4),
    })
    const rules = [1, 2, 3, 4, 5, 6].map((id) => ruleOn(id))
    expect(await readPredicates(server, INTERP, B, rules)).toEqual([1, 2, 3, 4, 5, 6])
    for (const r of rules) expect(r.expr).toBeUndefined()
    // What is known is said: which rule each follows, with nothing read of it.
    expect(rules[0]?.follows).toEqual({ account: A, ruleId: 7 })
    expect(rules[4]?.follows).toBeUndefined()
  })
})

describe('readFollowed: the rule an install follows, refused the ways the interpreter refuses it', () => {
  const at = { account: A, ruleId: 2 }
  const refused = async (p: Promise<unknown>, code: string, text: RegExp) => {
    const e = await p.then(
      () => undefined,
      (x) => x
    )
    expect(e).toBeInstanceOf(Refusal)
    expect((e as Refusal).code).toBe(code)
    expect((e as Refusal).message).toMatch(text)
  }

  it('its predicate now, its encoding, hash and nonce', async () => {
    const { server } = store({ [`${A}:2`]: inline(capped('500'), 3) })
    const f = await readFollowed(server, INTERP, at, CEILINGS, 'INSTALL_BUILD_FAILED')
    expect(f.expr).toEqual(capped('500'))
    expect(f.encoded).toBe(encode(capped('500')))
    expect(f.follows).toEqual({ ...at, nonce: 3, predicateHash: hashOf(encode(capped('500'))) })
  })

  it('missing (206), a build with no references, a chain (201), undecodable or over the limits', async () => {
    const run = (docs: Record<string, Val>, caps = CEILINGS) =>
      readFollowed(store(docs).server, INTERP, at, caps, 'INSTALL_BUILD_FAILED')
    await refused(run({}), 'INSTALL_BUILD_FAILED', /holds no rule 2 of .*206/)
    await refused(
      run({ [`${A}:2`]: docVal({ bytes: hex(capped('5')) }) }),
      'INSTALL_BUILD_FAILED',
      /no rule references/
    )
    await refused(run({ [`${A}:2`]: follows(B, 1) }), 'INSTALL_BUILD_FAILED', /one level only.*201/)
    const both = docVal({ bytes: hex(capped('5')), source: ['Rule', B, 1] })
    await refused(run({ [`${A}:2`]: both }), 'INSTALL_BUILD_FAILED', /one level only/)
    await refused(
      run({ [`${A}:2`]: docVal({ bytes: 'deadbeef', source: ['Inline'] }) }),
      'MALFORMED_PREDICATE',
      /cannot read/
    )
    await refused(
      run({ [`${A}:2`]: inline(capped('5')) }, { ...CEILINGS, max_leaves: 1 }),
      'MALFORMED_PREDICATE',
      /cannot read/
    )
  })
})

// ---- the authority scan ----

describe('overlaps: a rule whose predicate another account can change is judged as such', () => {
  const mine = { scope: { kind: 'call_contract' as const, contract: TOKEN }, signers: [SIGNER] }
  const tight = capped('10')
  const loose = capped('1000')

  it('a neighbour that follows another rule is refused, however tight it reads now', () => {
    const old: ObservedRule = { ...ruleOn(4), expr: tight, follows: { account: A, ruleId: 2 } }
    const [o] = overlaps({ ...mine, expr: loose }, [old], INTERP, 'testnet')
    expect(o).toMatchObject({ ruleId: 4, severity: 'refuse', why: 'follows' })
    // Unread, it is still a follower: refused for that.
    const unread: ObservedRule = {
      ...ruleOn(4),
      unreadable: true,
      follows: { account: A, ruleId: 2 },
    }
    expect(overlaps({ ...mine, expr: loose }, [unread], INTERP, 'testnet')[0]?.why).toBe('follows')
    // Its scope alone decides whether it serves the same calls: another contract does not.
    const away: ObservedRule = { ...old, scope: { kind: 'call_contract', contract: contract(8) } }
    expect(overlaps({ ...mine, expr: loose }, [away], INTERP, 'testnet')).toEqual([])
  })

  it('a new rule that follows: a tighter neighbour is refused (it could become the looser one)', () => {
    const old: ObservedRule = { ...ruleOn(4), expr: tight }
    expect(overlaps({ ...mine, expr: loose }, [old], INTERP, 'testnet')[0]?.severity).toBe('review')
    const [o] = overlaps(
      { ...mine, expr: loose, follows: { account: A, ruleId: 2 } },
      [old],
      INTERP,
      'testnet'
    )
    expect(o).toMatchObject({ severity: 'refuse', why: 'follows' })
  })
})

// ---- the install ----

describe('planInstall of a rule that follows another', () => {
  const ours: Fingerprint = {
    address: INTERP,
    grammarVersion: 7,
    wasmSha256: 'a'.repeat(64),
    matches: true,
  }
  const theirs = capped('500')
  const payload = encodeReference({ account: A, ruleId: 2 })
  const rule: Chosen = {
    contract: TOKEN,
    expr: theirs,
    encoded: payload,
    hash: hashOf(payload),
    follows: { account: A, ruleId: 2, nonce: 3, predicateHash: hashOf(encode(theirs)) },
  }
  const input = {
    network: 'testnet' as const,
    smartAccount: B,
    sourceAccount: SIGNER,
    signers: [SIGNER],
  }
  const chain = (rules: ObservedRule[] = [], drafts: RuleDraft[] = []): Chain => ({
    fingerprint: async () => ours,
    readRules: async () => ({ rules, complete: true, unreadable: [] }),
    build: async (d) => {
      drafts.push(d)
      return { unsignedXdr: 'AAAA' } as never
    },
    token: async () => true,
    contracts: async () => ({}),
  })

  it('emits the reference: the payload is (account, rule id) and the hash commits to it', async () => {
    const drafts: RuleDraft[] = []
    const r = await planInstall(input, rule, chain([], drafts))
    const d = drafts[0] as RuleDraft
    expect(d.predicate).toEqual({ encoded: payload, hash: hashOf(payload) })
    // The interpreter's install params carry exactly those bytes and that hash.
    const params = (ruleArgs(d, INTERP)[4] as { map: [Val, { map: [string, Val][] }][] }).map[0]
    const p = Object.fromEntries(params?.[1].map ?? [])
    expect(p.predicate).toEqual({ bytes: Buffer.from(payload, 'base64').toString('hex') })
    expect(p.predicate_hash).toEqual({ bytes: hashOf(payload) })
    expect(r.rule).toEqual({
      contract: TOKEN,
      predicateHash: hashOf(payload),
      follows: rule.follows,
    })
  })

  it("every refusal is judged on the followed rule's predicate now", async () => {
    const reads = callExpr({
      contract: TOKEN,
      fn: 'transfer',
      where: [
        { constraint: 'read', contract: contract(30), fn: 'spot', op: 'gte', to: { i128: '1' } },
      ],
    })
    const e = await planInstall(input, { ...rule, expr: reads }, chain()).catch((x) => x)
    expect(e).toBeInstanceOf(Refusal)
    expect((e as Refusal).code).toBe('READ_UNSAFE')
    const tighter: ObservedRule = { ...ruleOn(4), expr: capped('10') }
    const o = await planInstall(input, rule, chain([tighter])).catch((x) => x)
    expect((o as Refusal).message).toMatch(/follows rule 2 of/)
  })

  it('the review says what it follows, what it holds now and who can change it', () => {
    const text = lines([followed(rule.follows as never, {})]).join('\n')
    expect(text).toMatch(/Follows rule 2 of/)
    expect(text).toMatch(/install nonce 3/)
    expect(text).toMatch(/without this account's signature/)
    expect(text).toMatch(/refused \(206\)/)
    expect(lines([followed({ account: A, ruleId: 2 }, {})]).join('\n')).toMatch(/not read/)
  })
})

describe('the tools take `follow` as one more way to name a predicate, never beside another', () => {
  const follow = { smartAccount: A, ruleId: 2 }
  it('install_policy and simulate_policy refuse it beside a predicate or a source, before any RPC', async () => {
    const install = await run('install_policy', {
      network: 'testnet',
      follow,
      encodedPredicate: encode(capped('1')),
      smartAccount: B,
      sourceAccount: SIGNER,
      signers: [SIGNER],
    })
    expect(install.ok).toBe(false)
    expect(!install.ok && install.error).toMatchObject({ code: 'INVALID_INPUT' })
    expect(!install.ok && install.error.message).toMatch(
      /give exactly one of follow, encodedPredicate/
    )
    const sim = await run('simulate_policy', { network: 'testnet', follow, expr: capped('1') })
    expect(!sim.ok && sim.error.message).toMatch(
      /give exactly one of expr, encodedPredicate, follow/
    )
    const bad = await run('simulate_policy', {
      network: 'testnet',
      follow: { ...follow, extra: 1 },
    })
    expect(!bad.ok && bad.error.code).toBe('INVALID_INPUT')
  })
})
