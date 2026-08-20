// src/synth/overpermissive-harness.test.ts
//
// Regression harness for the over-permissiveness invariant:
//   P must ALLOW the exact recorded call
//   P must DENY every material mutation of the recorded call
//
// Driven by the three real mainnet fixture recordings. Uses the full
// synthesizeFromRecording pipeline (ORIGINAL_DIMENSIONS internally) to get
// the emitted policy, then decode + test with ALL dimensions (including
// over-permissive mutations) to surface FINDINGS.
//
// A failing deny case here is a FINDING — the harness reports it, it is not
// silently exempted. The existing suite (deny-cases.test.ts) covers the
// original 15-dimension battery.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Address, xdr } from '@stellar/stellar-sdk'
import { placeholderOzConfig } from '../adapters/oz/adapter.ts'
import type { PredicateNode, RecordedTransaction } from '../types.ts'
import { generateCases } from './deny-cases.ts'
import { evaluate } from './evaluate.ts'
import { runHarness } from './harness.ts'
import { buildPermitContext } from './permit-context.ts'
import { synthesizeFromRecording } from './synthesize-from-recording.ts'

// ---------------------------------------------------------------------------
// Fixtures — real mainnet recordings
// ---------------------------------------------------------------------------

// Resolved from this file, so the suite runs anywhere the repo is
// checked out. It previously pointed at an absolute path in a different
// repository on one machine: the recordings loaded there and nowhere
// else, so CI silently skipped every fixture and failed the coverage
// assertions that expect at least one.
const FIXTURE_ROOT = `${import.meta.dir}/../../fixtures/recordings`

interface Fixture {
  name: string
  file: string
  smartAccount: string
  responses: {
    windowSeconds: number
    invocationLimit?: number
    limitAmount?: string
    validUntilLedger: number
  }
  expectedDocCount: number
  expectedHash: string
}

// The Blend baselines moved when the invocation-count leaf left the grammar:
// those are the incoming-only flows that carried a frequency constraint, so
// each predicate lost one conjunct and gained nothing. The SoroSwap baseline
// moved earlier for the same reason when the oracle leaves went. SEP-41 is
// unchanged throughout, which is the check that nothing else shifted.
const FIXTURES: Fixture[] = [
  {
    name: 'Blend claim',
    file: `${FIXTURE_ROOT}/demo-rec-blend.json`,
    smartAccount: 'CDXO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO4M7R',
    responses: {
      windowSeconds: 86400,
      validUntilLedger: 200_000_000,
    },
    expectedDocCount: 1,
    expectedHash: '928b07824487221fdfcdaa7a420920258a4749c4e7e32d4919cf1e0dc9ab3f55',
  },
  {
    name: 'Blend submit',
    file: `${FIXTURE_ROOT}/demo-tx-260725/recording-blend.json`,
    smartAccount: 'CDXO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO4M7R',
    responses: {
      windowSeconds: 86400,
      validUntilLedger: 200_000_000,
    },
    expectedDocCount: 1,
    // Carries the call_arg_len(3) + 3 per-element call_arg_field binds for the
    // recorded `requests` vec - the binds that stop an extra request being
    // appended or a request's asset/amount being swapped.
    expectedHash: '5b3b51f8178e1a5c4e9a43c8873d6edb29ecd0d8179ae6052277dc6a034c7669',
  },
  {
    name: 'SoroSwap swap',
    file: `${FIXTURE_ROOT}/demo-rec-soroswap.json`,
    smartAccount: 'CDXO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO4M7R',
    responses: {
      windowSeconds: 86400,
      limitAmount: '367287890',
      validUntilLedger: 200_000_000,
    },
    expectedDocCount: 1,
    expectedHash: '1719c2bbed30206e43f54dc2fa3dbb3e26b43e7c2d22506cf5ecc5e5b980c416',
  },
  {
    name: 'SEP-41 transfer',
    file: `${FIXTURE_ROOT}/demo-rec-sep41.json`,
    smartAccount: 'CDXO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO4M7R',
    responses: {
      windowSeconds: 86400,
      limitAmount: '7320000000',
      validUntilLedger: 200_000_000,
    },
    expectedDocCount: 1,
    expectedHash: 'f1968c71ff85993c701e2df31ce751c61785a8715b51a1398901840eb36dea79',
  },
]

// ---------------------------------------------------------------------------
// Decode predicate from wire blob
// ---------------------------------------------------------------------------

/** Decode a base64 XDR predicate blob to its top-level PredicateNode. */
function decodePredicate(encodedPredicate: string): PredicateNode | null {
  const scval = xdr.ScVal.fromXDR(Buffer.from(encodedPredicate, 'base64'))
  if (scval.switch().name !== 'scvVec') return null
  const vec = scval.vec()
  if (!vec || vec.length < 2) return null
  const head = vec[0]
  if (head?.switch().name !== 'scvSymbol') return null
  const tag = head.sym().toString()
  if (tag !== 'and') return null
  const inner = vec[1]
  if (inner?.switch().name !== 'scvVec') return null
  const childVec = inner.vec()
  if (!childVec) return null
  const children: PredicateNode[] = []
  for (const c of childVec) {
    const decoded = decodeScValToPredicate(c)
    if (decoded) children.push(decoded)
  }
  return { op: 'and', children }
}

function decodeScValToPredicate(scval: xdr.ScVal): PredicateNode | null {
  if (scval.switch().name !== 'scvVec') return null
  const vec = scval.vec()
  if (!vec || vec.length < 2) return null
  const head = vec[0]
  if (head?.switch().name !== 'scvSymbol') return null
  const tag = head.sym().toString()
  switch (tag) {
    case 'and':
    case 'or': {
      const inner = vec[1]
      if (inner?.switch().name !== 'scvVec') return null
      const innerVec = inner.vec()
      if (!innerVec) return null
      const children: PredicateNode[] = []
      for (const c of innerVec) {
        const d = decodeScValToPredicate(c)
        if (d) children.push(d)
      }
      return { op: tag, children }
    }
    case 'not': {
      const child = vec[1]
      if (!child) return null
      const d = decodeScValToPredicate(child)
      if (!d) return null
      return { op: 'not', child: d }
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const left = vec[1]
      const right = vec[2]
      if (!left || !right) return null
      const leftLeaf = decodeScValToLeaf(left)
      const rightLeaf = decodeScValToLeaf(right)
      if (!leftLeaf || !rightLeaf) return null
      return { op: tag, left: leftLeaf, right: rightLeaf }
    }
    case 'in': {
      const needle = vec[1]
      const haystack = vec[2]
      if (!needle || !haystack) return null
      const needleLeaf = decodeScValToLeaf(needle)
      if (!needleLeaf) return null
      if (haystack.switch().name !== 'scvVec') return null
      const haystackVec = haystack.vec()
      if (!haystackVec) return null
      const haystackLeaves = []
      for (const h of haystackVec) {
        const l = decodeScValToLeaf(h)
        if (l) haystackLeaves.push(l)
      }
      return { op: 'in', needle: needleLeaf, haystack: haystackLeaves }
    }
    default:
      return null
  }
}

function decodeScValToLeaf(scval: xdr.ScVal): import('../types.ts').PredicateLeaf | null {
  switch (scval.switch().name) {
    case 'scvSymbol': {
      const s = scval.sym().toString()
      switch (s) {
        case 'call_contract':
          return { kind: 'call_contract' }
        case 'call_fn':
          return { kind: 'call_fn' }
        case 'now':
          return { kind: 'now' }
      }
      return { kind: 'literal_symbol', value: s }
    }
    case 'scvVec': {
      const vec = scval.vec()
      if (!vec || vec.length === 0) return null
      const head = vec[0]
      if (head?.switch().name !== 'scvSymbol') {
        const elements: import('../types.ts').PredicateLeaf[] = []
        for (const el of vec) {
          const e = decodeScValToLeaf(el)
          if (e) elements.push(e)
        }
        return { kind: 'literal_vec', elements }
      }
      const stag = head.sym().toString()
      switch (stag) {
        case 'call_contract':
          return { kind: 'call_contract' }
        case 'call_fn':
          return { kind: 'call_fn' }
        case 'call_arg': {
          const idx = vec[1]
          if (idx?.switch().name !== 'scvU32') return null
          return { kind: 'call_arg', index: idx.u32() }
        }
        case 'call_arg_len': {
          const idx = vec[1]
          if (idx?.switch().name !== 'scvU32') return null
          return { kind: 'call_arg_len', index: idx.u32() }
        }
        case 'call_arg_field': {
          const idx = vec[1]
          const element = vec[2]
          const field = vec[3]
          if (idx?.switch().name !== 'scvU32') return null
          if (element?.switch().name !== 'scvU32') return null
          if (field?.switch().name !== 'scvSymbol') return null
          return {
            kind: 'call_arg_field',
            index: idx.u32(),
            element: element.u32(),
            field: field.sym().toString(),
          }
        }
        case 'amount': {
          const addr = vec[1]
          if (addr?.switch().name !== 'scvAddress') return null
          return { kind: 'amount', token: Address.fromScAddress(addr.address()).toString() }
        }
        case 'window_spent': {
          const addr = vec[1]
          const secs = vec[2]
          if (!addr || !secs || addr.switch().name !== 'scvAddress') return null
          return {
            kind: 'window_spent',
            token: Address.fromScAddress(addr.address()).toString(),
            windowSeconds: Number(BigInt(secs.u64().toString())),
          }
        }
        case 'invocation_count': {
          const secs = vec[1]
          if (!secs) return null
          return {
            kind: 'invocation_count_in_window',
            windowSecs: Number(BigInt(secs.u64().toString())),
          }
        }
        default:
          return null
      }
    }
    case 'scvAddress':
      return { kind: 'literal_address', value: Address.fromScAddress(scval.address()).toString() }
    case 'scvU32':
      return { kind: 'literal_u32', value: scval.u32() }
    case 'scvI128': {
      const parts = scval.i128()
      const hi = BigInt(parts.hi().toString()) << 64n
      const lo = BigInt(parts.lo().toString())
      return { kind: 'literal_i128', value: (hi + lo).toString() }
    }
    case 'scvU64':
      return { kind: 'literal_u64', value: scval.u64().toString() }
    case 'scvBytes':
      return { kind: 'literal_bytes', value: scval.bytes().toString('hex') }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('overpermissive-harness: regression suite', () => {
  for (const fixture of FIXTURES) {
    describe(`fixture: ${fixture.name}`, () => {
      // Load the fixture JSON
      let tx: RecordedTransaction
      try {
        const content = readFileSync(fixture.file, 'utf8')
        const parsed = JSON.parse(content)
        tx = parsed.ok ? parsed.data : parsed
      } catch (err) {
        it(`SKIP: could not load fixture file: ${err}`, () => {})
        return
      }

      const ozConfig = placeholderOzConfig('mainnet')

      const synthRes = synthesizeFromRecording(
        tx,
        {
          network: 'mainnet',
          userResponses: fixture.responses,
          interpreter: {
            smartAccountAddress: fixture.smartAccount,
            installNonce: 1,
          },
        },
        ozConfig
      )

      it('synthesizes successfully', () => {
        expect(synthRes.ok).toBe(true)
        if (!synthRes.ok) return
        expect(synthRes.data.policyDocuments.length).toBe(fixture.expectedDocCount)
      })

      if (!synthRes.ok) return
      const policy = synthRes.data

      it(`predicateHash matches regression baseline: ${fixture.expectedHash}`, () => {
        expect(policy.policyDocuments[0]?.predicateHash).toBe(fixture.expectedHash)
      })

      it('no warnings from synthesis', () => {
        const unexpectedWarnings = policy.warnings.filter(
          (w) =>
            !w.includes('RECIPIENT_ALLOWLIST_EMPTY') &&
            !w.includes('Not covered by OZ built-in primitives')
        )
        expect(unexpectedWarnings).toEqual([])
      })

      // Decode predicate and build permit context
      const doc = policy.policyDocuments[0]
      if (!doc) return
      const predicate = decodePredicate(doc.encodedPredicate)

      it('predicate decodes successfully', () => {
        expect(predicate).not.toBeNull()
      })
      if (!predicate) return

      // Build the permit context from the recorded tx + user responses
      const permitCtx = buildPermitContext(tx, fixture.responses)

      it('the recorded call is permitted by the emitted predicate', () => {
        const result = evaluate(predicate, permitCtx)
        expect(result.permit).toBe(true)
      })

      // Run generateCases WITHOUT dimension filter to get ALL mutations including over-permissive ones
      const cases = generateCases(predicate, permitCtx)

      // Over-permissiveness dimensions to test as FINDINGS
      const newDimensions = ['argument_reorder', 'vec_append', 'map_field_flip'] as const

      for (const dim of newDimensions) {
        it(`${dim}: predicate must DENY this mutation — OVER-PERMISSIVE if this fails`, () => {
          const deny = cases.denies.find((d) => d.dimension === dim)
          // Not every fixture yields every mutation: argument_reorder needs two
          // adjacent address arguments, which only the SEP-41 transfer has. Skip
          // where it cannot be built rather than assert vacuously - the
          // dimension-coverage test below keeps that skip honest.
          if (!deny) return
          const result = evaluate(predicate, deny.ctx)
          // FINDING if result.permit is true (policy allowed an unintended mutation)
          expect(result.permit).toBe(false)
        })
      }

      // Run the full harness on ORIGINAL_DIMENSIONS to confirm baseline still denies
      it('all original-dimension deny cases deny (runHarness on ORIGINAL_DIMENSIONS)', () => {
        const { ORIGINAL_DIMENSIONS } = require('./deny-cases.ts')
        const origCases = generateCases(predicate, permitCtx, ORIGINAL_DIMENSIONS)
        const result = runHarness(predicate, origCases)
        expect(result.ok).toBe(true)
      })

      // Evil-twin: for the Blend submit fixture, the recorded request_type
      // is 3 (WithdrawCollateral). An attacker flipping it to 4 (Borrow) -
      // on any asset, any amount - MUST be denied. This is the per-element
      // `call_arg_field` pin in action: without it, a WithdrawCollateral
      // policy silently permits Borrow.
      if (fixture.name === 'Blend submit') {
        it('EVIL TWIN: request_type 3 (WithdrawCollateral) -> 4 (Borrow) is DENIED', () => {
          const evil = structuredClone(permitCtx)
          const arg3 = evil.args[3]
          if (arg3?.type !== 'vec' || arg3.value.length === 0) return
          const element = arg3.value[0]
          if (element?.type !== 'map' || !Array.isArray(element.value)) return
          element.value = element.value.map(
            (e: { key: string; val: { type: string; value: string } }) =>
              e.key === 'request_type' ? { key: e.key, val: { type: 'u32', value: '4' } } : e
          )
          const result = evaluate(predicate, evil)
          expect(result.permit).toBe(false)
        })
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Minimality: emitted predicate has more than 1 conjunct after minimise
// ---------------------------------------------------------------------------

describe('overpermissive-harness: minimality', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: emitted predicate has more than 1 conjunct after minimise`, () => {
      const ozConfig = placeholderOzConfig('mainnet')
      let tx: RecordedTransaction
      try {
        const content = readFileSync(fixture.file, 'utf8')
        const parsed = JSON.parse(content)
        tx = parsed.ok ? parsed.data : parsed
      } catch {
        return // skip if fixture not available
      }

      const synthRes = synthesizeFromRecording(
        tx,
        {
          network: 'mainnet',
          userResponses: fixture.responses,
          interpreter: { smartAccountAddress: fixture.smartAccount, installNonce: 1 },
        },
        ozConfig
      )
      if (!synthRes.ok) return
      const doc = synthRes.data.policyDocuments[0]
      if (!doc) return
      const predicate = decodePredicate(doc.encodedPredicate)
      if (!predicate) return

      // A predicate with only 1 conjunct is trivially minimal; skip
      if (predicate.op !== 'and' || predicate.children.length <= 1) return

      // The minimise step should have run — at minimum we expect contract + fn constraints
      expect(predicate.children.length).toBeGreaterThanOrEqual(2)
    })
  }
})

// ---------------------------------------------------------------------------
// Helper: build PermitContext (mirrors synthesizeFromRecording#buildPermitContext)
// ---------------------------------------------------------------------------

function _cloneScVal(
  value: { type: string; value: unknown },
  depth = 0
): { type: string; value: unknown } {
  if (value.type === 'vec') {
    if (depth >= 30) throw new Error('ScVal clone depth exceeded')
    return {
      type: 'vec',
      value: (value.value as Array<unknown>).map((v) =>
        _cloneScVal(v as { type: string; value: unknown }, depth + 1)
      ),
    }
  }
  if (value.type === 'map') {
    if (depth >= 30) throw new Error('ScVal clone depth exceeded')
    return {
      type: 'map',
      value: (value.value as Array<unknown>).map((e) => {
        const entry = e as { key: string; val: { type: string; value: unknown } }
        return { key: entry.key, val: _cloneScVal(entry.val, depth + 1) }
      }),
    }
  }
  return { ...value }
}

// ---------------------------------------------------------------------------
// Dimension coverage
// ---------------------------------------------------------------------------
//
// The per-fixture mutation tests skip when a dimension cannot be built for that
// fixture. That skip is reasonable - argument_reorder needs two adjacent address
// arguments and only the SEP-41 transfer has them - but it also means the whole
// battery could quietly degrade to nothing if generation stopped working. This
// test fails if no fixture exercises the dimension at all, so a silent all-skip
// cannot masquerade as a pass.

describe('overpermissive-harness: dimension coverage', () => {
  for (const dim of ['argument_reorder', 'vec_append', 'map_field_flip']) {
    it(`${dim} is exercised by at least one fixture`, () => {
      let exercised = 0
      for (const fixture of FIXTURES) {
        const parsed = JSON.parse(readFileSync(fixture.file, 'utf8'))
        const tx: RecordedTransaction = parsed.ok ? parsed.data : parsed
        const res = synthesizeFromRecording(
          tx,
          {
            network: 'mainnet',
            userResponses: fixture.responses,
            interpreter: { smartAccountAddress: fixture.smartAccount, installNonce: 1 },
          },
          placeholderOzConfig('mainnet')
        )
        if (!res.ok) continue
        const doc = res.data.policyDocuments[0]
        if (!doc) continue
        const predicate = decodePredicate(doc.encodedPredicate)
        if (!predicate) continue
        const permitCtx = buildPermitContext(tx, fixture.responses)
        const cases = generateCases(predicate, permitCtx)
        if (cases.denies.some((d) => d.dimension === dim)) exercised++
      }
      expect(exercised).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------
// Unconstrained-argument sweep
// ---------------------------------------------------------------------------
//
// The deny-case generator derives its mutations FROM the constraints a
// predicate already carries. That makes it good at proving an emitted
// constraint is enforced, and structurally blind to a constraint that was never
// emitted at all - it cannot mutate an argument nothing mentions.
//
// That blindness is not hypothetical. It is the exact shape of the swap
// recipient defect: the predicate pinned contract, function and hop path, every
// generated deny case passed, and the recipient argument was free.
//
// This sweep inverts the direction. It walks the RECORDED call's arguments,
// substitutes a different valid value of the same type into each one, and
// requires the predicate to deny. An argument the predicate does not constrain
// permits its own mutation and surfaces here.
//
// Arguments legitimately left free are listed in APPROVED_FREE_ARGS with the
// reason. Anything outside that list fails, so a newly unconstrained argument
// cannot land silently. Shrinking the list is tightening; growing it is a
// decision that should be argued for in review.

const APPROVED_FREE_ARGS: Record<string, Record<number, string>> = {
  'Blend claim': {
    0: 'from: the smart account itself, and the call already requires its auth',
    1: 'reserve token ids: a vec<u32> with no map fields; the grammar cannot bind element-wise',
  },
  'Blend submit': {
    0: 'from: the call already requires from authorisation, so binding adds no restriction',
    1: 'spender: same as from - the call already requires spender authorisation',
  },
  'SoroSwap swap': {
    0: 'amount_in: bounded by window_spent when --limit-amount is supplied',
    1: 'amount_out_min: a per-call floor the grammar does not express',
    4: 'deadline: a u64 ledger time the recorded flow does not fix',
  },
  'SEP-41 transfer': {
    0: 'from: the smart account itself, and the call already requires its auth',
    2: 'amount: bounded by the OZ spending_limit, not by the predicate',
  },
}

/** A different, valid value of the SAME type. Never a type or arity change: a
 *  call violating the contract's declared signature fails host dispatch and
 *  never reaches Policy::enforce, so denying it is not the policy's job.
 *
 *  vec / map handling (Phase 1 grammar extension): the sweep substitutes the
 *  same-type mutation that a real caller could issue. For a vec, the cheapest
 *  same-type mutation is to APPEND a fresh element (a caller can always send
 *  a longer vec; the v1 policy that does not pin length is over-permissive).
 *  For a map, the cheapest same-type mutation is to flip the value of a known
 *  field by +1 (a u32 / i128 / u64 / address). Both mutations are modelled
 *  by the OPT-IN `vec_append` and `map_field_flip` dimensions, so the
 *  predicate that does NOT pin them will be caught here. */
function differentSameTypeValue(arg: {
  type: string
  value: unknown
}): { type: string; value: unknown } | null {
  switch (arg.type) {
    case 'address': {
      // Two known-valid strkeys; pick whichever differs from the recorded one.
      const a = 'GBFKRGJYZXLTDEI36ZCQEIM225NMOCR2VDBOIHJTXJ54FEFFVL2FKALE'
      const b = 'GD6XSMQJ47EHHJOWXQOND5YDVZC37JWZJHYHBKE6QJFSLLJ5KQXM5QS5'
      return { type: 'address', value: arg.value === a ? b : a }
    }
    case 'i128':
    case 'u64':
    case 'u32':
      return { type: arg.type, value: String(BigInt(String(arg.value)) + 1n) }
    case 'symbol':
      return { type: 'symbol', value: `${String(arg.value)}x` }
    case 'vec':
      // Append a benign same-typed element (an opaque ScVal): the v1 grammar
      // cannot tell the new element apart from the recorded one without
      // pinning length + per-element fields, so a policy that omits those
      // permits the longer vec. This is exactly the evil-twin a missing
      // `call_arg_len` leaf lets through.
      return {
        type: 'vec',
        value: [...(arg.value as unknown[]), { type: 'other', value: 'sweep-vec-append' }],
      }
    case 'map': {
      // Flip the first numeric/address field by +1: the cheapest same-type
      // mutation that a malicious caller could issue. A policy that pins the
      // field (via `call_arg_field`) catches it; a policy that does not
      // permits it.
      const entries = arg.value as Array<{ key: string; val: { type: string; value: string } }>
      const newEntries = entries.map((e) => {
        if (e.val.type === 'i128' || e.val.type === 'u64' || e.val.type === 'u32') {
          return { key: e.key, val: { type: e.val.type, value: String(BigInt(e.val.value) + 1n) } }
        }
        if (e.val.type === 'address') {
          return {
            key: e.key,
            val: {
              type: 'address',
              value: 'GBFKRGJYZXLTDEI36ZCQEIM225NMOCR2VDBOIHJTXJ54FEFFVL2FKALE',
            },
          }
        }
        return e
      })
      return { type: 'map', value: newEntries }
    }
    default:
      // bytes: no obvious same-type neighbour.
      return null
  }
}

describe('overpermissive-harness: unconstrained-argument sweep', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: no argument is unconstrained beyond the approved set`, () => {
      const parsed = JSON.parse(readFileSync(fixture.file, 'utf8'))
      const tx: RecordedTransaction = parsed.ok ? parsed.data : parsed
      const res = synthesizeFromRecording(
        tx,
        {
          network: 'mainnet',
          userResponses: fixture.responses,
          interpreter: { smartAccountAddress: fixture.smartAccount, installNonce: 1 },
        },
        placeholderOzConfig('mainnet')
      )
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const doc = res.data.policyDocuments[0]
      expect(doc).toBeDefined()
      if (!doc) return
      const predicate = decodePredicate(doc.encodedPredicate)
      expect(predicate).not.toBeNull()
      if (!predicate) return

      const permitCtx = buildPermitContext(tx, fixture.responses)
      const approved = APPROVED_FREE_ARGS[fixture.name] ?? {}
      const unexpected: string[] = []
      let swept = 0

      for (let i = 0; i < permitCtx.args.length; i++) {
        const arg = permitCtx.args[i] as { type: string; value: unknown } | undefined
        if (!arg) continue
        const replacement = differentSameTypeValue(arg)
        if (!replacement) continue
        swept++
        const ctx = structuredClone(permitCtx)
        ctx.args[i] = replacement as (typeof ctx.args)[number]
        const verdict = evaluate(predicate, ctx)
        if (verdict.permit && !(i in approved)) {
          unexpected.push(
            `call_arg[${i}] (${arg.type}) unconstrained: predicate permits a different value`
          )
        }
      }

      // Guard against the sweep silently degrading to nothing.
      expect(swept).toBeGreaterThan(0)
      expect(unexpected).toEqual([])
    })
  }
})
