// src/synth/compose-from-recording.ts - facts + scope -> PolicyIR (OZ + interpreter).
//
// Fail-closed composition rules:
//   - unknown top-level protocol (registry.identifyProtocol returns null) ->
//     emit no OZ-primitive-producing IR node; scope is kept (CallContract + method)
//     and every inferred bound surfaces as a descriptive warning. An unrecognised
//     call never compiles to a permissive OZ primitive.
//   - carry the recorded top-level function into `rule.scope.method` so the OZ
//     adapter flags per-method scoping as not covered (CallContract permits every
//     method; a per-method restriction needs the interpreter predicate).
//   - `spending_limit` (window_spent(token, w) <= limit) is emitted ONLY when
//     the caller supplies BOTH limit (userResponses.limitAmount) AND window
//     (userResponses.windowSeconds). A single recorded spend does NOT authorise
//     that amount every window, so the observed amount is NEVER used as an
//     auto-ceiling: missing limit -> AMOUNT_BOUND_MISSING (observed amount
//     offered as a suggestion); missing window -> DURATION_UNSPECIFIED. EVERY
//     spent token is handled - none is silently dropped.
//   - incoming-only flows emit an `invocation_count` bound ONLY when the caller
//     supplies both the count and the window; otherwise FREQUENCY_BOUND_MISSING
//     with no fabricated count.
//   - the IR carries ONLY constraints justified by the recording + explicit
//     user input. Nothing invented: no oracle price fabricated from a slippage
//     bound, no synthetic exact-path compare. Those needs surface as warnings.
//
// Split rule (P3 wiring): `ComposeResult` carries BOTH `ir` (OZ-shape) and
// `interpreterIr` (predicate-shape). Each constraint is routed to EXACTLY ONE
// adapter:
//   - `window_spent(token, w) <= limit` where `token === scope.contract` and
//     protocol is known -> `ir` (OZ lowers to spending_limit).
//   - everything else (recipient allowlists, per-method scope.method,
//     invocation_count, eq_seq swap paths, oracle_price, AND window_spent
//     where token != scope.contract i.e. SoroSwap input-token cap) ->
//     `interpreterIr`.
//
// This prevents the interpreter adapter from emitting a duplicate
// `window_spent` predicate leaf alongside an OZ `spending_limit` primitive
// covering the same spend semantic - the two adapters never overlap.
//
// Default policy is `deny_all` (OZ context rules are deny-by-default).

import type { IRCompOp, IRCondition, IRPolicyRule, PolicyIR } from '../ir/types.ts'
import { type IdentifiedProtocol, identifyProtocol } from '../registry/identify.ts'
import type { AmbiguityPrompt, ContractInvocation, Network } from '../types.ts'
import type { IntentFacts } from './lower.ts'

/** Per-asset oracle-price bound supplied by the caller (e.g. swap allowed only
 *  if oracle_price(XLM) < 5.00 USDC). One entry per asset; the recorder never
 *  fabricates a price bound from a slippage value (different units). */
export interface OraclePriceBound {
  asset: string
  operator: IRCompOp
  value: string
  /** Decimal basis `value` is written on. REQUIRED: oracle prices normalise to
   *  9 dp, and a threshold silently assumed to share that basis is what let a
   *  raw 14-dp bound permit everything. The author states it; we convert. */
  decimals: number
}

/** Caller-supplied answers to the ambiguity prompts. Every numeric bound the
 *  synth might apply must come from here - the recording supplies observed
 *  amounts (offered only as suggestions), never authorised ceilings. */
export interface ComposeUserResponses {
  /** Rolling window (seconds) for a spending_limit / invocation_count. */
  windowSeconds?: number
  /** OZ context-rule expiry (ledger sequence). */
  validUntilLedger?: number
  /** Per-window spend ceiling (i128 decimal string). Required to emit a
   *  spending_limit; absent -> AMOUNT_BOUND_MISSING. */
  limitAmount?: string
  /** Max invocations per window for an incoming-only flow. Required to emit an
   *  invocation_count bound; absent -> FREQUENCY_BOUND_MISSING. */
  invocationLimit?: number
  /** Per-asset oracle-price bound(s). Each entry lowers to a single
   *  `oracle_price(asset) OP value` compare in the interpreter IR. */
  oraclePriceBound?: OraclePriceBound[]
  /** Minimum acceptable swap output per unit of input, as `num/den` (e.g.
   *  `{num:'95',den:'100'}` = accept losing at most 5%). REQUIRED to be
   *  supplied by the caller: never derived from the recording (the recorded
   *  in/out pair is a price at one moment, and freezing it as policy would
   *  deny ordinary trades as soon as the rate moves). Absent, no floor is
   *  emitted and the existing unbounded-output warning stands. */
  swapMinOutRatio?: { num: string; den: string }
  /** Recipient allowlist for a swap (call_arg[3] on SoroSwap's
   *  swap_exact_tokens_for_tokens). When supplied, REPLACES the default pin.
   *  Absent -> recipient is pinned to the recorded value (mirroring SEP-41)
   *  and RECIPIENT_ALLOWLIST_EMPTY surfaces as informational, never a silent
   *  free pass. */
  swapRecipientAllowlist?: string[]
}

/** Composition options. */
export interface ComposeOptions {
  network: Network
  userResponses?: ComposeUserResponses
  /** When true, constraints the OZ adapter cannot lower are routed to
   *  `interpreterIr` (the predicate-shape IR) so the orchestrator can compile
   *  them via the interpreter adapter. When false (the default for callers
   *  who have not opted in), every constraint goes to `ir` and the OZ
   *  adapter's `uncovered` machinery generates the descriptive warnings -
   *  today's behaviour. The orchestrator passes this flag through based on
   *  whether `opts.interpreter` was supplied. */
  interpreterEnabled?: boolean
}

/** Result of composition: the OZ-shape PolicyIR, the predicate-shape PolicyIR
 *  (contains the constraints the OZ adapter cannot lower; empty when
 *  `interpreterEnabled` is false), any ambiguities surfaced during inference,
 *  and descriptive warnings for needs that are NOT expressed as an IR node
 *  (so no fabricated constraint is emitted). The orchestrator carries
 *  ambiguities into `ProposedPolicy.ambiguities` and merges warnings into
 *  `ProposedPolicy.warnings`. */
export interface ComposeResult {
  ir: PolicyIR
  interpreterIr: PolicyIR
  ambiguities: AmbiguityPrompt[]
  warnings: string[]
}

/** Compose a PolicyIR pair from the lowered facts + the resolved scope.
 *  Pure (no randomness, no clock); same inputs -> byte-identical result. */
export function composeFromRecording(
  facts: IntentFacts,
  scopeContract: string,
  topLevel: ContractInvocation | null,
  opts: ComposeOptions
): ComposeResult {
  const interpreterEnabled = opts.interpreterEnabled === true
  const ambiguities: AmbiguityPrompt[] = []
  const warnings: string[] = []
  const ozConstraints: IRCondition[] = []
  const interpreterConstraints: IRCondition[] = []
  // Route to the matching IR. When the interpreter is enabled, constraints the
  // OZ adapter cannot lower go there; otherwise they go to OZ (which flags them
  // as uncovered) so today's warning-driven behaviour is preserved.
  const routeToAdapter = (cond: IRCondition): void => {
    if (interpreterEnabled) interpreterConstraints.push(cond)
    else ozConstraints.push(cond)
  }

  const protocol = topLevel
    ? identifyProtocol(topLevel.contract, topLevel.fn, topLevel.args, opts.network)
    : null
  const known = protocol !== null

  const windowSeconds = opts.userResponses?.windowSeconds
  const limitAmount = opts.userResponses?.limitAmount
  const spendTokens = Object.keys(facts.spendByToken)

  // Outgoing spend -> one spending_limit per spent token. A single caller
  // limit binds only an unambiguous single-token spend; a multi-token flow
  // needs a per-token limit, so each unmatched token surfaces
  // AMOUNT_BOUND_MISSING.
  //
  // Routing: a `window_spent(token, w) <= limit` constraint goes to the OZ IR
  // only when token === scope.contract (OZ's spending_limit binds the
  // CallContract target, not a token parameter). Otherwise it goes to the
  // interpreter IR.
  if (spendTokens.length > 0 && topLevel) {
    let durationFlagged = false
    for (const token of spendTokens) {
      const observed = facts.spendByToken[token]
      if (observed === undefined) continue

      if (!known) {
        warnings.push(
          `spend of ${observed} (token ${token}) not bounded: unrecognised protocol, spend cap needs the interpreter predicate`
        )
        continue
      }

      const limit = spendTokens.length === 1 ? limitAmount : undefined
      if (windowSeconds === undefined && !durationFlagged) {
        ambiguities.push({
          code: 'DURATION_UNSPECIFIED',
          question: `Recording shows a ${observed}-${token} spend. What rolling window (seconds) should the spending_limit use?`,
        })
        durationFlagged = true
      }
      if (limit === undefined) {
        ambiguities.push({
          code: 'AMOUNT_BOUND_MISSING',
          question: `Recording shows a ${observed}-${token} spend, but a single spend does not authorise that amount every window. What per-window spending_limit should apply? (observed amount, suggestion only: ${observed})`,
        })
        continue
      }
      if (windowSeconds !== undefined) {
        // Rolling spend cap always goes to OZ (`spending_limit` is the audited
        // implementation). The interpreter is NOT a fallback for token !=
        // scopeContract: on chain it sees one authorized call, not the
        // transaction's token movements, so it has no per-call amount to
        // accumulate and the counter would never move. OZ reports the case it
        // cannot cover (limit pins to the context contract) - the honest
        // outcome; the old fallback produced an interpreter predicate that
        // silently never bound.
        ozConstraints.push({
          op: 'compare',
          compare: {
            selector: { kind: 'window_spent', token, windowSeconds },
            operator: 'lte',
            value: limit,
          },
        })
        if (interpreterEnabled && token !== scopeContract) {
          warnings.push(
            `rolling spend cap on ${token} cannot be enforced on chain: OZ spending_limit pins the limit to the context contract, and the interpreter cannot observe token movements. Bound the per-call value with an argument cap plus an invocation-count limit instead.`
          )
        }
      }
    }
  }

  // Incoming-only / frequency intent: an invocation_count bound is emitted ONLY
  // when the caller supplies the count AND a window - never a fabricated `<= 1`.
  // Routed to the interpreter IR when interpreter is enabled (OZ cannot lower
  // invocation_count); otherwise to the OZ IR (which flags it as uncovered).
  //
  // A recognised swap is NOT an incoming-only flow: it has an outgoing input
  // leg whose spend simply was not attributed to the source account
  // (fee-sponsored / holder != source). Its real restrictions - exact path,
  // recipient, input-amount cap - come from the protocol-specific pass, so it
  // does NOT get the incoming-only frequency prompt. A caller wanting to
  // rate-limit the swap can still supply an invocationLimit + window, which
  // lowers to an invocation_count for any flow.
  if (spendTokens.length === 0 && topLevel) {
    const invocationLimit = opts.userResponses?.invocationLimit
    const isRecognisedSwap = protocol?.protocol === 'soroswap'
    if (known && windowSeconds !== undefined && invocationLimit !== undefined) {
      routeToAdapter({
        op: 'compare',
        compare: {
          selector: { kind: 'invocation_count', windowSeconds },
          // `lt`, not `lte`: the leaf reports the calls ALREADY made in the
          // window, so `< N` is what permits N of them. With `lte` a limit
          // of N let an N+1th call through.
          operator: 'lt',
          value: String(invocationLimit),
        },
      })
    } else if (!isRecognisedSwap) {
      ambiguities.push({
        code: 'FREQUENCY_BOUND_MISSING',
        question: 'Incoming-only flow - what max invocations per window should the policy enforce?',
      })
      warnings.push(
        'frequency bound needed for the incoming-only flow (needs the interpreter predicate); no invocation cap inferred'
      )
    }
  }

  // Per-asset oracle-price bound(s) supplied by the caller -> one
  // oracle_price compare per entry. Routed to the interpreter IR when enabled;
  // otherwise to the OZ IR (which flags it as uncovered).
  const oracleBounds = opts.userResponses?.oraclePriceBound
  if (oracleBounds) {
    for (const b of oracleBounds) {
      routeToAdapter({
        op: 'compare',
        compare: {
          selector: { kind: 'oracle_price', asset: b.asset },
          operator: b.operator,
          value: b.value,
          valueDecimals: b.decimals,
        },
      })
    }
  }

  // Observed recipient allowlist (SEP-41) is a real, recorded constraint the OZ
  // adapter flags as not covered; the interpreter adapter lowers it to an `in`
  // predicate. Unknown protocols emit nothing here. SoroSwap's swap recipient
  // (arg[3]) is the source-of-truth for the swapRecipientAllowlist surface.
  if (topLevel && protocol !== null) {
    // A SoroSwap input-amount cap binds the caller's limitAmount to call_arg[0]
    // (the exact amount_in) ONLY when no cumulative outgoing spend was detected
    // for the source account - i.e. the input token never moved FROM the source
    // (fee-sponsored swaps, or a holder != source). When a spend WAS detected,
    // the window_spent path above already consumed the limit, so the per-call
    // arg cap is skipped to avoid binding one limit to two different semantics.
    const swapInputAmountCap = spendTokens.length === 0 ? limitAmount : undefined
    appendProtocolSpecificConstraints(
      interpreterConstraints,
      routeToAdapter,
      warnings,
      ambiguities,
      facts,
      topLevel,
      protocol,
      opts.userResponses?.swapRecipientAllowlist,
      swapInputAmountCap,
      opts.userResponses?.swapMinOutRatio,
      interpreterEnabled
    )
  }

  // `scope.method` is carried on BOTH IRs so each adapter produces a
  // self-consistent rule. The interpreter adapter lowers scope.method into a
  // `call_fn == <method>` predicate leaf (a real restriction); the OZ adapter
  // flags it as uncovered (CallContract alone permits any method on the
  // contract).
  const scope: IRPolicyRule['scope'] = { contract: scopeContract }
  if (topLevel?.fn) scope.method = topLevel.fn

  const buildRule = (constraints: IRCondition[]): IRPolicyRule => {
    const rule: IRPolicyRule = {
      roles: [],
      scope: { ...scope },
      constraints,
    }
    if (opts.userResponses?.validUntilLedger !== undefined) {
      rule.expiry = { validUntilLedger: opts.userResponses.validUntilLedger }
    }
    return rule
  }

  const ir: PolicyIR = {
    chain: 'stellar',
    defaultBehavior: 'deny_all',
    rules: [buildRule(ozConstraints)],
  }
  const interpreterIr: PolicyIR = {
    chain: 'stellar',
    defaultBehavior: 'deny_all',
    rules: [buildRule(interpreterConstraints)],
  }
  return { ir, interpreterIr, ambiguities, warnings }
}

/** Add the constraints justified by the recording that the OZ backend cannot
 *  express natively. Each constraint is routed to either `ozConstraints` (the
 *  OZ adapter lowers it) or `interpreterConstraints` (the interpreter adapter
 *  lowers it). When `interpreterEnabled` is false, every protocol-specific
 *  constraint is routed to `ozConstraints` (which flags it as uncovered) so
 *  callers who haven't opted in keep today's warning-driven behaviour.
 *  SoroSwap's slippage / oracle / exact-path needs come from `userResponses`
 *  (oraclePriceBound + limitAmount) + the recorded path (eq_seq on
 *  call_arg[2]). */
function appendProtocolSpecificConstraints(
  interpreterConstraints: IRCondition[],
  routeToAdapter: (cond: IRCondition) => void,
  warnings: string[],
  ambiguities: AmbiguityPrompt[],
  facts: IntentFacts,
  topLevel: ContractInvocation,
  protocol: IdentifiedProtocol,
  swapRecipientAllowlist: string[] | undefined,
  swapInputAmountCap: string | undefined,
  swapMinOutRatio: { num: string; den: string } | undefined,
  interpreterEnabled: boolean
): void {
  // SEP-41 transfer / mint: the `to` arg (index 1) is the recipient. Emit a
  // single-element allowlist; the interpreter adapter lowers it to `in`.
  // When interpreter is not enabled, route to OZ so the caller sees today's
  // `value allowlist on arg 1` warning.
  if (protocol.protocol === 'sep41' && (protocol.fn === 'transfer' || protocol.fn === 'mint')) {
    const toArg = topLevel.args[1]
    if (toArg && toArg.type === 'address') {
      routeToAdapter({
        op: 'in',
        selector: { kind: 'arg', argIndex: 1, scalarType: 'address' },
        values: [toArg.value],
      })
    }
  }

  // Blend submit / claim: the `to` arg is the beneficiary - it receives the
  // resulting position shares on `submit` and the claimed tokens on `claim`.
  // Without it, a policy scoped to a pool + method still lets an agent send
  // the proceeds anywhere. `from` and `spender` are deliberately NOT pinned -
  // the call already requires their authorisation, so binding them adds no
  // restriction the chain is not already enforcing.
  if (protocol.protocol === 'blend' && (protocol.fn === 'submit' || protocol.fn === 'claim')) {
    // Index 2 in both signatures: submit(from, spender, to, requests) and
    // claim(from, reserve_token_ids, to).
    const toArg = topLevel.args[2]
    if (toArg && toArg.type === 'address') {
      routeToAdapter({
        op: 'in',
        selector: { kind: 'arg', argIndex: 2, scalarType: 'address' },
        values: [toArg.value],
      })
    }
  }

  // Blend `submit` ONLY (not `claim`, whose vec arg is a vec<u32> of
  // reserve_token_ids - no map fields to bind). The `requests` vec
  // (call_arg[3]) is a vec<Request{ address, amount, request_type }>. Each
  // Request is the per-reserve action selector (0 Supply, 1 Withdraw,
  // 2 SupplyCollateral, 3 WithdrawCollateral, 4 Borrow, 5 Repay, 6-9
  // liquidation/auction fills). Pinning only one element is unsafe: a caller
  // can append a second element with a different action (WithdrawCollateral
  // -> Borrow on a different asset, any amount, then auction fills). Length
  // + per-element pinning is total; a quantifier over elements is not. If we
  // cannot emit BOTH, we surface AMBIGUITY rather than emit a partial bind.
  if (protocol.protocol === 'blend' && protocol.fn === 'submit' && interpreterEnabled) {
    const requestsArg = topLevel.args[3]
    if (requestsArg && requestsArg.type === 'vec') {
      const elements = requestsArg.value
      interpreterConstraints.push({
        op: 'compare',
        compare: {
          selector: { kind: 'arg_len', argIndex: 3 },
          operator: 'eq',
          value: String(elements.length),
        },
      })
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i]
        // An element we cannot bind leaves that request's action, asset and
        // amount free while the length pin makes the policy LOOK total. The
        // length pin still stays (it is a real restriction, and dropping it
        // would only widen the policy) - what must not happen is dropping the
        // element quietly.
        if (element?.type !== 'map') {
          warnings.push(
            `Blend submit requests element ${i} is not a Request map (recorded as ${element?.type ?? 'nothing'}): its request_type, address and amount are NOT pinned, so any action on any asset for any amount is permitted in that position`
          )
          continue
        }
        const fields = element.value
        const fieldValue = (
          name: string,
          scalarType: 'address' | 'i128' | 'u32'
        ): string | null => {
          const entry = fields.find((e) => e.key === name)
          if (!entry) return null
          if (entry.val.type === 'address' && scalarType === 'address') return entry.val.value
          if (entry.val.type === 'i128' && scalarType === 'i128') return entry.val.value
          if (entry.val.type === 'u32' && scalarType === 'u32') return entry.val.value
          return null
        }
        const address = fieldValue('address', 'address')
        const amount = fieldValue('amount', 'i128')
        const requestType = fieldValue('request_type', 'u32')
        if (address === null || amount === null || requestType === null) {
          const missing = [
            requestType === null ? 'request_type (u32)' : null,
            address === null ? 'address' : null,
            amount === null ? 'amount (i128)' : null,
          ].filter((f): f is string => f !== null)
          // Partial pins are deliberately NOT emitted (see the note above): a
          // half-pinned request reads as a bound one on the review card.
          warnings.push(
            `Blend submit requests element ${i} could not be bound: ${missing.join(', ')} missing or of an unexpected type. That request's request_type, address and amount are NOT pinned, so any action on any asset for any amount is permitted in that position`
          )
          continue
        }
        interpreterConstraints.push({
          op: 'compare',
          compare: {
            selector: {
              kind: 'arg_field',
              argIndex: 3,
              element: i,
              field: 'request_type',
              scalarType: 'u32',
            },
            operator: 'eq',
            value: requestType,
          },
        })
        interpreterConstraints.push({
          op: 'compare',
          compare: {
            selector: {
              kind: 'arg_field',
              argIndex: 3,
              element: i,
              field: 'address',
              scalarType: 'address',
            },
            operator: 'eq',
            value: address,
          },
        })
        interpreterConstraints.push({
          op: 'compare',
          compare: {
            selector: {
              kind: 'arg_field',
              argIndex: 3,
              element: i,
              field: 'amount',
              scalarType: 'i128',
            },
            operator: 'lte',
            value: amount,
          },
        })
      }
    }
  }

  // SoroSwap: the recorded hop path -> eq_seq on the path arg (call_arg[2]).
  // The interpreter adapter is the ONLY way to express an exact ordered
  // sequence (OZ built-ins cannot). Element order is preserved verbatim.
  // When multiple paths were recorded, the intersection is emitted as the
  // canonical single path only if all observations agree; otherwise each is
  // surfaced descriptively.
  if (protocol.protocol === 'soroswap') {
    const paths = facts.allowedPaths?.[topLevel.contract]
    const route = paths?.length === 1 ? paths[0] : undefined
    if (route && route.length > 0 && interpreterEnabled) {
      const pathArgIndex = 2 // SoroSwap swap_exact_tokens_for_tokens: args = [amount_in, amount_out_min, path, to, deadline]
      interpreterConstraints.push({
        op: 'eq_seq',
        selector: { kind: 'arg', argIndex: pathArgIndex, scalarType: 'address' },
        values: route,
      })
    } else {
      const pathText = route && route.length > 0 ? `; observed path: ${route.join(' -> ')}` : ''
      warnings.push(
        `SoroSwap swap: slippage / oracle price bound and exact hop path need the interpreter predicate${pathText}`
      )
    }

    // Input-amount cap: bind the caller's limitAmount to the swap's input-amount
    // argument as `call_arg[i] <= limit`. The index is function-specific -
    // SoroSwap has three swap entrypoints: `swap_exact_tokens_for_tokens` and
    // `swap_exact_in_for_tokens` take the exact input as arg[0], while
    // `swap_tokens_for_exact_tokens` takes the MAXIMUM input (`amount_in_max`)
    // as arg[1] (its arg[0] is the exact OUTPUT, so binding arg[0] there would
    // cap the wrong value and leave the input unbounded). This is a per-call cap
    // that does NOT depend on attributing a token movement to the source account
    // (the fee-sponsored / holder != source case, where the window_spent path
    // detects no spend). Fail-closed: it only ever restricts the permitted input.
    // Routed to the interpreter predicate (OZ built-ins cannot express a per-arg
    // i128 bound); when the interpreter is not enabled it goes to OZ, which flags
    // it uncovered (a warning). The `type === 'i128'` check is defense in depth -
    // protocol identification's argsMatchAbi already pins the input arg to i128.
    const inputArgIndex = soroswapInputAmountArgIndex(protocol.fn)
    const inputAmountArg = inputArgIndex !== undefined ? topLevel.args[inputArgIndex] : undefined
    if (
      swapInputAmountCap !== undefined &&
      inputArgIndex !== undefined &&
      inputAmountArg &&
      inputAmountArg.type === 'i128'
    ) {
      routeToAdapter({
        op: 'compare',
        compare: {
          selector: { kind: 'arg', argIndex: inputArgIndex, scalarType: 'i128' },
          operator: 'lte',
          value: swapInputAmountCap,
        },
      })
    }

    // Slippage floor: `out >= in * num/den`. Only when the caller supplied the
    // ratio - see `swapMinOutRatio`. Without it the output arg stays free,
    // which is the case the unbounded-swap warning above describes.
    const outMinArgIndex = soroswapMinOutArgIndex(protocol.fn)
    const minOutRatio = swapMinOutRatio
    if (
      minOutRatio !== undefined &&
      inputArgIndex !== undefined &&
      outMinArgIndex !== undefined &&
      inputAmountArg &&
      inputAmountArg.type === 'i128'
    ) {
      routeToAdapter({
        op: 'slippage_floor',
        outArgIndex: outMinArgIndex,
        inArgIndex: inputArgIndex,
        num: minOutRatio.num,
        den: minOutRatio.den,
      })
    }

    // Swap recipient (call_arg[3]): when the caller supplies
    // swapRecipientAllowlist, emit it as an `in` constraint on the recipient
    // arg. When absent, PIN the recipient to the recorded value - mirroring the
    // SEP-41 `to` arg above: the recorded flow went to exactly one recipient, so
    // pinning it is the minimal policy that permits exactly that flow. Leaving
    // it unconstrained would permit an arbitrary recipient (an evil twin with
    // call_arg[3] = attacker_wallet). RECIPIENT_ALLOWLIST_EMPTY is still
    // surfaced, but as INFORMATIONAL (the recipient was pinned; here is how to
    // widen it), never as a silent free pass. The recipient is only enforceable
    // via the interpreter predicate, so the pin (and the ambiguity) apply only
    // when the interpreter is enabled - otherwise the swap recipient is ignored
    // (today's behaviour, matching the other SoroSwap constraints).
    const recipientArg = topLevel.args[3]
    if (swapRecipientAllowlist && swapRecipientAllowlist.length > 0) {
      routeToAdapter({
        op: 'in',
        selector: { kind: 'arg', argIndex: 3, scalarType: 'address' },
        values: [...swapRecipientAllowlist],
      })
    } else if (interpreterEnabled && recipientArg && recipientArg.type === 'address') {
      interpreterConstraints.push({
        op: 'in',
        selector: { kind: 'arg', argIndex: 3, scalarType: 'address' },
        values: [recipientArg.value],
      })
      ambiguities.push({
        code: 'RECIPIENT_ALLOWLIST_EMPTY',
        question: `No recipient allowlist supplied; the swap recipient (call_arg[3]) was pinned to the recorded value ${recipientArg.value}. To permit additional recipients, supply an allowlist (CLI: --recipient <C...|G...>, repeatable; MCP: userResponses.swapRecipientAllowlist) - it REPLACES this default pin.`,
      })
    }
  }
}

/** Positional index of the input-amount argument for a recognized SoroSwap swap
 *  function. `swap_exact_tokens_for_tokens` and `swap_exact_in_for_tokens` take
 *  the exact input as arg[0]; `swap_tokens_for_exact_tokens` takes the maximum
 *  input (`amount_in_max`) as arg[1] - its arg[0] is the exact OUTPUT. Any other
 *  function has no positional input-amount argument -> undefined (no cap bound). */
/** The argument carrying the swap's MINIMUM ACCEPTABLE OUTPUT.
 *
 *  Only the exact-input entrypoints have one: `swap_tokens_for_exact_tokens`
 *  fixes the output and varies the input, so its output needs no floor (its
 *  arg[1] is `amount_in_max`, already bounded by the input cap). Returning
 *  undefined there keeps a floor from being pinned to the wrong argument. */
function soroswapMinOutArgIndex(fn: string): number | undefined {
  switch (fn) {
    case 'swap_exact_tokens_for_tokens':
    case 'swap_exact_in_for_tokens':
      return 1
    default:
      return undefined
  }
}

function soroswapInputAmountArgIndex(fn: string): number | undefined {
  switch (fn) {
    case 'swap_exact_tokens_for_tokens':
    case 'swap_exact_in_for_tokens':
      return 0
    case 'swap_tokens_for_exact_tokens':
      return 1
    default:
      return undefined
  }
}
