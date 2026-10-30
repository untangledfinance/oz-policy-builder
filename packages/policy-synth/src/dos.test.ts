// unvalidated tool input reprocessed in loops blocks the single-threaded server.
// Each oversized input below used to take 7-42 s; it is now refused at once, before the expensive
// loop (the BigInt parse, the 512-call copy, the per-entry key compare, the lowering walk).

import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { denyCases } from './check.ts'
import type { Call } from './record.ts'
import { run } from './tools.ts'
import { type Expr, type Val, validate } from './wire.ts'

const C = contract(1)
const A = account(1)
const fast = async (fn: () => Promise<unknown> | unknown, ms = 1500) => {
  const t0 = performance.now()
  await fn()
  const took = performance.now() - t0
  expect(took).toBeLessThan(ms)
  return took
}

describe('oversized input is refused before the expensive loop', () => {
  it('a million-digit i128 across 200 conditions is rejected without parsing it', async () => {
    // One shared huge magnitude, referenced 200 times: constructing the input costs nothing, and
    // validate must not BigInt-parse a million digits per condition.
    const huge = { i128: '1'.repeat(1_000_000) } as Val
    const expr: Expr = ['and', Array.from({ length: 200 }, () => ['lte', ['call_arg', 0], huge])]
    await fast(() => expect(() => validate(expr)).toThrow())
  })

  it('a 930k-digit limit is rejected at the schema, before it is copied into every call', async () => {
    // The old builder copied the limit into a cap on each of up to 512 recorded calls before it was
    // range-checked; the amount schema now caps its length first.
    const intent = {
      calls: [{ contract: C, fn: 'submit', where: [{ constraint: 'cap', at: [0], max: '5' }] }],
    }
    const limit = '9'.repeat(930_000)
    await fast(async () => {
      const r = (await run('synthesize_policy', { network: 'testnet', intent, limit })) as {
        ok: boolean
        error?: { code: string }
      }
      expect(r.ok).toBe(false)
      expect(r.error?.code).toBe('INVALID_INPUT')
    })
  })

  it('a zero-padded key over a map of 9900 entries is compared without re-stringifying it', async () => {
    const bigMap = { map: Array.from({ length: 9900 }, (_, i) => [`k${i}`, { i128: '1' }]) } as Val
    const permit: Call = { contract: C, fn: 'f', args: [bigMap] }
    const hugeKey = `${'0'.repeat(930_000)}1`
    const conjunct: Expr = ['eq', ['call_path', 0, hugeKey], { i128: '1' }]
    // The map lookup walks all 9900 entries; the sought key is serialised once, not per entry.
    await fast(() => denyCases([conjunct], permit))
  })

  it('a 400-deep nested intent is rejected at the schema, before the lowering walk', async () => {
    let where: unknown[] = [{ constraint: 'cap', at: ['amount'], max: '5' }]
    for (let i = 0; i < 400; i++) where = [{ constraint: 'each', at: [3], where }]
    const intent = { calls: [{ contract: C, fn: 'submit', where }] }
    await fast(async () => {
      const r = (await run('synthesize_policy', { network: 'testnet', intent })) as {
        ok: boolean
        error?: { code: string }
      }
      expect(r.ok).toBe(false)
      expect(r.error?.code).toBe('INVALID_INPUT')
    })
  })

  it('still accepts honest inputs (no over-restriction)', async () => {
    // A normal amount, a shallow intent and a small map all pass.
    expect(() =>
      validate([
        'and',
        [
          ['eq', ['call_contract'], C],
          ['lte', ['call_arg', 2], { i128: '5000000' }],
        ],
      ])
    ).not.toThrow()
    const intent = {
      calls: [
        {
          contract: C,
          fn: 'submit',
          where: [
            {
              constraint: 'each',
              at: [3],
              where: [{ constraint: 'cap', at: ['amount'], max: '5' }],
            },
          ],
        },
      ],
    }
    const r = (await run('synthesize_policy', { network: 'testnet', intent, limit: '5' })) as {
      ok: boolean
    }
    expect(r.ok).toBe(true)
    const permit: Call = { contract: C, fn: 'transfer', args: [A, A, { i128: '100' }] }
    expect(denyCases([['lte', ['call_arg', 2], { i128: '100' }]], permit)).toHaveLength(1)
  })
})
