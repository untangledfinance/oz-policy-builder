// src/install/build-add-context-rule.test.ts - unit tests for the pure
// `add_context_rule` arg builder.
//
// Coverage:
//   - encodes context_type = Default, name, valid_until = Option<u32>,
//     signers = Vec<Signer>, policies = Map<Address, Val> with the
//     `PolicyInstallParams` struct fields
//   - enforces the OZ hard limits fail-closed:
//       signers > 15 -> INSTALL_BUILD_FAILED
//       policies > 5 -> INSTALL_BUILD_FAILED
//       both empty -> INSTALL_BUILD_FAILED
//   - refuses a caller-supplied `predicateHash` that does not match
//     sha256(encodedPredicate)
//   - sorts struct keys alphabetically (the host compares by symbol STRING,
//     not XDR bytes - a regression here would be a silent wire format break)
//
// These tests are pure; no network, no signing.

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { Address, Keypair } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import { type ContextRuleDraft, OZ_LIMITS, type PolicyRef, type SignerDraft } from '../types.ts'
import {
  ADD_CONTEXT_RULE_SYMBOL,
  type BuildAddContextRuleArgs,
  buildAddContextRuleArgs,
} from './build-add-context-rule.ts'

const INTERPRETER = Keypair.random().publicKey() // C... address (will be wrapped as Contract via Address logic)
const DEPLOYER = Keypair.random().publicKey()

function makeEncodedPredicate(): { encodedPredicate: string; predicateHash: string } {
  // eq(call_fn, "batch_add_signer") - the smallest predicate the on-chain
  // grammar accepts.
  const enc = encodePredicate({
    op: 'eq',
    left: { kind: 'call_fn' },
    right: { kind: 'literal_symbol', value: 'batch_add_signer' },
  })
  return enc
}

function defaults(overrides: Partial<BuildAddContextRuleArgs> = {}): BuildAddContextRuleArgs {
  const { encodedPredicate, predicateHash } = makeEncodedPredicate()
  return {
    signers: [{ kind: 'delegated', address: DEPLOYER }] as SignerDraft[],
    policies: [
      {
        kind: 'interpreter',
        interpreterAddress: INTERPRETER,
        predicateBlobBase64: encodedPredicate,
      },
    ] as PolicyRef[],
    installNonce: 1,
    encodedPredicate,
    predicateHash,
    ...overrides,
  }
}

function makeDraft(overrides: Partial<ContextRuleDraft> = {}): ContextRuleDraft {
  return {
    contextRuleType: { kind: 'default' },
    name: 'install-flow-test-rule',
    validUntilLedger: null,
    signers: [{ kind: 'delegated', address: DEPLOYER }],
    policies: [],
    ...overrides,
  }
}

describe('ADD_CONTEXT_RULE_SYMBOL', () => {
  it('is the OZ trait function name', () => {
    expect(ADD_CONTEXT_RULE_SYMBOL).toBe('add_context_rule')
  })
})

describe('buildAddContextRuleArgs - happy path', () => {
  it('emits five args in the OZ trait order', () => {
    const args = buildAddContextRuleArgs(makeDraft(), defaults())
    expect(args.length).toBe(5)
    // context_type
    expect(args[0].switch().name).toBe('scvVec')
    expect(args[0].vec()?.[0]?.sym().toString()).toBe('Default')
    // name (ScVal::String)
    expect(args[1].switch().name).toBe('scvString')
    expect(args[1].str().toString()).toBe('install-flow-test-rule')
    // valid_until = void (None)
    expect(args[2].switch().name).toBe('scvVoid')
    // signers = Vec<Signer>
    expect(args[3].switch().name).toBe('scvVec')
    expect(args[3].vec()?.length).toBe(1)
    // policies = Map<Address, Val>
    expect(args[4].switch().name).toBe('scvMap')
    expect(args[4].map()?.length).toBe(1)
  })

  it('encodes valid_until as ScVal::U32 when draft provides a ledger', () => {
    const args = buildAddContextRuleArgs(makeDraft({ validUntilLedger: 1234567 }), defaults())
    expect(args[2].switch().name).toBe('scvU32')
    expect(args[2].u32()).toBe(1234567)
  })

  it('encodes Delegated and External signers to the OZ enum wire form', () => {
    const args = buildAddContextRuleArgs(
      makeDraft(),
      defaults({
        signers: [
          { kind: 'delegated', address: DEPLOYER },
          { kind: 'external', verifier: INTERPRETER, keyBytes: 'deadbeef' },
        ],
      })
    )
    const signers = args[3].vec()!
    expect(signers.length).toBe(2)

    // Delegated
    const deleg = signers[0]!.vec()!
    expect(deleg[0]?.sym().toString()).toBe('Delegated')
    expect(Address.fromScAddress(deleg[1]?.address()).toString()).toBe(DEPLOYER)

    // External
    const ext = signers[1]!.vec()!
    expect(ext[0]?.sym().toString()).toBe('External')
    expect(Address.fromScAddress(ext[1]?.address()).toString()).toBe(INTERPRETER)
    expect(Buffer.from(ext[2]?.bytes()).toString('hex')).toBe('deadbeef')
  })

  it('encodes every PolicyInstallParams field, sorted by symbol', () => {
    const args = buildAddContextRuleArgs(makeDraft(), defaults({ installNonce: 7 }))
    const map = args[4].map()!
    expect(map.length).toBe(1)
    const inner = map[0]!.val().map()!
    const fields = inner.map((e) => e.key().sym().toString())
    // The host orders map entries by symbol STRING, not by XDR bytes. The
    // builder emits them in the same order so the encoding round-trips.
    //
    // This list mirrors the builder's own, so it pins ORDER and catches a
    // field being dropped from one side. It canNOT catch a field missing
    // from BOTH: the host unpacks the struct by field count, so a field the
    // contract has and neither this list nor the builder does fails every
    // install on chain with `Error(Object, UnexpectedSize)`. Only a real
    // install against a deployed contract closes that gap. The list must
    // match `PolicyInstallParams` in contracts/policy-interpreter/src/types.rs.
    expect(fields).toEqual(['grammar_version', 'install_nonce', 'predicate', 'predicate_hash'])

    // The pointer sorted alphabetically by symbol string; str-equivalent keys
    // produce the contract's view of the struct. Sanity-check the values.
    const byField = Object.fromEntries(inner.map((e) => [e.key().sym().toString(), e.val()]))
    expect(byField.grammar_version?.switch().name).toBe('scvU32')
    // Must equal the contract's SELF_VERSION; a mismatch is refused at install.
    expect(byField.grammar_version?.u32()).toBe(2)
    expect(byField.install_nonce?.u32()).toBe(7)
    expect(byField.predicate?.switch().name).toBe('scvBytes')
    expect(byField.predicate_hash?.switch().name).toBe('scvBytes')
  })

  it('round-trips the predicate hash: sha256(encodedPredicate) matches predicateHash', () => {
    const args = buildAddContextRuleArgs(makeDraft(), defaults())
    const inner = args[4].map()?.[0]?.val().map()
    const predicate = inner?.find((e) => e.key().sym().toString() === 'predicate')?.val()
    const hash = inner?.find((e) => e.key().sym().toString() === 'predicate_hash')?.val()
    if (!predicate || !hash) throw new Error('test setup: missing predicate/hash entry')
    const bytes = Buffer.from(predicate.bytes())
    const computed = createHash('sha256').update(bytes).digest()
    expect(Buffer.from(hash.bytes()).equals(computed)).toBe(true)
  })

  it('encodes the policies map key as the interpreter Address', () => {
    const args = buildAddContextRuleArgs(makeDraft(), defaults())
    const key = args[4].map()?.[0]?.key()
    expect(Address.fromScAddress(key.address()).toString()).toBe(INTERPRETER)
  })
})

describe('buildAddContextRuleArgs - limit refusals', () => {
  it('refuses more than OZ_LIMITS.maxSignersPerRule signers', () => {
    const signers = Array.from({ length: OZ_LIMITS.maxSignersPerRule + 1 }, () => ({
      kind: 'delegated',
      address: Keypair.random().publicKey(),
    })) as SignerDraft[]
    let caught: { code?: string; message?: string } | null = null
    try {
      buildAddContextRuleArgs(makeDraft(), defaults({ signers }))
    } catch (e) {
      caught = e as { code?: string; message?: string }
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('INSTALL_BUILD_FAILED')
    expect(caught?.message).toMatch(/signers 16 exceed MAX_SIGNERS_PER_RULE 15/)
  })

  it('refuses more than OZ_LIMITS.maxPoliciesPerRule policies', () => {
    // We only have an `interpreter` policy today - the OZ-builtin path is
    // Phase 06 follow-up. Build a synthetic list of 6 interpreter refs
    // pointing at the same address: the cap is checked BEFORE the duplicate
    // guard, so this still trips the limit.
    const policies = Array.from({ length: OZ_LIMITS.maxPoliciesPerRule + 1 }, (_, _i) => ({
      kind: 'interpreter' as const,
      interpreterAddress: INTERPRETER,
      predicateBlobBase64: 'BBBB',
    })) as PolicyRef[]
    let caught: { code?: string; message?: string } | null = null
    try {
      buildAddContextRuleArgs(makeDraft(), defaults({ policies }))
    } catch (e) {
      caught = e as { code?: string; message?: string }
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('INSTALL_BUILD_FAILED')
    expect(caught?.message).toMatch(/policies 6 exceed MAX_POLICIES_PER_RULE 5/)
  })

  it('refuses a rule with no signers and no policies', () => {
    let caught: { code?: string; message?: string } | null = null
    try {
      buildAddContextRuleArgs(makeDraft(), defaults({ signers: [], policies: [] }))
    } catch (e) {
      caught = e as { code?: string; message?: string }
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('INSTALL_BUILD_FAILED')
    expect(caught?.message).toMatch(/no signers and no policies/)
  })

  it('refuses a predicateHash that does not match sha256(encodedPredicate)', () => {
    const { encodedPredicate } = makeEncodedPredicate()
    let caught: { code?: string; message?: string } | null = null
    try {
      buildAddContextRuleArgs(
        makeDraft(),
        defaults({
          encodedPredicate,
          // 32 bytes of 0x00 - a syntactically valid hex sha256, but no
          // predicate encodes to this hash.
          predicateHash: '00'.repeat(32),
        })
      )
    } catch (e) {
      caught = e as { code?: string; message?: string }
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('INSTALL_BUILD_FAILED')
    expect(caught?.message).toMatch(/does not match sha256/)
  })
})

describe('buildAddContextRuleArgs - structured field order is stable', () => {
  // The host orders map entries by the SYMBOL STRING, not by XDR bytes.
  // A regression here would have struct keys sorted by their XDR length
  // prefix and the contract would read the wrong field. Pin the order.

  it('struct field names sorted alphabetically by symbol string', () => {
    // Encode the same payload twice; the round-trip must match.
    const a = buildAddContextRuleArgs(makeDraft(), defaults())
    const b = buildAddContextRuleArgs(makeDraft(), defaults())
    const aFields = a[4]
      .map()?.[0]
      ?.val()
      .map()
      ?.map((e) => e.key().sym().toString())
    const bFields = b[4]
      .map()?.[0]
      ?.val()
      .map()
      ?.map((e) => e.key().sym().toString())
    expect(aFields).toEqual(bFields)
    // alphabetical, not length-prefixed
    expect(aFields).toEqual([...aFields].sort())
  })
})

describe('buildAddContextRuleArgs - OZ built-in policies', () => {
  const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
  const SPENDING_LIMIT = 'CDXDHCLOIZDLO63RLLU2Z6ICKZSA3MOYM3AYHU3LEXCGQSMXCMNDDEOF'

  const spendingLimitRef = {
    kind: 'oz_builtin',
    instanceAddress: SPENDING_LIMIT,
    primitive: {
      primitive: 'spending_limit',
      params: { spending_limit: '1500000000', period_ledgers: 17_280 },
    },
  } as unknown as PolicyRef

  it('emits a two-entry policy map for interpreter + OZ primitive', () => {
    const args = buildAddContextRuleArgs(
      makeDraft({ contextRuleType: { kind: 'call_contract', contract: XLM_SAC } }),
      defaults({ policies: [...defaults().policies, spendingLimitRef] })
    )
    expect(args[4].map()?.length).toBe(2)
  })

  it('encodes the params the deployed contract declares', () => {
    const args = buildAddContextRuleArgs(
      makeDraft({ contextRuleType: { kind: 'call_contract', contract: XLM_SAC } }),
      defaults({ policies: [spendingLimitRef] })
    )
    const fields = args[4]
      .map()?.[0]
      ?.val()
      .map()
      ?.map((e) => e.key().sym().toString())
    // SpendingLimitAccountParams, symbol-string ordered.
    expect(fields).toEqual(['period_ledgers', 'spending_limit'])
  })

  // spending_limit caps the CONTEXT CONTRACT, so a Default rule is refused
  // on chain with a bare #3227. Fail here with the reason instead.
  it('refuses a spending_limit on a rule that is not scoped to a contract', () => {
    expect(() =>
      buildAddContextRuleArgs(makeDraft(), defaults({ policies: [spendingLimitRef] }))
    ).toThrow(/call_contract-scoped/)
  })
})
