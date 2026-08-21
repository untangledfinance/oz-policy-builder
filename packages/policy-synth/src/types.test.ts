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
  type OZPrimitiveConfig,
  type ParseConfidence,
  type PolicyDocument,
  type PolicyRef,
  PREDICATE_CAPS,
  type PredicateLeaf,
  type PredicateNode,
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

describe('PredicateNode / PredicateLeaf', () => {
  it('accepts a deeply nested and-tree (sanity-build the AST shape)', () => {
    const leaf: PredicateLeaf = { kind: 'call_contract' }
    const node: PredicateNode = {
      op: 'and',
      children: [
        { op: 'or', children: [{ op: 'not', child: leaf }] },
        { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'call_arg', index: 0 } },
        {
          op: 'lt',
          left: { kind: 'call_arg', index: 1 },
          right: { kind: 'literal_i128', value: '1000' },
        },
        { op: 'in', needle: { kind: 'call_fn' }, haystack: [{ kind: 'call_fn' }] },
        { op: 'lte', left: { kind: 'now' }, right: { kind: 'literal_u32', value: 100 } },
        {
          op: 'gt',
          left: { kind: 'call_arg_len', index: 2 },
          right: { kind: 'literal_u32', value: 1 },
        },
        {
          op: 'gte',
          left: { kind: 'call_arg_field', index: 0, element: 0, field: 'amount' },
          right: { kind: 'literal_i128', value: '0' },
        },
      ],
    }
    expect(node.op).toBe('and')
    expect(node.children.length).toBe(7)
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
    const oz: OZPrimitiveConfig = { primitive: 'spending_limit', params: {} }
    const policyRefOz: PolicyRef = { kind: 'oz_builtin', primitive: oz, instanceAddress: 'COZ' }

    const rule: ContextRuleDraft = {
      contextRuleType: { kind: 'call_contract', contract: 'CCONTRACT' },
      name: 'swap-rule',
      validUntilLedger: null,
      signers: [signer],
      policies: [policyRef, policyRefOz],
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
      policyRefs: [policyRef, policyRefOz],
      parseConfidence: confidence,
      warnings: [],
      ambiguities: [ambiguity],
    }

    expect(proposed.contextRule.signers[0]?.kind).toBe('delegated')
    expect(proposed.policyDocuments[0]?.grammarVersion).toBe(GRAMMAR_VERSION)
    expect(proposed.policyRefs.length).toBe(2)
  })
})
