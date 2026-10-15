// Real mainnet transactions (fixtures/corpus/mainnet.json, 33 envelopes of 26 shapes) taken
// all the way through: decoded, turned into a rule, and the rule put to the live
// interpreter with the call it was made from. Replayed offline from a recorded run.

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { readFileSync } from 'node:fs'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { runChecks } from './check.ts'
import { decodeEnvelope } from './record.ts'
import { propose, synthesize } from './synth.ts'

interface Entry {
  hash: string
  category: string
  hostFnType: string
  envelopeXdr: string
}
const corpus: Entry[] = JSON.parse(
  readFileSync(new URL('../fixtures/corpus/mainnet.json', import.meta.url), 'utf8')
)

setDefaultTimeout(60_000)
const net = recorded('corpus')
afterAll(() => net.stop())
const server = connect(net.endpoint)
const interpreter = interpreterFor('testnet')

describe('the real mainnet corpus', () => {
  it('is 33 contract calls', () => {
    expect(corpus).toHaveLength(33)
    expect(new Set(corpus.map((e) => e.hostFnType))).toEqual(
      new Set(['hostFunctionTypeInvokeContract'])
    )
  })

  it('every call decodes, becomes rules the contract would decode, and the interpreter permits the call it came from', async () => {
    const failures: string[] = []
    for (const e of corpus) {
      const rec = decodeEnvelope(e.envelopeXdr, 'mainnet')
      const s = synthesize(rec.contexts, { limit: '1000000000000000000' })
      for (const rule of propose(s.intent)) {
        const mine = rec.contexts.filter((c) => c.contract === rule.contract)
        const verdicts = await runChecks(server, 'testnet', interpreter, rule.encoded, mine)
        verdicts.forEach((v, n) => {
          if (!v.permitted)
            failures.push(`${e.category} ${e.hash.slice(0, 8)} ${mine[n]?.fn}: ${v.reason}`)
        })
      }
    }
    expect(failures).toEqual([])
  })
})
