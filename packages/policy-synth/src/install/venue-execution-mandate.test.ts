import { describe, expect, it } from 'bun:test'
import { decodePredicate } from '../predicate/decode.js'
import { buildBlendExecutionMandate } from './venue-execution-mandate.js'

// Real testnet addresses from the proven spike (its configSc produced the
// predicates a live Blend supply+withdraw enforced).
const PRIME = 'CCNJO6DTS6IMQFJV5ZMMIEKGGIDBSPU45ICVG3V4GVBWGWIKEWD6JBIA'
const EXECUTOR = 'CDIJJICD27DVP3IHDH35CGYVRLM43IR2JQWBMPV5WWEN2UZ62TPX32QK'
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
const CUSTODY = 'GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN'

const mandate = () =>
  buildBlendExecutionMandate({
    prime: PRIME,
    custody: CUSTODY,
    executor: EXECUTOR,
    token: TOKEN,
    pool: POOL,
    maxAmountBaseUnits: '20000000',
  })

describe('buildBlendExecutionMandate', () => {
  it('emits a two-branch call predicate (pull OR submit) and default max_calls', () => {
    const m = mandate()
    expect(m.executor).toBe(EXECUTOR)
    expect(m.maxCalls).toBe(3)
    expect(m.callPredicate.op).toBe('or')
    expect(m.callPredicate.op === 'or' && m.callPredicate.children.length).toBe(2)
  })

  it('pins the pull leg: token.transfer_from prime<-custody->executor, bounded', () => {
    const m = mandate()
    const pull = m.callPredicate.op === 'or' ? m.callPredicate.children[0] : undefined
    const j = JSON.stringify(pull)
    expect(j).toContain('transfer_from')
    for (const a of [PRIME, CUSTODY, EXECUTOR, TOKEN]) expect(j).toContain(a)
    expect(j).toContain('"op":"lt"') // strict upper bound
    expect(j).toContain('20000000')
  })

  it('pins the submit leg: pool.submit position-at-Prime, one request, asset+types+amount', () => {
    const m = mandate()
    const submit = m.callPredicate.op === 'or' ? m.callPredicate.children[1] : undefined
    const j = JSON.stringify(submit)
    expect(j).toContain('submit')
    expect(j).toContain('call_arg_len') // exactly one request pinned
    expect(j).toContain('request_type')
    expect(j).toContain('"op":"in"') // request types {0,1}
    for (const a of [PRIME, EXECUTOR, CUSTODY, POOL, TOKEN]) expect(j).toContain(a)
  })

  it('auth predicate pins the ONLY nested executor authorization: token.transfer executor->pool', () => {
    const m = mandate()
    const j = JSON.stringify(m.authPredicate)
    expect(j).toContain('transfer')
    expect(j).toContain(EXECUTOR)
    expect(j).toContain(POOL)
    expect(j).not.toContain('transfer_from')
  })

  it('encodes to canonical bytes that decode back to the same AST (round trip), deterministically', () => {
    const a = mandate()
    const b = mandate()
    expect(a.encoded.callPredicate).toBe(b.encoded.callPredicate)
    expect(a.encoded.authPredicate).toBe(b.encoded.authPredicate)
    // decode round-trips (the interpreter/policy will decode these same bytes).
    expect(decodePredicate(a.encoded.callPredicate).op).toBe('or')
    expect(decodePredicate(a.encoded.authPredicate).op).toBe('and')
  })
})
