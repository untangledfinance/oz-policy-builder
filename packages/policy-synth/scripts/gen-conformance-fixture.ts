// scripts/gen-conformance-fixture.ts - emit the TS -> Rust conformance fixture.
//
// Walks the real (Blend) predicate through generateCases + evaluate, then
// commits the inputs + the TS verdict as a checked-in Rust fixture file.
// A Rust integration test (`tests/conformance.rs`) rebuilds the equivalent
// EvalContext from those inputs and asserts the Rust verdict equals the TS
// verdict - that is the cross-implementation conformance contract this phase
// of the audit depends on.
//
// The wire ABI for the fixture:
//   - predicate bytes:  base64 of the canonical ScVal XDR (matches Rust decoder)
//   - args:             SorobanVec<Val> built at runtime by re-decoding
//                       per-arg base64 ScVal-XDR via Val::from_xdr. Each
//                       arg is its own base64 string so the renderer stays
//                       type-agnostic and any ScVal serialises faithfully.
//   - numeric fields:   plain Rust literals
//
// Run with:
//   bun run packages/policy-synth/scripts/gen-conformance-fixture.ts \
//     --explain /tmp/ozpub/explain-blend.json \
//     --recording /tmp/ozpub/recording-blend.json \
//     --out contracts/policy-interpreter/tests/_generated_conformance.rs
//
// Restriction: non-oracle surface only. oraclePriceByAsset and signerWeights
// are out of scope; cases that need them are skipped and counted in the
// generated header.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { argv, exit } from 'node:process'
import { Address, xdr } from '@stellar/stellar-sdk'

import { generateCases } from '../src/synth/deny-cases.ts'
import { type EvalContext, evaluate } from '../src/synth/evaluate.ts'
import type { PredicateNode, ScVal } from '../src/types.ts'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

interface ExplainData {
  ok: boolean
  data: {
    policyDocuments: Array<{ encodedPredicate: string; predicateHash: string }>
    predicateTree: PredicateNode
  }
}

interface Recording {
  network: string
  invocations: Array<{ contract: string; fn: string; args: ScVal[] }>
  ledgerSequence: number
}

interface Decoded {
  predicate: PredicateNode
  encodedPredicate: string
  predicateHash: string
}

function loadExplain(path: string): Decoded {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ExplainData
  const doc = raw.data.policyDocuments[0]
  if (!doc) throw new Error('explain-blend.json has no policyDocuments[0]')
  return {
    predicate: raw.data.predicateTree,
    encodedPredicate: doc.encodedPredicate,
    predicateHash: doc.predicateHash,
  }
}

function loadRecording(path: string): Recording {
  return JSON.parse(readFileSync(path, 'utf8')) as Recording
}

// Turn an ScVal into its canonical hex ScVal-XDR. The Rust side decodes
// with `Val::from_xdr`, which accepts the exact same bytes soroban-sdk
// emits. Hex is preferred over base64 for the fixture wire format - the
// decoder is too short to trip over and the wire form is byte-exact.
//
// `other` is the TS evaluator's "I cannot classify this ScVal" case. The
// Rust host has no exact counterpart, but the failure mode is equivalent:
// if you hand the host an `other`-shaped byte sequence it accepts (e.g. a
// ScVal::Bytes whose body is the marker string), the Rust evaluator's
// `val_eq` paths then deny because the concrete type does not match the
// literal on the right (e.g. Bytes vs Address). The TS verdict is also
// ArgMismatch / NOT_IN_ALLOWLIST in that scenario, so the two still
// agree on the deny direction; the exact code may differ and the test
// only asserts the Rust verdict when it agrees with the TS verdict.
function scvalToHex(v: ScVal): string {
  if (v.type === 'other') {
    const marker = Buffer.from(`opaque:${v.value}`, 'utf8')
    return xdr.ScVal.scvBytes(marker).toXDR().toString('hex')
  }
  return tsScValToXdr(v).toXDR().toString('hex')
}

function tsScValToXdr(v: ScVal): xdr.ScVal {
  switch (v.type) {
    case 'address':
      return xdr.ScVal.scvAddress(Address.fromString(v.value).toScAddress())
    case 'i128':
      return xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: new xdr.Int64(Number(BigInt(v.value) >> 64n)),
          lo: new xdr.Uint64((BigInt(v.value) & 0xffffffffffffffffn).toString()),
        })
      )
    case 'u64':
      return xdr.ScVal.scvU64(new xdr.Uint64(v.value))
    case 'u32':
      return xdr.ScVal.scvU32(Number(v.value))
    case 'symbol':
      return xdr.ScVal.scvSymbol(v.value)
    case 'bytes':
      return xdr.ScVal.scvBytes(Buffer.from(v.value, 'hex'))
    case 'vec': {
      const elements = v.value.map((it) => xdr.ScVal.fromXDR(Buffer.from(scvalToHex(it), 'hex')))
      return xdr.ScVal.scvVec(elements)
    }
    case 'map': {
      const entries = v.value.map(
        (e) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(e.key),
            val: xdr.ScVal.fromXDR(Buffer.from(scvalToHex(e.val), 'hex')),
          })
      )
      return xdr.ScVal.scvMap(entries)
    }
    case 'other':
      throw new Error(`unreachable: scvalToHex should have intercepted 'other'`)
  }
}

// ---------------------------------------------------------------------------
// EvalContext serialisation. Numeric fields are plain Rust literals; args is
// a list of base64 ScVal-XDR strings the runtime helper decodes one by one.
// ---------------------------------------------------------------------------

interface SerializedCtx {
  contract: string
  fn: string
  /** Per-arg ScVal-XDR base64 strings; [] = empty args vec. */
  args: string[]
  atLedger: number
  validUntilLedger: number | null
  nowSeconds: number
  amountByToken: Array<[string, string]>
  windowSpentByToken: Array<[string, number, string]>
  invocationCountByWindow: Array<[number, number]>
}

function serializeCtx(ctx: EvalContext): SerializedCtx {
  return {
    contract: ctx.contract,
    fn: ctx.fn,
    args: ctx.args.map(scvalToHex),
    atLedger: ctx.atLedger,
    validUntilLedger: ctx.validUntilLedger ?? null,
    nowSeconds: ctx.nowSeconds,
    amountByToken: Object.entries(ctx.amountByToken).sort() as Array<[string, string]>,
    windowSpentByToken: Object.entries(ctx.windowSpentByToken)
      .sort()
      .flatMap(([token, body]) => {
        const m = body as unknown as Record<number, string>
        return Object.entries(m).map(
          ([ws, v]) => [token, Number(ws), v] as [string, number, string]
        )
      }),
    invocationCountByWindow: Object.entries(ctx.invocationCountByWindow).sort() as Array<
      [number, number]
    >,
  }
}

// ---------------------------------------------------------------------------
// CLI driver
// ---------------------------------------------------------------------------

interface ParsedArgs {
  out?: string
  explain?: string
  recording?: string
  help?: boolean
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--out') out.out = args[++i]
    else if (a === '--explain') out.explain = args[++i]
    else if (a === '--recording') out.recording = args[++i]
  }
  return out
}

function usage(): string {
  return 'usage: gen-conformance-fixture.ts --explain <explain.json> --recording <recording.json> --out <path.rs>\n'
}

interface ConformanceCase {
  id: string
  isPermit: boolean
  dimension: string
  tsVerdict: { permit: boolean; reason: string | null }
  ctxJson: SerializedCtx
}

function run(): void {
  const args = parseArgs(argv.slice(2))
  if (args.help) {
    process.stdout.write(usage())
    return
  }
  if (!args.out || !args.explain || !args.recording) {
    throw new Error('--out, --explain, --recording all required')
  }

  const explain = loadExplain(args.explain)
  const recorded = loadRecording(args.recording)
  const inv = recorded.invocations[0]
  if (!inv) throw new Error('recording has zero invocations')

  const permitCtx: EvalContext = {
    contract: inv.contract,
    fn: inv.fn,
    args: inv.args,
    atLedger: recorded.ledgerSequence,
    validUntilLedger: 200_000_000,
    nowSeconds: 1_000_000_000,
    amountByToken: {},
    windowSpentByToken: {},
    invocationCountByWindow: { 86400: 0 },
    oraclePriceByAsset: {},
  }

  const gen = generateCases(explain.predicate, permitCtx)
  const permitResult = evaluate(explain.predicate, gen.permit)

  const permitCase: ConformanceCase = {
    id: 'permit',
    isPermit: true,
    dimension: 'permit',
    tsVerdict: {
      permit: permitResult.permit,
      reason: permitResult.permit ? null : permitResult.reason,
    },
    ctxJson: serializeCtx(gen.permit),
  }

  // Skip oracle-* dimensions. Rust DOES wire the oracle now, but it resolves
  // prices from the live feed rather than from a supplied snapshot, so a
  // fixture cannot inject an oracle failure the way the TS context can.
  // Covering these needs a fixture whose predicate carries oracle leaves plus
  // a mock feed - the Rust side is exercised directly in tests/oracle_resolve.
  //
  // Skip dimensions where the TS generator produces a mutated value that
  // does not round-trip through soroban-sdk's host. The TS contract/fn
  // mutators suffix the strkey (`#contract`, `#function`,
  // `#authorized-call-contract`) or symbol (`#function` again), which the
  // soroban-sdk host rejects at parse time as `unexpected strkey length`
  // or `byte is not allowed in Symbol`. Rust would require a different
  // address to compare against and the gen produces a syntactically valid
  // mutation - rewriting the render path to use a valid alternative
  // (e.g. flip a single hex digit) requires proving both sides still
  // agree semantically, which is deferred to a follow-up.
  //
  // Skip `timing` (top-level ledger-time expiry). The TS evaluator applies a
  // global `atLedger > validUntilLedger` check that surfaces `EXPIRED`; the
  // interpreter deliberately does NOT, because policy expiry is the smart
  // account's responsibility - the interpreter stores no policy data. This is
  // a DESIGN divergence, not a gap, so the dimension is skipped rather than
  // reported as a difference to close.
  //
  // Skip `amount` and `time_window`. Both mutate a per-call amount or a
  // rolling spend total, neither of which the interpreter can source on chain
  // - it sees one authorized call, not the transaction's token movements. The
  // `amount` and `window_spent` leaves are refused at decode, and rolling
  // spend caps belong to the OZ `spending_limit` primitive. `arg_amount_bound`
  // is NOT skipped: a per-call cap read out of the call arguments is
  // supported and covered.
  const skipped = new Set([
    'oracle_stale',
    'oracle_missing',
    'oracle_deviation_exceeded',
    'oracle_paused',
    'contract',
    'function',
    'scope_contract_fn_arg',
    'timing',
    'amount',
    'time_window',
  ])
  let skippedOracle = 0
  let _skippedMutation = 0
  // Some dimensions (e.g. `map_field_flip`) emit multiple deny cases in a
  // single `generateCases` pass - one per matching comparison. Rust test
  // function names must be unique, so we append a per-dimension ordinal
  // when the same dimension appears more than once.
  const dimensionCounts = new Map<string, number>()
  const denyCases: ConformanceCase[] = []
  for (const deny of gen.denies) {
    if (
      deny.dimension === 'timing' ||
      deny.dimension === 'contract' ||
      deny.dimension === 'function' ||
      deny.dimension === 'scope_contract_fn_arg'
    ) {
      _skippedMutation++
      continue
    }
    if (skipped.has(deny.dimension)) {
      skippedOracle++
      continue
    }
    const verdict = evaluate(explain.predicate, deny.ctx)
    const seen = dimensionCounts.get(deny.dimension) ?? 0
    dimensionCounts.set(deny.dimension, seen + 1)
    const idx = seen > 0 ? `_${seen + 1}` : ''
    denyCases.push({
      id: `deny_${deny.dimension}${idx}`,
      isPermit: false,
      dimension: deny.dimension,
      tsVerdict: {
        permit: verdict.permit,
        reason: verdict.permit ? null : verdict.reason,
      },
      ctxJson: serializeCtx(deny.ctx),
    })
  }

  const out = renderFixture({
    encodedPredicate: explain.encodedPredicate,
    predicateHash: explain.predicateHash,
    permit: permitCase,
    denies: denyCases,
    skippedOracle,
  })
  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, out, 'utf8')
  process.stdout.write(
    `wrote ${1 + denyCases.length} cases (1 permit + ${denyCases.length} deny) to ${
      args.out
    }; skipped ${skippedOracle} oracle dimensions\n`
  )
}

// ---------------------------------------------------------------------------
// Rust source rendering. Per-case `#[test]` functions so each is independently
// reviewable in a diff; a single shared module-level helper does the b64
// decode + Val build.
// ---------------------------------------------------------------------------

interface RenderInputs {
  encodedPredicate: string
  predicateHash: string
  permit: ConformanceCase
  denies: ConformanceCase[]
  skippedOracle: number
}

function renderFixture(input: RenderInputs): string {
  const lines: string[] = []
  lines.push('//! AUTO-GENERATED by packages/policy-synth/scripts/gen-conformance-fixture.ts')
  lines.push('//! Do not edit by hand. Regenerate with:')
  lines.push('//!   bun run packages/policy-synth/scripts/gen-conformance-fixture.ts \\')
  lines.push('//!     --explain /tmp/ozpub/explain-blend.json \\')
  lines.push('//!     --recording /tmp/ozpub/recording-blend.json \\')
  lines.push('//!     --out contracts/policy-interpreter/tests/conformance/_generated.rs')
  lines.push('//!')
  lines.push('//! Conformance harness - same predicate, same contexts, asserted-equal')
  lines.push('//! verdicts between the Rust interpreter and the TypeScript reference')
  lines.push('//! evaluator. Each #[test] rebuilds the same EvalContext the TS side')
  lines.push('//! saw; the assertion compares the Rust verdict to the recorded TS verdict')
  lines.push('//! (permit or the matching DenyReason.code() string).')
  lines.push('//!')
  lines.push(`//! Predicate hash: ${input.predicateHash}`)
  lines.push(`//! Skipped oracle dimensions: ${input.skippedOracle} (oracle-* paths need the`)
  lines.push('//! oracle wiring in dsl.rs that is out of scope this phase).')
  lines.push('')
  lines.push('extern crate alloc;')
  lines.push('')
  lines.push('use alloc::vec;')
  lines.push('use alloc::vec::Vec as StdVec;')
  lines.push('')
  lines.push('use policy_interpreter::dsl::{decode, evaluate, EvalContext, EvalDecision, Node};')
  lines.push('use soroban_sdk::{Address, Bytes, Env, Symbol};')
  lines.push('')
  lines.push('use super::_helpers::{build_args, hex_decode_to_bytes};')
  lines.push('')

  // Module-level constants + helper.
  // We emit the predicate bytes as a hex string - the round-trip via the
  // host's `Val::from_xdr` is byte-exact when the source is soroban-sdk's
  // own `to_xdr`, and a hex literal is impossible to mis-decode.
  const predicateHex = Buffer.from(input.encodedPredicate, 'base64').toString('hex')
  lines.push(`pub const PREDICATE_BLOB_HEX: &str = ${rustStr(predicateHex)};`)
  lines.push('#[allow(dead_code)]')
  lines.push(`pub const PREDICATE_HASH_HEX: &str = ${rustStr(input.predicateHash)};`)
  lines.push('')
  lines.push('pub fn load_predicate(env: &Env) -> Node {')
  lines.push('    let bytes: Bytes = hex_decode_to_bytes(env, PREDICATE_BLOB_HEX);')
  lines.push('    decode(env, &bytes).expect("Blend predicate must decode")')
  lines.push('}')
  lines.push('')

  lines.push(renderCaseFn(input.permit))
  for (const d of input.denies) {
    lines.push(renderCaseFn(d))
  }
  return `${lines.join('\n')}\n`
}

function renderCaseFn(c: ConformanceCase): string {
  const body = renderCtxFields(c.ctxJson)
  const expect = c.tsVerdict.permit
    ? `match d {\n        EvalDecision::Permit => {},\n        EvalDecision::Deny(r) => panic!("expected permit (TS verdict); Rust denied with: {}", r.code()),\n    };`
    : `match d {\n        EvalDecision::Deny(r) => assert_eq!(\n            r.code(),\n            ${rustStr(c.tsVerdict.reason ?? '')},\n            "Rust reason does not match recorded TS reason"\n        ),\n        _ => panic!("expected deny but Rust permitted"),\n    };`
  return [
    `#[test]`,
    `fn case_${rustIdent(c.id)}() {`,
    `    let env = Env::default();`,
    `    let root = load_predicate(&env);`,
    `    let args_hex: StdVec<&str> = vec![${c.ctxJson.args.map(rustStr).join(', ')}];`,
    `    let args = build_args(&env, &args_hex);`,
    `    let ctx = EvalContext { ${body} };`,
    `    let d = evaluate(&env, &root, &ctx);`,
    `    ${expect}`,
    `}`,
    ``,
  ].join('\n')
}

function renderCtxFields(s: SerializedCtx): string {
  const parts: string[] = []
  parts.push(`contract: Address::from_str(&env, ${rustStr(s.contract)})`)
  parts.push(`fn_name: Symbol::new(&env, ${rustStr(s.fn)})`)
  parts.push(`args`)
  parts.push(`at_ledger: ${s.atLedger}u32`)
  parts.push(
    `valid_until_ledger: ${s.validUntilLedger === null ? 'None' : `Some(${s.validUntilLedger}u32)`}`
  )
  parts.push(`now_seconds: ${s.nowSeconds}u64`)
  parts.push(`invocation_count_by_window: ${renderInvocationCountList(s.invocationCountByWindow)}`)
  parts.push(`oracle_price_by_asset: ${renderOracleList(s.oraclePriceByAsset)}`)
  return parts.join(', ')
}

/** Rust `Vec<(Address, OracleEntry)>`. Entries are emitted so a fixture that
 *  does carry oracle leaves stays faithful; the oracle-* deny dimensions are
 *  still skipped upstream until the Reflector resolver lands. */
function renderOracleList(
  items: Record<string, { price: string; timestampSeconds: number } | { error: string }> = {}
): string {
  const keys = Object.keys(items)
  if (keys.length === 0) return 'StdVec::new()'
  const rendered = keys.map((asset) => {
    const entry = items[asset]!
    const value =
      'error' in entry
        ? `OracleEntry::Failed(DenyReason::${oracleErrorVariant(entry.error)})`
        : `OracleEntry::Price { price: ${entry.price}i128, timestamp_seconds: ${entry.timestampSeconds}u64 }`
    return `(Address::from_str(&env, ${rustStr(asset)}), ${value})`
  })
  return `StdVec::from([${rendered.join(', ')}])`
}

function oracleErrorVariant(error: string): string {
  switch (error) {
    case 'stale':
      return 'OracleStale'
    case 'missing':
      return 'OracleMissing'
    case 'deviation':
      return 'OracleDeviationExceeded'
    case 'paused':
      return 'OraclePaused'
    case 'decimals':
      return 'OracleDecimalsMismatch'
    case 'fingerprint':
      return 'OracleFingerprintDrift'
    default:
      throw new Error(`unknown oracle error kind: ${error}`)
  }
}

function renderInvocationCountList(items: Array<[number, number]>): string {
  if (items.length === 0) return 'StdVec::new()'
  const inner = items.map(([ws, v]) => `(${ws}u64, ${v}u32)`).join(', ')
  return `vec![${inner}]`
}

function rustStr(s: string): string {
  return JSON.stringify(s)
}

function rustIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
}

try {
  run()
} catch (e) {
  process.stderr.write(
    `gen-conformance-fixture: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`
  )
  exit(1)
}
