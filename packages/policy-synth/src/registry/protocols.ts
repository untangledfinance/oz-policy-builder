// src/registry/protocols.ts - protocol ABI definitions (no addresses).
//
// A protocol is identified by EITHER:
//   - by interface (function-name signature + arg shape): a contract calling
//     one of these well-known fns with the expected arg shape IS that
//     protocol, regardless of address. SEP-41 is the canonical case - ANY
//     token contract calling `transfer` with the right arg shape is a
//     SEP-41 token. Blend pool `submit`/`claim` are similarly recognised by
//     interface (the pool factory address doesn't cover per-pool instances).
//   - by address: the contract is in the pinned `known-addresses` set (see
//     known-addresses.ts). SoroSwap uses address recognition because the
//     router is a single deployed contract; Blend uses it to recognise factory
//     calls in addition to its interface recognition.
//
// Args entries pin a ScVal subset type (matching the normalised `ScVal`
// vocabulary in src/types.ts) plus a human meaning string. The registry
// fails closed: a method call whose decoded args do NOT match the ABI
// signature is treated as unknown.

import type { ScVal } from '../types.ts'

export type ProtocolId = 'sep41' | 'blend' | 'soroswap' | 'oz_account'

/** ScVal subset type vocabulary the ABI uses. Mirrors `ScVal['type']` minus
 *  `other` (which by definition cannot be matched against an ABI arg). */
export type AbiArgType = Exclude<ScVal['type'], 'other'>

export interface AbiArg {
  name: string
  /** ScVal subset type the decoded arg must conform to. */
  type: AbiArgType
  /** Human-readable meaning for the downstream reviewer. */
  meaning: string
}

export interface AbiEntry {
  args: AbiArg[]
}

export type ProtocolAbi = Record<string, AbiEntry>

/** SEP-41 token interface - pinned from the SEP-41 spec (any token). */
export const SEP41_ABI: ProtocolAbi = {
  transfer: {
    args: [
      {
        name: 'from',
        type: 'address',
        meaning: 'source address (the `from` of the token transfer)',
      },
      {
        name: 'to',
        type: 'address',
        meaning: 'destination address (the `to` of the token transfer)',
      },
      {
        name: 'amount',
        type: 'i128',
        meaning: 'amount of tokens to move (i128, signed-decimal string)',
      },
    ],
  },
  mint: {
    args: [
      { name: 'to', type: 'address', meaning: 'recipient of the newly minted tokens' },
      { name: 'amount', type: 'i128', meaning: 'amount to mint (i128, signed-decimal string)' },
    ],
  },
  burn: {
    args: [
      { name: 'from', type: 'address', meaning: 'address whose balance is decremented' },
      { name: 'amount', type: 'i128', meaning: 'amount to burn (i128, signed-decimal string)' },
    ],
  },
  approve: {
    args: [
      { name: 'from', type: 'address', meaning: 'token holder granting the allowance' },
      {
        name: 'spender',
        type: 'address',
        meaning: 'address authorised to move tokens on behalf of `from`',
      },
      { name: 'amount', type: 'i128', meaning: 'allowance amount (i128, signed-decimal string)' },
      {
        name: 'expiration_ledger',
        type: 'u32',
        meaning: 'ledger sequence after which the allowance is invalid',
      },
    ],
  },
}

/** Blend pool interface (v2). Pinning the two fns the recorder surfaces.
 *  Pool-level recognition is by INTERFACE (real pool calls hit per-pool
 *  instances, not the factory). Arg shapes verified against the Blend v2
 *  pool contract source (blend-capital/blend-contracts-v2 `pool/src/contract.rs`,
 *  fetched 2026-07-23):
 *    submit(env, from: Address, spender: Address, to: Address, requests: Vec<Request>)
 *      -> Positions
 *    claim(env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128
 *  Other pool fns (add_reserves, withdraw, etc.) are intentionally omitted -
 *  they are too version-sensitive to bind by interface. */
export const BLEND_ABI: ProtocolAbi = {
  submit: {
    args: [
      { name: 'from', type: 'address', meaning: 'address supplying collateral or repaying debt' },
      { name: 'spender', type: 'address', meaning: 'address authorising the supply / repay' },
      { name: 'to', type: 'address', meaning: 'address receiving the resulting position shares' },
      { name: 'requests', type: 'vec', meaning: 'vec<Request> describing the action per reserve' },
    ],
  },
  claim: {
    args: [
      { name: 'from', type: 'address', meaning: 'address whose position is being claimed against' },
      {
        name: 'reserve_token_ids',
        type: 'vec',
        meaning: 'vec<u32> reserve token ids to claim emissions for',
      },
      { name: 'to', type: 'address', meaning: 'address receiving the claimed tokens' },
    ],
  },
}

/** SoroSwap router interface. Standard Uniswap-V2-style swap fn signatures
 *  pinned from the SoroSwap router source. Recognised by address only (the
 *  router is a single pinned contract); FIX 4 requires the method to also be
 *  in this ABI for address recognition to succeed. The `path` arg is a
 *  `vec<address>` - we record it as the outer `vec` subset and leave the
 *  per-element shape to the downstream reviewer. */
export const SOROSWAP_ABI: ProtocolAbi = {
  swap_exact_tokens_for_tokens: {
    args: [
      { name: 'amount_in', type: 'i128', meaning: 'exact input amount (i128)' },
      { name: 'amount_out_min', type: 'i128', meaning: 'minimum acceptable output (i128)' },
      { name: 'path', type: 'vec', meaning: 'vec<address> hop path through pools' },
      { name: 'to', type: 'address', meaning: 'recipient of the output tokens' },
      {
        name: 'deadline',
        type: 'u64',
        meaning: 'unix-seconds deadline after which the swap is refused',
      },
    ],
  },
  swap_tokens_for_exact_tokens: {
    args: [
      { name: 'amount_out', type: 'i128', meaning: 'exact output amount desired (i128)' },
      { name: 'amount_in_max', type: 'i128', meaning: 'maximum input willing to spend (i128)' },
      { name: 'path', type: 'vec', meaning: 'vec<address> hop path through pools' },
      { name: 'to', type: 'address', meaning: 'recipient of the output tokens' },
      {
        name: 'deadline',
        type: 'u64',
        meaning: 'unix-seconds deadline after which the swap is refused',
      },
    ],
  },
  swap_exact_in_for_tokens: {
    args: [
      { name: 'amount_in', type: 'i128', meaning: 'exact input amount (i128)' },
      { name: 'amount_out_min', type: 'i128', meaning: 'minimum acceptable output (i128)' },
      { name: 'path', type: 'vec', meaning: 'vec<address> hop path through pools' },
      { name: 'to', type: 'address', meaning: 'recipient of the output tokens' },
    ],
  },
}

/** OpenZeppelin smart-account ABI subset.
 *
 *  Why this lives in the recogniser: every user's smart account has a
 *  different C-address, so a per-deployment pin would never cover them.
 *  What is the same across every OpenZeppelin multisig account is the
 *  small set of public context-rule entrypoints. A recording that
 *  invokes `batch_add_signer(u32, vec<signer>)` on an arbitrary contract
 *  is overwhelmingly likely to be calling the user's own OpenZeppelin
 *  smart account (the canonical reason this product exists); we
 *  recognise that pattern by interface, the same way SEP-41 is
 *  recognised by interface.
 *
 *  SECURITY PROPERTY (load-bearing):
 *   - Recognition claims the call TARGETS a particular protocol. We
 *     only claim `oz_account` when the (fn, args) shape uniquely matches
 *     one of the three entrypoints below AND the call looks like a real
 *     context-rule operation. The match is exact: off-by-one arg count,
 *     off-by-one arg type, or a method name close-but-wrong returns null
 *     (fail-closed). A contract that incidentally happens to expose a
 *     single matching fn is not sufficient - the recorder requires ALL
 *     invocations to individually match, so a hostile contract with
 *     exactly one matching fn would still contribute to the unknown
 *     bucket for any other calls.
 *   - We do NOT claim `oz_account` for unknown calls, for arg-shape
 *     mismatches, or for calls where the recorder could not pin down
 *     the (fn, args) shape. The freshness gate then runs at the same
 *     1.0 threshold - lowering the gate for unknown protocols remains
 *     a separate, opt-in production override (see RecordInput below).
 *
 *  ABI source: contracts/policy-interpreter/tests/fixtures/multisig_account_example.wasm,
 *  pinned from the OpenZeppelin Reloaded `multisig_account_example`
 *  contract (commit ef82b65, fetched 2026-07-28).
 *
 *  SCOPE NOTE: this ABI only covers the three entrypoints whose args
 *  map cleanly onto the normalised `AbiArgType` vocabulary (u32, vec,
 *  ...). `add_context_rule` - the install path - takes `(Symbol,
 *  String, Option<u32>, Vec<SignerKey>, Map<Address, Val>)`. The
 *  `String`, `Option<u32>` (`scvVoid`), and `Map<...>` arg types are
 *  not in the AbiArgType set today (the recogniser's `argsMatchAbi`
 *  helper rejects `other` deliberately so a close-but-wrong call does
 *  not slip through). Excluding `add_context_rule` is the right
 *  trade-off for now - it never blocks OZ smart-account recognition,
 *  because the install tx always follows a recognised
 *  `batch_add_signer` (the demo's first-pass tx), so the
 *  contract still ends up in `knownContracts`. Updating the Arg type
 *  vocabulary to cover these shapes is a separate concern (and would
 *  also lift the SEP-41 / Blend recognition in the same change).
 */
export const OZ_ACCOUNT_ABI: ProtocolAbi = {
  batch_add_signer: {
    args: [
      {
        name: 'context_rule_id',
        type: 'u32',
        meaning: 'OZ context rule id this signer is added to',
      },
      {
        name: 'signers',
        type: 'vec',
        meaning: 'vec<SignerKey> signers to add (Delegated G-address or Account C-address)',
      },
    ],
  },
  batch_remove_signer: {
    args: [
      {
        name: 'context_rule_id',
        type: 'u32',
        meaning: 'OZ context rule id to remove signers from',
      },
      {
        name: 'signers',
        type: 'vec',
        meaning: 'vec<SignerKey> signers to remove from the rule',
      },
    ],
  },
  remove_context_rule: {
    args: [
      {
        name: 'context_rule_id',
        type: 'u32',
        meaning: 'OZ context rule id to delete',
      },
    ],
  },
}

export const PROTOCOL_ABIS: Record<ProtocolId, ProtocolAbi> = {
  sep41: SEP41_ABI,
  blend: BLEND_ABI,
  soroswap: SOROSWAP_ABI,
  oz_account: OZ_ACCOUNT_ABI,
}

export function getAbi(protocol: ProtocolId): ProtocolAbi {
  return PROTOCOL_ABIS[protocol]
}
