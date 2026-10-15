// The seven tools, one definition each: a name, a description, an input shape and
// a body. `tool()` is the only place input is validated, errors become the
// response envelope, and a thrown refusal gets its code; the MCP server and the
// CLI both register straight from `TOOLS`, so neither holds any logic.
//
// Nothing here holds a key. Install and revoke return an unsigned transaction.

import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'
import { card } from './card.ts'
import {
  connect,
  type Endpoint,
  ensureInterpreter,
  fingerprint,
  interpreterFor,
  mismatch,
  pinnedWasm,
} from './chain.ts'
import { MAX_CHECKS, runChecks, verifyRule } from './check.ts'
import {
  GRAMMAR_VERSION,
  INTERPRETER_WASM,
  type Network,
  POLICY_CONTRACTS,
  SPENDING_LIMIT,
} from './config.ts'
import { type ErrorCode, messageOf, Refusal, type ToolResponse } from './envelope.ts'
import { buildInstall, buildRevoke, type RuleDraft } from './install.ts'
import type { Intent } from './intent.ts'
import { type Call, decodeEnvelope, type Recording, recordHash } from './record.ts'
import { TEMPLATES } from './registry.ts'
import { overlaps, readRules, selectors } from './rules.ts'
import { type Answers, type ProposedRule, propose, type Synthesis, synthesize } from './synth.ts'
import { CAPS, decode, type Expr, encode, hashOf, validate, WireError } from './wire.ts'

// ---- input fragments ----

const net = {
  network: z.enum(['mainnet', 'testnet']).default('testnet'),
  rpcUrl: z.string().url().optional(),
  allowUnpinnedRpcUrl: z.boolean().optional(),
}
const account = z.string().refine(StrKey.isValidEd25519PublicKey, 'a G... account')
const contractId = z.string().refine(StrKey.isValidContract, 'a C... contract')
const anyAddress = z.union([account, contractId])
const amount = z
  .string()
  .regex(/^[1-9]\d*$/, 'a positive integer in the smallest unit, as a string')
const val: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(val), z.record(val)])
)
const path = z.array(z.union([z.number().int().nonnegative(), z.string().min(1)]))
const arg = z.object({ arg: path.min(1) }).strict()
const cmp = z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])

const rule: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('rule', [
    z.object({ rule: z.enum(['pin', 'not']), at: path, to: val }).strict(),
    z
      .object({ rule: z.literal('allow'), at: path, in: z.array(val).min(1).max(CAPS.entries) })
      .strict(),
    z
      .object({ rule: z.literal('deny'), at: path, nin: z.array(val).min(1).max(CAPS.entries) })
      .strict(),
    z.object({ rule: z.literal('cap'), at: path, max: amount }).strict(),
    z.object({ rule: z.literal('floor'), at: path, min: z.string().regex(/^-?\d+$/) }).strict(),
    z.object({ rule: z.literal('length'), at: path, max: z.number().int().nonnegative() }).strict(),
    z.object({ rule: z.literal('minOut'), at: path, of: path, num: amount, den: amount }).strict(),
    z.object({ rule: z.enum(['each', 'some']), at: path, where: z.array(rule).min(1) }).strict(),
    z.object({ rule: z.literal('total'), at: path, of: path.optional(), max: amount }).strict(),
    z
      .object({
        rule: z.literal('read'),
        contract: contractId,
        fn: z.string().min(1),
        args: z.array(z.union([arg, val])).optional(),
        path: path.optional(),
        op: cmp,
        to: val,
      })
      .strict(),
    z.object({ rule: z.enum(['until', 'from']), ts: z.number().int().positive() }).strict(),
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

/** What to make a rule of: a transaction (by hash or as XDR), a recording, an intent,
 *  or a template; exactly one. The answers say what a transaction cannot. */
const from = {
  hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
  xdr: z.string().min(1).max(400_000).optional(),
  recording: recording.optional(),
  intent: intent.optional(),
  template: z
    .object({
      name: z.enum(Object.keys(TEMPLATES) as [keyof typeof TEMPLATES]),
      params: z.record(z.unknown()),
    })
    .strict()
    .optional(),
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
      severity: 'error' as const,
      retryable: extra.retryable ?? false,
      remediation: { toolCall: { name, args: {} } },
      ...(extra.details === undefined ? {} : { details: extra.details }),
    },
  })
  return {
    name,
    description,
    shape,
    schema,
    async run(raw, signal) {
      const parsed = schema.safeParse(raw)
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

const SOURCES = ['hash', 'xdr', 'recording', 'intent', 'template']
const exactlyOne = (i: object, keys: string[]): string => {
  const given = keys.filter((k) => (i as Record<string, unknown>)[k] !== undefined)
  if (given.length !== 1)
    throw new Refusal('INVALID_INPUT', `give exactly one of ${keys.join(', ')}`)
  return given[0] as string
}

// ---- shared steps ----

type Source = Synthesis & { recording?: Recording }

async function recordOf(
  i: Endpoint & { hash?: string | undefined; xdr?: string | undefined }
): Promise<Recording> {
  if (i.xdr !== undefined) return decodeEnvelope(i.xdr, i.network)
  const other: Network = i.network === 'mainnet' ? 'testnet' : 'mainnet'
  // The wrong-network hint asks the other network's own endpoint, so only when this one is.
  const probe = i.rpcUrl === undefined ? connect({ network: other }) : undefined
  return recordHash(connect(i), i.network, i.hash as string, probe)
}

async function sourceOf(i: z.infer<z.ZodObject<typeof from & typeof net>>): Promise<Source> {
  const kind = exactlyOne(i, SOURCES)
  if (kind === 'intent') return { intent: i.intent as Intent, warnings: [], ambiguities: [] }
  if (kind === 'template') {
    const t = i.template as NonNullable<typeof i.template>
    const make = TEMPLATES[t.name] as (p: unknown) => Intent
    return { intent: make(t.params), warnings: [], ambiguities: [] }
  }
  const rec = kind === 'recording' ? (i.recording as Recording) : await recordOf(i)
  const answers: Answers = { limit: i.limit, limits: i.limits, allow: i.allow as Answers['allow'] }
  return { recording: rec, ...synthesize(rec.contexts, answers) }
}

const present = (r: ReturnType<typeof propose>[number]) => ({
  contract: r.contract,
  predicate: r.expr,
  encodedPredicate: r.encoded,
  predicateHash: r.hash,
  review: card(r.expr),
})

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

/** A predicate given as an expression or as its encoding, validated. */
function given(i: { expr?: unknown; encodedPredicate?: string | undefined }) {
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
  validate(expr)
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
  'Turn a transaction, a recording, an intent (the calls to allow, with per-argument rules: pin, allow, deny, cap, floor, length, minOut, each, some, total, read, until, from) or a template (adapter_batch, blend_venue) into rules: one per contract, each with its predicate (a wire expression), its encoding and hash, and a plain-language review. `ambiguities` are questions whose answers change what is permitted (usually the cap on an amount: answer with `limit`, `limits` or `allow`); `warnings` say what is left open.',
  { ...net, ...from },
  async (i) => {
    const s = await sourceOf(i)
    const rules = propose(s.intent)
    return {
      intent: s.intent,
      rules: rules.map(present),
      ambiguities: s.ambiguities,
      warnings: s.warnings,
      ...(s.recording ? { recording: s.recording } : {}),
    }
  }
)

const check = {
  ...net,
  ...from,
  interpreterAddress: contractId.optional(),
  /** Which rule, when the source covers more than one contract. */
  contract: contractId.optional(),
  expr: val.optional(),
  encodedPredicate: z.string().optional(),
  calls: z.array(call).min(1).max(MAX_CHECKS).optional(),
}

/** The predicate and the calls a simulate or verify is about. */
async function subject(i: z.infer<z.ZodObject<typeof check>>) {
  const hasSource = SOURCES.some((k) => (i as Record<string, unknown>)[k] !== undefined)
  const src = hasSource ? await sourceOf(i) : undefined
  const pred = i.expr !== undefined || i.encodedPredicate !== undefined ? given(i) : undefined
  if (!pred && !src)
    throw new Refusal(
      'INVALID_INPUT',
      'give a predicate (expr or encodedPredicate) or a source to build one from'
    )
  const rule = pred ? undefined : pick(propose((src as Source).intent), i.contract)
  const contexts = src?.recording?.contexts ?? []
  const calls = i.calls ?? contexts.filter((c) => !rule || c.contract === rule.contract)
  const { expr, encoded } = pred ?? (rule as ProposedRule)
  return { expr, encoded, calls: calls as Call[] }
}

const simulate_policy = tool(
  'simulate_policy',
  `Say whether a predicate permits each of some calls, and if not with which deny code. Give the predicate (\`expr\` or \`encodedPredicate\`, or a source to build it from) and the calls (\`calls\`, or the recorded ones). ${CHECKED}`,
  check,
  async (i, signal) => {
    const s = await subject(i)
    if (s.calls.length === 0)
      throw new Refusal('INVALID_INPUT', 'no call to check: give `calls` or a recording')
    const [server, interpreter] = [connect(i), interpreterFor(i.network, i.interpreterAddress)]
    await ensureInterpreter(server, i.network, interpreter)
    const verdicts = await runChecks(server, i.network, interpreter, s.encoded, s.calls, signal)
    return {
      predicateHash: hashOf(s.encoded),
      results: s.calls.map((c, n) => ({ call: c, ...verdicts[n] })),
    }
  }
)

const verify_policy = tool(
  'verify_policy',
  `Check a predicate against a call it must permit: the call must pass, every constraint is turned against the call and must refuse it, and each conjunct is dropped in turn to see the call it guards get through (minimality). \`ok\` needs the permit and every deny case. ${CHECKED} At most about 2 x the number of constraints + 1 calls are made, a few at a time.`,
  { ...check, call: call.optional() },
  async (i, signal) => {
    const s = await subject(i)
    const permits = i.call ? [i.call as Call] : s.calls
    if (permits.length === 0)
      throw new Refusal(
        'INVALID_INPUT',
        'verify needs a call that must be permitted: give `call` or a recording'
      )
    const [server, interpreter] = [connect(i), interpreterFor(i.network, i.interpreterAddress)]
    await ensureInterpreter(server, i.network, interpreter)
    return {
      predicateHash: hashOf(s.encoded),
      ...(await verifyRule(server, i.network, interpreter, s.expr, permits, signal)),
    }
  }
)

const install_policy = tool(
  'install_policy',
  "Build the UNSIGNED transaction that installs a rule on a smart account: `add_context_rule` carrying the interpreter's install parameters, so one signature installs the predicate. Name the rule with a source (as `synthesize_policy`, `contract` choosing among several) or `encodedPredicate` with `contract`. `signers` are the keys the rule governs; `admins` (default: `sourceAccount`) are the Policy Signer role that may later re-install or remove it. The interpreter is checked live before anything is built: it must speak the grammar and run a trusted build (a pinned address, or on a network with none, an `interpreterAddress` whose code hash is one this package trusts). The account's other rules are read: the install is REFUSED when a shared signer could name a looser or unpoliced rule instead (the new rule would never run), or a rolling total would not bind; `allowOverlap: true` installs anyway. An unanswered amount cap is refused unless `allowUnboundedAmount`. `spendingLimit` attaches OpenZeppelin's rolling total beside the predicate (ledgers, about five seconds each). The wallet signs the returned XDR; `outPath` also writes it to a file.",
  {
    ...net,
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
    allowUnboundedAmount: z.boolean().optional(),
    allowOverlap: z.boolean().optional(),
    interpreterAddress: contractId.optional(),
    baseFee: z.number().int().positive().optional(),
    outPath: z.string().min(1).optional(),
  },
  async (i) => {
    const network = i.network
    const fail = (m: string) => new Refusal('INSTALL_BUILD_FAILED', m)
    // The rule: an encoded predicate scoped by `contract`, or one the source yields.
    let chosen: { contract: string; expr: Expr; encoded: string; hash: string }
    let ambiguities: Source['ambiguities'] = []
    if (i.encodedPredicate !== undefined) {
      const p = given(i)
      const sel = [...new Set(selectors(p.expr).map((s) => s.contract))]
      const contract = i.contract ?? (sel.length === 1 && sel[0] !== '*' ? sel[0] : undefined)
      if (!contract) throw fail('the predicate does not pin one contract: name it with `contract`')
      chosen = { contract, expr: p.expr, encoded: p.encoded, hash: hashOf(p.encoded) }
    } else {
      const s = await sourceOf(i)
      ambiguities = s.ambiguities
      chosen = pick(propose(s.intent), i.contract)
    }
    if (ambiguities.length > 0 && !i.allowUnboundedAmount) {
      throw fail(
        `${ambiguities[0]?.question} Answer with \`limit\` or \`limits\`, or set allowUnboundedAmount to install without it.`
      )
    }
    if (POLICY_CONTRACTS.has(chosen.contract) || chosen.contract === i.smartAccount) {
      throw fail(
        'a rule scoped to a policy contract or to the account itself would expose its admin calls; scope it to the contract the calls go to'
      )
    }
    const interpreter = interpreterFor(network, i.interpreterAddress)
    const server = connect(i)
    const draft: RuleDraft = {
      scope: { kind: 'call_contract', contract: chosen.contract },
      name: i.name ?? `policy-${chosen.hash.slice(0, 8)}`,
      validUntil: i.validUntilLedger ?? null,
      signers: i.signers,
      admins: i.admins ?? [i.sourceAccount],
      predicate: { encoded: chosen.encoded, hash: chosen.hash },
      nonce: i.installNonce ?? 1,
      ...(i.spendingLimit ? { cap: { address: SPENDING_LIMIT[network], ...i.spendingLimit } } : {}),
    }
    // The live check of the interpreter, the account's rules and the build do not depend on
    // each other: ask all three at once, and throw the build away if the scan refuses.
    const [live, scan, built] = await Promise.all([
      fingerprint(server, network, interpreter),
      readRules(server, network, i.smartAccount, interpreter),
      buildInstall({ ...i, server }, draft, interpreter),
    ])
    if (!live.matches) throw mismatch(live)
    const found = overlaps({ ...draft, expr: chosen.expr }, scan.rules, interpreter, network)
    const refused = found.filter((o) => o.severity === 'refuse')
    if (i.allowOverlap !== true) {
      if (refused.length > 0) {
        throw fail(
          `refused: ${refused.map((o) => o.advice).join(' ')} Set allowOverlap to install anyway.`
        )
      }
      if (!scan.complete)
        throw fail(
          "the account's rules could not all be read, so whether this rule can bind is not known; set allowOverlap to install anyway"
        )
    }
    let writtenTo: string | undefined
    if (i.outPath !== undefined) writtenTo = await writeAtomic(i.outPath, built.unsignedXdr)
    return {
      ...built,
      rule: { contract: chosen.contract, predicateHash: chosen.hash, review: card(chosen.expr) },
      interpreter: live,
      authorityScan: { complete: scan.complete, overlaps: found },
      ...(writtenTo ? { writtenTo } : {}),
    }
  }
)

/** Write beside the target and rename (atomic), reading it back: a half-written
 *  file would reach a signer as a malformed transaction. */
async function writeAtomic(path: string, text: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0'))
    throw new Refusal('INVALID_INPUT', 'outPath must be an absolute path')
  const staging = `${path}.${randomBytes(4).toString('hex')}.partial`
  try {
    await writeFile(staging, text, { encoding: 'utf8', flag: 'wx' })
    if ((await readFile(staging, 'utf8')) !== text)
      throw new Error('outPath: the file was not persisted intact')
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
  return path
}

const revoke_policy = tool(
  'revoke_policy',
  'Build the UNSIGNED transaction that removes a rule from a smart account (`remove_context_rule`); the account uninstalls each attached policy itself.',
  {
    ...net,
    smartAccount: contractId,
    sourceAccount: account,
    ruleId: z.number().int().nonnegative(),
    baseFee: z.number().int().positive().optional(),
  },
  async (i) => buildRevoke({ ...i, server: connect(i) }, i.ruleId)
)

const get_interpreter_info = tool(
  'get_interpreter_info',
  'The interpreter a network uses: its pinned address, grammar version and wasm sha256, the predicate caps, and with `verifyLive` what is deployed at that address right now (grammar_version() and the code hash) and whether it matches the pin.',
  { ...net, verifyLive: z.boolean().optional(), interpreterAddress: contractId.optional() },
  async (i) => {
    const address = interpreterFor(i.network, i.interpreterAddress)
    const wasm = pinnedWasm(i.network, address)
    return {
      network: i.network,
      address,
      pinned: wasm !== undefined,
      grammarVersion: GRAMMAR_VERSION,
      wasmSha256: wasm ?? null,
      trustedWasmSha256: [...INTERPRETER_WASM],
      caps: CAPS,
      ...(i.verifyLive ? { live: await fingerprint(connect(i), i.network, address) } : {}),
    }
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
        error: {
          code: 'INVALID_INPUT',
          message: `unknown tool ${name}`,
          severity: 'error',
          retryable: false,
        },
      })
}
