// packages/policy-builder-cli/src/commands/synthesize.ts
//
// `policy-builder synthesize` subcommand. Dispatches to ONE of the two
// One front-end:
//   --recorded-tx <path.json> -> synthesizeFromRecording
//
// The CLI mirrors the MCP tool's discriminated union: one subcommand, two
// front-ends, mutually exclusive.
//
// Per-field response flags (--window-seconds, --valid-until, --limit-amount,
// --window-seconds) merge into `userResponses`. A flag overrides the same
// field from --responses (CLI flags are explicit; the file is a default bag).
// the interpreter opt-in and are rejected without --smart-account; tighten-only
// bounds are validated by the core.
//
// --explain (Phase 1) makes the synthesised policy human-readable. The
// orchestrator attaches the in-memory predicate tree
// to the success envelope; the CLI builds the deterministic review card
// from those inputs and emits it alongside the policy. Without --explain
// the output is byte-identical to today.

import {
  buildReviewCardSummary,
  isStellarAddress,
  type ProposedPolicy,
  type ReviewCardSummary,
} from '@crediolabs/policy-synth'
import { runSynthesizePolicy } from '@crediolabs/policy-synth/run'
import { CliError, type CliFlags, formatToolResponse, parsePairs, readJsonFile } from '../output.ts'

// Positive-int flags and i128 amount strings share the same wire shape: a
// base-10 unsigned decimal, no sign. The i128 stays a string at the boundary
// because it is wider than Number.MAX_SAFE_INTEGER.
const POSITIVE_INT_RE = /^[0-9]+$/

export async function runSynthesizeCommand(
  argv: ReadonlyArray<string>,
  flags: CliFlags
): Promise<ProposedPolicy> {
  const pairs = parsePairs(argv)
  if (!pairs['recorded-tx']) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: 'synthesize: --recorded-tx <path> is required',
      severity: 'error',
      retryable: false,
    })
  }

  // --explain is a STANDALONE flag (no value). Detect presence via
  // `!== undefined` so `--explain` (no value) and a missing flag are
  // distinguishable. The core defaults to ADDITIVE: with --explain the
  // output gains `review` + `predicateTree` and remains unchanged
  // otherwise.
  const explain = pairs.explain !== undefined

  const recordedFile = readJsonFile(pairs['recorded-tx'] as string) as Record<string, unknown>
  // Accept either a bare RecordedTransaction or the `{ ok, data }` artifact that
  // `record --out` writes (same shape as `--json`), so `record --out X` followed
  // by `synthesize --recorded-tx X` works end to end.
  const recordedTx =
    recordedFile?.ok === true && typeof recordedFile.data === 'object' && recordedFile.data !== null
      ? (recordedFile.data as Record<string, unknown>)
      : recordedFile
  const network = pairs.network
  if (!network) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: 'synthesize: --network <mainnet|testnet> is required with --recorded-tx',
      severity: 'error',
      retryable: false,
    })
  }
  const args: Record<string, unknown> = { source: 'recording', recordedTx, network }

  // userResponses precedence: --responses file is the base; per-field flags
  // override the same field. Only the override'd fields are merged in.
  const userResponses: Record<string, unknown> = {}
  if (pairs.responses) {
    const file = readJsonFile(pairs.responses)
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new CliError({
        code: 'CLI_INVALID_JSON',
        message: `synthesize: --responses ${pairs.responses} must be a JSON object`,
        severity: 'error',
        retryable: false,
      })
    }
    Object.assign(userResponses, file as Record<string, unknown>)
  }
  // Per-field overrides. Each entry: argv flag name, userResponses key,
  // and a parser that validates the raw string.
  const userResponseFlags: Array<[string, string, (raw: string, flag: string) => unknown]> = [
    ['window-seconds', 'windowSeconds', parsePositiveInt],
    ['valid-until', 'validUntilLedger', parsePositiveInt],
    ['limit-amount', 'limitAmount', parseI128String],
  ]
  for (const [flag, key, parse] of userResponseFlags) {
    if (pairs[flag] !== undefined) {
      userResponses[key] = parse(pairs[flag] as string, `--${flag}`)
    }
  }
  // --recipient <C...|G...> is REPEATABLE (parsePairs collapses duplicate keys,
  // so it is collected straight from argv). Each value builds the swap-recipient
  // allowlist; supplying it REPLACES the default pin to the recorded recipient.
  const recipients = collectRepeated(argv, 'recipient')
  for (const r of recipients) {
    // Same validator the run-layer schema applies (SDK StrKey underneath) - a
    // swap recipient may be a G... wallet or a C... contract. Shared rather
    // than re-inlined so the CLI and the schema cannot drift apart.
    if (!isStellarAddress(r)) {
      throw new CliError({
        code: 'CLI_MISSING_ARG',
        message: `synthesize: --recipient "${r}" is not a valid Stellar address (expected a G... wallet or C... contract)`,
        severity: 'error',
        retryable: false,
      })
    }
  }
  if (recipients.length > 0) userResponses.swapRecipientAllowlist = recipients
  if (Object.keys(userResponses).length > 0) args.userResponses = userResponses

  applySharedFlags(args, pairs, explain)

  // --smart-account <C...> opts into the interpreter adapter, so constraints OZ
  // exact hop paths) lower to a real predicate document instead of just warnings.
  // The core validates the address and installNonce; a bad value surfaces there.
  //
  // Use `!== undefined` (not truthy) so `--smart-account ""` and `--install-nonce`
  // without `--smart-account` are rejected up front instead of being silently
  // dropped. The foot-gun: an empty value previously produced an "ok" envelope
  // with 0 policyDocuments, so callers thought the constraint had been enforced
  // when it had been silently skipped.
  const smartAccountRaw = pairs['smart-account']
  const installNonceRaw = pairs['install-nonce']
  // front so they cannot be silently dropped when --smart-account is absent.
  if (smartAccountRaw === undefined) {
    if (installNonceRaw !== undefined) {
      throw new CliError({
        code: 'CLI_MISSING_ARG',
        message: 'synthesize: --install-nonce requires --smart-account <C...> (interpreter opt-in)',
        severity: 'error',
        retryable: false,
      })
    }
  } else {
    const smartAccount = smartAccountRaw.trim()
    if (smartAccount.length === 0) {
      throw new CliError({
        code: 'CLI_MISSING_ARG',
        message:
          'synthesize: --smart-account <C...> was passed empty; provide a 56-character contract strkey or omit the flag',
        severity: 'error',
        retryable: false,
      })
    }
    if (!/^C[2-7A-Z]{55}$/.test(smartAccount)) {
      throw new CliError({
        code: 'CLI_MISSING_ARG',
        message: `synthesize: --smart-account "${smartAccount}" is not a valid C... contract strkey (expected 56 chars starting with C)`,
        severity: 'error',
        retryable: false,
      })
    }
    const interpreter: Record<string, unknown> = { smartAccountAddress: smartAccount }
    if (installNonceRaw !== undefined) {
      const nonce = Number(installNonceRaw)
      if (!Number.isInteger(nonce) || nonce < 0) {
        throw new CliError({
          code: 'CLI_MISSING_ARG',
          message: `synthesize: --install-nonce "${installNonceRaw}" is not a non-negative integer`,
          severity: 'error',
          retryable: false,
        })
      }
      interpreter.installNonce = nonce
    }
    // core validates tighten-only (maxStalenessSeconds <= 600,
    // maxDeviationBps <= 200) - a too-loose value surfaces as SYNTHESIS_ERROR.
    args.interpreter = interpreter
  }
  if (explain) args.explain = true
  const res = await runSynthesizePolicy(args)
  // formatToolResponse runs FIRST so the "ok" line + --out / --json writes
  // happen with the additive fields already attached. emitExplainBlock
  // mutates `res.data` in place to inject `review` + `predicateTree`, so
  // the --out artefact and --json stdout both carry the same shape.
  if (explain) emitExplainBlock(res, flags)
  return formatToolResponse(res, flags, 'synthesize(recording)')
}

/** Apply the flags that are not part of the recording payload itself:
 *  --confidence, --explain. */
function applySharedFlags(
  args: Record<string, unknown>,
  pairs: Record<string, string>,
  explain: boolean
): void {
  if (pairs.confidence !== undefined) {
    args.confidenceOverride = { threshold: parseConfidence(pairs.confidence as string) }
  }
  if (explain) args.explain = true
}

/** Augment the tool response envelope with the --explain fields and
 *  (in non-JSON mode) print the review card readably. The CLI is the
 *  single seam that places `review` + `predicateTree` on the wire
 *  envelope; the core stays downstream of `formatToolResponse` so the
 *  byte-identical no-flag path is preserved. The envelope mutation is
 *  done BEFORE `formatToolResponse` so the on-disk --out artefact and
 *  the --json stdout both carry the same fields. */
function emitExplainBlock(
  res: {
    ok: boolean
    data?: ProposedPolicy
    explain?: {
      predicateTree: unknown
    }
  },
  flags: CliFlags
): void {
  if (!res.ok || !res.explain) return
  const review = buildReviewCardSummary(
    // The orchestrator's `predicateTree` is the exact in-memory AST
    // (canonical JSON shape). The builder's input is typed as
    // `PredicateNode | null`; a null is the truthful value when the
    // interpreter adapter was not engaged.
    (res.explain.predicateTree ?? null) as never,
    res.data?.policyRefs ?? [],
    res.data?.contextRule ?? {
      contextRuleType: { kind: 'default' as const },
      name: 'unknown',
      validUntilLedger: null,
      signers: [],
      policies: [],
    },
    'interpreter-v1'
  )
  // Attach the two additive fields to the on-wire envelope. formatToolResponse
  // reads from `res` and writes the JSON; we mutate the same object so the
  // --json path + --out path see the same shape.
  ;(res.data as ProposedPolicy & { review: ReviewCardSummary; predicateTree: unknown }).review =
    review
  ;(
    res.data as ProposedPolicy & { review: ReviewCardSummary; predicateTree: unknown }
  ).predicateTree = res.explain.predicateTree
  // In human mode (no --json), print the review card readably: the rule name,
  // the expiry, then one line per constraint. Plain text; no colour, no box
  // drawing. The "ok" line is printed by formatToolResponse; this block prints
  // ONLY the review-card lines.
  //
  // `review.plainEnglish` is deliberately not printed here: it is the same
  // constraint list joined into one sentence, so emitting both would state
  // every constraint twice. It stays on the JSON envelope for callers that
  // want a single-string summary.
  if (!flags.json && !flags.quiet) {
    process.stdout.write(`Review card: ${review.ruleName}\n`)
    process.stdout.write(`  ${review.expiry}\n`)
    process.stdout.write('  Constraints:\n')
    for (const line of review.constraints) {
      process.stdout.write(`    - ${line}\n`)
    }
  }
}

function parseConfidence(raw: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: `synthesize: --confidence "${raw}" must be a finite number within [0, 1]`,
      severity: 'error',
      retryable: false,
    })
  }
  return n
}

/** Parse a strictly positive integer (windowSeconds, validUntilLedger,
 *  field-specific caps; the CLI just enforces "looks like an integer > 0".
 *  The `^[0-9]+$` regex already pins the shape to a non-negative integer, so
 *  the only thing left to check is "not zero". */
function parsePositiveInt(raw: string, flagName: string): number {
  if (!POSITIVE_INT_RE.test(raw) || raw === '0') {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: `synthesize: ${flagName} "${raw}" must be a positive integer`,
      severity: 'error',
      retryable: false,
    })
  }
  return Number(raw)
}

/** Collect ALL values for a repeatable `--<name> <value>` / `--<name>=<value>`
 *  flag from argv, in order. Unlike `parsePairs` (which keeps only the last
 *  occurrence of a key), this preserves every occurrence so a flag like
 *  `--recipient` can be supplied multiple times to build an allowlist. A
 *  trailing `--<name>` with no value (or another flag next) is skipped. */
function collectRepeated(argv: ReadonlyArray<string>, name: string): string[] {
  const out: string[] = []
  const eqPrefix = `--${name}=`
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === `--${name}`) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.push(next)
        i++
      }
    } else if (a?.startsWith(eqPrefix)) {
      out.push(a.slice(eqPrefix.length))
    }
  }
  return out
}

/** Parse an i128 decimal string (positive, base 10). The synth gate, not the
 *  CLI, decides what to do with negatives - real recordings carry positive
 *  amounts on the wire for `limitAmount`. */
function parseI128String(raw: string, flagName: string): string {
  if (!POSITIVE_INT_RE.test(raw)) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: `synthesize: ${flagName} "${raw}" must be a positive decimal integer string (base-10 i128)`,
      severity: 'error',
      retryable: false,
    })
  }
  return raw
}
