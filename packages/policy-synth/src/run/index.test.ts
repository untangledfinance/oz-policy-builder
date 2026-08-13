// Tests for the tool-body adapters in run/index.ts. The recorder core
// (recordTransaction) already returns structured {ok:false, error} for
// decoder/validation failures; this suite covers the OUTER envelope that
// catches unhandled throws from the SDK (e.g. a non-Error object thrown from
// a malformed-XDR helper). The contract: every escape must produce a
// structured ToolError whose message carries enough diagnostic detail to
// distinguish the failure from a generic crash.

import { describe, expect, it } from 'bun:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { PredicateNode, RecordedTransaction } from '../types.ts'
import {
  caughtError,
  runGetInterpreterInfo,
  runInstallPolicy,
  runSimulatePolicy,
  runSynthesizePolicy,
  runVerifyPolicy,
} from './index.ts'
import { PINNED_INTERPRETER_TESTNET_ADDRESS } from './schemas.ts'

describe('caughtError envelope (non-Error throw path)', () => {
  it('extracts a useful message from a non-Error object with a `message` field', () => {
    // The pre-fix code stringified this as "[object Object]" and the
    // message lost every diagnostic.
    const inner = { message: 'getTransaction failed: rpc 503', code: 'XDR_READ_ERR' }
    const te = caughtError('record_transaction', 'RECORDING_FAILED', inner)
    expect(te.code).toBe('RECORDING_FAILED')
    expect(te.message).toContain('getTransaction failed: rpc 503')
    expect(te.message).not.toContain('[object Object]')
  })

  it('survives a throwing object with a circular reference (no JSON.stringify infinite loop)', () => {
    const circular: Record<string, unknown> = { message: 'circular payload' }
    circular.self = circular
    const te = caughtError('record_transaction', 'RECORDING_FAILED', circular)
    expect(te.code).toBe('RECORDING_FAILED')
    // Must not crash; must carry a recognisable substring.
    expect(te.message).toContain('circular payload')
  })

  it('truncates a huge string-only payload to a bounded diagnostic', () => {
    const big = 'x'.repeat(50_000)
    const te = caughtError('record_transaction', 'RECORDING_FAILED', { message: big, code: 'BIG' })
    expect(te.code).toBe('RECORDING_FAILED')
    // The full 50_000-byte payload must NOT be in the message verbatim.
    expect(te.message.length).toBeLessThan(2000)
  })

  it('still passes through real Error instances with their message intact', () => {
    const e = new Error('decoder: unparseable XDR at offset 42')
    const te = caughtError('record_transaction', 'RECORDING_FAILED', e)
    expect(te.code).toBe('RECORDING_FAILED')
    expect(te.message).toContain('decoder: unparseable XDR at offset 42')
  })

  it('keeps the existing envelope shape (severity, retryable, remediation)', () => {
    const te = caughtError('record_transaction', 'RECORDING_FAILED', { message: 'x' })
    expect(te.severity).toBe('error')
    expect(te.retryable).toBe(false)
    expect(te.remediation?.toolCall?.name).toBe('record_transaction')
  })

  it('records a `thrown` details field for agent inspection', () => {
    const te = caughtError('synthesize_policy', 'SYNTHESIS_ERROR', { message: 'boom', code: 'X' })
    expect(te.details).toBeDefined()
    const s = JSON.stringify(te.details)
    expect(s).toContain('boom')
    expect(s).not.toContain('[object Object]')
  })

  it('omits `stack` from the serialized Error payload (no server-side trace leakage)', () => {
    const e = new Error('decode failed at offset 17')
    // Force a non-trivial stack so a leak would have a distinctive signature.
    e.stack = 'Error: decode failed at offset 17\n    at safeStringify (file.ts:1:1)'
    const te = caughtError('install_policy', 'INSTALL_BUILD_FAILED', e)
    const detailsJson = JSON.stringify(te.details)
    expect(detailsJson).not.toMatch(/\bstack\b/)
    // Defensive: the message IS carried, so the agent still has a useful signal.
    expect(detailsJson).toContain('decode failed at offset 17')
  })

  it('omits host/URL detail from the simulated-failure user-facing message', async () => {
    // Reproduce the actual path: runInstallPolicy on an unreachable RPC.
    // Pre-fix, build-install-policy.ts interpolated `recorded.error`
    // straight into the throw, so the resulting ToolError carried the
    // host:port + URL. Post-fix it throws a stable, host-agnostic
    // reason; the ToolError must reflect that.
    const { encodePredicate } = await import('../predicate/encode.ts')
    const pred = encodePredicate({
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'transfer' },
    })
    const sourceAccount = Keypair.random().publicKey()
    const res = await runInstallPolicy({
      smartAccount: 'CDEG66TYZB2RTKRSIEA4UTFMRXOYESCEQUKWS7R2JN357PJDSY272PFK',
      sourceAccount,
      rule: {
        contextRuleType: { kind: 'default' },
        name: 'p',
        validUntilLedger: null,
        signers: [{ kind: 'delegated', address: sourceAccount }],
        policies: [
          {
            kind: 'interpreter',
            interpreterAddress: PINNED_INTERPRETER_TESTNET_ADDRESS,
            predicateBlobBase64: pred.encodedPredicate,
          },
        ],
      },
      installNonce: 1,
      // http://127.0.0.1:1 - SDK has allowHttp:false, so the very first
      // HTTP request throws (the SDK refuses the http scheme). The path
      // hosts no server, and the failure is local - no real RPC replies
      // with an account-not-found error that would mask the test signal.
      rpcUrl: 'http://127.0.0.1:1/should-not-connect',
      allowUnpinnedRpcUrl: true,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    // The ToolError payload (top-level message + details JSON) must
    // contain no host:port or URL detail, and no `stack` field.
    expect(res.error.message).not.toMatch(/10\.0\.0\.7/)
    expect(res.error.message).not.toMatch(/example\.invalid/)
    expect(res.error.message).not.toMatch(/127\.0\.0\.1/)
    const detailsJson = JSON.stringify(res.error.details ?? {})
    expect(detailsJson).not.toMatch(/10\.0\.0\.7/)
    expect(detailsJson).not.toMatch(/example\.invalid/)
    expect(detailsJson).not.toMatch(/127\.0\.0\.1/)
    expect(detailsJson).not.toMatch(/\bstack\b/)
    // No `stack` key anywhere in the tool error payload (top-level or
    // nested details). The fix drops it from safeStringify's Error
    // serialiser.
    const payloadJson = JSON.stringify(res.error)
    expect(payloadJson).not.toMatch(/\bstack\b/)
  })
})

// ---------------------------------------------------------------------------
// runSimulatePolicy / runVerifyPolicy wrappers. The engines already return
// fail-closed `{ok:false, error}` envelopes; the wrappers' contract is to
// validate the wire input, dispatch to the engine, and tag any unhandled
// SDK throw with the right tool code. The fixtures below mirror the ones
// the engine tests use so the wrapper is exercised end-to-end on a known-
// good payload.
// ---------------------------------------------------------------------------

const SMART_ACCOUNT = 'CDEG66TYZB2RTKRSIEA4UTFMRXOYESCEQUKWS7R2JN357PJDSY272PFK'
const TOKEN = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVON'

const SAMPLE_PREDICATE: PredicateNode = {
  op: 'and',
  children: [
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: TOKEN },
    },
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'transfer' },
    },
  ],
}

function recordedTx(): RecordedTransaction {
  return {
    network: 'mainnet',
    signers: [OWNER],
    invocations: [
      {
        contract: TOKEN,
        fn: 'transfer',
        args: [
          { type: 'address', value: OWNER },
          { type: 'address', value: OWNER },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: TOKEN, from: OWNER, to: OWNER, amount: '1000000000' }],
    events: [],
    authEntries: [],
    ledgerSequence: 1_000_000,
    fetchedAt: 1_700_000_000,
    parseConfidence: {
      overall: 1,
      knownContracts: [],
      unknownContracts: [],
      opaqueScVals: [],
      thresholdUsed: 1,
    },
    sourceAccount: OWNER,
  }
}

describe('runSimulatePolicy - envelope', () => {
  it('returns {ok:true} on a valid predicate + permitTx', async () => {
    const res = await runSimulatePolicy({ predicate: SAMPLE_PREDICATE, permitTx: recordedTx() })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.permit).toEqual({ tx: 'permit' })
    expect(res.data.backend).toBe('ts-model')
  })

  it('accepts a null predicate (OZ-only policy)', async () => {
    const res = await runSimulatePolicy({ predicate: null, permitTx: recordedTx() })
    expect(res.ok).toBe(true)
  })

  it('returns {ok:false} with SIMULATION_ERROR on a malformed predicate', async () => {
    const res = await runSimulatePolicy({
      // The schema rejects this BEFORE the engine ever sees it; the
      // wrapper converts the failure into a structured ToolError under
      // the simulate_policy code.
      predicate: { op: 'xor', children: [] },
      permitTx: recordedTx(),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
    expect(res.error.message).toContain('simulate_policy')
    expect(res.error.remediation?.toolCall?.name).toBe('simulate_policy')
  })

  it('returns {ok:false} with SIMULATION_ERROR when permitTx is missing', async () => {
    const res = await runSimulatePolicy({ predicate: SAMPLE_PREDICATE })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('SIMULATION_ERROR')
  })
})

describe('runVerifyPolicy - envelope', () => {
  it('returns {ok:true} on a minimal predicate (no over-broad conjuncts)', async () => {
    const res = await runVerifyPolicy({ predicate: SAMPLE_PREDICATE, permitTx: recordedTx() })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toBe(true)
  })

  it('returns {ok:false} with VERIFICATION_FAILED on an over-broad predicate', async () => {
    // The minimal predicate PLUS a duplicate `call_fn` conjunct. The
    // minimizer drops the duplicate (the recorded call already satisfies
    // ONE `call_fn == transfer` conjunct); the wrapper surfaces
    // VERIFICATION_FAILED with the dropped constraint in `details`.
    const overBroad: PredicateNode = {
      op: 'and',
      children: [
        SAMPLE_PREDICATE.children[0] as PredicateNode,
        SAMPLE_PREDICATE.children[1] as PredicateNode,
        // Duplicate `call_fn` conjunct - load-bearing-free.
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'transfer' },
        },
      ],
    }
    const res = await runVerifyPolicy({ predicate: overBroad, permitTx: recordedTx() })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    // The engine surfaces the dropped constraints in details.droppedConstraints.
    const details = res.error.details as { droppedConstraints?: string[] } | undefined
    expect(details?.droppedConstraints?.length).toBeGreaterThan(0)
  })

  it('returns {ok:false} with VERIFICATION_FAILED on a malformed predicate', async () => {
    const res = await runVerifyPolicy({
      predicate: { kind: 'call_contract' } as unknown as PredicateNode,
      permitTx: recordedTx(),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
    expect(res.error.message).toContain('verify_policy')
  })

  it('returns {ok:false} with VERIFICATION_FAILED when the predicate is null', async () => {
    // The schema rejects a null predicate for verify_policy (the engine
    // requires one); the wrapper surfaces the validation failure under
    // the verify_policy code.
    const res = await runVerifyPolicy({
      predicate: null as unknown as PredicateNode,
      permitTx: recordedTx(),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('VERIFICATION_FAILED')
  })
})

// The tools were individually correct and still could not be chained: a
// ProposedPolicy carries `policyDocuments[].encodedPredicate` (ScVal bytes),
// while simulate/verify want the PredicateNode TREE, and the tree only comes
// back under `explain`. Unit tests on each tool passed throughout and said
// nothing about whether step 2's output can reach step 3's input, so this
// asserts the join rather than the parts.
// The shared OWNER / TOKEN above are placeholders that never reach an address
// decoder, which is fine for the OZ-only paths. Compiling an interpreter
// predicate DOES decode them and rejects a placeholder as an unsupported
// address type, so the chain tests carry real-format strkeys.
const CHAIN_OWNER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ'
const CHAIN_TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

function chainRecordedTx(): RecordedTransaction {
  return {
    ...recordedTx(),
    signers: [CHAIN_OWNER],
    sourceAccount: CHAIN_OWNER,
    invocations: [
      {
        contract: CHAIN_TOKEN,
        fn: 'transfer',
        args: [
          { type: 'address', value: CHAIN_OWNER },
          { type: 'address', value: CHAIN_OWNER },
          { type: 'i128', value: '1000000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [
      { token: CHAIN_TOKEN, from: CHAIN_OWNER, to: CHAIN_OWNER, amount: '1000000000' },
    ],
  }
}

describe('synthesize -> simulate/verify chain', () => {
  it('hands the predicate tree from synthesize into both checks', async () => {
    const synth = await runSynthesizePolicy({
      source: 'recording',
      recordedTx: chainRecordedTx(),
      network: 'mainnet',
      // Both are required for a tree to exist: `interpreter` engages the
      // adapter that builds one, `explain` returns it. Drop either and the
      // OZ-only path yields `predicateTree: null` and nothing downstream is
      // provable.
      interpreter: { smartAccountAddress: SMART_ACCOUNT },
      explain: true,
    })
    expect(synth.ok).toBe(true)
    const tree = (synth as { explain?: { predicateTree: PredicateNode | null } }).explain
      ?.predicateTree
    expect(tree).not.toBeNull()
    expect(tree).toBeDefined()

    const simulated = await runSimulatePolicy({ predicate: tree, permitTx: chainRecordedTx() })
    expect(simulated.ok).toBe(true)

    const verified = await runVerifyPolicy({ predicate: tree, permitTx: chainRecordedTx() })
    expect(verified.ok).toBe(true)
  })

  it('yields no tree when the interpreter adapter is not engaged', async () => {
    const synth = await runSynthesizePolicy({
      source: 'recording',
      recordedTx: recordedTx(),
      network: 'mainnet',
      explain: true,
    })
    expect(synth.ok).toBe(true)
    const explain = (synth as { explain?: { predicateTree: PredicateNode | null } }).explain
    // Not an error - the OZ-only path has no predicate to explain. Asserted so
    // the null is understood as the documented outcome rather than a
    // regression in the chain above.
    expect(explain?.predicateTree).toBeNull()
  })
})

// TS-F3: get_interpreter_info must enforce the RPC pin when verifyLive is
// true. The live grammar_version() call's answer binds to whichever RPC
// returned it, so a non-pinned URL would silently bind the caller to a
// host they picked. Mirrors the install/revoke pin enforcement.
describe('runGetInterpreterInfo - RPC pin enforcement (TS-F3)', () => {
  it('refuses a non-pinned rpcUrl when verifyLive is true', async () => {
    const res = await runGetInterpreterInfo({
      network: 'testnet',
      verifyLive: true,
      rpcUrl: 'https://attacker.example.com/soroban',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('RECORDING_FAILED')
    expect(res.error.message).toMatch(/rpcUrl must equal the pinned/)
    expect(res.error.remediation?.toolCall?.name).toBe('get_interpreter_info')
  })

  it('accepts a non-pinned rpcUrl when allowUnpinnedRpcUrl is true (opt-in path)', async () => {
    // The opt-in clears the gate, so the failure shifts to the live call
    // itself (the fake URL does not answer). The point of this test is to
    // prove the pin gate, NOT the network call: we do not assert the
    // outbound call succeeds - it cannot against a fake URL - we only
    // assert the error is not the pin-enforcement error.
    const res = await runGetInterpreterInfo({
      network: 'testnet',
      verifyLive: true,
      rpcUrl: 'https://attacker.example.com/soroban',
      allowUnpinnedRpcUrl: true,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.message).not.toMatch(/rpcUrl must equal the pinned/)
  })

  it('does NOT enforce the pin when verifyLive is false (no outbound call)', async () => {
    // The pin only matters when the live RPC call is engaged; the static
    // fingerprint branch is local data. A non-pinned URL with verifyLive
    // unset must NOT be rejected - it never reaches the network.
    const res = await runGetInterpreterInfo({
      network: 'testnet',
      rpcUrl: 'https://attacker.example.com/soroban',
    })
    expect(res.ok).toBe(true)
  })
})
