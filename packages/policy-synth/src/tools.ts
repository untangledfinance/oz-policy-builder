// The eleven tools, one definition each: a name, a description, an input shape and
// a body. `tool()` is the only place input is validated, errors become the
// response envelope, and a thrown refusal gets its code; the MCP server and the
// CLI both register straight from `TOOLS`, so neither holds any logic.
//
// Nothing here holds a key. Install and revoke return an unsigned transaction.

import { StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'
import { isSolanaKey } from './bytes.ts'
import { type Authority, authority, followed, lines, overridden, tree, warned } from './card.ts'
import {
  codeHash,
  connect,
  contractKinds,
  type Endpoint,
  ensureInterpreter,
  fingerprint,
  interpreterFor,
  isToken,
  pinnedWasm,
} from './chain.ts'
import { MAX_CHECKS, runChecks, verifyRule } from './check.ts'
import {
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETER_WASM,
  type Network,
  OZ_ACCOUNT_WASM,
} from './config.ts'
import { type ErrorCode, messageOf, Refusal, type ToolResponse } from './envelope.ts'
import { reviewEvm } from './evm.ts'
import {
  buildBind,
  buildInstall,
  buildRevoke,
  type Chain,
  type Chosen,
  gate,
  INSTALL_OVERRIDES,
  keyedSafeOnNoGate,
  type Override,
  planBind,
  planInstall,
  planRevoke,
} from './install.ts'
import type { Intent } from './intent.ts'
import { type Call, decodeEnvelope, type Recording, recordHash } from './record.ts'
import { reviewUnsigned } from './review.ts'
import { type Followed, readFollowed, readRule, readRules, selectors } from './rules.ts'
import { reviewSolana } from './solana.ts'
import {
  type Answers,
  type ProposedRule,
  propose,
  type Synthesis,
  synthesize,
  unbounded,
  unboundedExpr,
} from './synth.ts'
import {
  type Caps,
  CEILINGS,
  decode,
  type Expr,
  encode,
  encodeReference,
  hashOf,
  type Reference,
  validate,
  WireError,
} from './wire.ts'

// ---- input fragments ----

const net = {
  network: z.enum(['mainnet', 'testnet']).default('testnet'),
}
/** `raw`: the review shows full addresses and every value as written. */
const display = { raw: z.boolean().optional() }
/** Stroops per operation: the cap keeps a bad caller from handing a wallet an absurd fee to bid. */
const baseFee = z.number().int().positive().max(10_000_000).optional()
const account = z.string().refine(StrKey.isValidEd25519PublicKey, 'a G... account')
const contractId = z.string().refine(StrKey.isValidContract, 'a C... contract')
const anyAddress = z.union([account, contractId])
const u32 = z.number().int().positive().max(0xffffffff)
const amount = z
  .string()
  .regex(/^[1-9]\d*$/, 'a positive integer in the smallest unit, as a string')
const val: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(val), z.record(z.string(), val)])
)
const path = z.array(z.union([z.number().int().nonnegative(), z.string().min(1)]))
const arg = z.object({ arg: path.min(1) }).strict()
const cmp = z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])

/** One constraint of an intent: its name, and the strict shape of the rest. */
const row = <C extends string, S extends z.ZodRawShape>(constraint: C, shape: S) =>
  z.object({ constraint: z.literal(constraint), ...shape }).strict()
const list = z.array(val).min(1).max(CEILINGS.max_in_operands)
const rule: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('constraint', [
    row('pin', { at: path, to: val }),
    row('not', { at: path, to: val }),
    row('allow', { at: path, in: list }),
    row('deny', { at: path, nin: list }),
    row('cap', { at: path, max: amount }),
    row('floor', { at: path, min: z.string().regex(/^-?\d+$/) }),
    row('length', { at: path, max: z.number().int().nonnegative() }),
    row('count', { at: path, is: z.number().int().nonnegative().max(0xffffffff) }),
    row('same', { at: path, as: path }),
    row('minOut', { at: path, of: path, num: amount, den: amount }),
    row('each', { at: path, where: z.array(rule).min(1) }),
    row('some', { at: path, where: z.array(rule).min(1) }),
    row('total', { at: path, of: path.optional(), max: amount }),
    row('read', {
      contract: contractId,
      fn: z.string().min(1),
      args: z.array(z.union([arg, val])).optional(),
      path: path.optional(),
      op: cmp,
      to: val,
    }),
    row('until', { ts: z.number().int().positive() }),
    row('from', { ts: z.number().int().positive() }),
  ])
)
const intent = z
  .object({
    calls: z
      .array(
        z
          .object({ contract: contractId, fn: z.string().min(1), where: z.array(rule).optional() })
          .strict()
      )
      .min(1)
      .max(32),
  })
  .strict()

const call = z.object({ contract: contractId, fn: z.string().min(1), args: z.array(val) }).strict()
/** A rule to follow instead of a predicate: `ruleId` of `smartAccount`, on the same interpreter. */
const follow = z
  .object({ smartAccount: contractId, ruleId: z.number().int().nonnegative().max(0xffffffff) })
  .strict()
const recording = z
  .object({
    network: z.enum(['mainnet', 'testnet']),
    source: z.string(),
    ledger: z.number(),
    signers: z.array(z.string()),
    contexts: z.array(call).max(512),
  })
  .strict()

/** What to make a rule of: a transaction (by hash or as XDR), a recording or an intent; exactly
 *  one. The answers say what a transaction cannot. */
const from = {
  hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
  xdr: z.string().min(1).max(400_000).optional(),
  recording: recording.optional(),
  intent: intent.optional(),
  limit: amount.optional(),
  limits: z.record(z.string(), amount).optional(),
  allow: z.record(z.string(), z.array(anyAddress).min(1)).optional(),
}

// ---- the wrapper ----

export interface Tool {
  name: string
  description: string
  shape: Record<string, z.ZodType>
  /** The input as a strict object: an unknown key is refused, wherever the tool is served from. */
  schema: z.ZodObject<Record<string, z.ZodType>, z.core.$strict>
  run: (raw: unknown, signal?: AbortSignal) => Promise<ToolResponse<unknown>>
}

const CODE: Record<string, ErrorCode> = {
  record_transaction: 'RECORDING_FAILED',
  synthesize_policy: 'SYNTHESIS_ERROR',
  simulate_policy: 'SIMULATION_ERROR',
  verify_policy: 'VERIFICATION_FAILED',
  install_policy: 'INSTALL_BUILD_FAILED',
  revoke_policy: 'REVOKE_BUILD_FAILED',
  bind_policy: 'BIND_BUILD_FAILED',
  get_interpreter_info: 'INTERPRETER_MISMATCH',
  review_unsigned: 'INVALID_INPUT',
  solana_review: 'INVALID_INPUT',
  evm_review: 'INVALID_INPUT',
}

function tool<S extends Record<string, z.ZodType>>(
  name: string,
  description: string,
  shape: S,
  body: (input: z.infer<z.ZodObject<S>>, signal?: AbortSignal) => Promise<unknown>
): Tool {
  const schema = z.object(shape).strict()
  const fail = (
    code: ErrorCode,
    message: string,
    extra: { retryable?: boolean; details?: unknown } = {}
  ) => ({
    ok: false as const,
    error: {
      code,
      message: `${name}: ${message}`,
      retryable: extra.retryable ?? false,
      ...(extra.details === undefined ? {} : { details: extra.details }),
    },
  })
  return {
    name,
    description,
    shape,
    schema,
    async run(raw, signal) {
      let parsed: ReturnType<typeof schema.safeParse>
      try {
        parsed = schema.safeParse(raw)
      } catch (e) {
        // Input nested past the parser's stack is still input, not a crash.
        return fail('INVALID_INPUT', `invalid input: ${messageOf(e)}`)
      }
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join('.') || '<input>'}: ${i.message}`
        )
        return fail('INVALID_INPUT', `invalid input: ${issues.join('; ')}`)
      }
      try {
        return { ok: true, data: await body(parsed.data, signal) }
      } catch (e) {
        if (e instanceof Refusal) return fail(e.code, e.message, e.extra)
        if (e instanceof WireError) return fail('MALFORMED_PREDICATE', e.message)
        return fail(CODE[name] ?? 'INVALID_INPUT', messageOf(e))
      }
    },
  }
}

const SOURCES = ['hash', 'xdr', 'recording', 'intent']
const exactlyOne = (i: object, keys: string[]): string => {
  const given = keys.filter((k) => (i as Record<string, unknown>)[k] !== undefined)
  if (given.length !== 1)
    throw new Refusal('INVALID_INPUT', `give exactly one of ${keys.join(', ')}`)
  return given[0] as string
}

// ---- shared steps ----

type Source = Synthesis & { recording?: Recording }

const recordOf = (i: Endpoint & { hash?: string | undefined; xdr?: string | undefined }) =>
  i.xdr !== undefined
    ? decodeEnvelope(i.xdr, i.network)
    : recordHash(connect(i), i.network, i.hash as string)

async function sourceOf(i: z.infer<z.ZodObject<typeof from & typeof net>>): Promise<Source> {
  const kind = exactlyOne(i, SOURCES)
  if (kind === 'intent') {
    const intent = i.intent as Intent
    return { intent, warnings: [], ambiguities: unbounded(intent) }
  }
  const rec = kind === 'recording' ? (i.recording as Recording) : await recordOf(i)
  const answers: Answers = { limit: i.limit, limits: i.limits, allow: i.allow as Answers['allow'] }
  return { recording: rec, ...synthesize(rec.contexts, answers) }
}

/** The open amount and slippage questions, as `planInstall` takes them. */
const questions = (as: Synthesis['ambiguities']) => ({
  unanswered: as.find((a) => a.code === 'AMOUNT_BOUND_MISSING')?.question,
  openSlippage: as.find((a) => a.code === 'SLIPPAGE_FLOOR_MISSING')?.question,
})

const present = (r: ReturnType<typeof propose>[number]) => ({
  contract: r.contract,
  predicate: r.expr,
  encodedPredicate: r.encoded,
  predicateHash: r.hash,
})

/** The review of a predicate: what the request waived first, then the authority, then the tree,
 *  and the text of it. Roles are the package's ([bracketed] in the review); `allow` names are the
 *  caller's («marked»). */
export function explain(
  i: Endpoint & { raw?: boolean | undefined; allow?: Record<string, string[]> | undefined } & {
    [k in 'smartAccount' | 'sourceAccount' | 'admins' | 'signers']?: string | string[] | undefined
  },
  item: {
    expr?: Expr | undefined
    contract?: string | undefined
    authority?: Authority | undefined
    overrides?: Override[] | undefined
    /** The rule follows this one's predicate: `expr` is that rule's predicate now. */
    follows?: Followed | undefined
    /** What the owners must know before signing (E-38), read right after any override. */
    warnings?: string[] | undefined
  }
) {
  const roles: Record<string, string> = {}
  const labels: Record<string, string> = {}
  const put = (m: Record<string, string>, label: string, a?: string | string[]) => {
    for (const x of [a ?? []].flat()) m[x] ??= label
  }
  put(roles, 'smart account', i.smartAccount)
  put(roles, 'source account', i.sourceAccount)
  put(roles, 'admin', i.admins)
  put(roles, 'signer', i.signers)
  for (const [k, a] of Object.entries(i.allow ?? {})) if (!/^\d/.test(k)) put(labels, k, a)
  const head = [
    ...(item.overrides?.length ? [overridden(item.overrides)] : []),
    ...(item.warnings?.length ? [warned(item.warnings)] : []),
  ]
  try {
    const view = { roles, labels, raw: i.raw, contract: item.contract, network: i.network }
    const held = item.authority ? [authority(item.authority, view)] : []
    const source = item.follows ? [followed(item.follows, view)] : []
    const body = item.expr === undefined ? [] : tree(item.expr, view)
    const reviewTree = [...head, ...held, ...source, ...body]
    return { review: lines(reviewTree), reviewTree }
  } catch {
    // What a rule follows is said even when the predicate cannot be described.
    const source = item.follows ? [followed(item.follows, { raw: i.raw })] : []
    const reviewTree = [...head, ...source]
    return { review: [...lines(reviewTree), '(this predicate could not be described)'], reviewTree }
  }
}

/** The rule a request is about: the one for `contract`, or the only one. */
function pick(rules: ReturnType<typeof propose>, contract?: string) {
  const hit = contract ? rules.find((r) => r.contract === contract) : rules.length === 1 && rules[0]
  if (!hit) {
    const names = rules.map((r) => r.contract).join(', ')
    throw new Refusal(
      'INVALID_INPUT',
      `${rules.length} rules (${names}): name one with \`contract\``
    )
  }
  return hit
}

/** A predicate given as an expression or as its encoding, validated against the interpreter's `caps`. */
function given(i: { expr?: unknown; encodedPredicate?: string | undefined }, caps: Caps) {
  const kind = exactlyOne(i, ['expr', 'encodedPredicate'])
  let expr: Expr
  try {
    expr = kind === 'expr' ? (i.expr as Expr) : decode(i.encodedPredicate as string)
  } catch (e) {
    throw new Refusal(
      'MALFORMED_PREDICATE',
      `the predicate is not a value the contract could read: ${messageOf(e)}`
    )
  }
  validate(expr, caps)
  const encoded = encode(expr)
  if (kind === 'encodedPredicate' && encoded !== i.encodedPredicate) {
    throw new Refusal(
      'MALFORMED_PREDICATE',
      'the encoding is not canonical: it does not re-encode to itself'
    )
  }
  return { expr, encoded }
}

/** The one contract a predicate pins, which scopes its rule: refused when it pins none or several. */
function onlyContract(e: Expr): string {
  const sel = [...new Set(selectors(e).map((s) => s.contract))]
  if (sel.length === 1 && sel[0] !== '*') return sel[0] as string
  throw new Refusal(
    'INSTALL_BUILD_FAILED',
    'the predicate does not pin one contract: name it with `contract`'
  )
}

/** The rule `i.follow` names, read off the interpreter the request uses: its predicate now. */
async function followOf(
  i: Endpoint & {
    interpreterAddress?: string | undefined
    follow?: z.infer<typeof follow> | undefined
  },
  caps: Caps,
  code: ErrorCode
) {
  const f = i.follow as z.infer<typeof follow>
  const interpreter = interpreterFor(i.network, i.interpreterAddress)
  const ref = { account: f.smartAccount, ruleId: f.ruleId }
  return readFollowed(connect(i), interpreter, ref, caps, code)
}

// ---- the tools ----

const CHECKED = `Every verdict is the interpreter's own \`check\` (a dry run that always fails with its verdict), so the answer is what the contract would do, with its deny code.`

const record_transaction = tool(
  'record_transaction',
  'Decode a Soroban transaction (an on-chain hash, or a base64 envelope) into the calls it authorises: the call it makes, then every nested call its authorisation covers.',
  { ...net, hash: from.hash, xdr: from.xdr },
  async (i) => {
    exactlyOne(i, ['hash', 'xdr'])
    return recordOf(i)
  }
)

const synthesize_policy = tool(
  'synthesize_policy',
  'Turn a transaction, a recording, an intent (the calls to allow, with per-argument constraints (`{constraint: "cap", at, max}`): pin, allow, deny, not, cap, floor, length, count, same, minOut, each, some, total, read, until, from) into rules: one per contract, each with its predicate (a wire expression), its encoding and hash, and its review (`review`, a text tree, and `reviewTree`, nodes each carrying the wire `raw` it was read from; labels are display only; with no hash to fetch, this tool asks no RPC). `ambiguities` are questions whose answers change what is permitted (usually the cap on an amount: answer with `limit`, `limits` or `allow`); `warnings` say what is left open. `heldTo` says which limits the rules were held to: those recorded for the pinned interpreter, else the defaults.',
  { ...net, ...display, ...from },
  async (i) => {
    const s = await sourceOf(i)
    // Proposing needs no live interpreter: the pin's recorded limits are its limits.
    const pin = INTERPRETER[i.network]
    const rules = propose(s.intent, pin?.limits)
    return {
      intent: s.intent,
      rules: rules.map((r) => ({ ...present(r), ...explain(i, r) })),
      heldTo: pin
        ? `the limits recorded for ${pin.address}`
        : `the default limits (no interpreter is pinned for ${i.network})`,
      ambiguities: s.ambiguities,
      warnings: s.warnings,
      ...(s.recording ? { recording: s.recording } : {}),
    }
  }
)

const predicateInput = {
  ...net,
  ...display,
  ...from,
  interpreterAddress: contractId.optional(),
  /** Which rule, when the source covers more than one contract. */
  contract: contractId.optional(),
  expr: val.optional(),
  encodedPredicate: z.string().optional(),
  follow: follow.optional(),
  calls: z.array(call).min(1).max(MAX_CHECKS).optional(),
}

/** The predicate and the calls a simulate or verify is about. */
async function subject(i: z.infer<z.ZodObject<typeof predicateInput>>) {
  const hasSource = SOURCES.some((k) => (i as Record<string, unknown>)[k] !== undefined)
  const hasPred = i.expr !== undefined || i.encodedPredicate !== undefined || i.follow !== undefined
  if (!hasPred && !hasSource)
    throw new Refusal(
      'INVALID_INPUT',
      'give a predicate (expr, encodedPredicate or follow) or a source to build one from'
    )
  // Whatever is checked is held to the limits of the interpreter that checks it: the one named, else
  // the pin. A predicate that is only explained never reaches one, but is held to the same limits when
  // the network names or pins one (so what explains is what installs), and otherwise to the ceilings,
  // the most any instance allows. `heldTo` says which.
  if (i.follow !== undefined) exactlyOne(i, ['expr', 'encodedPredicate', 'follow'])
  const explainOnly = hasPred && !hasSource && i.calls === undefined
  const named = i.interpreterAddress ?? INTERPRETER[i.network]?.address
  // A followed rule is read off the interpreter, so it always needs one.
  const caps =
    explainOnly && !named && i.follow === undefined
      ? CEILINGS
      : await ensureInterpreter(connect(i), i.network, i.interpreterAddress)
  const src = hasSource ? await sourceOf(i) : undefined
  const ref = i.follow && (await followOf(i, caps, 'INVALID_INPUT'))
  const pred = ref || (hasPred ? given(i, caps) : undefined)
  const rule = pred ? undefined : pick(propose((src as Source).intent, caps), i.contract)
  const contexts = src?.recording?.contexts ?? []
  const calls = i.calls ?? contexts.filter((c) => !rule || c.contract === rule.contract)
  const { expr, encoded } = pred ?? (rule as ProposedRule)
  return {
    expr,
    encoded,
    calls: calls as Call[],
    /** Only a predicate was given, no source and no calls: it is explained, nothing is checked. */
    explainOnly,
    heldTo: named ? `the limits of ${named}` : 'the ceilings (no interpreter given)',
    /** What names it: its own pins, the contract of the rule a source made, the rule it follows. */
    item: { expr, contract: rule?.contract, follows: ref?.follows },
  }
}

const simulate_policy = tool(
  'simulate_policy',
  `Say whether a predicate permits each of some calls, and if not with which deny code. Give the predicate (\`expr\` or \`encodedPredicate\`, \`follow\` for an existing rule's predicate as it is now, or a source to build it from) and the calls (\`calls\`, or the recorded ones). With a predicate and no call it only explains the predicate. The answer carries \`review\` (the rule as a text tree) and \`reviewTree\` (the same as nodes, each with the wire \`raw\` it was read from); labels are display only. ${CHECKED}`,
  predicateInput,
  async (i, signal) => {
    const s = await subject(i)
    if (s.calls.length === 0 && !s.explainOnly)
      throw new Refusal('INVALID_INPUT', 'no call to check: give `calls` or a recording')
    // With calls to check, `subject` has checked the interpreter.
    const at = () => interpreterFor(i.network, i.interpreterAddress)
    const verdicts = s.calls.length
      ? await runChecks(connect(i), i.network, at(), s.encoded, s.calls, signal)
      : []
    return {
      predicateHash: hashOf(s.encoded),
      results: s.calls.map((c, n) => ({ call: c, ...verdicts[n] })),
      ...(s.explainOnly ? { heldTo: s.heldTo } : {}),
      ...explain(i, s.item),
    }
  }
)

const verify_policy = tool(
  'verify_policy',
  `Check a predicate against a call it must permit: the call must pass, every constraint is turned against the call and must refuse it, and each conjunct is dropped in turn to see the call it guards get through (minimality). Give the call that must be permitted as \`call\`, or one per branch of an \`or\` as \`calls\` (or a recording). \`ok\` WITHOUT \`complete: true\` does not prove every limit (a swap's spend cap can be \`untested\` while \`ok\` is true): always read \`complete\`. \`ok\` needs every call permitted, every deny case refused, and every branch of an \`or\` taken by a call; a conjunct holding a nested \`or\` that nothing was tried against makes it not \`ok\`. \`complete\` also needs nothing \`untested\`; \`redundant\` lists exact duplicates only. ${CHECKED} At most 64 calls are made in all (a length bound above 255 derives no case), a few at a time.`,
  { ...predicateInput, call: call.optional() },
  async (i, signal) => {
    const s = await subject(i)
    const permits = i.call ? [i.call as Call] : s.calls
    if (permits.length === 0)
      throw new Refusal(
        'INVALID_INPUT',
        'verify needs a call that must be permitted: give `call` or a recording'
      )
    // `subject` has checked the interpreter, or (with none named or pinned) this refuses.
    const interpreter = interpreterFor(i.network, i.interpreterAddress)
    const verified = await verifyRule(connect(i), i.network, interpreter, s.expr, permits, signal)
    return { predicateHash: hashOf(s.encoded), ...verified, ...explain(i, s.item) }
  }
)

const install_policy = tool(
  'install_policy',
  "Build the UNSIGNED transaction that installs a rule on a smart account: `add_context_rule` carrying the interpreter's install parameters, so one signature installs the predicate. Name the rule with a source (as `synthesize_policy`, `contract` choosing among several) or `encodedPredicate` with `contract`, or make it FOLLOW an existing rule with `follow` ({ smartAccount, ruleId } of a rule on the same interpreter): the rule then carries no predicate of its own, the interpreter checks that rule's predicate as it is at every call, and the hash the account's admins sign commits to that reference, not to the predicate. That rule's admins can change what this rule permits without this account's signature, so every refusal below is judged on its predicate as it is now (read live, with its nonce, and shown in `follows` and the review), and a shared signer with any other rule serving the same calls is refused. A followed rule must carry its own predicate (one level only). A KEYLESS rule that follows another is built, with a warning in `warnings` and at the top of the review (E-38): its predicate is its only fence, and the followed rule's admins (its master set, named in the warning) can loosen it at will with that rule's account: through an adapter with no gate anyone could then move funds, through a gated one the gate still limits destinations; follow only a rule whose admins are trusted with these funds. `sourceAccount` must be a signer of the account's rule 0 (that rule authorises the install), and the account must run an OpenZeppelin smart account build this package signs for, read live: the 0.7.2-line `91a2cd56…` or the 0.8.0 `8286422f…`, each signed in the form it asks for (any other build is REFUSED, as for `revoke_policy` and `bind_policy`); `signers` are the keys the rule governs (none, with `executor`, for a keyless rule: it permits only calls that execution adapter vouches for, and nothing until `bind_policy` binds it; a rule scoped to its executor must pin `call_fn = run` or a whole immediate batch: `execute`, wait 0, the number of calls, and each call's target and function_name, else it is REFUSED); `admins` (default: `sourceAccount`) are the Policy Signer role that may later re-install or remove it. The interpreter is checked live before anything is built: it must speak the grammar and run a trusted build (a pinned address, or on a network with none, an `interpreterAddress` whose code hash is one this package trusts). The account's other rules are read: the install is REFUSED when a shared signer could name a looser or unpoliced rule instead (the new rule would never run), or a rolling total would not bind. An unanswered amount cap is refused, and so is a swap's least output that nothing sets. Answer the question a refusal asks; the overrides (`allowOverlap`, `allowUnboundedAmount`, `allowOpenSlippage`, `anyOne`) are the account owners' decision, never a way past a refusal: each one set comes back in `overrides` with the refusal it waived and opens the review, and on mainnet they are refused unless the operator sets POLICY_BUILDER_ALLOW_OVERRIDES=1. `threshold` ({ simple: n }: n of the signers; { weighted: { weights, n } }: signers whose weights total n) attaches OpenZeppelin's threshold policy beside the predicate; with several signers and no threshold (or one a single signer meets) the install is REFUSED, because a rule with a policy is satisfied by any ONE of its signers acting alone; `anyOne` is the owners' override for that, echoed and gated like the others. `spendingLimit` attaches OpenZeppelin's rolling total beside the predicate (ledgers, about five seconds each). The wallet signs the returned XDR.",
  {
    ...net,
    ...display,
    ...from,
    contract: contractId.optional(),
    encodedPredicate: z.string().optional(),
    follow: follow.optional(),
    smartAccount: contractId,
    sourceAccount: account,
    signers: z.array(anyAddress).max(15),
    executor: contractId.optional(),
    admins: z.array(anyAddress).min(1).max(15).optional(),
    name: z.string().min(1).max(20).optional(),
    validUntilLedger: z.number().int().positive().max(0xffffffff).optional(),
    installNonce: z.number().int().positive().optional(),
    spendingLimit: z
      .object({ amount: amount, periodLedgers: z.number().int().positive() })
      .strict()
      .optional(),
    threshold: z
      .union([
        z.object({ simple: u32 }).strict(),
        z
          .object({ weighted: z.object({ weights: z.record(anyAddress, u32), n: u32 }).strict() })
          .strict(),
      ])
      .transform((t) => ('simple' in t ? { n: t.simple } : t.weighted))
      .optional(),
    anyOne: z.boolean().optional(),
    allowUnboundedAmount: z.boolean().optional(),
    allowOpenSlippage: z.boolean().optional(),
    allowOverlap: z.boolean().optional(),
    interpreterAddress: contractId.optional(),
    baseFee,
  },
  async (i, signal) => {
    // A mainnet override without the operator's switch is refused before the network is asked.
    gate(
      i.network,
      INSTALL_OVERRIDES.filter((f) => i[f] === true),
      'INSTALL_BUILD_FAILED'
    )
    // The rule: an encoded predicate scoped by `contract`, or one the source yields.
    let rule: Chosen
    if (i.signers.length === 0 && i.executor === undefined)
      throw new Refusal(
        'INVALID_INPUT',
        'signers: none given; a rule with no signer is keyless and names the `executor` it will be bound to'
      )
    if (i.follow !== undefined) exactlyOne(i, ['follow', 'encodedPredicate', ...SOURCES])
    const caps = await ensureInterpreter(connect(i), i.network, i.interpreterAddress)
    if (i.follow !== undefined) {
      // The rule carries the reference; what it permits is the followed rule's predicate now, and
      // every refusal below is judged on that.
      const f = await followOf(i, caps, 'INSTALL_BUILD_FAILED')
      const contract = i.contract ?? onlyContract(f.expr)
      const encoded = encodeReference(f.follows)
      rule = {
        contract,
        expr: f.expr,
        encoded,
        hash: hashOf(encoded),
        follows: f.follows,
        ...questions(unboundedExpr(f.expr)),
      }
    } else if (i.encodedPredicate !== undefined) {
      const p = given(i, caps)
      const contract = i.contract ?? onlyContract(p.expr)
      rule = {
        contract,
        expr: p.expr,
        encoded: p.encoded,
        hash: hashOf(p.encoded),
        ...questions(unboundedExpr(p.expr)),
      }
    } else {
      const s = await sourceOf(i)
      rule = { ...pick(propose(s.intent, caps), i.contract), ...questions(s.ambiguities) }
    }
    const server = connect(i)
    const chain: Chain = {
      fingerprint: (a) => fingerprint(server, i.network, a),
      readRules: (account, interpreter) =>
        readRules(server, i.network, account, interpreter, signal),
      build: (draft, interpreter) => buildInstall({ ...i, server }, draft, interpreter),
      token: (c) => isToken(server, c),
      contracts: (a) => contractKinds(server, a),
    }
    const plan = await planInstall(i, rule, chain)
    // Only a rule that passed every refusal is described.
    const shown = explain(i, {
      ...rule,
      authority: plan.authority,
      overrides: plan.overrides,
      warnings: plan.warnings,
    })
    return { ...plan, rule: { ...plan.rule, ...shown } }
  }
)

const revoke_policy = tool(
  'revoke_policy',
  'Build the UNSIGNED transaction that removes a rule from a smart account (`remove_context_rule`); the account uninstalls each attached policy itself. The rule is read and returned as `removes`. Rule 0, any Default-scoped rule and a rule scoped to the account itself are REFUSED: removing them can lock the account out of its own administration for good. `allowAdminRule` waives it, as the owners decide: it comes back in `overrides` and opens the review of `removes`, and on mainnet it is refused unless the operator sets POLICY_BUILDER_ALLOW_OVERRIDES=1.',
  {
    ...net,
    ...display,
    smartAccount: contractId,
    sourceAccount: account,
    ruleId: z.number().int().nonnegative(),
    allowAdminRule: z.boolean().optional(),
    baseFee,
  },
  async (i) => {
    gate(i.network, i.allowAdminRule === true ? ['allowAdminRule'] : [], 'REVOKE_BUILD_FAILED')
    const server = connect(i)
    const mine = INTERPRETER[i.network]?.address
    // The account's own rule is described only if the account is a build the package knows: any
    // other answers with whatever it likes.
    const trusted = trustedAccount(server, i.smartAccount)
    const plan = await planRevoke(i, {
      readRule: async (id) =>
        readRule(server, i.network, i.smartAccount, id, (await trusted).known ? mine : undefined),
      build: (id) => buildRevoke({ ...i, server }, id),
    })
    const r = plan.removes
    // An override opens the review of what is removed, described or not.
    const contract = r.scope.kind === 'call_contract' ? r.scope.contract : undefined
    const shown =
      r.expr || r.follows || plan.overrides.length
        ? explain(i, { expr: r.expr, contract, overrides: plan.overrides, follows: r.follows })
        : {}
    // `reviewSkipped` covers a build the package signs for but does not describe: it is reached
    // only when `trusted.known` is false yet `buildRevoke` succeeded. `buildRevoke` goes through
    // `buildSelfCall`/`accountAuthOf`, which refuses any build outside `OZ_ACCOUNT_AUTH`, and
    // `trusted.known` is `OZ_ACCOUNT_WASM.has(code)`; with those two sets equal today the branch
    // is unreachable. It is kept for an account build added to `OZ_ACCOUNT_AUTH` (signable) but not
    // to `OZ_ACCOUNT_WASM` (whose rules the package would then not describe).
    const skipped = (await trusted).known
      ? {}
      : { reviewSkipped: notKnown(i.smartAccount, await trusted) }
    return { ...plan, removes: { ...r, ...shown, ...skipped } }
  }
)

const bind_policy = tool(
  'bind_policy',
  "Build the UNSIGNED transaction that binds a rule to an executor: the interpreter's `bind_executor((smartAccount, ruleId), executor)`. A bound rule permits a call only with that executor's grant for it (the executor's own `run` excepted), and a keyless rule (installed with no signers and `executor`) permits nothing until it is bound. The rule is read first, with its stored predicate, executor and admins; the build is REFUSED unless the rule is policed by the pinned interpreter with a predicate the package can read, the executor is an execution adapter (read off the ledger), a rule scoped to the executor pins `call_fn = run` or a whole immediate batch (`execute`, wait 0, the number of calls, each call's target and function_name; the interpreter refuses anything else with 221), and the rule's admins are the source account alone (each admin signs `bind_executor`). With no gate, the adapter vouches for every call of an immediate batch anyone runs through it, so the rule's predicate is the only fence: the review says so. A keyless rule that follows another comes back with the E-38 warning in `warnings` (its followed rule's admins can loosen that only fence at will; worded for the executor's kind). The rule comes back as `binds` with its review; `rebinds` names an executor it replaces. The wallet signs the returned XDR.",
  {
    ...net,
    ...display,
    smartAccount: contractId,
    sourceAccount: account,
    ruleId: z.number().int().nonnegative().max(0xffffffff),
    executor: contractId,
    interpreterAddress: contractId.optional(),
    baseFee,
  },
  async (i) => {
    const server = connect(i)
    const interpreter = interpreterFor(i.network, i.interpreterAddress)
    const plan = await planBind(i, interpreter, {
      readRule: (id) => readRule(server, i.network, i.smartAccount, id, interpreter),
      readRules: () => readRules(server, i.network, i.smartAccount, interpreter),
      kind: async (a) => (await contractKinds(server, [a]))[a] ?? 'absent',
      fingerprint: (a) => fingerprint(server, i.network, a),
      build: () => buildBind({ ...i, server }, interpreter, i.ruleId, i.executor),
    })
    return bound(i, interpreter, plan)
  }
)

/** What `bind_policy` returns for a binding `planBind` made: the plan, with the rule it binds and
 *  that rule's review (its authority with the executor, any E-38 warning, what it follows, its
 *  predicate). */
export function bound(
  i: Parameters<typeof explain>[0],
  interpreter: string,
  plan: Awaited<ReturnType<typeof planBind>>
) {
  const r = plan.binds
  const contract = r.scope.kind === 'call_contract' ? r.scope.contract : undefined
  const authority: Authority = {
    signers: r.signers,
    executor: { address: r.executor, kind: plan.executorKind },
    ...(r.admins ? { admins: r.admins } : {}),
    interpreter,
  }
  const shown = explain(i, {
    expr: r.expr,
    contract,
    authority,
    follows: r.follows,
    warnings: plan.warnings,
  })
  return { ...plan, binds: { ...r, ...shown } }
}

/** The code an account runs, and whether it is an OpenZeppelin smart account build the package
 *  knows. A failure to read the code is `unread`, never "not a known build": it says nothing of the account. */
async function trustedAccount(server: ReturnType<typeof connect>, account: string) {
  try {
    const code = await codeHash(server, account)
    return { code, known: code !== undefined && OZ_ACCOUNT_WASM.has(code), unread: undefined }
  } catch (e) {
    return { code: undefined, known: false, unread: messageOf(e) }
  }
}
/** What `revoke_policy` says of a rule it does not describe: what it still shows is the account's word. */
const notKnown = (account: string, t: Awaited<ReturnType<typeof trustedAccount>>) =>
  `${
    t.unread === undefined
      ? `${account} does not run a known OpenZeppelin smart account build (code ${t.code ?? 'none'})`
      : `could not read the account's code (${t.unread})`
  }: its stored predicate is not described; scope, signers and policies are as the account reports them, unverified`

const get_interpreter_info = tool(
  'get_interpreter_info',
  'The interpreter a network uses: its pinned address, grammar version and wasm sha256, `limits` (the caps the instance was deployed with: recorded for the pin, else read from it with `limits()`, and a contract that does not answer, or answers more than the `ceilings`, is refused) and, with `verifyLive`, what is deployed at that address right now (grammar_version(), the code hash and limits) and whether it matches the pin.',
  {
    ...net,
    verifyLive: z.boolean().optional(),
    interpreterAddress: contractId.optional(),
  },
  async (i) => {
    const address = interpreterFor(i.network, i.interpreterAddress)
    const wasm = pinnedWasm(i.network, address)
    // What a build this package does not trust says of itself is shown by `verifyLive`, never believed.
    const live = i.verifyLive ? await fingerprint(connect(i), i.network, address) : undefined
    const from = live ? undefined : wasm ? 'recorded' : 'live'
    const limits = live
      ? (live.limits ?? null)
      : (INTERPRETER[i.network]?.limits ??
        (await ensureInterpreter(connect(i), i.network, address)))
    return {
      network: i.network,
      address,
      pinned: wasm !== undefined,
      grammarVersion: GRAMMAR_VERSION,
      wasmSha256: wasm ?? null,
      trustedWasmSha256: [...INTERPRETER_WASM],
      limits,
      ...(from ? { limitsFrom: from } : {}),
      ceilings: CEILINGS,
      ...(live ? { live } : {}),
    }
  }
)

const review_unsigned = tool(
  'review_unsigned',
  "Review an UNSIGNED transaction from `install_policy`, `revoke_policy` or `bind_policy` from its bytes alone, with no RPC: for the account owner's side (a wallet or the Prime app) to run on the XDR it is about to sign, with `smartAccount` naming the account the owner means to change. `problems` lists what is wrong in the bytes themselves: a shape the builder never makes (an authorisation for anything but the call, a rule other than 0, a `__check_auth` argument that does not match on this network (either form: the 0.7.2-line account's digest bytes or the OpenZeppelin 0.8.0 account's preimage struct; `auth.form` says which), a signer other than the source, no time bound or a longer one, a fee above the ceiling, a precondition or memo, an External signer or admin) or a value it can check offline (an interpreter other than the pin, a predicate whose hash does not match its bytes, a policy the package does not know), and an envelope that already carries a signature. With `readContracts: true` (through the operator's RPC, the one exception to no RPC) the account's code is read too: an account that runs no OpenZeppelin build the package signs for, or an authorisation in another form than its build asks for, is a problem. A contract signer is a problem unless `readContracts: true` reads it off the ledger: then only an execution adapter bound to no gate, an execution adapter signing a rule scoped to itself that does not pin call_fn = run, or a contract that is not deployed, is a problem. A binding (`bind_executor` on the interpreter) names an executor: it is a problem unless `readContracts: true` shows it to be an execution adapter, and one with no gate is described as what it is (anyone may run an immediate batch through it, so the bound rule's predicate is the only fence). An install that follows another rule (`follow`) carries no predicate: it is a problem unless `readContracts: true` also reads that rule's predicate and nonce now off the pinned interpreter, which the review then shows under Follows, with the warning that its admins can change it without this account. `warnings` lists what is allowed but must be known before signing, none of it a problem: a keyless install that follows another rule (E-38: the followed rule's admins can loosen its only fence at will, and anyone could then move funds through the adapter it is bound to; with `readContracts` the warning names those admins). Every other contract (a seat, a smart account, an adapter with a gate signing any other rule, any contract an agent deployed) then reads signable unvetted: the owner checks who controls it. `signable` means no problem was found; it does NOT mean safe to sign. An agent can rewrite the unsigned bytes consistently (itself as admin or signer, a threshold dropped, a cap raised with a matching hash) and they come back signable; so do installs that used an override and rules the builder would refuse for reasons it does not check from the bytes (overlap, read safety, 1-of-n). The owner must read `review`/`reviewTree`: the problems first, then the transaction (call, source, fee, time bound, authorisation expiry), then for an install the Authority node (signers, who can act alone, admins, expiry, total, interpreter) and the predicate, all read from the bytes.",
  {
    ...net,
    ...display,
    xdr: z.string().min(1).max(400_000),
    smartAccount: contractId.optional(),
    readContracts: z.boolean().optional(),
  },
  async (i) => {
    // Bytes the decoder refuses are refused before any read.
    const offline = reviewUnsigned(i)
    // The rule's scope too, when a keyed rule there could hand out an adapter's word (E-36).
    const scope = offline.rule?.scope
    const scopedTo =
      Array.isArray(scope) && scope[0] === 'CallContract' ? String(scope[1]) : undefined
    const keyed = (offline.authority?.signers.length ?? 0) > 0
    const leak =
      keyed && scopedTo && !keyedSafeOnNoGate(offline.rule?.predicate, !!offline.rule?.follows)
    const signers = [
      ...new Set([
        ...(offline.authority?.signers.filter((s) => s.startsWith('C')) ?? []),
        ...(offline.binds ? [offline.binds.executor] : []),
      ]),
    ]
    const ref = offline.rule?.follows
    const asked = leak && !signers.includes(scopedTo) ? scopedTo : undefined
    if (i.readContracts !== true) return offline
    const server = connect(i)
    // A signer that cannot be read refuses the review; a scope or an account code that cannot be
    // read stays a problem. The account's code says which authorisation form it asks for.
    const [contracts, scopeKind, followed, accountCode] = await Promise.all([
      signers.length ? contractKinds(server, signers) : undefined,
      asked ? contractKinds(server, [asked]).catch(() => undefined) : undefined,
      ref && followedFor(server, i.network, offline.authority?.interpreter, ref),
      codeHash(server, offline.smartAccount).then(
        (wasmSha256) => ({ wasmSha256 }),
        (e) => ({ error: messageOf(e) })
      ),
    ])
    const all = contracts || scopeKind ? { ...scopeKind, ...contracts } : undefined
    return reviewUnsigned({ ...i, contracts: all, followed, accountCode })
  }
)

/** The rule a reviewed install follows, read off the interpreter it names when that is the pin (any
 *  other interpreter's records are its own word), or why it was not read. */
async function followedFor(
  server: ReturnType<typeof connect>,
  network: Network,
  interpreter: string | undefined,
  ref: Reference
) {
  const pin = INTERPRETER[network]
  if (!pin || interpreter !== pin.address)
    return {
      error: `the rule is not policed by the pinned ${network} interpreter, so its records are not read`,
    }
  try {
    const f = await readFollowed(server, pin.address, ref, pin.limits, 'INVALID_INPUT')
    return { expr: f.expr, follows: f.follows }
  } catch (e) {
    return { error: messageOf(e) }
  }
}

const solanaKey = z.string().refine(isSolanaKey, 'a base58 Solana public key')
const base64 = z.string().min(1).max(20_000)

const solana_review = tool(
  'solana_review',
  "Review an UNSIGNED Squads Smart Account transaction on Solana (devnet) from its bytes alone, with no RPC: for an account owner to run on the transaction it is about to sign. Give the whole transaction (`transaction`, base64, signature slots included) or its message alone (`message`), `role` (`custody`: the account that holds the funds, whose rules pin venue and token calls; `prime`: the Prime account, whose bands pin Squads' execute_transaction_sync_v2 into a custody rule) and `account` (the Squads account the owner means: the settings account, or for an execution the rule's policy account). It decodes a settings change (execute_settings_transaction_sync or create_settings_transaction: the rules it adds, edits or removes, owners, threshold, time lock) and an execution (execute_transaction_sync_v2: the calls it makes, a nested band-to-custody execution included) and checks them against the configuration-only design. `problems` (each one a reason not to sign) include: a ProgramInteraction rule with no instruction constraints, which admits ANY instruction (STRIDE E-02); a SettingsChange policy (on custody it defeats the 3-of-3 and the trustee, E-03); a SpendingLimit policy or legacy spending limit (with no destinations it pays anyone, E-04); an InternalFundTransfer policy or a hook; a constraint with no discriminator or token tag pinned; a program the role never pins (custody: klend and the token programs; prime: Squads' execute_transaction_sync_v2), klend v1 or an unknown klend instruction, a token Approve, SetAuthority, CloseAccount or freeze; a destination, source or reserve that is not pinned (klend _v2 deposit, borrow, repay, withdraw, liquidate positions; token transfer and mint destinations; a band's account 0), or pinned outside `destinations` when given; a repay whose obligation is not pinned (klend binds a repay to no owner); a collateral withdraw without the has_debt == 0 read (U8 @2287, owner klend) when the change also permits a borrow or `requireNoDebt` is set; a liquidation without the marked read (U64Le @2336 > 0, owner klend); a signer outside `signers` when given; a threshold below 3 on custody or 2 on the Prime account; a settings time lock below `minTimeLock`; and in the envelope a signature already present, a durable nonce, a top-level instruction other than compute budget and Scope or klend refreshes, a lookup-table account where the Squads account should be, or an `account` that is missing or differs. `warnings` (allowed, but to know): a rule edit refills its spending limits, a rule with no expiry, no per-call ceiling, a time lock dropped to 0, a settings-level execution. `signable` means no problem was found; it does NOT mean safe to sign: the owner must read `review`/`reviewTree` (problems first, then the transaction, then each rule's signers, who can act alone, expiry, every constraint and spending limit). Squads `0e51082`, klend `e921c64` (1.26 offsets).",
  {
    transaction: base64.optional(),
    message: base64.optional(),
    role: z.enum(['custody', 'prime']),
    account: solanaKey.optional(),
    destinations: z.array(solanaKey).min(1).max(64).optional(),
    signers: z.array(solanaKey).min(1).max(64).optional(),
    requireNoDebt: z.boolean().optional(),
    minTimeLock: z.number().int().nonnegative().max(0xffffffff).optional(),
    raw: z.boolean().optional(),
  },
  async (i) => {
    exactlyOne(i, ['transaction', 'message'])
    return reviewSolana(i)
  }
)

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x address')
const evmUint = z.string().regex(/^\d{1,78}$/, 'a non-negative integer, as a string')

const evm_review = tool(
  'evm_review',
  "Review an UNSIGNED Safe transaction (Safe 1.4.1 or 1.5.0, Zodiac Roles v2.1.1) from its bytes alone, with no RPC: for an owner to run on the Safe transaction it is about to sign. Give it as `safeTx` (to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce) or as `calldata` (execTransaction, signatures empty, with `nonce`), with `safe` (the Safe the owner means), `chainId` (default 84532, Base Sepolia) and `role` (`custody`: the custody Safe and its gate; `prime`: the Prime account and its bands). It returns the EIP-712 `safeTxHash` to compare with the wallet, decodes a MultiSend batch, and decodes every Roles call (scopeTarget, scopeFunction with its condition tree, allowTarget, allowFunction, revokeTarget, revokeFunction, setAllowance, assignRoles, setDefaultRole, setTransactionUnwrapper, setUp) and every Safe setting call. `problems` (each one a reason not to sign): an under-read scoping (allowTarget opens every function; allowFunction or a tree that constrains nothing takes any arguments); a wrong layout (a Matches whose children differ in number or type from the function's ABI, so arguments past the last one read pass unchecked; a band's inner call with no Bitmask pinning its four selector bytes); a recipient not pinned to the avatar (supply or deposit onBehalfOf, withdraw to, transfer to, transferFrom to, repay onBehalfOf: EqualToAvatar, or EqualTo one of `recipients`) or an unpinned approval spender, on the custody gate; a band that leaves the gate call's target, value, operation, role key or shouldRevert open, or reaches execTransactionFromModule; a revokeTarget without revoking that target's functions in the same batch (revokeTarget keeps the function scopes, which return on the next scopeTarget); calldata past the last argument of any decoded call; a Custom condition, a DelegateCall execution option, a borrow, credit delegation or Permit2 on the gate; an unwrap adapter other than the Roles MultiSend unwrapper; a Roles module set up, re-owned or re-pointed to anything but the Safe; a delegatecall other than MultiSend 1.4.1 (and CreateCall deploying the exact Roles proxy); a guard or fallback handler; a threshold below 3 on custody or 2 on the Prime account; the Safe itself calling a venue; a gas refund, value sent, or signatures already present; `safe` missing. `warnings`: every scopeTarget (stored function scopes come back), a band leaving a recipient for the gate to pin, no ceiling on a band's amount, a function with no known ABI, owner changes. `signable` means no problem was found; it does NOT mean safe to sign: read `review`/`reviewTree` (the transaction and its hash, then each call and its condition tree). Roles v2.1.1 `218a5164`, Safe `v1.4.1`.",
  {
    safeTx: z
      .object({
        to: evmAddress,
        value: evmUint.optional(),
        data: z
          .string()
          .regex(/^0x([0-9a-fA-F]{2})*$/)
          .max(400_000)
          .optional(),
        operation: z.union([z.literal(0), z.literal(1)]).optional(),
        safeTxGas: evmUint.optional(),
        baseGas: evmUint.optional(),
        gasPrice: evmUint.optional(),
        gasToken: evmAddress.optional(),
        refundReceiver: evmAddress.optional(),
        nonce: evmUint.optional(),
      })
      .strict()
      .optional(),
    calldata: z
      .string()
      .regex(/^0x([0-9a-fA-F]{2})*$/)
      .max(400_000)
      .optional(),
    nonce: evmUint.optional(),
    safe: evmAddress.optional(),
    chainId: z
      .number()
      .int()
      .positive()
      .max(2 ** 48)
      .optional(),
    role: z.enum(['custody', 'prime']),
    recipients: z.array(evmAddress).min(1).max(64).optional(),
    raw: z.boolean().optional(),
  },
  async (i) => {
    exactlyOne(i, ['safeTx', 'calldata'])
    return reviewEvm(i)
  }
)

export const TOOLS: Tool[] = [
  record_transaction,
  synthesize_policy,
  simulate_policy,
  verify_policy,
  install_policy,
  revoke_policy,
  bind_policy,
  get_interpreter_info,
  review_unsigned,
  solana_review,
  evm_review,
]

export const run = (
  name: string,
  input: unknown,
  signal?: AbortSignal
): Promise<ToolResponse<unknown>> => {
  const t = TOOLS.find((x) => x.name === name)
  return t
    ? t.run(input, signal)
    : Promise.resolve({
        ok: false,
        error: { code: 'INVALID_INPUT', message: `unknown tool ${name}`, retryable: false },
      })
}
