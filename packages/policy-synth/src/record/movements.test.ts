import { describe, expect, it } from 'bun:test'
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import type { OnChainEvent } from '../types.ts'
import { computeParseConfidence } from './freshness.ts'
import { extractTokenMovements, readAmount } from './movements.ts'

function buildTransferEvent(opts: {
  token: string
  from: string
  to: string
  amount: bigint
}): OnChainEvent {
  const fromAddr = Address.fromString(opts.from)
  const toAddr = Address.fromString(opts.to)
  return {
    contract: opts.token,
    topics: ['transfer', fromAddr.toString(), toAddr.toString()],
    data: { type: 'i128', value: opts.amount.toString() },
  }
}

describe('extractTokenMovements', () => {
  it('parses a SEP-41 transfer event into a single TokenMovement', () => {
    const from = Keypair.random().publicKey()
    const to = Keypair.random().publicKey()
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const evts = [buildTransferEvent({ token, from, to, amount: 250n })]
    const movements = extractTokenMovements(evts)
    expect(movements.length).toBe(1)
    expect(movements[0]).toEqual({
      token,
      from,
      to,
      amount: '250',
    })
  })

  it('parses a mint event with admin topic + recipient topic', () => {
    const admin = Keypair.random().publicKey()
    const to = Keypair.random().publicKey()
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const evts: OnChainEvent[] = [
      {
        contract: token,
        topics: ['mint', admin, to],
        data: { type: 'i128', value: '1000' },
      },
    ]
    const movements = extractTokenMovements(evts)
    expect(movements.length).toBe(1)
    expect(movements[0]?.from).toBe('mint')
    expect(movements[0]?.to).toBe(to)
    expect(movements[0]?.amount).toBe('1000')
  })

  it('parses a burn event (single from, "burn" sentinel for to)', () => {
    const from = Keypair.random().publicKey()
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const evts: OnChainEvent[] = [
      {
        contract: token,
        topics: ['burn', from],
        data: { type: 'i128', value: '7' },
      },
    ]
    const movements = extractTokenMovements(evts)
    expect(movements.length).toBe(1)
    expect(movements[0]).toEqual({
      token,
      from,
      to: 'burn',
      amount: '7',
    })
  })

  it('ignores non-token-movement events', () => {
    const evts: OnChainEvent[] = [
      {
        contract: 'CABC',
        topics: ['set_admin'],
        data: { type: 'symbol', value: 'noop' },
      },
    ]
    const movements = extractTokenMovements(evts)
    expect(movements).toEqual([])
  })

  it('skips events that are missing both amount and topic fields', () => {
    const evts: OnChainEvent[] = [
      { contract: '', topics: [], data: { type: 'other', value: 'scvVoid' } },
    ]
    const movements = extractTokenMovements(evts)
    expect(movements).toEqual([])
  })

  it('reads amount from a Vec<Address,I128> data shape (SAC classic)', () => {
    const evts: OnChainEvent[] = [
      {
        contract: 'CABC',
        topics: ['transfer', 'GFROM', 'GTO'],
        data: {
          type: 'vec',
          value: [
            { type: 'address', value: 'GTO' },
            { type: 'i128', value: '999' },
          ],
        },
      },
    ]
    const movements = extractTokenMovements(evts)
    expect(movements.length).toBe(1)
    expect(movements[0]?.amount).toBe('999')
  })

  it('lowers confidence for an undecodable movement event', () => {
    const opaqueScVals: Array<{ path: string; type: string }> = []
    const movements = extractTokenMovements(
      [
        {
          contract: 'CABC',
          topics: ['transfer', 'GFROM', 'GTO'],
          data: { type: 'symbol', value: 'not-an-amount' },
        },
      ],
      opaqueScVals
    )
    const confidence = computeParseConfidence({
      knownContracts: ['CABC'],
      unknownContracts: [],
      opaqueScVals,
    })
    expect(movements).toEqual([])
    expect(opaqueScVals).toEqual([{ path: 'events[0]', type: 'undecodable-token-movement' }])
    expect(confidence.overall).toBeLessThan(1)
  })

  it('lowers confidence for a muxed movement topic address', () => {
    const opaqueScVals: Array<{ path: string; type: string }> = []
    extractTokenMovements(
      [
        {
          contract: 'CABC',
          topics: ['transfer', 'MUNSUPPORTED', 'GTO'],
          data: { type: 'i128', value: '1' },
        },
      ],
      opaqueScVals
    )
    const confidence = computeParseConfidence({
      knownContracts: ['CABC'],
      unknownContracts: [],
      opaqueScVals,
    })
    expect(opaqueScVals).toEqual([{ path: 'events[0]', type: 'unsupported-muxed-address-topic' }])
    expect(confidence.overall).toBeLessThan(1)
  })
})

describe('readAmount', () => {
  it('reads a direct I128 amount', () => {
    expect(readAmount({ type: 'i128', value: '42' })).toBe('42')
  })
  it('reads a U64 amount as a fallback', () => {
    expect(readAmount({ type: 'u64', value: '7' })).toBe('7')
  })
  it('walks a Vec to find an I128 child', () => {
    expect(
      readAmount({
        type: 'vec',
        value: [
          { type: 'address', value: 'GABC' },
          { type: 'i128', value: '123' },
        ],
      })
    ).toBe('123')
  })
  it('returns null when no amount-shaped value exists', () => {
    expect(readAmount({ type: 'symbol', value: 'noop' })).toBeNull()
    expect(readAmount({ type: 'vec', value: [] })).toBeNull()
  })
  // SAC/SEP-41 mainnet transfer event data: Map { amount: I128, to_muxed_id: ... }
  // (hex of tx 112d2392...; key 'amount' is the conventional SEP-41/SAC field name).
  it('reads an I128 from a Map data ScVal keyed by "amount"', () => {
    expect(
      readAmount({
        type: 'map',
        value: [
          { key: 'amount', val: { type: 'i128', value: '71200000' } },
          { key: 'to_muxed_id', val: { type: 'symbol', value: 'noop' } },
        ],
      })
    ).toBe('71200000')
  })
  it('reads a U64 from a Map data ScVal keyed by "amount"', () => {
    expect(
      readAmount({
        type: 'map',
        value: [{ key: 'amount', val: { type: 'u64', value: '999' } }],
      })
    ).toBe('999')
  })
  // The pre-fix docstring at movements.ts:91 documents the case where [0] of a
  // Vec is a Map; that path was never implemented for the map-shaped amount.
  it('reads an I128 from a Vec whose [0] is a Map keyed by "amount"', () => {
    expect(
      readAmount({
        type: 'vec',
        value: [
          {
            type: 'map',
            value: [{ key: 'amount', val: { type: 'i128', value: '606000000' } }],
          },
          { type: 'address', value: 'GABC' },
        ],
      })
    ).toBe('606000000')
  })
  it('returns null on a Map whose "amount" entry is not an I128/U64', () => {
    expect(
      readAmount({
        type: 'map',
        value: [{ key: 'amount', val: { type: 'symbol', value: 'oops' } }],
      })
    ).toBeNull()
  })
  it('returns null on a Map that has no "amount" entry', () => {
    expect(
      readAmount({
        type: 'map',
        value: [{ key: 'to_muxed_id', val: { type: 'i128', value: '100' } }],
      })
    ).toBeNull()
  })
  it('returns null on a Map with no entries (fail-closed)', () => {
    expect(readAmount({ type: 'map', value: [] })).toBeNull()
  })
  // Real mainnet SAC transfer event end-to-end (tx 112d2392...): the event
  // data is a Map { amount: I128, to_muxed_id: String } and the topics carry
  // the from/to addresses. The pre-fix readAmount refused the Map and the
  // recording was refused with parseConfidence = 0.
  it('extractTokenMovements decodes a SAC mainnet transfer event with Map data', () => {
    const from = Keypair.random().publicKey()
    const to = Keypair.random().publicKey()
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const evts: OnChainEvent[] = [
      {
        contract: token,
        topics: ['transfer', from, to],
        data: {
          type: 'map',
          value: [
            { key: 'amount', val: { type: 'i128', value: '71200000' } },
            { key: 'to_muxed_id', val: { type: 'symbol', value: 'noop' } },
          ],
        },
      },
    ]
    const movements = extractTokenMovements(evts)
    expect(movements).toEqual([{ token, from, to, amount: '71200000' }])
  })
})

describe('parseContractEventToMovement', () => {
  it('round-trips a synthetic transfer ContractEvent', async () => {
    const { parseContractEventToMovement } = await import('./movements.ts')
    const from = Address.fromString(Keypair.random().publicKey())
    const to = Address.fromString(Keypair.random().publicKey())
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const body = new xdr.ContractEventV0({
      topics: [
        xdr.ScVal.scvSymbol('transfer'),
        xdr.ScVal.scvAddress(from.toScAddress()),
        xdr.ScVal.scvAddress(to.toScAddress()),
      ],
      data: xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString('0'),
          lo: xdr.Uint64.fromString('321'),
        })
      ),
    })
    const movement = parseContractEventToMovement(token, body)
    expect(movement).toEqual({ token, from: from.toString(), to: to.toString(), amount: '321' })
  })
  it('silently skips non-movement events', async () => {
    const { parseContractEventToMovement } = await import('./movements.ts')
    const token = 'CABC'
    const body = new xdr.ContractEventV0({
      topics: [xdr.ScVal.scvSymbol('set_admin')],
      data: nativeToScVal('x'),
    })
    expect(parseContractEventToMovement(token, body)).toBeNull()
  })
})
