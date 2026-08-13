import { describe, expect, it } from 'bun:test'
import { type CompileGateOpts, compileCheck, hasRustToolchain } from './compile-gate.ts'

const KNOWN_GOOD_SOURCE = `// Auto-generated test source.
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};
#[contracttype]
pub enum DataKey { State(Address, u32) }
#[contract]
pub struct Sample;
#[contractimpl]
impl Sample {
    pub fn install(_e: &Env, _a: Address, _r: u32) {}
    pub fn enforce(e: &Env, smart_account: Address, rule_id: u32) {
        smart_account.require_auth();
        let _: () = e.storage().persistent().get(&DataKey::State(smart_account, rule_id)).unwrap_or_default();
    }
    pub fn uninstall(e: &Env, smart_account: Address, rule_id: u32) {
        e.storage().persistent().remove(&DataKey::State(smart_account, rule_id));
    }
}
`

const KNOWN_BROKEN_SOURCE = `// deliberately broken: unclosed paren, no body.
pub struct Sample;
impl Sample { pub fn enforce(
`

const TOOLCHAIN_PRESENT = await hasRustToolchain()

// A real `cargo check` against soroban-sdk takes roughly a minute cold. The
// 5s default is fine while the toolchain is absent and the gate short-circuits
// to SKIPPED, which is why these tests passed for as long as no host had both
// cargo and the Soroban CLI. On a host that has both, the default turns three
// honest tests into timeouts.
const REAL_COMPILE_TIMEOUT_MS = 180_000

describe('compileCheck', () => {
  it(
    'SKIPS when the Rust toolchain is absent (cargo / stellar missing)',
    async () => {
      if (TOOLCHAIN_PRESENT) {
        // Toolchain present: confirm the SKIP branch is not accidentally hit.
        const r = await compileCheck(KNOWN_GOOD_SOURCE)
        expect(r.code).toBe('COMPILE_OK')
        return
      }
      const r = await compileCheck(KNOWN_GOOD_SOURCE)
      expect(r.code).toBe('SKIPPED')
      if (r.code === 'SKIPPED') {
        expect(typeof r.reason).toBe('string')
        expect(r.reason.length).toBeGreaterThan(0)
      }
    },
    REAL_COMPILE_TIMEOUT_MS
  )

  it(
    'returns COMPILE_OK for known-good source when the toolchain is present',
    async () => {
      if (!TOOLCHAIN_PRESENT) return
      const r = await compileCheck(KNOWN_GOOD_SOURCE)
      expect(r.code).toBe('COMPILE_OK')
    },
    REAL_COMPILE_TIMEOUT_MS
  )

  it(
    'returns COMPILE_GATE_FAILED for deliberately-broken source when the toolchain is present',
    async () => {
      if (!TOOLCHAIN_PRESENT) return
      const r = await compileCheck(KNOWN_BROKEN_SOURCE)
      expect(r.code).toBe('COMPILE_GATE_FAILED')
      if (r.code === 'COMPILE_GATE_FAILED') {
        expect(typeof r.stderr).toBe('string')
        expect(r.stderr.length).toBeGreaterThan(0)
      }
    },
    REAL_COMPILE_TIMEOUT_MS
  )

  it('honours the abortSignal option (no COMPILE_OK when already aborted)', async () => {
    const ac = new AbortController()
    ac.abort()
    const opts: CompileGateOpts = { signal: ac.signal }
    const r = await compileCheck(KNOWN_GOOD_SOURCE, opts)
    expect(r.code === 'COMPILE_OK').toBe(false)
  })
})
