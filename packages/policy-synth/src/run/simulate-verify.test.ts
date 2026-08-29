// packages/policy-synth/src/run/simulate-verify.test.ts
//
// `simulate_policy` and `verify_policy` bodies. Both are driven from a real
// recorded transaction so the tests exercise the same join an MCP client makes:
// synthesize with `explain`, then feed the returned predicate tree back in.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Address } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import type { PredicateNode, RecordedTransaction } from '../types.ts'
import { runSimulatePolicy, runSynthesizePolicy, runVerifyPolicy } from './index.ts'
import { SimulatePolicyInputSchema } from './schemas.ts'

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
    const res = await runSimulatePolicy({ predicate, permitTx: tx })
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
    const res = await runSimulatePolicy({ predicate, permitTx: elsewhere })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permitted).toBe(false)
    expect(res.data.reason).toBe('CONTRACT_SCOPE')
  })

  it('rejects a recording carrying no invocation rather than reporting a verdict', async () => {
    const { predicate } = await synthesise('demo-rec-sep41')
    const empty = { ...recording('demo-rec-sep41'), invocations: [] }
    const res = await runSimulatePolicy({ predicate, permitTx: empty })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
    // The code alone does not distinguish this from a malformed-input refusal
    // (both are SIMULATION_ERROR), so pin the reason the call was refused.
    expect(res.error.message).toBe('simulate_policy: permitTx carries no invocation to evaluate')
  })

  it('refuses a malformed input with a structured error, never a throw', async () => {
    const res = await runSimulatePolicy({ predicate: { op: 'nope' }, permitTx: {} })
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
      const res = await runVerifyPolicy({ predicate, permitTx: tx })
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
    const res = await runVerifyPolicy({ predicate, permitTx: empty })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.message).toBe('verify_policy: permitTx carries no invocation to evaluate')
  })

  it('always exercises the contract and function pins', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41')
    const res = await runVerifyPolicy({ predicate, permitTx: tx })
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
    const res = await runVerifyPolicy({ predicate: fnOnly, permitTx: tx })
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
    const sim = await runSimulatePolicy({ predicate: fnOnly, permitTx: elsewhere })
    expect(sim.ok).toBe(true)
    if (!sim.ok) return
    expect(sim.data.permitted).toBe(true)
    // ...yet verify still says ok, because it had no contract case to run.
    expect(res.data.ok).toBe(true)
  })

  it('exercises the amount cap: one unit over is refused', async () => {
    const { tx, predicate } = await synthesise('demo-rec-sep41', '1000000')
    const res = await runVerifyPolicy({ predicate, permitTx: tx })
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
    const res = await runVerifyPolicy({ predicate, permitTx: tx })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.denies.some((d) => d.dimension === 'amount_over_cap')).toBe(false)
  })
})

// The check tools take a transaction hash as an alternative to the tree. The
// tree only comes back from `synthesize_policy` under `explain`, so without
// this a caller who did not ask for it has nothing to pass - and silently
// skipping verification is worse than any wrong verdict it could return.

describe('simulate_policy / verify_policy accept a transaction hash', () => {
  const HASH = 'bd46f023c74bed01085015dc4ffebb9bb9f6a1023efe6d2bf1b3a25e1933408a'

  it('accepts a hash with neither predicate nor recording', () => {
    expect(
      SimulatePolicyInputSchema.safeParse({ transactionHash: HASH, network: 'testnet' }).success
    ).toBe(true)
  })

  it('rejects a request naming neither, rather than checking nothing', () => {
    const parsed = SimulatePolicyInputSchema.safeParse({ network: 'testnet' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(' ')).toContain('transactionHash')
    }
  })

  it('rejects a half-supplied pair, which would otherwise check the wrong thing', () => {
    expect(
      SimulatePolicyInputSchema.safeParse({ predicate: { op: 'and', args: [] } }).success
    ).toBe(false)
  })

  it('rejects a malformed hash at the boundary', () => {
    for (const bad of ['not-a-hash', HASH.toUpperCase(), HASH.slice(0, 63)]) {
      expect(SimulatePolicyInputSchema.safeParse({ transactionHash: bad }).success).toBe(false)
    }
  })
})

// A DECLARED policy has no recording behind it, so a hash cannot stand in for
// it - re-synthesizing would check a different predicate than the one declared.
// `encodedPredicate` is the handle for that path: one opaque base64 string
// where the tree is the shape callers mistype.

describe('the check tools accept an encoded predicate', () => {
  const HASH = 'd520d9e1f601d7cfe64a9d75557d7db143c1ccf89c3917b02e64eb79165c4a6a'

  it('accepts an encoded predicate paired with a hash', () => {
    const parsed = SimulatePolicyInputSchema.safeParse({
      encodedPredicate: 'AAAAEA==',
      transactionHash: HASH,
      network: 'testnet',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a predicate with nothing to check it against', () => {
    expect(SimulatePolicyInputSchema.safeParse({ encodedPredicate: 'AAAAEA==' }).success).toBe(
      false
    )
  })

  it('prefers the caller predicate over re-synthesis, so a declared policy is what gets checked', async () => {
    // A predicate that pins a function no recording of this transfer produces.
    // If the tool re-synthesized from the hash instead of honouring what was
    // passed, the call would be permitted and this would fail.
    const encoded = encodePredicate({
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'not_transfer' },
    }).encodedPredicate
    const res = await runSimulatePolicy({
      encodedPredicate: encoded,
      transactionHash: HASH,
      network: 'testnet',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permitted).toBe(false)
  })
})
