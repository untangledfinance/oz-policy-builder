import { describe, expect, it } from 'bun:test'
import type { ContractInvocation, RecordedTransaction, TokenMovement } from '../types.ts'
import { type IntentFacts, lower } from './lower.ts'

const FULL_CONFIDENCE = {
  overall: 1,
  knownContracts: [],
  unknownContracts: [],
  opaqueScVals: [],
  thresholdUsed: 1,
} as const

function tx(opts: {
  invocations: ContractInvocation[]
  tokenMovements?: TokenMovement[]
  signers?: string[]
  sourceAccount?: string
  network?: 'mainnet' | 'testnet'
}): RecordedTransaction {
  return {
    network: opts.network ?? 'mainnet',
    signers: opts.signers ?? ['GOWNER'],
    invocations: opts.invocations,
    tokenMovements: opts.tokenMovements ?? [],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 0,
    parseConfidence: { ...FULL_CONFIDENCE },
    sourceAccount: opts.sourceAccount ?? 'GOWNER',
  }
}

/** SEP-41 token address used by the SEP-41 subscription fixture. The token is
 *  recognised by interface (any C... calling `transfer` with the right arg
 *  shape) so parseConfidence reaches 1.0 for this fixture. */
const SEP41_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
/** Blend pool address. Pinned mainnet factory address from
 *  src/registry/known-addresses.ts - the test uses mainnet so the address
 *  pins to Blend in the registry. */
const BLEND_POOL = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
/** SoroSwap router address. Pinned mainnet from known-addresses.ts. */
const SOROSWAP_ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'
const XLM_TOKEN = 'CAS3J7GYLGXMF6TDJ5WQ2PEN4GRVNXJUIQ2TZU3ZB3OQ2V4DRCWI7WPF'
const USDC_TOKEN = 'CCWCLTASNDT57N3BCHOSVB5QWMV5URK4BXLDDF6ZZQYMBQ4OKZA3ZB2N'
const G_OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD'

describe('lower - SEP-41 subscription billing', () => {
  const fixture: RecordedTransaction = tx({
    network: 'mainnet',
    sourceAccount: G_OWNER,
    invocations: [
      {
        contract: SEP41_TOKEN,
        fn: 'transfer',
        args: [
          { type: 'address', value: G_OWNER },
          { type: 'address', value: 'GBILLER' },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: SEP41_TOKEN, from: G_OWNER, to: 'GBILLER', amount: '1000000000' }],
  })

  it('extracts callTargets as the single distinct contract', () => {
    const facts: IntentFacts = lower(fixture)
    expect(facts.callTargets).toEqual([SEP41_TOKEN])
  })

  it('records the function invoked on the contract', () => {
    const facts = lower(fixture)
    expect(facts.functionsByContract).toEqual({ [SEP41_TOKEN]: ['transfer'] })
  })

  it('aggregates the outgoing spend per token', () => {
    const facts = lower(fixture)
    expect(facts.spendByToken).toEqual({ [SEP41_TOKEN]: '1000000000' })
  })

  it('exposes the recorded signers', () => {
    const facts = lower(fixture)
    expect(facts.signers).toEqual(['GOWNER'])
  })

  it('omits sharedRouter / allowedPaths for a single-call tx', () => {
    const facts = lower(fixture)
    expect(facts.sharedRouter).toBeUndefined()
    expect(facts.allowedPaths).toBeUndefined()
  })

  it('is deterministic: same tx -> deep-equal facts across runs', () => {
    const a = lower(fixture)
    const b = lower(fixture)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('lower - Blend yield-claim (incoming-only)', () => {
  const fixture: RecordedTransaction = tx({
    network: 'mainnet',
    sourceAccount: G_OWNER,
    invocations: [
      {
        contract: BLEND_POOL,
        fn: 'claim',
        args: [
          { type: 'address', value: G_OWNER },
          { type: 'vec', value: [{ type: 'u32', value: '0' }] },
          { type: 'address', value: G_OWNER },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      // Yield paid to the user (incoming only).
      { token: XLM_TOKEN, from: BLEND_POOL, to: G_OWNER, amount: '1500000' },
    ],
  })

  it('records callTargets and functions, with empty spendByToken', () => {
    const facts = lower(fixture)
    expect(facts.callTargets).toEqual([BLEND_POOL])
    expect(facts.functionsByContract).toEqual({ [BLEND_POOL]: ['claim'] })
    expect(facts.spendByToken).toEqual({})
  })
})

describe('lower - SoroSwap swap', () => {
  const fixture: RecordedTransaction = tx({
    network: 'mainnet',
    sourceAccount: G_OWNER,
    invocations: [
      {
        contract: SOROSWAP_ROUTER,
        fn: 'swap_exact_tokens_for_tokens',
        args: [
          { type: 'i128', value: '50000000' },
          { type: 'i128', value: '45000000' },
          {
            type: 'vec',
            value: [
              { type: 'address', value: XLM_TOKEN },
              { type: 'address', value: USDC_TOKEN },
            ],
          },
          { type: 'address', value: G_OWNER },
          { type: 'u64', value: '1700000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: XLM_TOKEN, from: G_OWNER, to: SOROSWAP_ROUTER, amount: '50000000' },
      { token: USDC_TOKEN, from: SOROSWAP_ROUTER, to: G_OWNER, amount: '45000000' },
    ],
  })

  it('extracts the route path for the router', () => {
    const facts = lower(fixture)
    expect(facts.allowedPaths).toEqual({
      [SOROSWAP_ROUTER]: [[XLM_TOKEN, USDC_TOKEN]],
    })
  })

  it('records the outgoing input as the only spend (USDC incoming is filtered out)', () => {
    const facts = lower(fixture)
    expect(facts.spendByToken).toEqual({ [XLM_TOKEN]: '50000000' })
  })
})

describe('lower - edge cases', () => {
  it('sums multiple outgoing movements of the same token', () => {
    const t: RecordedTransaction = tx({
      network: 'mainnet',
      sourceAccount: G_OWNER,
      invocations: [
        {
          contract: SEP41_TOKEN,
          fn: 'transfer',
          args: [
            { type: 'address', value: G_OWNER },
            { type: 'address', value: 'GA' },
            { type: 'i128', value: '100' },
          ],
          subInvocations: [],
        },
        {
          contract: SEP41_TOKEN,
          fn: 'transfer',
          args: [
            { type: 'address', value: G_OWNER },
            { type: 'address', value: 'GB' },
            { type: 'i128', value: '50' },
          ],
          subInvocations: [],
        },
      ],
      tokenMovements: [
        { token: SEP41_TOKEN, from: G_OWNER, to: 'GA', amount: '100' },
        { token: SEP41_TOKEN, from: G_OWNER, to: 'GB', amount: '50' },
      ],
    })
    const facts = lower(t)
    expect(facts.spendByToken).toEqual({ [SEP41_TOKEN]: '150' })
    expect(facts.callTargets).toEqual([SEP41_TOKEN])
  })

  it('marks a sharedRouter when two top-level invocations hit the same contract', () => {
    const t: RecordedTransaction = tx({
      network: 'mainnet',
      invocations: [
        {
          contract: SOROSWAP_ROUTER,
          fn: 'swap_exact_tokens_for_tokens',
          args: [
            { type: 'i128', value: '1' },
            { type: 'i128', value: '1' },
            {
              type: 'vec',
              value: [
                { type: 'address', value: XLM_TOKEN },
                { type: 'address', value: USDC_TOKEN },
              ],
            },
            { type: 'address', value: G_OWNER },
            { type: 'u64', value: '1700000000' },
          ],
          subInvocations: [],
        },
        {
          contract: SOROSWAP_ROUTER,
          fn: 'swap_exact_tokens_for_tokens',
          args: [
            { type: 'i128', value: '1' },
            { type: 'i128', value: '1' },
            {
              type: 'vec',
              value: [
                { type: 'address', value: XLM_TOKEN },
                { type: 'address', value: USDC_TOKEN },
              ],
            },
            { type: 'address', value: G_OWNER },
            { type: 'u64', value: '1700000000' },
          ],
          subInvocations: [],
        },
      ],
      tokenMovements: [],
    })
    const facts = lower(t)
    expect(facts.sharedRouter).toBe(SOROSWAP_ROUTER)
  })

  it('keeps callTargets distinct with stable first-seen ordering', () => {
    const t: RecordedTransaction = tx({
      network: 'mainnet',
      invocations: [
        {
          contract: 'CA',
          fn: 'fn',
          args: [],
          subInvocations: [],
        },
        {
          contract: 'CB',
          fn: 'fn',
          args: [],
          subInvocations: [],
        },
        {
          contract: 'CA',
          fn: 'other',
          args: [],
          subInvocations: [],
        },
      ],
      tokenMovements: [],
    })
    const facts = lower(t)
    expect(facts.callTargets).toEqual(['CA', 'CB'])
    expect(facts.functionsByContract).toEqual({ CA: ['fn', 'other'], CB: ['fn'] })
  })

  it('does not include sub-invocation arg paths in allowedPaths', () => {
    const t: RecordedTransaction = tx({
      network: 'mainnet',
      invocations: [
        {
          contract: SOROSWAP_ROUTER,
          fn: 'swap_exact_tokens_for_tokens',
          args: [{ type: 'i128', value: '1' }],
          // Sub-invocation containing an address vec. v1 grammar does NOT
          // walk sub-invocations - lower() must ignore it.
          subInvocations: [
            {
              contract: 'CINNER',
              fn: 'inner',
              args: [
                {
                  type: 'vec',
                  value: [
                    { type: 'address', value: XLM_TOKEN },
                    { type: 'address', value: USDC_TOKEN },
                  ],
                },
              ],
              subInvocations: [],
            },
          ],
        },
      ],
      tokenMovements: [],
    })
    const facts = lower(t)
    expect(facts.allowedPaths).toBeUndefined()
  })
})
