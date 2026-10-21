import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import {
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETERS,
  OZ_ACCOUNT_WASM,
  POLICY_CONTRACTS,
  SAFE_READS,
  SPENDING_LIMIT,
  safeRead,
  thresholdAddress,
} from './config.ts'

const root = new URL('../../../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

describe('the pins are the contract that was built and deployed', () => {
  it("the grammar is the interpreter source's SELF_VERSION", () => {
    const v = read('contracts/stellar/policy-interpreter/src/version.rs')
    expect(v).toMatch(new RegExp(`SELF_VERSION: u32 = ${GRAMMAR_VERSION};`))
  })

  it('the testnet pin is the deployment record: address and wasm hash', () => {
    const record = JSON.parse(read('deployments/interpreter-testnet.json'))
    expect(record.grammar).toBe(GRAMMAR_VERSION)
    expect(INTERPRETER.testnet).toEqual({
      address: record.interpreter,
      wasmSha256: record.wasmHashes.interpreter,
      limits: record.limits, // immutable per instance: what synthesize holds a rule to with no RPC
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

  it('the threshold policies the builder attaches are the ones in the record, per network', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      expect(thresholdAddress(network, false)).toBe(oz[network].simple_threshold)
      expect(thresholdAddress(network, true)).toBe(oz[network].weighted_threshold)
    }
  })

  it('and a deployed interpreter this build does not trust is still recognised', () => {
    expect(INTERPRETERS.has('CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5')).toBe(true)
  })
})

describe('the smart-account builds a review will read', () => {
  const record = JSON.parse(read('deployments/oz-accounts.json'))
  it('say plainly how much is known of where the bytes came from, and what was tried', () => {
    const p = record.provenance.multisig_account_example
    expect(p.sourceCommitRecorded).toBe(false)
    expect(p.buildCommandRecorded).toBe(false)
    expect(p.reproductionAttempts.length).toBeGreaterThan(0)
    for (const a of p.reproductionAttempts) {
      expect(a.wasmSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(a.matches).toBe(a.wasmSha256 === record.wasmSha256.multisig_account_example)
    }
  })

  it('are the deployment record, and the example account this repo ships', () => {
    expect([...OZ_ACCOUNT_WASM].sort()).toEqual(Object.values(record.wasmSha256).sort())
    const wasm = readFileSync(
      new URL(
        'contracts/stellar/policy-interpreter/tests/fixtures/multisig_account_example.wasm',
        root
      )
    )
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(
      record.wasmSha256.multisig_account_example
    )
  })
})

describe('read targets that cannot be moved within one transaction', () => {
  it('testnet: the Reflector oracles, lastprice and price (their spec was read on chain); mainnet: an empty slot until one is verified', () => {
    const t = Object.entries(SAFE_READS.testnet)
    expect(t.length).toBeGreaterThan(0)
    for (const [address, fns] of t) {
      expect(StrKey.isValidContract(address)).toBe(true)
      expect(fns).toEqual(['lastprice', 'price'])
    }
    expect(SAFE_READS.mainnet).toEqual({})
  })
  it('a read is safe only for a listed contract and function, on that network', () => {
    const [address] = Object.keys(SAFE_READS.testnet) as [string]
    expect(safeRead('testnet', address, 'lastprice', [])).toBe(true)
    expect(safeRead('testnet', address, 'price', [{ u64: '1' }])).toBe(true)
    expect(safeRead('testnet', address, 'set_price', [])).toBe(false)
    // A call-derived argument (an asset or a timestamp the caller picks) makes it a live value.
    expect(safeRead('testnet', address, 'lastprice', [['call_arg', 1]])).toBe(false)
    expect(safeRead('testnet', address, 'price', [['lit', 'XLM'], ['now']])).toBe(false)
    expect(
      safeRead('testnet', address, 'price', [
        ['lit', 'XLM'],
        ['lit', 5],
      ])
    ).toBe(true)
    expect(safeRead('testnet', address, 'constructor', [])).toBe(false)
    expect(safeRead('mainnet', address, 'lastprice', [])).toBe(false)
    expect(safeRead('testnet', 'C'.padEnd(56, 'A'), 'lastprice', [])).toBe(false)
  })
})

describe('the operator extends the safe list: POLICY_BUILDER_SAFE_READS_<NET>', () => {
  const [A, B] = [contract(1), contract(2)]
  const withEnv = (
    v: string | undefined,
    f: () => void,
    key = 'POLICY_BUILDER_SAFE_READS_TESTNET'
  ) => {
    const before = process.env[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
    try {
      f()
    } finally {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    }
  }
  it('a listed contract and function is safe with constant arguments, on that network only', () => {
    withEnv(`${A}:position,${B}:balance`, () => {
      expect(safeRead('testnet', A, 'position', [{ i128: '1' }])).toBe(true)
      expect(safeRead('testnet', B, 'balance', [])).toBe(true)
      expect(safeRead('mainnet', A, 'position', [])).toBe(false)
    })
    expect(safeRead('testnet', A, 'position', [])).toBe(false)
  })
  it('the same contract with another function, or a call-derived argument, is a live value', () => {
    withEnv(`${A}:position`, () => {
      expect(safeRead('testnet', A, 'balance', [])).toBe(false)
      expect(safeRead('testnet', A, 'position', [['call_arg', 1]])).toBe(false)
      expect(safeRead('testnet', A, 'position', [['now']])).toBe(false)
    })
  })
  it('the mainnet variable lists mainnet reads, not testnet ones', () => {
    withEnv(
      `${A}:position`,
      () => {
        expect(safeRead('mainnet', A, 'position', [])).toBe(true)
        expect(safeRead('testnet', A, 'position', [])).toBe(false)
      },
      'POLICY_BUILDER_SAFE_READS_MAINNET'
    )
  })
  it('a malformed value refuses the whole of it, naming the variable, never part', () => {
    for (const bad of [
      `${A}`,
      `${A}:`,
      `${A}:position,`,
      `${A}:position,${B}`,
      `${A}:po sition`,
      `${A}:1position`,
      `${A}:${'a'.repeat(33)}`,
      `${A}:position:x`,
      ` ${A}:position`,
      `G${A.slice(1)}:position`,
      `${A.slice(0, -1)}A:position`,
      'junk',
    ])
      withEnv(bad, () => {
        expect(() => safeRead('testnet', A, 'position', [])).toThrow(
          /POLICY_BUILDER_SAFE_READS_TESTNET/
        )
        // a built-in read is refused with it too: the value is wrong, not one entry
        expect(() =>
          safeRead('testnet', Object.keys(SAFE_READS.testnet)[0] as string, 'lastprice', [])
        ).toThrow()
      })
  })
  it('a one-letter and a 32-letter function name are valid entries', () => {
    withEnv(`${A}:a,${A}:${'b'.repeat(32)}`, () => {
      expect(safeRead('testnet', A, 'a', [])).toBe(true)
      expect(safeRead('testnet', A, 'b'.repeat(32), [])).toBe(true)
    })
  })
  it('an empty value is no list', () => {
    withEnv('', () => expect(safeRead('testnet', A, 'position', [])).toBe(false))
  })
})
