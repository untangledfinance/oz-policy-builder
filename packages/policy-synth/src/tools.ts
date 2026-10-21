// The eight tools, one definition each: a name, a description, an input shape and
// a body. `tool()` is the only place input is validated, errors become the
// response envelope, and a thrown refusal gets its code; the MCP server and the
// CLI both register straight from `TOOLS`, so neither holds any logic.
//
// Nothing here holds a key. Install and revoke return an unsigned transaction.

import { StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'
import { type Authority, authority, lines, overridden, tree } from './card.ts'
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
import { GRAMMAR_VERSION, INTERPRETER, INTERPRETER_WASM, OZ_ACCOUNT_WASM } from './config.ts'
import { type ErrorCode, messageOf, Refusal, type ToolResponse } from './envelope.ts'
import {
  buildInstall,
  buildRevoke,
  type Chain,
  type Chosen,
  gate,
  INSTALL_OVERRIDES,
  type Override,
  planInstall,
  planRevoke,
} from './install.ts'
import type { Intent } from './intent.ts'
import { type Call, decodeEnvelope, type Recording, recordHash } from './record.ts'
import { reviewUnsigned } from './review.ts'
import { readRule, readRules, selectors } from './rules.ts'
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
  hashOf,
  validate,
  WireError,
} from './wire.ts'

// ---- input fragments ----

const net = {
  network: z.enum(['mainnet', 'testnet']).default('testnet'),
}
/** `raw`: the review shows full addresses, raw values and where each name came from on the wire. */
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
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(val), z.record(val)])
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
  limits: z.record(amount).optional(),
  allow: z.record(z.array(anyAddress).min(1)).optional(),
}

// ---- the wrapper ----

export interface Tool {
  name: string
  description: string
  shape: z.ZodRawShape
  /** The input as a strict object: an unknown key is refused, wherever the tool is served from. */
  schema: z.ZodObject<z.ZodRawShape, 'strict'>
  run: (raw: unknown, signal?: AbortSignal) => Promise<ToolResponse<unknown>>
}

const CODE: Record<string, ErrorCode> = {
  record_transaction: 'RECORDING_FAILED',
  synthesize_policy: 'SYNTHESIS_ERROR',
  simulate_policy: 'SIMULATION_ERROR',
  verify_policy: 'VERIFICATION_FAILED',
  install_policy: 'INSTALL_BUILD_FAILED',
  revoke_policy: 'REVOKE_BUILD_FAILED',
  get_interpreter_info: 'INTERPRETER_MISMATCH',
  review_unsigned: 'INVALID_INPUT',
}

function tool<S extends z.ZodRawShape>(
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
  const head = item.overrides?.length ? [overridden(item.overrides)] : []
  try {
    const view = { roles, labels, raw: i.raw, contract: item.contract, network: i.network }
    const held = item.authority ? [authority(item.authority, view)] : []
    const reviewTree = [...head, ...held, ...(item.expr === undefined ? [] : tree(item.expr, view))]
    return { review: lines(reviewTree), reviewTree }
  } catch {
    return { review: [...lines(head), '(this predicate could not be described)'], reviewTree: head }
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
  'Turn a transaction, a recording, an intent (the calls to allow, with per-argument constraints (`{constraint: "cap", at, max}`): pin, allow, deny, cap, floor, length, minOut, each, some, total, read, until, from) into rules: one per contract, each with its predicate (a wire expression), its encoding and hash, and its review (`review`, a text tree, and `reviewTree`, nodes each carrying the wire `raw` it was read from; labels are display only; with no hash to fetch, this tool asks no RPC). `ambiguities` are questions whose answers change what is permitted (usually the cap on an amount: answer with `limit`, `limits` or `allow`); `warnings` say what is left open. `heldTo` says which limits the rules were held to: those recorded for the pinned interpreter, else the defaults.',
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
  calls: z.array(call).min(1).max(MAX_CHECKS).optional(),
}

/** The predicate and the calls a simulate or verify is about. */
async function subject(i: z.infer<z.ZodObject<typeof predicateInput>>) {
  const hasSource = SOURCES.some((k) => (i as Record<string, unknown>)[k] !== undefined)
  const hasPred = i.expr !== undefined || i.encodedPredicate !== undefined
  if (!hasPred && !hasSource)
    throw new Refusal(
      'INVALID_INPUT',
      'give a predicate (expr or encodedPredicate) or a source to build one from'
    )
  // Whatever is checked is held to the limits of the interpreter that checks it: the one named, else
  // the pin. A predicate that is only explained never reaches one, but is held to the same limits when
  // the network names or pins one (so what explains is what installs), and otherwise to the ceilings,
  // the most any instance allows. `heldTo` says which.
  const explainOnly = hasPred && !hasSource && i.calls === undefined
  const named = i.interpreterAddress ?? INTERPRETER[i.network]?.address
  const caps =
    explainOnly && !named
      ? CEILINGS
      : await ensureInterpreter(connect(i), i.network, i.interpreterAddress)
  const src = hasSource ? await sourceOf(i) : undefined
  const pred = hasPred ? given(i, caps) : undefined
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
    /** What names it: its own pins, and the contract of the rule a source made. */
    item: { expr, contract: rule?.contract },
  }
}

const simulate_policy = tool(
  'simulate_policy',
  `Say whether a predicate permits each of some calls, and if not with which deny code. Give the predicate (\`expr\` or \`encodedPredicate\`, or a source to build it from) and the calls (\`calls\`, or the recorded ones). With a predicate and no call it only explains the predicate. The answer carries \`review\` (the rule as a text tree) and \`reviewTree\` (the same as nodes, each with the wire \`raw\` it was read from); labels are display only. ${CHECKED}`,
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
  "Build the UNSIGNED transaction that installs a rule on a smart account: `add_context_rule` carrying the interpreter's install parameters, so one signature installs the predicate. Name the rule with a source (as `synthesize_policy`, `contract` choosing among several) or `encodedPredicate` with `contract`. `sourceAccount` must be a signer of the account's rule 0 (that rule authorises the install); `signers` are the keys the rule governs; `admins` (default: `sourceAccount`) are the Policy Signer role that may later re-install or remove it. The interpreter is checked live before anything is built: it must speak the grammar and run a trusted build (a pinned address, or on a network with none, an `interpreterAddress` whose code hash is one this package trusts). The account's other rules are read: the install is REFUSED when a shared signer could name a looser or unpoliced rule instead (the new rule would never run), or a rolling total would not bind. An unanswered amount cap is refused, and so is a swap's least output that nothing sets. Answer the question a refusal asks; the overrides (`allowOverlap`, `allowUnboundedAmount`, `allowOpenSlippage`, `anyOne`) are the account owners' decision, never a way past a refusal: each one set comes back in `overrides` with the refusal it waived and opens the review, and on mainnet they are refused unless the operator sets POLICY_BUILDER_ALLOW_OVERRIDES=1. `threshold` ({ simple: n }: n of the signers; { weighted: { weights, n } }: signers whose weights total n) attaches OpenZeppelin's threshold policy beside the predicate; with several signers and no threshold (or one a single signer meets) the install is REFUSED, because a rule with a policy is satisfied by any ONE of its signers acting alone; `anyOne` is the owners' override for that, echoed and gated like the others. `spendingLimit` attaches OpenZeppelin's rolling total beside the predicate (ledgers, about five seconds each). The wallet signs the returned XDR.",
  {
    ...net,
    ...display,
    ...from,
    contract: contractId.optional(),
    encodedPredicate: z.string().optional(),
    smartAccount: contractId,
    sourceAccount: account,
    signers: z.array(anyAddress).min(1).max(15),
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
    const caps = await ensureInterpreter(connect(i), i.network, i.interpreterAddress)
    if (i.encodedPredicate !== undefined) {
      const p = given(i, caps)
      const sel = [...new Set(selectors(p.expr).map((s) => s.contract))]
      const contract = i.contract ?? (sel.length === 1 && sel[0] !== '*' ? sel[0] : undefined)
      if (!contract)
        throw new Refusal(
          'INSTALL_BUILD_FAILED',
          'the predicate does not pin one contract: name it with `contract`'
        )
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
    const shown = explain(i, { ...rule, authority: plan.authority, overrides: plan.overrides })
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
      r.expr || plan.overrides.length
        ? explain(i, { expr: r.expr, contract, overrides: plan.overrides })
        : {}
    const skipped = (await trusted).known
      ? {}
      : { reviewSkipped: notKnown(i.smartAccount, await trusted) }
    return { ...plan, removes: { ...r, ...shown, ...skipped } }
  }
)

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
  "Review an UNSIGNED transaction from `install_policy` or `revoke_policy` from its bytes alone, with no RPC: for the account owner's side (a wallet or the Prime app) to run on the XDR it is about to sign, with `smartAccount` naming the account the owner means to change. `problems` lists what is wrong in the bytes themselves: a shape the builder never makes (an authorisation for anything but the call, a rule other than 0, a `__check_auth` digest that does not match on this network, a signer other than the source, no time bound or a longer one, a fee above the ceiling, a precondition or memo, an External signer or admin) or a value it can check offline (an interpreter other than the pin, a predicate whose hash does not match its bytes, a policy the package does not know), and an envelope that already carries a signature. A contract signer is a problem unless `readContracts: true` reads it off the ledger through the operator's RPC (the one exception to no RPC): then only an execution adapter bound to no gate, an execution adapter signing a rule scoped to itself that does not pin call_fn = run, or a contract that is not deployed, is a problem. Every other contract (a seat, a smart account, an adapter with a gate signing any other rule, any contract an agent deployed) then reads signable unvetted: the owner checks who controls it. `signable` means no problem was found; it does NOT mean safe to sign. An agent can rewrite the unsigned bytes consistently (itself as admin or signer, a threshold dropped, a cap raised with a matching hash) and they come back signable; so do installs that used an override and rules the builder would refuse for reasons it does not check from the bytes (overlap, read safety, 1-of-n). The owner must read `review`/`reviewTree`: the problems first, then the transaction (call, source, fee, time bound, authorisation expiry), then for an install the Authority node (signers, who can act alone, admins, expiry, total, interpreter) and the predicate, all read from the bytes.",
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
    const signers = offline.authority?.signers.filter((s) => s.startsWith('C')) ?? []
    if (i.readContracts !== true || signers.length === 0) return offline
    return reviewUnsigned({ ...i, contracts: await contractKinds(connect(i), signers) })
  }
)

export const TOOLS: Tool[] = [
  record_transaction,
  synthesize_policy,
  simulate_policy,
  verify_policy,
  install_policy,
  revoke_policy,
  get_interpreter_info,
  review_unsigned,
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
