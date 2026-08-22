// src/registry/on-chain-spec.ts - read a contract's own interface off chain.
//
// The compiled-in registry covers the protocols we pinned by hand. Everything
// else was reported as `no-abi`, which read as "this contract does not
// describe itself" when it almost always does: a Soroban contract embeds a
// typed spec in its wasm, and the network will hand it over. The recorder was
// refusing calls whose interface was one RPC round-trip away.
//
// What this buys is NARROW and deliberately so. A fetched spec says what the
// contract's arguments ARE, not what they MEAN. So a call verified against it
// is recognised - the decode is trustworthy, the confidence gate stops
// refusing it - but the arguments carry the contract's own parameter NAMES
// rather than a curated meaning, and nothing here infers which argument is a
// spend or a recipient. A pinned protocol still outranks a fetched spec for
// exactly that reason, and `identifyProtocol` is consulted first.

import { contract as sdkContract } from '@stellar/stellar-sdk'
import type { ContractInvocation, ScVal } from '../types.ts'
import { argsMatchAbi } from './identify.ts'
import type { AbiArg, AbiArgType, ProtocolAbi } from './protocols.ts'

/** Map an XDR spec type to the ScVal subset vocabulary the matcher uses.
 *
 *  Returns null for a type the recorder's ScVal subset cannot represent. That
 *  is deliberate: an argument we cannot type is an argument we cannot check,
 *  and claiming a match on it would be the fail-OPEN direction. A function
 *  with any such argument is dropped from the derived ABI, so a call to it
 *  stays unrecognised rather than being waved through. */
export function abiTypeFromSpecType(specTypeName: string): AbiArgType | null {
  switch (specTypeName) {
    case 'scSpecTypeAddress':
      return 'address'
    case 'scSpecTypeI128':
      return 'i128'
    case 'scSpecTypeU64':
    case 'scSpecTypeI64':
      return 'u64'
    case 'scSpecTypeU32':
    case 'scSpecTypeI32':
      return 'u32'
    case 'scSpecTypeSymbol':
      return 'symbol'
    case 'scSpecTypeVec':
      return 'vec'
    case 'scSpecTypeBytes':
    case 'scSpecTypeBytesN':
      return 'bytes'
    case 'scSpecTypeMap':
      return 'map'
    default:
      return null
  }
}

/** The RPC surface this module needs. Narrowed to one method so a test can
 *  supply a stub without standing up a server, and so the recorder's existing
 *  RPC client can be passed straight in. */
export interface SpecFetcher {
  contractSpec(contractId: string): Promise<sdkContract.Spec | null>
}

/** Build a `SpecFetcher` over the SDK's contract client. */
export function specFetcherFromRpc(rpcUrl: string, networkPassphrase: string): SpecFetcher {
  return {
    async contractSpec(contractId: string): Promise<sdkContract.Spec | null> {
      try {
        const client = await sdkContract.Client.from({ contractId, networkPassphrase, rpcUrl })
        return (client as unknown as { spec: sdkContract.Spec }).spec ?? null
      } catch {
        // A contract with no spec, an unreachable RPC and a bad address all
        // land here and all mean the same thing to the caller: no interface
        // was obtained, so the contract stays unrecognised. Fail closed.
        return null
      }
    },
  }
}

/** Convert a fetched spec into the ABI shape `identifyProtocol` already
 *  matches against. Functions with an argument outside the ScVal subset are
 *  OMITTED rather than partially typed. */
export function abiFromSpec(spec: sdkContract.Spec): ProtocolAbi {
  const abi: ProtocolAbi = {}
  for (const fn of spec.funcs()) {
    const name = fn.name().toString()
    // The constructor is not callable after deployment, so a recorded
    // invocation can never be one. Keeping it would only widen the surface.
    if (name === '__constructor') continue
    const args: AbiArg[] = []
    let usable = true
    for (const input of fn.inputs()) {
      const type = abiTypeFromSpecType(input.type().switch().name)
      if (type === null) {
        usable = false
        break
      }
      const argName = input.name().toString()
      args.push({
        name: argName,
        type,
        // The contract's own parameter name is the honest description. It is
        // NOT a curated meaning - nothing here knows whether `value` is a
        // spend - so downstream must not treat it as one.
        meaning: `${argName} (from the contract's on-chain interface)`,
      })
    }
    if (usable) abi[name] = { args }
  }
  return abi
}

/** Fetch and convert in one step. Returns null when no usable interface was
 *  obtained, which the caller must treat as "unrecognised". */
export async function fetchContractAbi(
  contractId: string,
  fetcher: SpecFetcher
): Promise<ProtocolAbi | null> {
  const spec = await fetcher.contractSpec(contractId)
  if (spec === null) return null
  const abi = abiFromSpec(spec)
  return Object.keys(abi).length === 0 ? null : abi
}

/** Every contract invoked anywhere in the tree, with the calls made on it. */
function callsByContract(
  invocations: ReadonlyArray<ContractInvocation>
): Map<string, Array<{ fn: string; args: ScVal[] }>> {
  const out = new Map<string, Array<{ fn: string; args: ScVal[] }>>()
  const walk = (inv: ContractInvocation): void => {
    const list = out.get(inv.contract) ?? []
    list.push({ fn: inv.fn, args: inv.args })
    out.set(inv.contract, list)
    for (const sub of inv.subInvocations) walk(sub)
  }
  for (const inv of invocations) walk(inv)
  return out
}

/** Contracts whose EVERY recorded call matches their own published interface.
 *
 *  All-or-nothing per contract, deliberately. A contract where one call
 *  verifies and another does not is a contract we do not understand, and
 *  marking it recognised would raise confidence on the strength of the call
 *  we happened to check. The unverified call is the one that matters.
 *
 *  A contract with no fetchable spec, or a call naming a function absent from
 *  it, simply stays unknown - this only ever ADDS recognition, so a failure
 *  here degrades to today's behaviour rather than to a wrong answer. */
export async function resolveContractsByOnChainSpec(
  invocations: ReadonlyArray<ContractInvocation>,
  candidates: ReadonlyArray<string>,
  fetcher: SpecFetcher
): Promise<Set<string>> {
  const resolved = new Set<string>()
  const calls = callsByContract(invocations)
  for (const contract of new Set(candidates)) {
    const made = calls.get(contract)
    if (!made || made.length === 0) continue
    const abi = await fetchContractAbi(contract, fetcher)
    if (abi === null) continue
    const everyCallVerifies = made.every((c) => {
      const entry = abi[c.fn]
      return entry !== undefined && argsMatchAbi(entry.args, c.args)
    })
    if (everyCallVerifies) resolved.add(contract)
  }
  return resolved
}
