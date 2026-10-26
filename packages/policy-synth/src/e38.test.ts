// STRIDE E-38: a KEYLESS rule that FOLLOWS another rule hands its whole fence to that rule's owner,
// who can loosen it at will. The pattern is allowed (an issuer governing a borrower's keyless rule),
// so it is never refused: the install, the binding and the owner's review each carry a warning
// naming the followed rule, and a keyed follower, a keyless rule of its own and an inline rule carry
// none. The tool cases run on testnet (recorded in fixtures/rpc/e38.json).

import { afterAll, describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { lines, warned } from './card.ts'
import type { ContractKind, Fingerprint } from './chain.ts'
import { INTERPRETER } from './config.ts'
import {
  type BindChain,
  type Chain,
  type Chosen,
  KEYLESS_FOLLOWER,
  planBind,
  planInstall,
  ruleWarnings,
} from './install.ts'
import { callExpr } from './intent.ts'
import type { ObservedRule } from './rules.ts'
import { explain, run } from './tools.ts'
import { encode, encodeReference, hashOf } from './wire.ts'

const INTERP = (INTERPRETER.testnet as { address: string }).address
const OWNER = contract(61)
const ACCOUNT_ = contract(62)
const ADAPTER = contract(63)
const VENUE = contract(64)
const SOURCE = account(6)
const KEY = account(7)

const ours: Fingerprint = {
  address: INTERP,
  grammarVersion: 7,
  wasmSha256: 'a'.repeat(64),
  matches: true,
}
const theirs = callExpr({ contract: VENUE, fn: 'submit' })
const payload = encodeReference({ account: OWNER, ruleId: 3 })
const follower: Chosen = {
  contract: VENUE,
  expr: theirs,
  encoded: payload,
  hash: hashOf(payload),
  follows: { account: OWNER, ruleId: 3, nonce: 2, predicateHash: hashOf(encode(theirs)) },
}
const inline: Chosen = {
  contract: VENUE,
  expr: theirs,
  encoded: encode(theirs),
  hash: hashOf(encode(theirs)),
}
const input = { network: 'testnet' as const, smartAccount: ACCOUNT_, sourceAccount: SOURCE }
const chain = (
  kinds: Record<string, ContractKind> = { [ADAPTER]: 'null-gate adapter' }
): Chain => ({
  fingerprint: async () => ours,
  readRules: async () => ({ rules: [], complete: true, unreadable: [] }),
  build: async () => ({ unsignedXdr: 'AAAA' }) as never,
  token: async () => true,
  contracts: async (a) => Object.fromEntries(a.map((x) => [x, kinds[x] ?? 'contract'])),
})
/** The one E-38 warning, as each surface must carry it. */
const e38 = (executor?: string) => KEYLESS_FOLLOWER({ account: OWNER, ruleId: 3 }, executor)

describe('E-38: the warning text', () => {
  it('names the finding, the followed owner and rule, the executor, and what to do', () => {
    const w = e38(ADAPTER)
    expect(w.startsWith('E-38: ')).toBe(true)
    expect(w).toContain(`owner ${OWNER}, rule 3`)
    expect(w).toContain(`this rule's executor ${ADAPTER}`)
    expect(w).toMatch(/loosen it at will and allow anyone to move funds/)
    expect(w).toMatch(/Only follow a rule whose owner you trust with these funds\.$/)
    expect(e38()).toContain('the adapter this rule is bound to')
  })

  it('fires only for no signer AND a followed rule', () => {
    const ref = { account: OWNER, ruleId: 3 }
    expect(ruleWarnings([], ref)).toEqual([e38()])
    expect(ruleWarnings([KEY], ref)).toEqual([])
    expect(ruleWarnings([], undefined)).toEqual([])
    expect(ruleWarnings([KEY], undefined)).toEqual([])
  })
})

describe('E-38: planInstall warns, and builds', () => {
  it('a keyless follower: built, with the warning naming the followed owner and the executor', async () => {
    const r = await planInstall({ ...input, signers: [], executor: ADAPTER }, follower, chain())
    expect(r.unsignedXdr).toBe('AAAA')
    expect(r.warnings).toEqual([e38(ADAPTER)])
    // Never a refusal and never an override: nothing was waived to build it.
    expect(r.overrides).toEqual([])
  })

  it('a keyed follower, a keyless rule of its own and an inline keyed rule: no warning', async () => {
    const keyed = await planInstall({ ...input, signers: [KEY] }, follower, chain())
    expect(keyed.warnings).toEqual([])
    const own = await planInstall({ ...input, signers: [], executor: ADAPTER }, inline, chain())
    expect(own.warnings).toEqual([])
    const plain = await planInstall({ ...input, signers: [KEY] }, inline, chain())
    expect(plain.warnings).toEqual([])
  })
})

describe('E-38: planBind warns when it binds a keyless follower', () => {
  const observed = (o: Partial<ObservedRule> = {}): ObservedRule => ({
    id: 4,
    scope: { kind: 'call_contract', contract: VENUE },
    signers: [],
    policies: [INTERP],
    expr: theirs,
    admins: [SOURCE],
    follows: { account: OWNER, ruleId: 3, nonce: 2 },
    ...o,
  })
  const bindChain = (r: ObservedRule): BindChain => ({
    readRule: async () => r,
    readRules: async () => ({ rules: [r], complete: true, unreadable: [] }),
    kind: async () => 'null-gate adapter',
    fingerprint: async () => ours,
    build: async () => ({ unsignedXdr: 'BBBB' }) as never,
  })
  const i = { smartAccount: ACCOUNT_, sourceAccount: SOURCE, ruleId: 4, executor: ADAPTER }

  it('fires for a keyless follower, and the binding is still built', async () => {
    const r = await planBind(i, INTERP, bindChain(observed()))
    expect(r.unsignedXdr).toBe('BBBB')
    expect(r.warnings).toEqual([e38(ADAPTER)])
  })

  it('a keyless rule with its own predicate: no warning', async () => {
    const r = await planBind(i, INTERP, bindChain(observed({ follows: undefined })))
    expect(r.warnings).toEqual([])
  })
})

describe('E-38: the review shows the warning right after any override, before the authority', () => {
  it('explain puts the warnings node after the overrides and before the rest', () => {
    const shown = explain(
      { network: 'testnet' },
      {
        expr: theirs,
        follows: follower.follows,
        overrides: [{ flag: 'allowOverlap', waived: null }],
        warnings: [e38(ADAPTER)],
      }
    )
    expect(shown.reviewTree.map((n) => n.op).slice(0, 3)).toEqual([
      'overrides',
      'warnings',
      'follows',
    ])
    const text = shown.review.join('\n')
    expect(text).toContain('Warning: 1 thing(s) to know before signing')
    expect(text).toContain(`warning:  ${e38(ADAPTER)}`)
    expect(explain({ network: 'testnet' }, { expr: theirs }).review.join('\n')).not.toMatch(
      /E-38|Warning:/
    )
  })

  it('the card node reads one line per warning', () => {
    expect(lines([warned(['a', 'b'])])).toEqual([
      'Warning: 2 thing(s) to know before signing',
      '├─ warning:  a',
      '└─ warning:  b',
    ])
  })
})

// ---- the tools, on the live-test account (recorded) ----

const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const NULL_ADAPTER = 'CD5Y3SNPN3HX5S6XXYCZRQIP7U6FCQIMJJDZ7QKKSYYJG4343SYJ5SA2'
const LIVE_VENUE = 'CCLBPEYS3XFK65MYYXSBMOGKUI4ODN5S7SUZBGD7NALUQF64QILLX5B5'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

const net = recorded('e38')
afterAll(() => net.stop())
const base = { network: 'testnet', smartAccount: ACCOUNT, sourceAccount: SIGNER }
type Out = {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}
type Install = { unsignedXdr: string; warnings: string[]; rule: { review: string[] } }
type Review = { problems: string[]; warnings: string[]; signable: boolean; review: string[] }
/** Rule 6 of the live-test account (a cap of 500 on a transfer): the rule the followers follow. */
const RULE6 = KEYLESS_FOLLOWER({ account: ACCOUNT, ruleId: 6 }, NULL_ADAPTER)
const RULE6_BYTES = KEYLESS_FOLLOWER({ account: ACCOUNT, ruleId: 6 })

const install = async (i: object) => {
  const r = (await run('install_policy', { ...base, ...i })) as Out
  expect(r.error).toBeUndefined()
  return r.data as Install
}
const review = async (x: string, readContracts = false) =>
  (
    (await run('review_unsigned', {
      network: 'testnet',
      xdr: x,
      smartAccount: ACCOUNT,
      readContracts,
    })) as Out
  ).data as Review

describe('E-38: install_policy and review_unsigned, on a live account', () => {
  it('a keyless follower: built, warned in the result and at the top of both reviews, still signable', async () => {
    const d = await install({
      signers: [],
      executor: NULL_ADAPTER,
      follow: { smartAccount: ACCOUNT, ruleId: 6 },
    })
    expect(d.warnings).toEqual([RULE6])
    expect(d.rule.review.join('\n')).toContain(`warning:  ${RULE6}`)
    expect(d.rule.review[0]).toBe('Warning: 1 thing(s) to know before signing')
    // Offline the followed predicate is not in the bytes (a problem), and the warning is there anyway.
    const offline = await review(d.unsignedXdr)
    expect(offline.warnings).toEqual([RULE6_BYTES])
    expect(offline.problems.join('\n')).not.toMatch(/E-38/)
    // Read through the RPC, nothing is wrong: signable, and warned all the same.
    const read = await review(d.unsignedXdr, true)
    expect(read).toMatchObject({ problems: [], signable: true, warnings: [RULE6_BYTES] })
    expect(read.review.join('\n')).toContain(`warning:  ${RULE6_BYTES}`)
  })

  it('a keyed follower, a keyless rule of its own and an inline keyed rule: no warning anywhere', async () => {
    const keyed = await install({
      signers: [account(5)],
      follow: { smartAccount: ACCOUNT, ruleId: 6 },
    })
    const own = await install({
      signers: [],
      executor: NULL_ADAPTER,
      intent: {
        calls: [
          {
            contract: NULL_ADAPTER,
            fn: 'execute',
            where: [
              { constraint: 'pin', at: [2], to: 0 },
              { constraint: 'count', at: [0], is: 1 },
              { constraint: 'pin', at: [0, 0, 'target'], to: LIVE_VENUE },
              { constraint: 'pin', at: [0, 0, 'function_name'], to: 'submit' },
              { constraint: 'count', at: [1], is: 0 },
            ],
          },
        ],
      },
    })
    const plain = await install({
      signers: [account(8)],
      intent: {
        calls: [
          { contract: XLM, fn: 'transfer', where: [{ constraint: 'cap', at: [2], max: '500' }] },
        ],
      },
    })
    for (const d of [keyed, own, plain]) {
      expect(d.warnings).toEqual([])
      expect(d.rule.review.join('\n')).not.toMatch(/E-38|Warning:/)
      const r = await review(d.unsignedXdr)
      expect(r.warnings).toEqual([])
      expect(r.review.join('\n')).not.toMatch(/E-38|Warning:/)
    }
  })
})
