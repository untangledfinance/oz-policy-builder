// packages/policy-builder-cli/src/output.ts
//
// Output helpers for the CLI: formatToolResponse for the `--json` flag and
// file I/O for `--out`. The CLI is intentionally tiny - no commander / yargs
// dependency; the router is a hand-rolled argv parser.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ErrorCode, ToolError, ToolResponse } from '@crediolabs/policy-synth'

/** CLI flags (the only ones shipped in T1). */
export interface CliFlags {
  json: boolean
  quiet: boolean
  out: string | null
}

/** Parse the argv tail for the known flags. Unrecognised flags are ignored
 *  (the caller enforces per-subcommand required flags separately). */
export function parseFlags(argv: ReadonlyArray<string>): CliFlags {
  let json = false
  let quiet = false
  let out: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--quiet') quiet = true
    else if (a === '--out' && argv[i + 1]) {
      out = argv[i + 1] as string
      i++
    } else if (a?.startsWith('--out=')) {
      out = a.slice('--out='.length)
    }
  }
  return { json, quiet, out }
}

/** Resolve `--value <v>` style pairs after the subcommand name. Returns
 *  an object keyed by the option name (without `--`). Throws on missing
 *  value or duplicate keys.
 *
 *  Note: an empty value (`--smart-account ""`) IS captured as an empty
 *  string so the caller can distinguish "flag omitted" from "flag passed
 *  empty" - a foot-gun: silently dropping empty values caused callers to
 *  believe the interpreter adapter was engaged when it was not. The next
 *  token is treated as a value iff it is present and does not start with
 *  `--`; tokens starting with `--` are never consumed as values. */
export function parsePairs(argv: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a?.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=')
      const key = a.slice(2, eq)
      const val = a.slice(eq + 1)
      if (key && val !== undefined) out[key] = val
    } else if (a?.startsWith('--')) {
      const key = a.slice(2)
      if (!key) continue
      const next = argv[i + 1]
      // Only consume the next token if it is present AND does not look like
      // another flag. Empty strings DO count as values so callers can
      // distinguish "omitted" from "passed empty".
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        // Standalone flag (no value) - record as empty string so `!== undefined`
        // checks upstream can detect presence.
        out[key] = ''
      }
    }
  }
  return out
}

/** Read a JSON file, parse it, and return the value. Throws with a CLI-
 *  friendly error if the file is missing or malformed. */
export function readJsonFile(path: string): unknown {
  const abs = resolve(path)
  if (!existsSync(abs)) {
    throw new CliError({
      code: 'CLI_FILE_NOT_FOUND',
      message: `file not found: ${path}`,
      severity: 'error',
      retryable: false,
    })
  }
  const raw = readFileSync(abs, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new CliError({
      code: 'CLI_INVALID_JSON',
      message: `invalid JSON in ${path}: ${(e as Error).message}`,
      severity: 'error',
      retryable: false,
    })
  }
}

/** Write a JSON-serialisable value to disk. Pretty-prints by default so the
 *  artefact is human-readable; CI scripts that need compact JSON can pipe
 *  through `jq` instead. */
export function writeJsonFile(path: string, value: unknown): void {
  const abs = resolve(path)
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Wraps a core ToolResponse for the CLI:
 *    - always prints something useful (JSON or a short summary)
 *    - exits non-zero on ToolError so CI scripts can gate on `$?`
 *    - writes the `{ ok, data }` envelope to --out when present (matches
 *      the --json stdout shape so CI scripts get a single canonical payload)
 *
 *  Throws CliError so the router can map it to a process exit code + a
 *  structured JSON envelope under --json. */
export function formatToolResponse<T>(
  res: ToolResponse<T>,
  flags: CliFlags,
  outLabel = 'result'
): T {
  if (!res.ok) throw new CliError(res.error)
  const envelope = { ok: true as const, data: res.data }
  if (flags.out) writeJsonFile(flags.out, envelope)
  if (flags.json) {
    // newline-terminated JSON so it pipes cleanly
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
  } else if (!flags.quiet) {
    process.stdout.write(`${outLabel}: ok\n`)
  }
  return res.data
}

/** CLI-specific error codes, distinct from the core's ErrorCode union. They
 *  cover failures that arise around the core call (bad argv, missing or
 *  malformed input files) and never collide with a core code. */
export type CliErrorCode =
  | 'CLI_MISSING_ARG'
  | 'CLI_FILE_NOT_FOUND'
  | 'CLI_INVALID_JSON'
  | 'CLI_INTERNAL'

/** A ToolError whose `code` may be a core ErrorCode OR a CLI-local code. The
 *  CLI wraps both core failures and its own argv / IO failures in this shape;
 *  a core ToolError is assignable here since ErrorCode is a subset. */
export type CliToolError = Omit<ToolError, 'code'> & { code: ErrorCode | CliErrorCode }

/** CLI-local error class wrapping a (core or CLI) ToolError so the router can
 *  map it to a non-zero exit. The error is preserved verbatim for --json. */
export class CliError extends Error {
  readonly toolError: CliToolError
  constructor(err: CliToolError) {
    super(err.message)
    this.toolError = err
  }
}

/** Pretty-print a CliError to stderr and exit non-zero. Used by the router
 *  when the catch fires. */
export function emitCliError(e: unknown, flags: CliFlags): never {
  if (e instanceof CliError) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: e.toolError })}\n`)
    } else {
      process.stderr.write(`error: ${e.toolError.code} - ${e.toolError.message}\n`)
    }
    process.exit(1)
  }
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: 'CLI_INTERNAL', message: (e as Error).message, severity: 'fatal', retryable: false } })}\n`
    )
  } else {
    process.stderr.write(`internal error: ${(e as Error).message}\n`)
  }
  process.exit(2)
}
