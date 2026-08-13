import { describe, expect, it } from 'bun:test'
import { type EscapeHatchSpec, generateRust } from './template.ts'

const SAMPLE: EscapeHatchSpec = {
  contract: 'CBP_POLICY',
  fnName: 'enforce',
  uncovered: [
    'multi-asset-cap with weights > 1',
    'conditional co-signer approval only when amount >= threshold',
  ],
}

describe('generateRust', () => {
  it('is deterministic: same spec -> byte-identical output', () => {
    const a = generateRust(SAMPLE, 'escape-hatch-policy')
    const b = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(a).toBe(b)
  })

  it('uses the policy name (sanitised) as the contract struct name', () => {
    // The sanitiser maps `-` to `_` so the generated identifier is a valid
    // Rust type name.
    const src = generateRust(SAMPLE, 'my-policy')
    expect(src).toContain('pub struct my_policy;')
  })

  it('invokes smart_account.require_auth() inside enforce', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(src).toContain('fn enforce(')
    expect(src).toContain('smart_account.require_auth()')
    // The require_auth call must be lexically after the `fn enforce(` opening
    // and before the closing brace of the function body (which is the
    // 4-space-indented `}\n\n` before the next `pub fn ...` declaration).
    const enforceStart = src.indexOf('fn enforce(')
    const requireAuthAt = src.indexOf('smart_account.require_auth()')
    const fnCloseIdx = src.indexOf('}\n\n    pub fn uninstall(', enforceStart)
    expect(enforceStart).toBeGreaterThanOrEqual(0)
    expect(requireAuthAt).toBeGreaterThan(enforceStart)
    expect(requireAuthAt).toBeLessThan(fnCloseIdx)
  })

  it('keys storage by the (smart_account, rule_id) composite', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(src).toMatch(/\(smart_account\.clone\(\),\s*rule_id\)/)
  })

  it('uses unwrap_or_default() on chain reads', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(src).toContain('.unwrap_or_default()')
  })

  it('uses persistent() storage (NOT instance())', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(src).toContain('persistent()')
    expect(src).not.toMatch(/\binstance\(\)/)
  })

  it('uninstall removes the stored state', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    const uninstallStart = src.indexOf('fn uninstall(')
    expect(uninstallStart).toBeGreaterThanOrEqual(0)
    const body = src.slice(uninstallStart)
    expect(body).toContain('remove(')
  })

  it('leaves a clearly marked TODO(user) hole for the predicate logic', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(src).toContain('// TODO(user):')
  })

  it('surfaces the uncovered constraint list as a comment block', () => {
    const src = generateRust(SAMPLE, 'escape-hatch-policy')
    expect(src).toContain('multi-asset-cap with weights > 1')
    expect(src).toContain('conditional co-signer approval only when amount >= threshold')
  })
})
