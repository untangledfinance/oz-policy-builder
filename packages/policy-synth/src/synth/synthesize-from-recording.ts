// src/synth/synthesize-from-recording.ts - recording-path orchestrator.
//
// `synthesizeFromRecording` INFERS a bounded policy from a `RecordedTransaction`
// via the same `PolicyIR` + adapter pair used by the deterministic Mandate path.
// Flow: validate -> parseConfidence gate -> lower -> decideScope -> composeFromRecording
// -> OZ compile -> (opt-in) interpreter compile + self-verify + minimise -> merge.
// Same (tx, opts, ozConfig) -> byte-identical ProposedPolicy (no randomness, clock, globals).

import type { InterpreterAdapterConfig } from '../adapters/interpreter/adapter.ts'
import {
  createInterpreterAdapter,
  lowerRuleToPredicate,
  PLACEHOLDER_INTERPRETER_ADDRESS,
} from '../adapters/interpreter/adapter.ts'
import type { OzAdapterConfig } from '../adapters/oz/adapter.ts'
import { createOzAdapter } from '../adapters/oz/adapter.ts'
import type { ToolError, ToolResponse } from '../errors.ts'
import { encodePredicate } from '../predicate/encode.ts'
import {
  type ContractInvocation,
  MAX_SCVAL_CLONE_DEPTH,
  type Network,
  OZ_LIMITS,
  type PredicateLeaf,
  type PredicateNode,
  type ProposedPolicy,
  type RecordedTransaction,
  SOROBAN_LIMITS,
} from '../types.ts'
import type { SimulationResult } from '../verify/envelope.ts'
import {
  type ComposeOptions,
  type ComposeUserResponses,
  composeFromRecording,
} from './compose-from-recording.ts'
import { generateCases, ORIGINAL_DIMENSIONS } from './deny-cases.ts'
import { type EvalContext, evaluate } from './evaluate.ts'
import { runHarness } from './harness.ts'
import { lower } from './lower.ts'
import { minimize } from './minimize.ts'
import { decideScope, type ScopeDecision } from './scope.ts'

const UNCOVERED_PREFIX = 'Not covered by OZ built-in primitives: '

/** Per-policy interpreter adapter config the caller opts into. Absent ->
 *  recording path runs in week-1 mode (OZ adapter only, warnings for the
 *  constraints OZ cannot express). */
export interface InterpreterAdapterOptions {
  /** The smart account this interpreter policy will be installed against.
   *  Must be a C... contract address - the on-chain policy-bound account.
   *  The G... source account from the recording is a separate concept. */
  smartAccountAddress: string
  /** Per-rule install nonce (first install = 1). Defaults to 1. */
  installNonce?: number
}

/** PRIVATE test-only extension of `InterpreterAdapterOptions` for the
 *  `__testPredicateNode` seam. Exported under a `__` prefix so production
 *  callers can grep for it and see it is a test hook. The seam is read in
 *  `synthesizeFromRecordingInner` only when `process.env.NODE_ENV === 'test'`
 *  - a hard RUNTIME guard throws otherwise so a misconfigured production
 *  caller cannot bypass the recording -> interpreter adapter compile path. */
export type __TestInterpreterAdapterOptions = InterpreterAdapterOptions & {
  /** @internal Test-only seam. Throws at runtime when NODE_ENV !== 'test'. */
  __testPredicateNode?: PredicateNode
}

/** Top-level orchestrator inputs. */
export interface SynthesizeFromRecordingOptions {
  network: Network
  userResponses?: ComposeUserResponses
  confidenceOverride?: { threshold: number }
  interpreter?: InterpreterAdapterOptions
  /** --explain opt-in. The flag is ADDITIVE: existing ProposedPolicy fields are
   *  never altered by enabling explain. Absent -> success envelope is byte-identical. */
  explain?: true
}

export function synthesizeFromRecording(
  tx: RecordedTransaction,
  opts: SynthesizeFromRecordingOptions,
  ozConfig: OzAdapterConfig
): ToolResponse<ProposedPolicy> & {
  /** Present iff `opts.explain === true` and the synthesis succeeded. The
   *  `predicateTree` is the exact in-memory `PredicateNode` (canonical
   *  JSON shape) that was encoded into `proposed.policyDocuments[*].encodedPredicate`
   *  - reading the predicate tree from the policy document is therefore
   *  unnecessary; the orchestrator carries it through. The `simulation`
   *  is the verdict produced by the same self-verify pipeline that already
   *  runs in the recording path (runHarness + evaluate), so the value is
   *  REAL not synthetic. Absent when the synthesis did not engage the
   *  interpreter (no interpreter opts supplied) - in that case the CLI
   *  builds a minimal honest SimulationResult downstream. */
  explain?: {
    predicateTree: PredicateNode | null
    simulation: SimulationResult
  }
} {
  // Convert any ToolError-shaped throw (object with a string `.code`) to a
  // structured `{ok:false, error}`; anything else is rethrown so genuine bugs
  // crash instead of being silently swallowed. Wraps the entire body so
  // cap errors (PREDICATE_TOO_DEEP, TOO_MANY_LEAVES) and cloneScVal depth
  // throws surface as structured ToolErrors rather than RangeErrors.
  try {
    return synthesizeFromRecordingInner(tx, opts, ozConfig)
  } catch (e) {
    if (isToolErrorShape(e)) {
      return {
        ok: false,
        error: {
          code: e.code as ToolError['code'],
          message: e.message,
          severity: 'error',
          retryable: false,
        },
      }
    }
    throw e
  }
}

/** True when `e` is a ToolError-shaped throw (object with a string `code`).
 *  Detected by string `code` field — the only contract the body's internal
 *  helpers agree on. */
function isToolErrorShape(e: unknown): e is { code: string; message: string } {
  if (e === null || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  const message = (e as { message?: unknown }).message
  return typeof code === 'string' && typeof message === 'string'
}

/** ToolError-shaped error helper used by the body to surface a structured
 *  failure that the envelope converts to `{ok:false, error}`. */
function throwToolError(code: ToolError['code'], message: string): never {
  const err = new Error(message) as Error & { code: string; severity: string; retryable: boolean }
  err.code = code
  err.severity = 'error'
  err.retryable = false
  throw err
}

function synthesizeFromRecordingInner(
  tx: RecordedTransaction,
  opts: SynthesizeFromRecordingOptions,
  ozConfig: OzAdapterConfig
): ToolResponse<ProposedPolicy> & {
  explain?: {
    predicateTree: PredicateNode | null
    simulation: SimulationResult
  }
} {
  // 0. validate inputs (fail closed - never synthesize from garbage).
  const invalid = validateOptions(opts)
  if (invalid) return { ok: false, error: invalid }

  // 0a. per-movement amount validation. Reject malformed recordings here so
  //     the downstream `BigInt(m.amount)` in `buildPermitContext` cannot throw
  //     a SyntaxError past the envelope.
  for (const [i, m] of tx.tokenMovements.entries()) {
    if (!/^[0-9]+$/.test(m.amount)) {
      return {
        ok: false,
        error: {
          code: 'RECORDING_VALIDATION_FAILED',
          message: `tokenMovements[${i}].amount must be a positive decimal integer string, got: ${m.amount}`,
          severity: 'error',
          retryable: false,
        },
      }
    }
  }

  // 1. parseConfidence gate.
  const threshold = opts.confidenceOverride?.threshold ?? tx.parseConfidence.thresholdUsed
  if (tx.parseConfidence.overall < threshold) {
    return {
      ok: false,
      error: {
        code: 'RECORDING_VALIDATION_FAILED',
        message: `parseConfidence ${tx.parseConfidence.overall} < threshold ${threshold}`,
        severity: 'error',
        retryable: false,
        details: tx.parseConfidence,
      },
    }
  }

  // 1a. Zero-invocation refusal. A recording with zero invocations clears
  //     parseConfidence legitimately (denom === 0 short-circuits overall to 1.0),
  //     but a policy must scope to an authorized contract call. Refuse early.
  const hasNoInvocations = tx.parseConfidence.noInvocations === true || tx.invocations.length === 0
  if (hasNoInvocations) {
    return {
      ok: false,
      error: {
        code: 'SYNTHESIS_ERROR',
        message:
          'Recording contains no contract invocation to scope a policy to. Re-record a transaction that invokes a Soroban contract function (e.g. an SAC/SEP-41 transfer, a Blend yield-claim, or a SoroSwap swap).',
        severity: 'error',
        retryable: false,
        details: {
          invocations: tx.invocations.length,
          noInvocationsMarker: tx.parseConfidence.noInvocations === true,
        },
      },
    }
  }

  // Bound the recording size fail-closed (defense-in-depth for direct callers;
  // the MCP schema caps this too).
  if (tx.invocations.length > SOROBAN_LIMITS.maxInvocations) {
    return {
      ok: false,
      error: {
        code: 'RECORDING_VALIDATION_FAILED',
        message: `recorded transaction has ${tx.invocations.length} invocations, exceeding the cap of ${SOROBAN_LIMITS.maxInvocations}`,
        severity: 'error',
        retryable: false,
      },
    }
  }

  const facts = lower(tx)

  const scopeRes = decideScope(facts, {
    network: opts.network,
    ...(opts.userResponses?.validUntilLedger !== undefined
      ? { validUntilLedger: opts.userResponses.validUntilLedger }
      : {}),
  })
  if (!scopeRes.ok) return scopeRes
  const scope: ScopeDecision = scopeRes.data
  if (scope.kind !== 'call_contract') {
    return {
      ok: false,
      error: {
        code: 'SYNTHESIS_ERROR',
        message: 'recording path requires a scoped contract; no default-scoped policies emitted',
        severity: 'error',
        retryable: false,
      },
    }
  }

  // 4. compose.
  const topLevel = tx.invocations[0] ?? null
  const composeOpts: ComposeOptions = {
    network: opts.network,
    interpreterEnabled: opts.interpreter !== undefined,
    ...(opts.userResponses !== undefined ? { userResponses: opts.userResponses } : {}),
  }
  const composed = composeFromRecording(facts, scope.contract, topLevel, composeOpts)

  // --explain hook: capture the in-memory predicate tree + the real
  // self-verify verdict (built from the SAME runHarness + evaluate that gated
  // the synthesis, not a parallel simulation).
  let explain: PredicateNode | null = null
  let explainSim: SimulationResult | null = null

  // 5. OZ compile (always runs).
  const ozAdapter = createOzAdapter(ozConfig)
  const compileRes = ozAdapter.compile(composed.ir)

  if (!compileRes.proposed) {
    return {
      ok: false,
      error: {
        code: 'SYNTHESIS_ERROR',
        message: `recording lowered to no installable OZ policy: ${compileRes.uncovered.join('; ')}`,
        severity: 'error',
        retryable: false,
        details: { uncovered: compileRes.uncovered },
      },
    }
  }

  // 6. Interpreter compile (opt-in; fail-closed when the user routed real
  //    restrictions to the interpreter).
  const interpreterOpts = opts.interpreter

  let interpreterPolicyDocument: ProposedPolicy['policyDocuments'][number] | null = null
  let interpreterPolicyRef: ProposedPolicy['policyRefs'][number] | null = null
  // Cross-layer L3: declared OUTSIDE the `if (interpreterOpts)` block so the
  // warnings folded into `proposed.warnings[]` (which lives after that block)
  // can read it. The block assigns it; the default is empty.
  let permitCtxWarnings: string[] = []

  if (interpreterOpts) {
    const interpreterConfig: InterpreterAdapterConfig = {
      network: opts.network,
      installNonce: interpreterOpts.installNonce ?? 1,
      smartAccountAddress: interpreterOpts.smartAccountAddress,
    }

    let startingPredicate: PredicateNode | null = null
    // `__testPredicateNode` is a test-only seam. It is NOT in the public
    // `InterpreterAdapterOptions` type, so a production caller cannot set it
    // without bypassing the type system. We read it via a private cast and
    // enforce a runtime NODE_ENV check so a misconfigured production caller
    // that smuggles it in (any-cast, JSON-driven opt, etc.) is caught here
    // rather than silently overriding the compiled predicate.
    const testSeam = (interpreterOpts as __TestInterpreterAdapterOptions).__testPredicateNode
    if (testSeam !== undefined) {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error(
          'synthesizeFromRecording: __testPredicateNode is a test-only seam and is refused outside NODE_ENV=test'
        )
      }
      startingPredicate = testSeam
    } else {
      const interpreterAdapter = createInterpreterAdapter(interpreterConfig)

      let interpreterRes: Awaited<ReturnType<typeof interpreterAdapter.compile>>
      try {
        interpreterRes = interpreterAdapter.compile(composed.interpreterIr)
      } catch (e) {
        const code = (e as { code?: ToolError['code'] }).code
        const allowedCodes: ToolError['code'][] = [
          'SCOPE_SELF_CALL',
          'MALFORMED_PREDICATE',
          'PREDICATE_TOO_LARGE',
          'PREDICATE_TOO_DEEP',
          'TOO_MANY_LEAVES',
          'IN_OPERAND_LIMIT',
        ]
        const surfacedCode = code && allowedCodes.includes(code) ? code : 'SYNTHESIS_ERROR'
        return {
          ok: false,
          error: {
            code: surfacedCode,
            message: `interpreter predicate could not be compiled: ${(e as Error).message}`,
            severity: 'error',
            retryable: false,
          },
        }
      }

      if (!interpreterRes.covered) {
        return {
          ok: false,
          error: {
            code: 'SYNTHESIS_ERROR',
            message: `interpreter predicate is not fully covered: ${interpreterRes.uncovered.join('; ')}`,
            severity: 'error',
            retryable: false,
            details: { uncovered: interpreterRes.uncovered },
          },
        }
      }

      if (!interpreterRes.proposed) {
        return {
          ok: false,
          error: {
            code: 'SYNTHESIS_ERROR',
            message: 'interpreter adapter returned no installable policy',
            severity: 'error',
            retryable: false,
          },
        }
      }

      interpreterPolicyDocument = interpreterRes.proposed.policyDocuments[0] ?? null
      interpreterPolicyRef = interpreterRes.proposed.policyRefs[0] ?? null
      if (!interpreterPolicyDocument || !interpreterPolicyRef) {
        return {
          ok: false,
          error: {
            code: 'SYNTHESIS_ERROR',
            message: 'interpreter adapter returned a policy missing the document or ref',
            severity: 'error',
            retryable: false,
          },
        }
      }

      const firstInterpreterRule = composed.interpreterIr.rules[0]
      if (!firstInterpreterRule) {
        return {
          ok: false,
          error: {
            code: 'SYNTHESIS_ERROR',
            message: 'interpreter IR has no rules to lower',
            severity: 'error',
            retryable: false,
          },
        }
      }
      startingPredicate = lowerRuleToPredicate(firstInterpreterRule, interpreterConfig)
    }

    if (!startingPredicate) {
      return {
        ok: false,
        error: {
          code: 'SYNTHESIS_ERROR',
          message: 'interpreter predicate was not derived',
          severity: 'error',
          retryable: false,
        },
      }
    }

    // 6b. Self-verify + minimise.
    if (!topLevel) {
      return {
        ok: false,
        error: {
          code: 'SYNTHESIS_ERROR',
          message: 'self-verify requires a recorded top-level invocation',
          severity: 'error',
          retryable: false,
        },
      }
    }
    if (scope.kind !== 'call_contract') {
      return {
        ok: false,
        error: {
          code: 'SYNTHESIS_ERROR',
          message: 'self-verify requires a call_contract scope',
          severity: 'error',
          retryable: false,
        },
      }
    }
    // Cross-layer L3: warnings collected from `buildPermitContext` (currently
    // policy's `warnings[]` so the caller sees them on the success envelope.
    const permitCtxResult = buildPermitContext(
      tx,
      scope,
      topLevel,
      opts.userResponses,
      startingPredicate
    )
    const permitCtx = permitCtxResult.ctx
    permitCtxWarnings = permitCtxResult.warnings

    const finalPredicate: PredicateNode =
      startingPredicate.op === 'and'
        ? minimize(startingPredicate, permitCtx, ORIGINAL_DIMENSIONS)
        : startingPredicate

    const harnessCases = generateCases(finalPredicate, permitCtx, ORIGINAL_DIMENSIONS)
    const harnessResult = runHarness(finalPredicate, harnessCases)
    if (!harnessResult.ok) {
      return {
        ok: false,
        error: {
          code: 'DENY_CASE_FAILURE',
          message: `self-verify harness failed for the interpreter predicate (${harnessResult.failures.length} failure(s))`,
          severity: 'error',
          retryable: false,
          details: { failures: harnessResult.failures },
        },
      }
    }
    const evalResult = evaluate(finalPredicate, permitCtx)
    if (!evalResult.permit) {
      return {
        ok: false,
        error: {
          code: 'DENY_CASE_FAILURE',
          message: `intended recorded call was denied by the interpreter predicate: ${evalResult.reason}`,
          severity: 'error',
          retryable: false,
          details: { reason: evalResult.reason },
        },
      }
    }

    // --explain capture: quote the SAME verdict that gated the synthesis.
    // Re-evaluate each deny case to surface its concrete reason (the harness
    // only records whether the got-matches-expected boundary held).
    if (opts.explain) {
      explain = finalPredicate
      const evaluatedCases: SimulationResult['evaluatedCases'] = [
        {
          dimension: 'permit',
          outcome: evalResult.permit ? 'permit' : 'deny',
          reason: 'matches recorded call',
        },
      ]
      for (const deny of harnessCases.denies) {
        const r = evaluate(finalPredicate, deny.ctx)
        evaluatedCases.push({
          dimension: deny.dimension,
          outcome: r.permit ? 'permit' : 'deny',
          reason: r.permit ? 'no matching deny' : r.reason,
        })
      }
      explainSim = {
        permit: { tx: 'permit' },
        evaluatedCases,
        backend: 'ts-model',
        simulatorVersion: 'ts-model-1.0.0',
      }
    }

    // 6c. Re-encode the (possibly minimised) PredicateNode and stamp the
    //     canonical bytes back onto the PolicyDocument + PolicyRef. Cap breaches
    //     (PREDICATE_TOO_DEEP, TOO_MANY_LEAVES) throw ToolError-shaped errors;
    //     the outer envelope converts them to structured `{ok:false, error}`.
    const { encodedPredicate, predicateHash } = encodePredicate(finalPredicate)

    if (testSeam !== undefined) {
      interpreterPolicyDocument = {
        grammarVersion: 1,
        installNonce: interpreterOpts.installNonce ?? 1,
        encodedPredicate,
        predicateHash,
      }
      interpreterPolicyRef = {
        kind: 'interpreter',
        interpreterAddress: PLACEHOLDER_INTERPRETER_ADDRESS,
        predicateBlobBase64: encodedPredicate,
      }
    } else {
      if (!interpreterPolicyDocument || !interpreterPolicyRef) {
        return {
          ok: false,
          error: {
            code: 'SYNTHESIS_ERROR',
            message: 'interpreter policy document or ref was lost before re-encode',
            severity: 'error',
            retryable: false,
          },
        }
      }
      interpreterPolicyDocument = {
        ...interpreterPolicyDocument,
        encodedPredicate,
        predicateHash,
      }
      if (interpreterPolicyRef.kind === 'interpreter') {
        interpreterPolicyRef = {
          ...interpreterPolicyRef,
          predicateBlobBase64: encodedPredicate,
        }
      }
    }
  }

  // When the interpreter succeeds, OZ-side `uncovered` warnings that the
  // interpreter actually lowered are misleading: OZ really did not lower them,
  // but the interpreter did. Drop those so the user-facing warnings reflect
  // what is still UN-enforced, not what OZ alone could not do.
  const ozUncovered = interpreterPolicyRef
    ? compileRes.uncovered.filter((u) => !INTERPRETER_COVERED_OZ_PATTERN.test(u))
    : compileRes.uncovered

  // 7. Merge into the OZ-shaped ProposedPolicy.
  const ozRefs = compileRes.proposed.policyRefs
  const mergedRefs: ProposedPolicy['policyRefs'] = []
  if (interpreterPolicyRef) mergedRefs.push(interpreterPolicyRef)
  for (const r of ozRefs) mergedRefs.push(r)

  if (mergedRefs.length > OZ_LIMITS.maxPoliciesPerRule) {
    return {
      ok: false,
      error: {
        code: 'POLICY_CAP_EXCEEDED',
        message: `merged policy count ${mergedRefs.length} exceeds OZ maxPoliciesPerRule (${OZ_LIMITS.maxPoliciesPerRule})`,
        severity: 'error',
        retryable: false,
      },
    }
  }

  const mergedContextRule = {
    ...compileRes.proposed.contextRule,
    policies: mergedRefs,
  }

  // When nothing installable was synthesised (no interpreter doc AND no OZ
  // policy refs), an empty `policies` array reads as "no restrictions" rather
  // than "I synthesised nothing". Surface that explicitly so the empty result
  // is never mistaken for a permissive policy.
  const zeroPolicyWarning =
    mergedRefs.length === 0 && !interpreterPolicyDocument
      ? [
          'No policy constraints were synthesised: the call to this contract is UNCONSTRAINED by this policy. Enable the interpreter (supply a smart account) to enforce the surfaced constraints.',
        ]
      : []

  const proposed: ProposedPolicy = {
    contextRule: mergedContextRule,
    policyDocuments: interpreterPolicyDocument ? [interpreterPolicyDocument] : [],
    policyRefs: mergedRefs,
    parseConfidence: { ...tx.parseConfidence },
    warnings: [
      ...zeroPolicyWarning,
      ...ozUncovered.map((u) => `${UNCOVERED_PREFIX}${u}`),
      ...composed.warnings.map((w) => `${UNCOVERED_PREFIX}${w}`),
      ...permitCtxWarnings,
    ],
    ambiguities: mergeAmbiguities(composed.ambiguities, scope.ambiguities),
  }
  // --explain success envelope. When opts.explain is set and the OZ-only
  // path ran, construct the minimal honest SimulationResult: the verdict
  // is NOT a passing simulation - the interpreter was never engaged, so
  // permit is deny with a truthful reason and evaluatedCases is empty.
  const envelope: ToolResponse<ProposedPolicy> & {
    explain?: {
      predicateTree: PredicateNode | null
      simulation: SimulationResult
    }
  } = { ok: true, data: proposed }
  if (opts.explain) {
    if (explainSim) {
      envelope.explain = { predicateTree: explain, simulation: explainSim }
    } else {
      envelope.explain = {
        predicateTree: null,
        simulation: {
          permit: {
            tx: 'deny',
            reason: 'No self-verification was performed (interpreter adapter was not engaged)',
          },
          evaluatedCases: [],
          backend: 'ts-model',
          simulatorVersion: 'not-run',
        },
      }
    }
  }
  return envelope
}

export { throwToolError }

/** OZ-side `uncovered` warning patterns the interpreter adapter actually lowers
 *  when wired in. When the interpreter adapter succeeds, matching entries are
 *  dropped from the OZ uncovered list so user-facing warnings reflect what is
 *  still UN-enforced rather than what OZ alone could not do. Matches the
 *  exact descriptor strings the OZ adapter emits (see `src/adapters/oz/adapter.ts`
 *  `describeCondition` / `describeSelector`). */
const INTERPRETER_COVERED_OZ_PATTERN =
  /^per-method scoping to|^value allowlist on arg|^exact ordered sequence on arg|^invocation-count window|^spending_limit on token .+ needs a CallContract context scoped to that token/

/** Reject non-sane inputs before any policy is synthesized. windowSeconds /
 *  validUntilLedger / invocationLimit must be positive integers; limitAmount a
 *  positive i128 decimal string; network mainnet|testnet. When the interpreter
 *  adapter is opted in, `smartAccountAddress` must be a C... contract address
 *  (the on-chain policy-bound account, NOT the G... source account),
 *  tighten-only vs the wasm defaults. */
function validateOptions(opts: SynthesizeFromRecordingOptions): ToolError | null {
  if (opts.network !== 'mainnet' && opts.network !== 'testnet') {
    return synthesisError(`network must be 'mainnet' or 'testnet', got: ${String(opts.network)}`)
  }
  // A confidenceOverride outside [0, 1] would disable the recorder gate (a
  // negative threshold can never be exceeded), so reject it fail-closed.
  const co = opts.confidenceOverride?.threshold
  if (co !== undefined && (!Number.isFinite(co) || co < 0 || co > 1)) {
    return synthesisError(
      `confidenceOverride.threshold must be a finite number within [0, 1], got: ${co}`
    )
  }
  const ur = opts.userResponses
  if (ur) {
    if (ur.windowSeconds !== undefined && !isPositiveInt(ur.windowSeconds)) {
      return synthesisError(`windowSeconds must be a positive integer, got: ${ur.windowSeconds}`)
    }
    if (
      ur.validUntilLedger !== undefined &&
      (!isPositiveInt(ur.validUntilLedger) || ur.validUntilLedger > SOROBAN_LIMITS.u32Max)
    ) {
      return synthesisError(
        `validUntilLedger must be a positive u32 ledger sequence (<= ${SOROBAN_LIMITS.u32Max}), got: ${ur.validUntilLedger}`
      )
    }
    if (ur.invocationLimit !== undefined && !isPositiveInt(ur.invocationLimit)) {
      return synthesisError(
        `invocationLimit must be a positive integer, got: ${ur.invocationLimit}`
      )
    }
    if (ur.limitAmount !== undefined && !isPositiveI128(ur.limitAmount)) {
      return synthesisError(
        `limitAmount must be a positive i128 decimal string within [1, ${I128_MAX}] (2^127-1), got: ${ur.limitAmount}`
      )
    }
  }
  if (opts.interpreter) {
    const sa = opts.interpreter.smartAccountAddress
    if (typeof sa !== 'string' || sa.length === 0) {
      return synthesisError(
        `interpreter.smartAccountAddress must be a non-empty string, got: ${String(sa)}`
      )
    }
    // Block placeholder/stub prefixes BEFORE the C.../56-char shape check so
    // a fixture/LLM-seam marker is reported with the specific placeholder
    // error. 'VERIFY-*' / 'PLACEHOLDER-*' / 'TODO-*' must never reach install.
    if (PLACEHOLDER_SMART_ACCOUNT_PREFIX.test(sa)) {
      return synthesisError(
        `interpreter.smartAccountAddress must not be a placeholder/stub address (matches /${PLACEHOLDER_SMART_ACCOUNT_PREFIX.source}/), got: ${sa}`
      )
    }
    if (!isContractAddress(sa)) {
      return synthesisError(
        `interpreter.smartAccountAddress must be a C... Stellar contract address (the on-chain policy-bound account, not the G... source account), got: ${sa}`
      )
    }
    const nonce = opts.interpreter.installNonce
    // installNonce must fit u32 (the on-chain per-rule nonce is a u32).
    if (nonce !== undefined && (!isPositiveInt(nonce) || nonce > SOROBAN_LIMITS.u32Max)) {
      return synthesisError(
        `interpreter.installNonce must be a positive u32 integer (<= ${SOROBAN_LIMITS.u32Max}), got: ${nonce}`
      )
    }
  }
  return null
}

/** Placeholder/stub smart-account prefixes. Mirrors the
 *  `PLACEHOLDER_INTERPRETER_ADDRESS` marker the interpreter adapter uses for
 *  the interpreter-contract strkey; a real install must point at a C...
 *  contract address derivable from the on-chain account, never a
 *  fixture/LLM-seam marker. */
const PLACEHOLDER_SMART_ACCOUNT_PREFIX = /^(VERIFY-|PLACEHOLDER-|TODO-)/i

/** Maximum value a signed i128 can hold (2^127-1). A limitAmount above this
 *  cannot be represented on-chain, so reject it at the synthesis boundary
 *  (fail-closed) instead of passing it through as an over-broad spending_limit. */
const I128_MAX = 2n ** 127n - 1n

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

/** True when `s` is a canonical positive decimal integer inside [1, 2^127-1].
 *  Values above the i128 ceiling are rejected fail-closed: they cannot be
 *  installed on-chain, and accepting them would emit a spending_limit with an
 *  effectively unbounded cap. */
function isPositiveI128(s: string): boolean {
  if (!/^[0-9]+$/.test(s)) return false
  try {
    const v = BigInt(s)
    return v > 0n && v <= I128_MAX
  } catch {
    return false
  }
}

/** True when `s` looks like a Stellar C... contract address (strkey). The
 *  source account from the recording is a G... account; the smart account is
 *  a separate C... contract. */
function isContractAddress(s: string): boolean {
  return s.startsWith('C') && s.length === 56
}

function synthesisError(message: string): ToolError {
  return { code: 'SYNTHESIS_ERROR', message, severity: 'error', retryable: false }
}

function mergeAmbiguities(
  ...lists: ProposedPolicy['ambiguities'][]
): ProposedPolicy['ambiguities'] {
  const out: ProposedPolicy['ambiguities'] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const a of list) {
      if (seen.has(a.code)) continue
      seen.add(a.code)
      out.push(a)
    }
  }
  return out
}

/** Build the permit `EvalContext` the self-verify harness drives. Shape
 *  mirrors the intended recorded call so:
 *    - `evaluate(predicate, ctx).permit === true` must hold (a failure
 *      surfaces as DENY_CASE_FAILURE).
 *    - `generateCases(predicate, ctx)` produces a deny battery that reflects
 *      the actual recorded move (real amount, args, window start).
 *  Amounts are summed per-token over all movements (BigInt, never lossy). */
function buildPermitContext(
  tx: RecordedTransaction,
  scope: Extract<ScopeDecision, { kind: 'call_contract' }>,
  topLevel: ContractInvocation,
  userResponses: ComposeUserResponses | undefined,
  predicate: PredicateNode
): { ctx: EvalContext; warnings: string[] } {
  const amountByToken: Record<string, string> = {}
  const totals = new Map<string, bigint>()
  for (const m of tx.tokenMovements) {
    const current = totals.get(m.token) ?? 0n
    totals.set(m.token, current + BigInt(m.amount))
  }
  for (const [token, total] of totals) {
    amountByToken[token] = total.toString()
  }

  const warnings: string[] = []

  const ctx: EvalContext = {
    contract: scope.contract,
    fn: topLevel.fn,
    args: topLevel.args.map(cloneScVal),
    atLedger: tx.ledgerSequence,
    nowSeconds: tx.fetchedAt,
    amountByToken,
    windowSpentByToken: {},
    invocationCountByWindow: {},
  }
  if (userResponses?.validUntilLedger !== undefined) {
    ctx.validUntilLedger = userResponses.validUntilLedger
  }
  return { ctx, warnings }
}

function cloneScVal(
  value: { type: string; value: unknown },
  depth = 0
): ContractInvocation['args'][number] {
  // Clone top-level shells so the harness can mutate deny cases without
  // aliasing the recorded call. Recursion bounded by MAX_SCVAL_CLONE_DEPTH so
  // a hand-crafted nested-vec cannot RangeError the JS stack; the over-depth
  // branch throws a ToolError-shaped error the envelope converts to
  // `{ok:false, error}`.
  if (value.type === 'vec') {
    if (depth >= MAX_SCVAL_CLONE_DEPTH) {
      throw cloneDepthError(value)
    }
    return {
      type: 'vec',
      value: (value.value as ContractInvocation['args'][number][]).map((v) =>
        cloneScVal(v, depth + 1)
      ),
    }
  }
  return { ...value } as ContractInvocation['args'][number]
}

function cloneDepthError(value: { type: string; value: unknown }): never {
  const err = new Error(
    `ScVal clone depth exceeds MAX_SCVAL_CLONE_DEPTH (${MAX_SCVAL_CLONE_DEPTH})`
  ) as Error & { code: string; severity: string; retryable: boolean; depthContext: unknown }
  err.code = 'SYNTHESIS_ERROR'
  err.severity = 'error'
  err.retryable = false
  err.depthContext = value.type
  throw err
}

