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
import { PINNED_INTERPRETER_GRAMMAR_VERSION } from '../run/schemas.ts'
import { GRAMMAR_VERSION } from '../types.ts'
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
  it('GRAMMAR_VERSION equals the contract SELF_VERSION', () => {
    expect(GRAMMAR_VERSION).toBe(selfVersionFromContract())
  })

  // `PolicyDocument.grammarVersion` is the version the synthesiser advertises on
  // the document it proposes; `DEFAULT_GRAMMAR_VERSION` is what the XDR builder
  // puts on the wire. Both must derive from the one constant or they can skew
  // apart again - which is what happened when the contract went to 3 and the
  // proposed documents carried on advertising 2.
  it('DEFAULT_GRAMMAR_VERSION derives from the same constant', () => {
    expect(DEFAULT_GRAMMAR_VERSION).toBe(GRAMMAR_VERSION)
  })

  // The two assertions above compare this tree against ITSELF. They pass while
  // the builder is skewed against the interpreter it actually installs into,
  // because neither of them looks at the pin.
  //
  // `install_policy` refuses any interpreter address other than the pinned one
  // unless `allowUnpinnedInterpreter` is set, and stamps GRAMMAR_VERSION into
  // `install_params`. So if the pinned deployment speaks a different grammar,
  // every install this package builds is refused on chain with error 200
  // VersionMismatch - and, as before, nothing off chain notices.
  //
  // This assertion is the pair that was missing. It is EXPECTED TO FAIL while
  // the tree is ahead of the deployment; that is the signal, not a flake.
  it('the pinned deployment speaks the grammar this tree emits', () => {
    if (PINNED_INTERPRETER_GRAMMAR_VERSION !== GRAMMAR_VERSION) {
      throw new Error(
        `Grammar skew between this tree and its pinned deployment.\n` +
          `  builder stamps into install_params: ${GRAMMAR_VERSION}\n` +
          `  PINNED_INTERPRETER_GRAMMAR_VERSION: ${PINNED_INTERPRETER_GRAMMAR_VERSION}\n` +
          `Every install built here against the pin is refused on chain with error 200 ` +
          `VersionMismatch, because install_policy also refuses any interpreter address other ` +
          `than the pinned one.\n` +
          `To clear it: deploy a version-${GRAMMAR_VERSION} interpreter to a NEW address (a ` +
          `grammar change never upgrades in place - see contracts/policy-interpreter/src/` +
          `version.rs), then re-pin PINNED_INTERPRETER_MAINNET_ADDRESS, _TESTNET_ADDRESS, ` +
          `_WASM_SHA256 and _GRAMMAR_VERSION together in run/schemas.ts.\n` +
          `Do NOT "fix" this by editing _GRAMMAR_VERSION alone: that re-hides the skew and ` +
          `every install still fails.`
      )
    }
    expect(PINNED_INTERPRETER_GRAMMAR_VERSION).toBe(GRAMMAR_VERSION)
  })
})
