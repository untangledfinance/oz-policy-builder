// src/install/get-interpreter-info.ts - read-only fingerprint lookup for
// the interpreter contract.
//
// Returns the pinned deployment fingerprint + (optionally) compares a
// caller-supplied live `grammar_version` against the pin. No fabricated
// audit field; a real deployed-contract check is worth more than a fake
// reference.
//
// Per design decision 5: phase-04's "audit #44" is aspirational and has no
// source-of-truth in the repo. Returning a fabricated audit id would be a
// lie on a security surface. The honest outputs are:
//   - the pinned address (`PINNED_INTERPRETER_*_ADDRESS` in run/schemas.ts)
//   - the pinned grammar version (SELF_VERSION in version.rs)
//   - the pinned wasm sha256 (`PINNED_INTERPRETER_WASM_SHA256` in run/schemas.ts)
//   - an OPTIONAL `deployedGrammarVersion` returned by a live `grammar_version()`
//     RPC call, with a `liveMatchesPin` boolean the caller can dispatch on. A
//     mismatch means the deployed wasm is NOT the pinned artifact - the caller
//     should refuse to install until they redeploy.
//
// The RPC plumbing lives in the run layer (`run/index.ts`); this module
// stays pure so it is testable without a network.

import type { Network } from '../types.ts'

export interface InterpreterInfo {
  /** Pinned interpreter contract address. */
  pinnedAddress: string
  /** Pinned grammar version (matches SELF_VERSION in version.rs). */
  pinnedGrammarVersion: number
  /** Pinned wasm sha256 (hex). */
  pinnedWasmHash: string
  /** Network this pin applies to (the address + hash are network-scoped). */
  network: Network
  /** Present only when the caller supplied a live `deployedGrammarVersion`. */
  deployedGrammarVersion?: number
  /** True when `deployedGrammarVersion` matches `pinnedGrammarVersion`.
   *  Absent when no live verification was performed. */
  liveMatchesPin?: boolean
}

/** Build the interpreter-info response. When `deployedGrammarVersion` is
 *  supplied (after a live RPC `grammar_version()` call by the run layer),
 *  compares it to the pin and sets `liveMatchesPin`. When absent, returns
 *  the pin alone. */
export function getInterpreterInfo(args: {
  pinnedAddress: string
  pinnedGrammarVersion: number
  pinnedWasmHash: string
  network: Network
  /** When supplied, the u32 returned by the live contract's
   *  `grammar_version()` RPC call. */
  deployedGrammarVersion?: number
}): InterpreterInfo {
  const info: InterpreterInfo = {
    pinnedAddress: args.pinnedAddress,
    pinnedGrammarVersion: args.pinnedGrammarVersion,
    pinnedWasmHash: args.pinnedWasmHash,
    network: args.network,
  }
  if (typeof args.deployedGrammarVersion === 'number') {
    return {
      ...info,
      deployedGrammarVersion: args.deployedGrammarVersion,
      liveMatchesPin: args.deployedGrammarVersion === args.pinnedGrammarVersion,
    }
  }
  return info
}
