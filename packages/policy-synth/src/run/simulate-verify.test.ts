// packages/policy-synth/src/run/simulate-verify.test.ts
//
// `simulate_policy` and `verify_policy` bodies. Both are driven from a real
// recorded transaction so the tests exercise the same join an MCP client makes:
// synthesize with `explain`, then feed the returned predicate tree back in.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Address } from '@stellar/stellar-sdk'
import type { PredicateNode, RecordedTransaction } from '../types.ts'
import { runSimulatePolicy, runSynthesizePolicy, runVerifyPolicy } from './index.ts'

const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0x01)).toString()

function recording(name: string): RecordedTransaction {
  const raw = JSON.parse(
    readFileSync(new URL(`../../fixtures/recordings/${name}.json`, import.meta.url), 'utf8')
  )
  return (raw.data ?? raw) as RecordedTransaction
}

async function synthesise(
  name: string,
  limitAmount?: string
): Promise<{ tx: RecordedTransaction; predicate: PredicateNode }> {
  const tx = recording(name)
  const res = await runSynthesizePolicy({
    source: 'recording',
    network: 'mainnet',
    recordedTx: tx,
    explain: true,
    userResponses: {
      validUntilLedger: 200_000_000,
      ...(limitAmount !== undefined ? { limitAmount } : {}),
    },
    interpreter: { smartAccountAddress: SMART_ACCOUNT, installNonce: 1 },
  })
  if (!res.ok) throw new Error(`synthesis failed: ${res.error.code}`)
  const predicate = res.explain?.predicateTree
  if (!predicate) throw new Error('synthesis returned no predicate tree')
  return { tx, predicate }
}

describe('runSimulatePolicy', () => {
  it('permits the transaction the predicate was synthesised from', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41')
    const res = runSimulatePolicy({ predicate, permitTx: tx })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permitted).toBe(true)
    expect(res.data.reason).toBeNull()
    // The verdict names the call it judged, so a caller cannot mistake which
    // invocation was evaluated.
    expect(res.data.call.fn).toBe(tx.invocations[0]?.fn)
  })

  it('denies the same call sent to a different contract, and says why', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41')
    const elsewhere: RecordedTransaction = {
      ...tx,
      invocations: [
        {
          ...tx.invocations[0]!,
          contract: Address.contract(Buffer.alloc(32, 0x5a)).toString(),
        },
        ...tx.invocations.slice(1),
      ],
    }
    const res = runSimulatePolicy({ predicate, permitTx: elsewhere })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permitted).toBe(false)
    expect(res.data.reason).toBe('CONTRACT_SCOPE')
  })

  it('rejects a recording carrying no invocation rather than reporting a verdict', async () => {
    const { predicate } = await synthesise('demo-rec-sep41')
    const empty = { ...recording('demo-rec-sep41'), invocations: [] }
    const res = runSimulatePolicy({ predicate, permitTx: empty })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
    // The code alone does not distinguish this from a malformed-input refusal
    // (both are SIMULATION_ERROR), so pin the reason the call was refused.
    expect(res.error.message).toBe('simulate_policy: permitTx carries no invocation to evaluate')
  })

  it('refuses a malformed input with a structured error, never a throw', () => {
    const res = runSimulatePolicy({ predicate: { op: 'nope' }, permitTx: {} })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
    expect(res.error.retryable).toBe(false)
  })
})

describe('runVerifyPolicy', () => {
  it.each(['demo-rec-blend', 'demo-rec-sep41', 'demo-rec-soroswap'])(
    'passes for %s: the permit case is permitted and every deny case is denied',
    async (name) => {
      const { tx, predicate } = await synthesise(name)
      const res = runVerifyPolicy({ predicate, permitTx: tx })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.data.permit.permitted).toBe(true)
      expect(res.data.denies.every((d) => d.denied)).toBe(true)
      expect(res.data.ok).toBe(true)
    }
  )

  it('rejects a recording carrying no invocation rather than reporting a verdict', async () => {
    const { predicate } = await synthesise('demo-rec-sep41')
    const empty = { ...recording('demo-rec-sep41'), invocations: [] }
    const res = runVerifyPolicy({ predicate, permitTx: empty })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.message).toBe('verify_policy: permitTx carries no invocation to evaluate')
  })

  it('always exercises the contract and function pins', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41')
    const res = runVerifyPolicy({ predicate, permitTx: tx })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Without these two the harness could report `ok` having only mutated an
    // argument, which is the weakest of the bypasses a policy must refuse.
    const dimensions = res.data.denies.map((d) => d.dimension)
    expect(dimensions).toContain('contract_scope')
    expect(dimensions).toContain('function_scope')
    expect(res.data.dimensionsCovered).toBe(res.data.denies.length)
  })

  // A limitation worth stating rather than discovering later: the deny cases
  // are derived FROM the predicate, so a dimension the predicate does not
  // constrain produces no case for it. `ok: true` therefore means "nothing the
  // harness could construct got through", not "this policy is tight".
  it('generates no contract case for a predicate that never pins the contract, and still reports ok', async () => {
    const { tx } = await synthesise('demo-rec-sep41')
    const fnOnly: PredicateNode = {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: tx.invocations[0]!.fn },
    }
    const res = runVerifyPolicy({ predicate: fnOnly, permitTx: tx })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.denies.some((d) => d.dimension === 'contract_scope')).toBe(false)
    // The call really would reach any contract under this predicate.
    const elsewhere = {
      ...tx,
      invocations: [
        { ...tx.invocations[0]!, contract: Address.contract(Buffer.alloc(32, 0x5a)).toString() },
      ],
    }
    const sim = runSimulatePolicy({ predicate: fnOnly, permitTx: elsewhere })
    expect(sim.ok).toBe(true)
    if (!sim.ok) return
    expect(sim.data.permitted).toBe(true)
    // ...yet verify still says ok, because it had no contract case to run.
    expect(res.data.ok).toBe(true)
  })

  it('exercises the amount cap: one unit over is refused', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41', '1000000')
    const res = runVerifyPolicy({ predicate, permitTx: tx })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Every value bound is an `lte`. Without a case that steps one unit past
    // it, nothing exercises the guarantee the product is sold on.
    const overCap = res.data.denies.find((d) => d.dimension === 'amount_over_cap')
    expect(overCap).toBeDefined()
    expect(overCap?.denied).toBe(true)
    expect(overCap?.reason).toBe('ARG_MISMATCH')
  })

  it('generates no amount case when the caller supplied no cap', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41')
    const res = runVerifyPolicy({ predicate, permitTx: tx })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.denies.some((d) => d.dimension === 'amount_over_cap')).toBe(false)
  })
})
