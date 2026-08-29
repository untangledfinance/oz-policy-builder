// src/run/install-by-hash.test.ts - `install_policy` accepts a transaction hash
// as an alternative to a full ContextRuleDraft.
//
// Same cause as the `synthesize_policy` hash form: an MCP client has no
// variable to pass by reference, so an agent handed a draft must retype it.
// A draft nests a signer array, a policy array and a nullable ledger number,
// and a retyped copy arrives with `validUntilLedger` as a string, `signers` as
// "" and `policies` as an object - the install then fails on a rule the server
// had already built correctly one call earlier.
//
// These tests cover the boundary: that one of the two inputs is required and
// that the hash form is shaped correctly. The synthesis the server performs
// behind `fromHash` is `synthesize_policy`'s and is covered there; the live
// install is covered by the testnet scripts.

import { describe, expect, it } from 'bun:test'
import { Keypair } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import { runInstallPolicy } from './index.ts'
import { InstallPolicyInputSchema } from './schemas.ts'

const SMART_ACCOUNT = 'CDEG66TYZB2RTKRSIEA4UTFMRXOYESCEQUKWS7R2JN357PJDSY272PFK'
const SOURCE_ACCOUNT = Keypair.random().publicKey()
const HASH = '7508e761a6b658c7f54930c75db2aa5878b20a45cdabc341ee03815a7383b4a4'

function makeRule() {
  const pred = encodePredicate({
    op: 'eq',
    left: { kind: 'call_fn' },
    right: { kind: 'literal_symbol', value: 'transfer' },
  })
  return {
    contextRuleType: { kind: 'default' as const },
    name: 'test-rule',
    validUntilLedger: null,
    signers: [{ kind: 'delegated' as const, address: SOURCE_ACCOUNT }],
    policies: [
      {
        kind: 'interpreter' as const,
        interpreterAddress: SMART_ACCOUNT,
        predicateBlobBase64: pred.encodedPredicate,
      },
    ],
  }
}

const base = {
  smartAccount: SMART_ACCOUNT,
  sourceAccount: SOURCE_ACCOUNT,
  installNonce: 1,
}

describe('InstallPolicyInputSchema', () => {
  it('accepts a hash instead of a rule', () => {
    expect(
      InstallPolicyInputSchema.safeParse({ ...base, fromHash: { transactionHash: HASH } }).success
    ).toBe(true)
  })

  it('carries the answers to the synthesizer questions alongside the hash', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromHash: { transactionHash: HASH, userResponses: { limitAmount: '1000000000' } },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a response key the synthesizer does not read, rather than dropping it', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromHash: { transactionHash: HASH, userResponses: { limitAmmount: '1000000000' } },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a request naming neither, rather than installing an empty rule', () => {
    const parsed = InstallPolicyInputSchema.safeParse(base)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(' ')).toContain('fromHash')
    }
  })

  it('rejects a malformed hash at the boundary', () => {
    for (const bad of ['not-a-hash', HASH.toUpperCase(), HASH.slice(0, 63), `${HASH}00`]) {
      expect(
        InstallPolicyInputSchema.safeParse({ ...base, fromHash: { transactionHash: bad } }).success
      ).toBe(false)
    }
  })

  it('still accepts a supplied rule, so programmatic callers are unaffected', () => {
    expect(InstallPolicyInputSchema.safeParse({ ...base, rule: makeRule() }).success).toBe(true)
  })

  it('takes the keys the rule governs as plain addresses', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromHash: { transactionHash: HASH, signers: [SOURCE_ACCOUNT, SMART_ACCOUNT] },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a signer that is not a Stellar address', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromHash: { transactionHash: HASH, signers: ['alice'] },
    })
    expect(parsed.success).toBe(false)
  })
})

// A rule that governs no key is refused on chain, and the refusal arrives as a
// bare contract error code. Synthesis emits exactly that rule - it reads a
// transaction, and which keys a rule binds is not something one recording
// answers - so the empty set is the common case, not an edge one.

describe('runInstallPolicy signer requirement', () => {
  it('says the rule names no signer instead of letting the chain answer', async () => {
    const res = await runInstallPolicy({ ...base, rule: { ...makeRule(), signers: [] } })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain('no signer')
  })
})

// `declare_policy` returns a predicate, not a rule. Before `fromPredicate`
// there was no route from there to here: `fromHash` re-synthesizes and would
// discard the declared predicate, and `rule` is typed `unknown` at the tool
// boundary, so a caller hand-building it is guessing. One agent asked to do
// that concluded it had to deploy an ed25519 signer contract first, which is
// not a thing - a delegated signer is a plain account address.

describe('install_policy accepts a predicate the caller already holds', () => {
  const encoded = encodePredicate({
    op: 'and',
    children: [
      { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: SMART_ACCOUNT },
      },
    ],
  }).encodedPredicate

  it('accepts an encoded predicate plus the keys it governs', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromPredicate: { encodedPredicate: encoded, signers: [SOURCE_ACCOUNT] },
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a predicate that governs no key', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromPredicate: { encodedPredicate: encoded, signers: [] },
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a signer that is not an address, rather than treating it as a contract', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromPredicate: { encodedPredicate: encoded, signers: ['ed25519-signer'] },
    })
    expect(parsed.success).toBe(false)
  })

  it('names all three ways in when the caller supplies none', () => {
    const parsed = InstallPolicyInputSchema.safeParse(base)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const message = parsed.error.issues.map((i) => i.message).join(' ')
    expect(message).toContain('fromPredicate')
    expect(message).toContain('fromHash')
  })
})

// Two defects that let a "cap" reach the chain capping nothing, and cost a user
// turn on the way. Both are boundary behaviour, so both are pinned here.

describe('install_policy guards', () => {
  it('does not require installNonce, which a caller cannot discover', () => {
    const { installNonce, ...withoutNonce } = base
    void installNonce
    const parsed = InstallPolicyInputSchema.safeParse({
      ...withoutNonce,
      fromHash: { transactionHash: HASH, signers: [SOURCE_ACCOUNT] },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts the deliberate opt-in to an unbounded rule', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      fromHash: { transactionHash: HASH, signers: [SOURCE_ACCOUNT] },
      allowUnboundedAmount: true,
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses to install a rule that bounds no amount when the recording shows a spend', async () => {
    const res = await runInstallPolicy({
      smartAccount: 'CAEI3JCERLHEWVARAUSLJOBSF4555B5O4KGIGSC3TBHHCWABO6M7GULQ',
      sourceAccount: 'GDI64EFSV4IVJ53EWNXAPTZG3XR6O5YM4AYR7DI67Z6DRFDU3DHR6TH2',
      network: 'testnet',
      fromHash: {
        transactionHash: 'd520d9e1f601d7cfe64a9d75557d7db143c1ccf89c3917b02e64eb79165c4a6a',
        signers: ['GDDNZBJTFTR46JICTYX2EYWW7OSXXHQWVH4TD7AUIMWIPDMQAKCHF3BX'],
      },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.message).toContain('does not bound')
  })
})

// "N per day" is the request the tools could not express: a predicate bounds
// one call and keeps no state, so a per-call cap of N authorises N again
// immediately. `spendingLimit` attaches an OpenZeppelin built-in beside the
// predicate on the same rule, and both must permit.

describe('install_policy spendingLimit', () => {
  const withRule = {
    ...base,
    rule: {
      ...makeRule(),
      contextRuleType: {
        kind: 'call_contract' as const,
        contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      },
    },
  }

  it('accepts a rolling total alongside the per-call predicate', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...withRule,
      spendingLimit: { amount: '153000000', periodLedgers: 17280 },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a period given in seconds-shaped nonsense at the boundary', () => {
    for (const bad of [0, -1, 1.5]) {
      const parsed = InstallPolicyInputSchema.safeParse({
        ...withRule,
        spendingLimit: { amount: '153000000', periodLedgers: bad },
      })
      expect(parsed.success).toBe(false)
    }
  })

  it('rejects an amount that is not a smallest-unit integer', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...withRule,
      spendingLimit: { amount: '15.3', periodLedgers: 17280 },
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a rolling total on a rule not scoped to one token', async () => {
    // The primitive meters transfers of a single contract. A default-scoped
    // rule would install and meter nothing, which reads as a working cap.
    const res = await runInstallPolicy({
      ...base,
      rule: { ...makeRule(), contextRuleType: { kind: 'default' } },
      spendingLimit: { amount: '153000000', periodLedgers: 17280 },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.message).toContain('scoped to that token')
  })
})
