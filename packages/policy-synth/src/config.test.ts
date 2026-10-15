import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import {
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETERS,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
} from './config.ts'

const root = new URL('../../../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

describe('the pins are the contract that was built and deployed', () => {
  it("the grammar is the interpreter source's SELF_VERSION", () => {
    const v = read('contracts/prime/stellar/policy-interpreter/src/version.rs')
    expect(v).toMatch(new RegExp(`SELF_VERSION: u32 = ${GRAMMAR_VERSION};`))
  })

  it('the testnet pin is the deployment record: address and wasm hash', () => {
    const record = JSON.parse(read('deployments/grammar7-testnet.json'))
    expect(record.grammar).toBe(GRAMMAR_VERSION)
    expect(INTERPRETER.testnet).toEqual({
      address: record.interpreter,
      wasmSha256: record.wasmHashes.interpreter,
    })
    expect(record.interpreterSource.reproducibleWasmSha256).toBe(record.wasmHashes.interpreter)
  })

  it('mainnet has none yet, and every address is a valid contract id', () => {
    expect(INTERPRETER.mainnet).toBeNull()
    for (const a of [
      INTERPRETER.testnet?.address,
      ...Object.values(SPENDING_LIMIT),
      ...POLICY_CONTRACTS,
    ]) {
      expect(StrKey.isValidContract(a as string)).toBe(true)
    }
    expect(POLICY_CONTRACTS.has(INTERPRETER.testnet?.address as string)).toBe(true)
  })
})

describe('every interpreter this project deployed is a policy contract no rule may be scoped to', () => {
  it('the addresses in deployments/*.json (and the one a record replaced) are all known', () => {
    const files = readdirSync(new URL('deployments/', root)).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) {
      const d = JSON.parse(read(`deployments/${f}`))
      for (const a of [d.interpreter, d.previous?.interpreter].filter(Boolean)) {
        expect(INTERPRETERS.has(a)).toBe(true)
        expect(POLICY_CONTRACTS.has(a)).toBe(true)
      }
    }
    for (const a of Object.values(SPENDING_LIMIT)) expect(POLICY_CONTRACTS.has(a)).toBe(true)
  })
})

describe('the OZ policies we deployed are policy contracts no rule may be scoped to', () => {
  const oz = JSON.parse(read('deployments/oz-policies.json'))
  it('every address in deployments/oz-policies.json is in POLICY_CONTRACTS, mainnet and testnet, all three policies', () => {
    for (const network of ['mainnet', 'testnet'] as const)
      for (const name of ['spending_limit', 'simple_threshold', 'weighted_threshold']) {
        expect(StrKey.isValidContract(oz[network][name])).toBe(true)
        expect(POLICY_CONTRACTS.has(oz[network][name])).toBe(true)
      }
    expect(SPENDING_LIMIT).toEqual({
      testnet: oz.testnet.spending_limit,
      mainnet: oz.mainnet.spending_limit,
    })
  })

  it('and so is the grammar-4 testnet interpreter the README lists', () => {
    expect(INTERPRETERS.has('CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5')).toBe(true)
  })
})
