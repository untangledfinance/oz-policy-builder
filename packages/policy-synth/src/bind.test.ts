// bind_policy on testnet (recorded): the unsigned bind_executor of a live rule, refused the ways the
// builder refuses it, and read back by the owner's review.

import { afterAll, describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { run } from './tools.ts'

const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const GATED_ADAPTER = 'CCXFDHD7I7NWV37GQ6JTNSGP67EXYLG3QV4GJWUQUBEUEH3IANEI2QTG'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const TOKEN = contract(7)
const NULL_ADAPTER = 'CD5Y3SNPN3HX5S6XXYCZRQIP7U6FCQIMJJDZ7QKKSYYJG4343SYJ5SA2'
const VENUE = 'CCLBPEYS3XFK65MYYXSBMOGKUI4ODN5S7SUZBGD7NALUQF64QILLX5B5'

const net = recorded('bind')
afterAll(() => net.stop())
const base = { network: 'testnet', smartAccount: ACCOUNT, sourceAccount: SIGNER }
type Out = {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}

describe('bind_policy, on a live account', () => {
  it('builds bind_executor for rule 6 (the pinned interpreter, its admin the source), and the review reads it back', async () => {
    const r = (await run('bind_policy', { ...base, ruleId: 6, executor: GATED_ADAPTER })) as Out
    expect(r.error).toBeUndefined()
    const d = r.data as {
      unsignedXdr: string
      binds: { id: number; review: string[] }
      executorKind: string
    }
    expect(d.executorKind).toBe('gated adapter')
    expect(d.binds.id).toBe(6)
    expect(d.binds.review.join('\n')).toMatch(/executor/)
    const v = (await run('review_unsigned', {
      network: 'testnet',
      xdr: d.unsignedXdr,
      smartAccount: ACCOUNT,
      readContracts: true,
    })) as Out
    expect(v.data).toMatchObject({
      problems: [],
      signable: true,
      binds: { ruleId: 6, executor: GATED_ADAPTER },
    })
  })

  it('refuses a rule the pinned interpreter does not police, a missing rule, and an executor that is no adapter', async () => {
    const no = async (input: object, text: RegExp) => {
      const r = (await run('bind_policy', { ...base, executor: GATED_ADAPTER, ...input })) as Out
      expect(r.error?.code).toBe('BIND_BUILD_FAILED')
      expect(r.error?.message).toMatch(text)
    }
    await no({ ruleId: 3 }, /not policed/)
    await no({ ruleId: 400 }, /has no rule 400/)
    await no({ ruleId: 6, executor: XLM }, /not an execution adapter/)
  })
})

describe('install_policy of a keyless rule for the no-gate adapter, on a live account', () => {
  const liquidation = {
    calls: [
      {
        contract: NULL_ADAPTER,
        fn: 'execute',
        where: [
          { constraint: 'pin', at: [2], to: 0 },
          { constraint: 'count', at: [0], is: 1 },
          { constraint: 'pin', at: [0, 0, 'target'], to: VENUE },
          { constraint: 'pin', at: [0, 0, 'function_name'], to: 'submit' },
          { constraint: 'count', at: [1], is: 0 },
        ],
      },
    ],
  }

  it('builds add_context_rule with no signer, scoped to the adapter, and says what binding it means', async () => {
    const r = (await run('install_policy', {
      ...base,
      signers: [],
      executor: NULL_ADAPTER,
      intent: liquidation,
    })) as Out
    expect(r.error).toBeUndefined()
    const d = r.data as {
      unsignedXdr: string
      authority: { signers: string[] }
      rule: { review: string[] }
    }
    expect(d.authority.signers).toEqual([])
    expect(d.rule.review.join('\n')).toMatch(/anyone may call its execute with an immediate batch/)
    const v = (await run('review_unsigned', {
      network: 'testnet',
      xdr: d.unsignedXdr,
      smartAccount: ACCOUNT,
    })) as Out
    expect(v.data).toMatchObject({ problems: [], signable: true })
    expect((v.data as { review: string[] }).review.join('\n')).toMatch(
      /no key: the rule permits only a call its executor vouches for, and with no executor bound, none/
    )
  })

  it('refuses a batch left open: the interpreter would refuse it once bound (221)', async () => {
    const open = {
      calls: [{ ...liquidation.calls[0], where: liquidation.calls[0]?.where.slice(0, 1) }],
    }
    const r = (await run('install_policy', {
      ...base,
      signers: [],
      executor: NULL_ADAPTER,
      intent: open,
    })) as Out
    expect(r.error?.code).toBe('INSTALL_BUILD_FAILED')
    expect(r.error?.message).toMatch(/221/)
  })
})

describe('a rule that follows another, on the pinned interpreter (it supports references)', () => {
  // Not rule 7's signer: a second follower of rule 6 beside it would share that signer, refused.
  const OTHER_SIGNER = account(5)

  it('install_policy with follow builds the reference, and the owner review resolves it signable', async () => {
    const r = (await run('install_policy', {
      ...base,
      signers: [OTHER_SIGNER],
      follow: { smartAccount: ACCOUNT, ruleId: 6 },
    })) as Out
    expect(r.error).toBeUndefined()
    const d = r.data as {
      unsignedXdr: string
      rule: { follows: { ruleId: number; nonce: number }; review: string[] }
    }
    expect(d.rule.follows).toMatchObject({ account: ACCOUNT, ruleId: 6, nonce: 1 })
    expect(d.rule.review.join('\n')).toMatch(/Follows rule 6 of/)
    const offline = (await run('review_unsigned', {
      network: 'testnet',
      xdr: d.unsignedXdr,
      smartAccount: ACCOUNT,
    })) as Out
    expect(offline.data).toMatchObject({ signable: false })
    const read = (await run('review_unsigned', {
      network: 'testnet',
      xdr: d.unsignedXdr,
      smartAccount: ACCOUNT,
      readContracts: true,
    })) as Out
    expect(read.data).toMatchObject({ problems: [], signable: true })
  })

  it('simulate_policy with follow checks the followed predicate now, on the interpreter itself', async () => {
    const r = (await run('simulate_policy', {
      network: 'testnet',
      follow: { smartAccount: ACCOUNT, ruleId: 6 },
      calls: [
        { contract: TOKEN, fn: 'transfer', args: [ACCOUNT, SIGNER, { i128: '400' }] },
        { contract: TOKEN, fn: 'transfer', args: [ACCOUNT, SIGNER, { i128: '600' }] },
      ],
    })) as Out
    expect(r.error).toBeUndefined()
    const res = (r.data as { results: { permitted: boolean }[] }).results
    expect(res.map((x) => x.permitted)).toEqual([true, false])
  })

  it('following a rule that itself follows another is refused before anything is built', async () => {
    const r = (await run('install_policy', {
      ...base,
      signers: [OTHER_SIGNER],
      follow: { smartAccount: ACCOUNT, ruleId: 7 },
    })) as Out
    expect(r.error?.code).toBe('INSTALL_BUILD_FAILED')
    expect(r.error?.message).toMatch(/one level only/)
  })
})
