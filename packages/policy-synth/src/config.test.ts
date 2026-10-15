import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import { GRAMMAR_VERSION, INTERPRETER, POLICY_CONTRACTS, SPENDING_LIMIT } from './config.ts'

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
