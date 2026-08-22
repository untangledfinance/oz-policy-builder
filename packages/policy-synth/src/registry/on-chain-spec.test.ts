// Tests for reading a contract's interface off chain.
//
// Every spec here is built in memory, so the suite never touches the network.
// That matters beyond speed: the point of this module is that it only ever
// ADDS recognition, and the cases that must NOT add it (no spec, unknown
// function, wrong argument types) are exactly the ones a live endpoint would
// make non-deterministic.

import { describe, expect, it } from 'bun:test'
import { Address, contract as sdkContract, xdr } from '@stellar/stellar-sdk'
import type { ContractInvocation, ScVal } from '../types.ts'
import {
  abiFromSpec,
  abiTypeFromSpecType,
  fetchContractAbi,
  resolveContractsByOnChainSpec,
  type SpecFetcher,
} from './on-chain-spec.ts'

const TOKEN = Address.contract(Buffer.alloc(32, 0x0b)).toString()
const ALICE = Address.account(Buffer.alloc(32, 0xa1)).toString()

function fn(name: string, inputs: Array<[string, xdr.ScSpecTypeDef]>): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: inputs.map(([n, type]) => new xdr.ScSpecFunctionInputV0({ doc: '', name: n, type })),
      outputs: [],
    })
  )
}

const T = {
  address: () => xdr.ScSpecTypeDef.scSpecTypeAddress(),
  i128: () => xdr.ScSpecTypeDef.scSpecTypeI128(),
  u32: () => xdr.ScSpecTypeDef.scSpecTypeU32(),
}

const TRANSFER_SPEC = new sdkContract.Spec([
  fn('transfer', [
    ['from', T.address()],
    ['to', T.address()],
    ['amount', T.i128()],
  ]),
  fn('__constructor', [['admin', T.address()]]),
])

function fetcherFor(map: Record<string, sdkContract.Spec | null>): SpecFetcher {
  return { contractSpec: async (id) => map[id] ?? null }
}

function invocation(contract: string, name: string, args: ScVal[]): ContractInvocation {
  return { contract, fn: name, args, subInvocations: [] }
}

const ADDR: ScVal = { type: 'address', value: ALICE }
const AMT: ScVal = { type: 'i128', value: '100' }

describe('abiTypeFromSpecType', () => {
  it('maps the ScVal subset', () => {
    expect(abiTypeFromSpecType('scSpecTypeAddress')).toBe('address')
    expect(abiTypeFromSpecType('scSpecTypeI128')).toBe('i128')
    expect(abiTypeFromSpecType('scSpecTypeSymbol')).toBe('symbol')
  })

  it('returns null for a type the recorder cannot represent', () => {
    // Null is the fail-CLOSED answer: an argument we cannot type is one we
    // cannot check, so the function carrying it is dropped rather than
    // matched loosely.
    expect(abiTypeFromSpecType('scSpecTypeUdt')).toBeNull()
    expect(abiTypeFromSpecType('scSpecTypeOption')).toBeNull()
  })
})

describe('abiFromSpec', () => {
  it('derives named, typed arguments', () => {
    const abi = abiFromSpec(TRANSFER_SPEC)
    expect(abi.transfer?.args.map((a) => `${a.name}:${a.type}`)).toEqual([
      'from:address',
      'to:address',
      'amount:i128',
    ])
  })

  it('omits the constructor, which cannot be invoked after deployment', () => {
    expect(abiFromSpec(TRANSFER_SPEC).__constructor).toBeUndefined()
  })

  it('omits a function with an argument outside the ScVal subset', () => {
    const spec = new sdkContract.Spec([
      fn('opaque', [
        [
          'cfg',
          xdr.ScSpecTypeDef.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: T.u32() })),
        ],
      ]),
      fn('plain', [['n', T.u32()]]),
    ])
    const abi = abiFromSpec(spec)
    expect(abi.opaque).toBeUndefined()
    expect(abi.plain).toBeDefined()
  })
})

describe('fetchContractAbi', () => {
  it('returns null when no spec is available', async () => {
    expect(await fetchContractAbi(TOKEN, fetcherFor({}))).toBeNull()
  })

  it('returns null when the spec yields no usable function', async () => {
    // Constructor-only: nothing invocable survives, so the contract must stay
    // unrecognised rather than counting as described.
    const spec = new sdkContract.Spec([fn('__constructor', [['admin', T.address()]])])
    expect(await fetchContractAbi(TOKEN, fetcherFor({ [TOKEN]: spec }))).toBeNull()
  })
})

describe('resolveContractsByOnChainSpec', () => {
  const fetcher = fetcherFor({ [TOKEN]: TRANSFER_SPEC })

  it('recognises a contract whose call matches its published interface', async () => {
    const invs = [invocation(TOKEN, 'transfer', [ADDR, ADDR, AMT])]
    const got = await resolveContractsByOnChainSpec(invs, [TOKEN], fetcher)
    expect([...got]).toEqual([TOKEN])
  })

  it('does NOT recognise a call to a function the interface does not describe', async () => {
    const invs = [invocation(TOKEN, 'not_a_method', [ADDR])]
    const got = await resolveContractsByOnChainSpec(invs, [TOKEN], fetcher)
    expect(got.size).toBe(0)
  })

  it('does NOT recognise a call whose argument types disagree with the interface', async () => {
    // Same arity, wrong types. This is the case a spec check has to catch:
    // the function name alone matching would be recognition on no evidence.
    const invs = [invocation(TOKEN, 'transfer', [AMT, AMT, ADDR])]
    const got = await resolveContractsByOnChainSpec(invs, [TOKEN], fetcher)
    expect(got.size).toBe(0)
  })

  it('does NOT recognise a call with the wrong arity', async () => {
    const invs = [invocation(TOKEN, 'transfer', [ADDR, ADDR])]
    const got = await resolveContractsByOnChainSpec(invs, [TOKEN], fetcher)
    expect(got.size).toBe(0)
  })

  it('is all-or-nothing per contract', async () => {
    // One good call and one bad one on the SAME contract. Recognising it on
    // the strength of the good call would raise confidence while the call
    // that actually matters stayed undecoded.
    const invs = [
      invocation(TOKEN, 'transfer', [ADDR, ADDR, AMT]),
      invocation(TOKEN, 'mystery', [ADDR]),
    ]
    const got = await resolveContractsByOnChainSpec(invs, [TOKEN], fetcher)
    expect(got.size).toBe(0)
  })

  it('checks calls nested in sub-invocations, not just the top level', async () => {
    const nested: ContractInvocation = {
      contract: Address.contract(Buffer.alloc(32, 0x0c)).toString(),
      fn: 'submit',
      args: [],
      subInvocations: [invocation(TOKEN, 'mystery', [ADDR])],
    }
    const got = await resolveContractsByOnChainSpec([nested], [TOKEN], fetcher)
    expect(got.size).toBe(0)
  })

  it('leaves a contract with no fetchable spec alone', async () => {
    const invs = [invocation(TOKEN, 'transfer', [ADDR, ADDR, AMT])]
    const got = await resolveContractsByOnChainSpec(invs, [TOKEN], fetcherFor({}))
    expect(got.size).toBe(0)
  })
})
