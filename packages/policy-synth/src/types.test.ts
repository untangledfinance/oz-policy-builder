import { describe, expect, it } from 'bun:test'
import {
  type AmbiguityCode,
  type AmbiguityPrompt,
  type ContextRuleDraft,
  type ContractInvocation,
  GRAMMAR_VERSION,
  type Network,
  type OnChainEvent,
  OZ_LIMITS,
  type ParseConfidence,
  type PolicyDocument,
  type PolicyRef,
  PREDICATE_CAPS,
  type ProposedPolicy,
  type RecordedTransaction,
  type ScVal,
  type SignerDraft,
  type TokenMovement,
} from './types.ts'

describe('OZ_LIMITS', () => {
  it('pins the verified OZ framework limits', () => {
    expect(OZ_LIMITS.maxPoliciesPerRule).toBe(5)
    expect(OZ_LIMITS.maxSignersPerRule).toBe(15)
  })
})

describe('PREDICATE_CAPS', () => {
  it('pins the predicate-document caps (single source of truth)', () => {
    expect(PREDICATE_CAPS.MAX_DEPTH).toBe(5)
    expect(PREDICATE_CAPS.MAX_LEAVES).toBe(200)
    expect(PREDICATE_CAPS.MAX_PREDICATE_BYTES).toBe(32 * 1024)
    expect(PREDICATE_CAPS.MAX_IN_OPERAND_COUNT).toBe(32)
  })
})

describe('Constructibility of full domain shapes', () => {
  it('builds a ProposedPolicy literal and shapes a RecordedTransaction', () => {
    const scVal: ScVal = { type: 'i128', value: '1000000' }
    const token: TokenMovement = { token: 'CABC', from: 'GFROM', to: 'GTO', amount: '1000000' }
    const evt: OnChainEvent = { contract: 'CCONTRACT', topics: ['topic'], data: scVal }
    const inv: ContractInvocation = {
      contract: 'CCONTRACT',
      fn: 'swap',
      args: [scVal],
      subInvocations: [],
    }

    const confidence: ParseConfidence = {
      overall: 1.0,
      knownContracts: ['CCONTRACT'],
      unknownContracts: [],
      opaqueScVals: [],
      thresholdUsed: 1.0,
    }

    const recorded: RecordedTransaction = {
      network: 'testnet' as Network,
      signers: ['GABC'],
      invocations: [inv],
      tokenMovements: [token],
      events: [evt],
      authEntries: [],
      ledgerSequence: 1,
      fetchedAt: Date.now(),
      parseConfidence: confidence,
      sourceAccount: 'GABC',
    }

    expect(recorded.invocations[0]?.fn).toBe('swap')
    expect(recorded.tokenMovements[0]?.amount).toBe('1000000')

    const signer: SignerDraft = { kind: 'delegated', address: 'GABC' }
    const policyRef: PolicyRef = {
      kind: 'interpreter',
      interpreterAddress: 'CINT',
      predicateBlobBase64: 'AAAA',
    }
    const rule: ContextRuleDraft = {
      contextRuleType: { kind: 'call_contract', contract: 'CCONTRACT' },
      name: 'swap-rule',
      validUntilLedger: null,
      signers: [signer],
      policies: [policyRef],
    }

    const doc: PolicyDocument = {
      grammarVersion: GRAMMAR_VERSION,
      installNonce: 1,
      encodedPredicate: 'AAAA',
      predicateHash: 'a'.repeat(64),
    }

    const ambiguity: AmbiguityPrompt = {
      code: 'DURATION_UNSPECIFIED' as AmbiguityCode,
      question: 'how long?',
    }

    const proposed: ProposedPolicy = {
      contextRule: rule,
      policyDocuments: [doc],
      policyRefs: [policyRef],
      parseConfidence: confidence,
      warnings: [],
      ambiguities: [ambiguity],
    }

    expect(proposed.contextRule.signers[0]?.kind).toBe('delegated')
    expect(proposed.policyDocuments[0]?.grammarVersion).toBe(GRAMMAR_VERSION)
    expect(proposed.policyRefs.length).toBe(1)
  })
})
