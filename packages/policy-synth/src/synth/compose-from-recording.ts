// src/synth/compose-from-recording.ts - facts + scope -> a composed rule.
//
// Fail-closed composition rules:
//   - unknown top-level protocol (registry.identifyProtocol returns null) ->
//     no ABI means no argument can be singled out by role (recipient, spender,
//     etc.), so a spend is never capped and no argument is guessed at; every
//     address argument the call actually carries is pinned to its observed
//     value instead (AC-33.19), and every other inferred bound surfaces as a
//     descriptive warning. An unrecognised call never compiles to a
//     permissive policy.
//   - a spend cap is emitted ONLY when the caller supplies `limitAmount` AND
//     the call carries an amount argument to bind it to. A single recorded
//     spend does NOT authorise that amount on every call, so the observed
//     amount is NEVER used as an auto-ceiling: without both,
//     AMOUNT_BOUND_MISSING carries the observed amount as a suggestion. EVERY
//     spent token is handled - none is silently dropped.
//   - the IR carries ONLY constraints justified by the recording plus an
//     explicit bound, no synthetic exact-path compare. Other needs surface as
//     warnings.
//
// Default policy is `deny_all` (OZ context rules are deny-by-default).

import { type IdentifiedProtocol, identifyProtocol } from '../registry/identify.ts'
import { getAbi } from '../registry/protocols.ts'
import type { AmbiguityPrompt, ContractInvocation, Network, PredicateNode } from '../types.ts'
import type { IntentFacts } from './lower.ts'

/** Caller-supplied answers to the ambiguity prompts. Every numeric bound the
 *  synth might apply must come from here - the recording supplies observed
 *  amounts (offered only as suggestions), never authorised ceilings. */
export interface ComposeUserResponses {
  /** OZ context-rule expiry (ledger sequence). */
  validUntilLedger?: number
  /** Per-call ceiling on the amount the call carries (i128 decimal string).
   *  Required to bound the amount argument; absent -> AMOUNT_BOUND_MISSING. */
  limitAmount?: string
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
  /** The smart account this rule will be installed on, when known. Used only
   *  to detect self-scope (see the warning below `scopeContract` is set) -
   *  composition proceeds identically when this is omitted. */
  smartAccountAddress?: string
}

/** One composed rule: what the call must be scoped to, the constraints on it,
 *  and how long the resulting context rule lives. The constraints are already
 *  predicate nodes - there is one enforcement backend, so there is nothing to
 *  translate between. */
export interface ComposedRule {
  scope: { contract?: string; method?: string }
  constraints: PredicateNode[]
  expiry?: { validUntilLedger?: number }
}

/** Result of composition: the composed rule the interpreter compiler
 *  compiles, the ambiguities the caller must answer, and descriptive warnings
 *  for needs that are NOT expressed as an IR node (so no fabricated constraint
 *  is emitted). The orchestrator carries ambiguities into
 *  `ProposedPolicy.ambiguities` and merges warnings into
 *  `ProposedPolicy.warnings`. */
export interface ComposeResult {
  interpreterRule: ComposedRule
  ambiguities: AmbiguityPrompt[]
  warnings: string[]
}

/** Compose a rule from the lowered facts + the resolved scope.
 *  Pure (no randomness, no clock); same inputs -> byte-identical result. */
export function composeFromRecording(
  facts: IntentFacts,
  scopeContract: string,
  topLevel: ContractInvocation | null,
  opts: ComposeOptions
): ComposeResult {
  const ambiguities: AmbiguityPrompt[] = []
  const warnings: string[] = []
  const interpreterConstraints: PredicateNode[] = []

  const protocol = topLevel
    ? identifyProtocol(topLevel.contract, topLevel.fn, topLevel.args, opts.network)
    : null
  const known = protocol !== null

  const limitAmount = opts.userResponses?.limitAmount
  const spendTokens = Object.keys(facts.spendByToken)

  // Outgoing spend -> a cap on the call's own amount ARGUMENT. The interpreter
  // is passed one authorised call, not the transaction's token movements, so a
  // rolling per-window total is not something it can read; the enforceable
  // shape is a bound on the amount the call itself carries. A multi-token flow
  // has no single argument to bind, so each token surfaces AMOUNT_BOUND_MISSING.
  if (spendTokens.length > 0 && topLevel) {
    for (const token of spendTokens) {
      const observed = facts.spendByToken[token]
      if (observed === undefined) continue

      if (!known) {
        warnings.push(
          `spend of ${observed} (token ${token}) not bounded: unrecognised protocol, so the amount argument cannot be located`
        )
        continue
      }

      const limit = spendTokens.length === 1 ? limitAmount : undefined
      const amountArgIndex = limitArgumentIndex(protocol, topLevel)
      if (limit === undefined || amountArgIndex === null) {
        ambiguities.push({
          code: 'AMOUNT_BOUND_MISSING',
          question: `Recording shows a ${observed}-${token} spend, but a single spend does not authorise that amount on every call. What per-call cap should apply? (observed amount, suggestion only: ${observed})`,
        })
        continue
      }
      interpreterConstraints.push({
        op: 'lte',
        left: { kind: 'call_arg', index: amountArgIndex },
        right: { kind: 'literal_i128', value: limit },
      })
    }
  }

  // Incoming-only / frequency intent: the interpreter is passed one authorised
  // call, so it cannot count prior calls - no frequency bound is emitted and
  // never a fabricated `<= 1`. The need surfaces as a prompt plus a warning.
  //
  // A recognised swap is NOT an incoming-only flow: it has an outgoing input
  // leg whose spend simply was not attributed to the source account
  // (fee-sponsored / holder != source). Its real restrictions - exact path,
  // recipient, input-amount cap - come from the protocol-specific pass, so it
  // does NOT get the incoming-only frequency prompt.
  if (spendTokens.length === 0 && topLevel) {
    const isRecognisedSwap = protocol?.protocol === 'soroswap'
    if (!isRecognisedSwap) {
      ambiguities.push({
        code: 'FREQUENCY_BOUND_MISSING',
        question:
          'Incoming-only flow - the policy does not bound how often this call may be made. Bound it outside the policy, or scope the rule more tightly.',
      })
      warnings.push(
        'incoming-only flow: call frequency is NOT bounded - the interpreter reads only the authorized call, so it cannot count prior calls'
      )
    }
  }

  // Observed recipient allowlist (SEP-41) is a real, recorded constraint the
  // interpreter adapter lowers to an `in` predicate. SoroSwap's swap recipient
  // (arg[3]) is the source-of-truth for the swapRecipientAllowlist surface.
  if (topLevel && protocol !== null) {
    // A SoroSwap input-amount cap binds the caller's limitAmount to the swap's
    // input-amount argument ONLY when no outgoing spend was detected for the
    // source account - i.e. the input token never moved FROM the source
    // (fee-sponsored swaps, or a holder != source). When a spend WAS detected,
    // the cap above already consumed the limit, so this one is skipped to avoid
    // binding one limit to two different args.
    const swapInputAmountCap = spendTokens.length === 0 ? limitAmount : undefined
    appendProtocolSpecificConstraints(
      interpreterConstraints,
      warnings,
      ambiguities,
      facts,
      topLevel,
      protocol,
      opts.userResponses?.swapRecipientAllowlist,
      swapInputAmountCap
    )
  } else if (topLevel && protocol === null) {
    // Unrecognised protocol: there is no published ABI, so no argument can be
    // singled out as THE recipient - guessing an index risks pinning the
    // wrong value (false security) or a value that means something else
    // entirely for a different contract sharing the same shape. What the
    // recording DOES evidence, without any interpretation, is every address
    // literally carried by the call. AC-33.19: a value the recording
    // evidences is pinned by default, never left open because its semantic
    // role is unrecognised - so every address argument is pinned to its
    // observed value, not just the one a known ABI would call "to".
    const addressArgIndexes = topLevel.args.flatMap((arg, i) => (arg.type === 'address' ? [i] : []))
    if (addressArgIndexes.length > 0) {
      for (const i of addressArgIndexes) {
        const arg = topLevel.args[i]
        if (arg?.type !== 'address') continue
        interpreterConstraints.push({
          op: 'in',
          needle: { kind: 'call_arg', index: i },
          haystack: [{ kind: 'literal_address', value: arg.value }],
        })
      }
      warnings.push(
        `unrecognised protocol: every address argument observed in the call (index ${addressArgIndexes.join(', ')}) was pinned to its recorded value - the ABI is unknown, so no single argument could be identified as the recipient specifically; read this pin with less confidence than a recognised protocol's`
      )
    }
  }

  // Self-scope: a rule whose scope targets the smart account that will hold
  // it lets the account authorise calls against its own governance surface
  // (e.g. a recorded batch_add_signer against the account itself). Such a
  // rule installs cleanly and then denies every OTHER call with OZ error
  // #3002, bricking the account. Detected only when the caller supplies
  // smartAccountAddress; without it the composer has nothing to compare
  // scopeContract against, so composition proceeds unchanged.
  if (opts.smartAccountAddress !== undefined && scopeContract === opts.smartAccountAddress) {
    warnings.push(
      `scope.contract (${scopeContract}) is the smart account's own address: a rule scoping ${topLevel?.fn ?? 'this call'} to the account that will hold it lets the account govern its own governance surface, and denies every other call with OZ error #3002 once installed`
    )
  }

  // The interpreter adapter lowers `scope.method` into a `call_fn == <method>`
  // predicate leaf.
  const scope: ComposedRule['scope'] = { contract: scopeContract }
  if (topLevel?.fn) scope.method = topLevel.fn

  const buildRule = (constraints: PredicateNode[]): ComposedRule => {
    const rule: ComposedRule = {
      scope: { ...scope },
      constraints,
    }
    if (opts.userResponses?.validUntilLedger !== undefined) {
      rule.expiry = { validUntilLedger: opts.userResponses.validUntilLedger }
    }
    return rule
  }

  return { interpreterRule: buildRule(interpreterConstraints), ambiguities, warnings }
}

/** Index of the argument a caller-supplied `limitAmount` binds to, or null when
 *  the call carries no such argument. The interpreter is passed one authorised
 *  call, not the transaction's token movements, so bounding an argument the
 *  call itself carries is the only enforceable shape. */
function limitArgumentIndex(
  protocol: IdentifiedProtocol | null,
  topLevel: ContractInvocation | null
): number | null {
  if (!protocol || !topLevel) return null
  const named = amountArgumentIndex(protocol)
  if (named !== null) return named
  // SoroSwap names its input argument `amount_in` / `amount_in_max`, so the
  // lookup by name misses it and the index is function-specific.
  if (protocol.protocol !== 'soroswap') return null
  const i = soroswapInputAmountArgIndex(protocol.fn)
  // Defense in depth: identification's argsMatchAbi already pins it to i128.
  return i !== undefined && topLevel.args[i]?.type === 'i128' ? i : null
}

/** Index of the argument the protocol ABI calls `amount`, or null when the ABI
 *  does not name one. */
function amountArgumentIndex(protocol: IdentifiedProtocol): number | null {
  const abi = getAbi(protocol.protocol)[protocol.fn]
  if (!abi) return null
  const i = abi.args.findIndex((a) => a.name === 'amount')
  return i >= 0 ? i : null
}

/** Add the protocol-specific constraints the recording justifies: recipient
 *  allowlists, exact swap paths and per-call argument caps. */
function appendProtocolSpecificConstraints(
  interpreterConstraints: PredicateNode[],
  warnings: string[],
  ambiguities: AmbiguityPrompt[],
  facts: IntentFacts,
  topLevel: ContractInvocation,
  protocol: IdentifiedProtocol,
  swapRecipientAllowlist: string[] | undefined,
  swapInputAmountCap: string | undefined
): void {
  // SEP-41 transfer / mint: the `to` arg (index 1) is the recipient. Emit a
  // single-element allowlist; the interpreter adapter lowers it to `in`.
  if (protocol.protocol === 'sep41' && (protocol.fn === 'transfer' || protocol.fn === 'mint')) {
    const toArg = topLevel.args[1]
    if (toArg && toArg.type === 'address') {
      interpreterConstraints.push({
        op: 'in',
        needle: { kind: 'call_arg', index: 1 },
        haystack: [{ kind: 'literal_address', value: toArg.value }],
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
      interpreterConstraints.push({
        op: 'in',
        needle: { kind: 'call_arg', index: 2 },
        haystack: [{ kind: 'literal_address', value: toArg.value }],
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
  if (protocol.protocol === 'blend' && protocol.fn === 'submit') {
    const requestsArg = topLevel.args[3]
    if (requestsArg && requestsArg.type === 'vec') {
      const elements = requestsArg.value
      interpreterConstraints.push({
        op: 'eq',
        left: { kind: 'call_arg_len', index: 3 },
        right: { kind: 'literal_u32', value: elements.length },
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
          op: 'eq',
          left: { kind: 'call_arg_field', index: 3, element: i, field: 'request_type' },
          right: { kind: 'literal_u32', value: Number.parseInt(requestType, 10) },
        })
        interpreterConstraints.push({
          op: 'eq',
          left: { kind: 'call_arg_field', index: 3, element: i, field: 'address' },
          right: { kind: 'literal_address', value: address },
        })
        interpreterConstraints.push({
          op: 'lte',
          left: { kind: 'call_arg_field', index: 3, element: i, field: 'amount' },
          right: { kind: 'literal_i128', value: amount },
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
    if (route && route.length > 0) {
      const pathArgIndex = 2 // SoroSwap swap_exact_tokens_for_tokens: args = [amount_in, amount_out_min, path, to, deadline]
      interpreterConstraints.push({
        op: 'eq',
        left: { kind: 'call_arg', index: pathArgIndex },
        right: {
          kind: 'literal_vec',
          elements: route.map((v) => ({ kind: 'literal_address', value: v }) as const),
        },
      })
    } else {
      const pathText = route && route.length > 0 ? `; observed path: ${route.join(' -> ')}` : ''
      warnings.push(`SoroSwap swap: the exact hop path needs the interpreter predicate${pathText}`)
    }

    // Input-amount cap: bind the caller's limitAmount to the swap's input-amount
    // argument as `call_arg[i] <= limit`. The index is function-specific -
    // SoroSwap has three swap entrypoints: `swap_exact_tokens_for_tokens` and
    // `swap_exact_in_for_tokens` take the exact input as arg[0], while
    // `swap_tokens_for_exact_tokens` takes the MAXIMUM input (`amount_in_max`)
    // as arg[1] (its arg[0] is the exact OUTPUT, so binding arg[0] there would
    // cap the wrong value and leave the input unbounded). This is a per-call cap
    // that does NOT depend on attributing a token movement to the source account
    // (the fee-sponsored / holder != source case, where no spend is detected).
    // Fail-closed: it only ever restricts the permitted input. The
    // `type === 'i128'` check is defense in depth - protocol identification's
    // argsMatchAbi already pins the input arg to i128.
    const inputArgIndex = soroswapInputAmountArgIndex(protocol.fn)
    const inputAmountArg = inputArgIndex !== undefined ? topLevel.args[inputArgIndex] : undefined
    if (
      swapInputAmountCap !== undefined &&
      inputArgIndex !== undefined &&
      inputAmountArg &&
      inputAmountArg.type === 'i128'
    ) {
      interpreterConstraints.push({
        op: 'lte',
        left: { kind: 'call_arg', index: inputArgIndex },
        right: { kind: 'literal_i128', value: swapInputAmountCap },
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
    // widen it), never as a silent free pass.
    const recipientArg = topLevel.args[3]
    if (swapRecipientAllowlist && swapRecipientAllowlist.length > 0) {
      interpreterConstraints.push({
        op: 'in',
        needle: { kind: 'call_arg', index: 3 },
        haystack: swapRecipientAllowlist.map(
          (v) => ({ kind: 'literal_address', value: v }) as const
        ),
      })
    } else if (recipientArg && recipientArg.type === 'address') {
      interpreterConstraints.push({
        op: 'in',
        needle: { kind: 'call_arg', index: 3 },
        haystack: [{ kind: 'literal_address', value: recipientArg.value }],
      })
      ambiguities.push({
        code: 'RECIPIENT_ALLOWLIST_EMPTY',
        question: `No recipient allowlist supplied; the swap recipient (call_arg[3]) was pinned to the recorded value ${recipientArg.value}. To permit additional recipients, supply an allowlist (CLI: --recipient <C...|G...>, repeatable; MCP: userResponses.swapRecipientAllowlist) - it REPLACES this default pin.`,
      })
    }
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
