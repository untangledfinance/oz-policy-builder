// Reference keyless rules (recorded predicate bytes): the rules scoped to their own executor
// still pass the builder's mirror of the interpreter's `pins_own` once the grants count is required,
// and a rule scoped elsewhere is not judged by it. The liquidation rule pins its
// grants count to 5 in one `or` branch and 3 in the other.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pinsOwn } from './install.ts'
import { CEILINGS, decode, type Expr, validate } from './wire.ts'

type Reference = {
  id: number
  signers: number
  scope: string
  executor: string | null
  source: string
  predicate_hex: string
}
const reference = JSON.parse(
  readFileSync(new URL('../fixtures/keyless-reference-predicates.json', import.meta.url), 'utf8')
) as Record<string, Reference[]>

const exprOf = (r: Reference): Expr =>
  decode(Buffer.from(r.predicate_hex, 'hex').toString('base64'))

describe('the reference keyless rules, scoped to their own executor', () => {
  for (const [deployment, rules] of Object.entries(reference)) {
    const own = rules.filter(
      (r) => r.predicate_hex !== '' && r.executor !== null && r.scope === r.executor
    )
    it(`${deployment}: there are some, and each still pins \`run\` or a whole batch with its grants count`, () => {
      expect(own.length).toBeGreaterThanOrEqual(2)
      for (const r of own) {
        const e = exprOf(r)
        validate(e, CEILINGS)
        expect(pinsOwn(e)).toBe(true)
      }
    })
  }

  it('the liquidation rule pins 5 grants in one branch and 3 in the other, and is refused without them', () => {
    const r = reference['set-a']?.find((x) => x.id === 22) as Reference
    const e = exprOf(r)
    const counts = JSON.stringify(e).match(/\["eq",\["call_path",1,true\],(\d+)\]/g) ?? []
    expect(counts.map((c) => c.replace(/\D+/g, '').slice(-1)).sort()).toEqual(['3', '5'])
    // The same rule with each grants pin replaced by a trivially true comparison: nothing pins them.
    const strip = (v: unknown): unknown =>
      !Array.isArray(v)
        ? v
        : v[0] === 'eq' && JSON.stringify(v[1]) === '["call_path",1,true]'
          ? ['eq', 0, 0]
          : v.map(strip)
    expect(pinsOwn(strip(e) as Expr)).toBe(false)
    // One branch stripped only: still refused (an `or` pins only when every branch does).
    let stripped = 0
    const stripOnce = (v: unknown): unknown => {
      if (!Array.isArray(v)) return v
      if (v[0] === 'eq' && JSON.stringify(v[1]) === '["call_path",1,true]' && stripped === 0) {
        stripped++
        return ['eq', 0, 0]
      }
      return v.map(stripOnce)
    }
    expect(pinsOwn(stripOnce(e) as Expr)).toBe(false)
  })
})
