// A gated executor whose gate can pay the interpreter: bind_policy warns. The gate cannot know the
// interpreter's address, so keeping it off `payees` is not enforced by the contract, and the builder says so.

import { describe, expect, it } from 'bun:test'
import { Address, xdr } from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import type { Fingerprint } from './chain.ts'
import { payeesOfGate } from './chain.ts'
import { INTERPRETER } from './config.ts'
import { type BindChain, GATE_PAYEES_UNREAD, GATE_PAYS_INTERPRETER, planBind } from './install.ts'
import { callExpr } from './intent.ts'

const INTERP = (INTERPRETER.testnet as { address: string }).address
const ADAPTER = contract(71)
const ACCOUNT = contract(72)
const VENUE = contract(73)
const TOKEN = contract(74)
const SOURCE = account(5)

const vec = (xs: string[]) => xdr.ScVal.scvVec(xs.map((a) => new Address(a).toScVal()))
const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const instance = (entries: [string, xdr.ScVal][]) =>
  xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      storage: entries.map(([k, val]) => new xdr.ScMapEntry({ key: sym(k), val })),
    })
  )
const cfg = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, val]) => new xdr.ScMapEntry({ key: sym(k), val }))
  )

describe('payeesOfGate', () => {
  it('reads payees when the gate has them and allowed when it has none', () => {
    const now = instance([['cfg', cfg({ allowed: vec([VENUE, INTERP]), payees: vec([VENUE]) })]])
    expect(payeesOfGate(now)).toEqual([VENUE])
    const noPayees = instance([['cfg', cfg({ allowed: vec([VENUE, INTERP]) })]])
    expect(payeesOfGate(noPayees)).toEqual([VENUE, INTERP])
  })

  it('reads nothing from an instance that is not a gate configuration', () => {
    expect(payeesOfGate(undefined)).toBeUndefined()
    expect(payeesOfGate(instance([]))).toBeUndefined()
    expect(payeesOfGate(instance([['cfg', xdr.ScVal.scvU32(1)]]))).toBeUndefined()
    expect(payeesOfGate(instance([['cfg', cfg({ payees: xdr.ScVal.scvU32(1) })]]))).toBeUndefined()
    // A vector holding anything but addresses is not read.
    const odd = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)])
    expect(payeesOfGate(instance([['cfg', cfg({ payees: odd })]]))).toBeUndefined()
  })
})

describe('planBind: the gate of a gated executor', () => {
  const ours: Fingerprint = {
    address: INTERP,
    grammarVersion: 7,
    wasmSha256: 'a'.repeat(64),
    matches: true,
  }
  const rule = {
    id: 4,
    scope: { kind: 'call_contract' as const, contract: VENUE },
    signers: [],
    policies: [INTERP],
    expr: callExpr({ contract: VENUE, fn: 'submit' }),
    admins: [SOURCE],
  }
  const chain = (gatePayees?: BindChain['gatePayees']): BindChain => ({
    readRule: async () => rule,
    readRules: async () => ({ rules: [rule], complete: true, unreadable: [] }),
    kind: async () => 'gated adapter',
    fingerprint: async () => ours,
    build: async () => ({ unsignedXdr: 'BBBB' }) as never,
    ...(gatePayees ? { gatePayees } : {}),
  })
  const i = { smartAccount: ACCOUNT, sourceAccount: SOURCE, ruleId: 4, executor: ADAPTER }

  it('warns when the gate pays the interpreter, and says nothing when it does not', async () => {
    const bad = await planBind(
      i,
      INTERP,
      chain(async () => [VENUE, TOKEN, INTERP])
    )
    expect(bad.warnings).toEqual([GATE_PAYS_INTERPRETER(ADAPTER, INTERP)])
    expect(bad.unsignedXdr).toBe('BBBB')
    const good = await planBind(
      i,
      INTERP,
      chain(async () => [VENUE, TOKEN])
    )
    expect(good.warnings).toEqual([])
  })

  it('warns that the payees were not read, whether undefined or a failed read', async () => {
    const unread = [GATE_PAYEES_UNREAD(ADAPTER)]
    expect(
      (
        await planBind(
          i,
          INTERP,
          chain(async () => undefined)
        )
      ).warnings
    ).toEqual(unread)
    const failing = chain(async () => {
      throw new Error('rpc down')
    })
    expect((await planBind(i, INTERP, failing)).warnings).toEqual(unread)
  })

  it('is skipped for an executor that is not a gated adapter, or when no reader is given', async () => {
    const nogate = {
      ...chain(async () => [INTERP]),
      kind: async () => 'null-gate adapter' as const,
    }
    expect((await planBind(i, INTERP, nogate)).warnings).toEqual([])
    expect((await planBind(i, INTERP, chain())).warnings).toEqual([])
  })
})
