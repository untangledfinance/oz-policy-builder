// The rule's version counter, as the interpreter keeps it: read off the ledger for a bind, 0 when absent.

import { describe, expect, it } from 'bun:test'
import { Address, type rpc, xdr } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import { readVersion } from './rules.ts'

const INTERP = contract(40)
const ACCOUNT = contract(41)

/** A server that answers `getLedgerEntries` with `val` for whatever key it is asked (or nothing). */
const serving = (val: xdr.ScVal | undefined) => {
  const asked: xdr.LedgerKey[] = []
  const server = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      asked.push(...keys)
      return {
        entries: val
          ? keys.map((key) => ({
              key,
              val: xdr.LedgerEntryData.contractData(
                new xdr.ContractDataEntry({
                  ext: new xdr.ExtensionPoint(0),
                  contract: new Address(INTERP).toScAddress(),
                  key: key.contractData().key(),
                  durability: xdr.ContractDataDurability.persistent(),
                  val,
                })
              ),
            }))
          : [],
      }
    },
  } as unknown as rpc.Server
  return { server, asked }
}

describe('readVersion', () => {
  it('asks the persistent entry ("ver", account, ruleId) of the interpreter', async () => {
    const { server, asked } = serving(xdr.ScVal.scvU32(3))
    expect(await readVersion(server, INTERP, { account: ACCOUNT, ruleId: 7 })).toBe(3)
    const key = asked[0]?.contractData()
    expect(Address.fromScAddress(key?.contract() as xdr.ScAddress).toString()).toBe(INTERP)
    expect(key?.durability().name).toBe('persistent')
    const parts = key?.key().vec() ?? []
    expect(parts.map((p) => p.switch().name)).toEqual(['scvSymbol', 'scvAddress', 'scvU32'])
    expect(parts[0]?.sym().toString()).toBe('ver')
    expect(parts[2]?.u32()).toBe(7)
  })

  it('reads 0 when the interpreter holds no counter for the rule', async () => {
    expect(
      await readVersion(serving(undefined).server, INTERP, { account: ACCOUNT, ruleId: 1 })
    ).toBe(0)
  })

  it('refuses an entry that is not a u32', async () => {
    const { server } = serving(xdr.ScVal.scvSymbol('x'))
    await expect(readVersion(server, INTERP, { account: ACCOUNT, ruleId: 1 })).rejects.toThrow(
      /not a u32/
    )
  })
})
