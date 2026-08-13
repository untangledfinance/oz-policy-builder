// src/registry/identify.ts - protocol identification (fail-closed).
//
// Given a (contract, method, args) triple, decide whether the call belongs
// to a known protocol. Returns null when it does NOT - the caller MUST
// preserve the fail-closed posture for null results.
//
// Recognition rules:
//   1. SEP-41: recognised by INTERFACE - any contract calling one of the
//      SEP-41 fns (transfer / mint / burn / approve) with a matching arg
//      shape is a SEP-41 token. No address pin is needed.
//   2. Blend: recognised by INTERFACE - real pool `submit` / `claim` calls
//      hit per-pool instances, not the factory. The arg shape must match
//      the Blend pool ABI (verified against the pool contract source).
//      Address recognition still applies when the call is against the
//      pinned factory address, with the same arg-shape check.
//   3. SoroSwap: recognised by ADDRESS only - the router is a single pinned
//      contract. FIX 4: the method must ALSO be present in the protocol's
//      ABI; an unknown method on a pinned router -> null (fail-closed).
//   4. OZ smart-account: recognised by INTERFACE - the user-facing context
//      rule entrypoints (`batch_add_signer` / `batch_remove_signer` /
//      `add_context_rule` / `remove_context_rule`) have a fixed (fn, args)
//      shape across every OZ multisig deployment. Pinned per-deployment
//      addresses are impossible (every user deploys their own smart
//      account), so interface recognition is the only viable path - same
//      reasoning SEP-41 uses for any token address.
//
// Method lookup uses `Object.hasOwn` rather than `in` so prototype-chain
// names like `constructor`, `toString`, `hasOwnProperty` do NOT register as
// valid method calls. Arg-shape validation compares arg count + each arg's
// ScVal subset type against the ABI signature; mismatch -> null.

import type { ScVal } from '../types.ts'
import { addressToProtocol } from './known-addresses.ts'
import type { AbiArg, ProtocolId } from './protocols.ts'
import { BLEND_ABI, OZ_ACCOUNT_ABI, SEP41_ABI, SOROSWAP_ABI } from './protocols.ts'

export interface IdentifiedProtocol {
  protocol: ProtocolId
  fn: string
}

/** Identify the protocol for a single (contract, method, args) invocation.
 *  Returns null on ANY mismatch (method not in ABI, arg count off, arg type
 *  off, or unknown method on a pinned address). The caller MUST keep the
 *  null path fail-closed. */
export function identifyProtocol(
  contract: string,
  method: string,
  args: ScVal[],
  network?: 'mainnet' | 'testnet'
): IdentifiedProtocol | null {
  // 1) SEP-41 by interface. Any contract whose (method, args) matches a
  //    SEP-41 ABI signature is a SEP-41 token.
  if (Object.hasOwn(SEP41_ABI, method)) {
    const sig = SEP41_ABI[method]
    if (sig && argsMatchAbi(sig.args, args)) {
      return { protocol: 'sep41', fn: method }
    }
    return null
  }

  // 2) Blend by interface. Real pool calls hit per-pool instances; pinned
  //    factory calls also match here when the method is in the pool ABI.
  if (Object.hasOwn(BLEND_ABI, method)) {
    const sig = BLEND_ABI[method]
    if (sig && argsMatchAbi(sig.args, args)) {
      return { protocol: 'blend', fn: method }
    }
    return null
  }

  // 3) OpenZeppelin smart-account by interface. The four context-rule
  //    entrypoints have a fixed (fn, args) shape across every OZ
  //    multisig deployment. `__check_auth` is private (host-invoked)
  //    and is intentionally NOT in this ABI - the recogniser only
  //    claims OZ for the public surface.
  if (Object.hasOwn(OZ_ACCOUNT_ABI, method)) {
    const sig = OZ_ACCOUNT_ABI[method]
    if (sig && argsMatchAbi(sig.args, args)) {
      return { protocol: 'oz_account', fn: method }
    }
    return null
  }

  // 4) Pinned-address recognition (Blend factory + SoroSwap router/factory).
  //    FIX 4: the method must also be in the protocol's ABI; an unknown
  //    method on a pinned address -> null.
  if (network) {
    const pinned = addressToProtocol(contract, network)
    if (pinned) {
      const abi = pinned === 'blend' ? BLEND_ABI : SOROSWAP_ABI
      if (Object.hasOwn(abi, method)) {
        const sig = abi[method]
        if (sig && argsMatchAbi(sig.args, args)) {
          return { protocol: pinned, fn: method }
        }
      }
    }
  }

  void contract
  return null
}

/** Compare the decoded args against the ABI signature. Returns true only when
 *  the arg count matches AND every arg's ScVal subset type matches the ABI's
 *  declared type. `other` is intentionally NOT a valid ABI match - it means
 *  the decoder couldn't classify the value, which is exactly the signal
 *  fail-closed should refuse. */
function argsMatchAbi(expected: AbiArg[], actual: ScVal[]): boolean {
  if (expected.length !== actual.length) return false
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]
    const got = actual[i]
    if (!want || !got) return false
    if (want.type !== got.type) return false
  }
  return true
}
