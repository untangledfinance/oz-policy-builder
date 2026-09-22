// Cross-layer parity: every builder must stamp the grammar version the
// interpreter it actually installs into is running.
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
//
// THERE IS NO LONGER ONE INTERPRETER, which is what this file used to assume.
// A grammar change never upgrades in place - it means a new contract at a new
// address - so the lines coexist, each with its own deployment and its own
// builder:
//
//   grammar 4   this package, pinned below; both pins read back `4` on chain
//   grammar 5   the app's v1 execution interpreter
//   grammar 6   the source in `contracts/`, driven by the app's v2 adapter
//
// So comparing this package against `contracts/` compared two different lines
// and failed permanently, which trains a reader to ignore the suite. What
// actually protects an install is the pairing: a builder against ITS pin. That
// is asserted below, and the divergence is pinned as a number rather than
// waved through - move either side and this file fails until someone records
// which line moved and why.

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

/**
 * The version the interpreter SOURCE in this repo implements.
 *
 * Not the version this package emits, and deliberately written out rather
 * than read from the source and compared to itself: this constant is the
 * record that the divergence is known. A bump in `version.rs` fails here
 * until someone states which line moved, which is the conversation that
 * should happen before a new grammar ships.
 */
const CONTRACT_SOURCE_GRAMMAR_VERSION = 6

describe('grammar version parity (TS builder vs Rust contract)', () => {
  it('this package emits the grammar its own pinned interpreters run', () => {
    // The pairing that decides whether an install lands. Both pinned
    // addresses were read back with `grammar_version()` on their own networks
    // and both answered 4, matching what this package stamps.
    expect(GRAMMAR_VERSION).toBe(PINNED_INTERPRETER_GRAMMAR_VERSION)
  })

  it('the interpreter source is the line this package is NOT on, and stays put', () => {
    // A fail here means `version.rs` moved. That is allowed - it is how a new
    // grammar ships - but it must be recorded, because the number above is
    // what tells a reader the two are different on purpose.
    expect(selfVersionFromContract()).toBe(CONTRACT_SOURCE_GRAMMAR_VERSION)
    expect(selfVersionFromContract()).not.toBe(GRAMMAR_VERSION)
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
  // Kept as its own case with the full remedy in the message: the assertion
  // above says WHAT is wrong in one line, this says what to do about it.
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
