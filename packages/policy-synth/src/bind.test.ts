// bind_policy on testnet (recorded): the unsigned bind_executor of a live rule, refused the ways the
// builder refuses it, and read back by the owner's review.

import { afterAll, describe, expect, it } from 'bun:test'
import { recorded } from '../test/rpc.ts'
import { run } from './tools.ts'

const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const GATED_ADAPTER = 'CCXFDHD7I7NWV37GQ6JTNSGP67EXYLG3QV4GJWUQUBEUEH3IANEI2QTG'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
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
  it('builds bind_executor for rule 5 (the pinned interpreter, its admin the source), and the review reads it back', async () => {
    const r = (await run('bind_policy', { ...base, ruleId: 5, executor: GATED_ADAPTER })) as Out
    expect(r.error).toBeUndefined()
    const d = r.data as {
      unsignedXdr: string
      binds: { id: number; review: string[] }
      executorKind: string
    }
    expect(d.executorKind).toBe('gated adapter')
    expect(d.binds.id).toBe(5)
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
      binds: { ruleId: 5, executor: GATED_ADAPTER },
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
    await no({ ruleId: 5, executor: XLM }, /not an execution adapter/)
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
