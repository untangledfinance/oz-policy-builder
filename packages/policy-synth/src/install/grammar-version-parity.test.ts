// Cross-layer parity: the grammar version this package emits MUST equal the
// `SELF_VERSION` compiled into the interpreter wasm.
//
// The contract refuses an install whose `grammar_version` differs from its own
// (`lib.rs`, error 200 VERSION_MISMATCH). A skew is therefore total: every
// install fails on chain, and nothing off chain notices, because the builder is
// perfectly happy emitting a number the contract will not accept.
//
// That is not hypothetical. `SELF_VERSION` was bumped to 2 when the oracle
// leaves left the grammar, and this package kept emitting 1 - so every install
// it produced would have been rejected. The defect survived a green typecheck
// and a green test run because nothing compared the two constants. This test is
// that comparison.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DEFAULT_GRAMMAR_VERSION } from './build-add-context-rule.ts'

/** Parse `pub const SELF_VERSION: u32 = N;` out of the contract source. */
function selfVersionFromContract(): number {
  const path = `${import.meta.dir}/../../../../contracts/policy-interpreter/src/version.rs`
  const src = readFileSync(path, 'utf8')
  const match = src.match(/pub const SELF_VERSION:\s*u32\s*=\s*(\d+)\s*;/)
  if (!match?.[1]) {
    throw new Error(`could not find SELF_VERSION in ${path} - has the constant been renamed?`)
  }
  return Number(match[1])
}

describe('grammar version parity (TS builder vs Rust contract)', () => {
  it('DEFAULT_GRAMMAR_VERSION equals the contract SELF_VERSION', () => {
    expect(DEFAULT_GRAMMAR_VERSION).toBe(selfVersionFromContract())
  })
})
