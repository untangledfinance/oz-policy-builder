// A keyless rule bound to an execution adapter with no gate (the no-gate liquidation): what pins a
// whole immediate batch, mirrored case for case from the interpreter's `tests/batch_pin.rs`; the
// intent rows that write one; the install that emits the keyless rule and the binding that follows.

import { describe, expect, it } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { authority, lines } from './card.ts'
import type { ContractKind, Fingerprint } from './chain.ts'
import { INTERPRETER } from './config.ts'
import { Refusal } from './envelope.ts'
import {
  type BindChain,
  type Chain,
  type Chosen,
  executorProblem,
  pinsOwn,
  planBind,
  planInstall,
  type RuleDraft,
  ruleArgs,
} from './install.ts'
import { callExpr, type Intent, intentExprs } from './intent.ts'
import type { ObservedRule } from './rules.ts'
import { run } from './tools.ts'
import { CEILINGS, type Expr, encode, hashOf, type Val, validate } from './wire.ts'

const INTERP = (INTERPRETER.testnet as { address: string }).address
const ADAPTER = contract(21)
const VENUE = contract(22)
const TOKEN = contract(23)
const OTHER = contract(24)
const ACCOUNT = contract(25)
const SOURCE = account(3)

// ---- the predicates of batch_pin.rs, on the wire ----

const and = (kids: Expr[]): Expr => ['and', kids]
const or = (kids: Expr[]): Expr => ['or', kids]
const fnIs = (name: string): Expr => ['eq', ['call_fn'], name]
const path = (...steps: Val[]): Expr => ['call_path', ...steps]
const eq = (a: Val, b: Val): Expr => ['eq', a, b]
const waitZero = () => eq(path(2), 0)
const lenIs = (n: number) => eq(path(0, true), n)
const target = (i: number) => path(0, i, 'target')
const fn = (i: number) => path(0, i, 'function_name')
const shape = (): Expr[] => [
  fnIs('execute'),
  waitZero(),
  lenIs(2),
  eq(target(0), VENUE),
  eq(fn(0), 'submit'),
  ['in', target(1), [TOKEN, OTHER]],
  eq(fn(1), 'transfer'),
]
const but = (i: number, w?: Expr): Expr => {
  const k = shape()
  if (w === undefined) k.splice(i, 1)
  else k[i] = w
  return and(k)
}

describe('pinsOwn mirrors the interpreter: every way of writing the full shape binds', () => {
  const field = (i: number, f: string): Expr => ['call_arg_field', 0, i, f]
  const accepted: Expr[] = [
    and(shape()),
    but(2, lenIs(1)),
    but(2, eq(['call_arg_len', 0], 2)),
    but(3, eq(field(0, 'target'), VENUE)),
    but(1, eq(path(2), { i128: '0' })),
    but(4, eq(path(0, 0, ['lit', 'function_name']), 'submit')),
    but(0, eq('execute', ['call_fn'])),
    or([and(shape()), but(2, lenIs(1))]),
    and([and(shape().slice(0, 3)), and(shape().slice(3)), ['gt', path(0, 1, 'args', 2), 0]]),
    // `run` alone, unchanged.
    fnIs('run'),
  ]
  for (const [n, p] of accepted.entries())
    it(`case ${n}`, () => {
      validate(p, CEILINGS)
      expect(pinsOwn(p)).toBe(true)
    })
})

describe('pinsOwn mirrors the interpreter: anything less than the full shape is refused (221)', () => {
  const open: Expr[] = [
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => but(i)),
    but(1, eq(path(2), 1)),
    but(1, ['lte', path(2), 0]),
    but(2, lenIs(3)),
    but(2, ['lte', path(0, true), 2]),
    but(3, ['ne', target(0), TOKEN]),
    but(5, ['nin', target(1), [TOKEN]]),
    but(3, eq(target(0), target(1))),
    but(0, ['in', ['call_fn'], ['execute']]),
    but(3, eq(path(0, 0, 'args'), VENUE)),
    but(4, eq(path(0, 0, { string: 'function_name' }), 'submit')),
    but(3, eq(target(1), VENUE)),
    but(3, eq(path(0, 0, 'target', 0), VENUE)),
    or([and(shape()), but(3)]),
    or([and(shape()), fnIs('run'), fnIs('execute')]),
    or([and(shape()), fnIs('run')]),
    and([
      fnIs('execute'),
      waitZero(),
      lenIs(2),
      ['all', ['call_arg', 0], eq(['elem', 'target'], VENUE)],
    ]),
    but(6, or([eq(fn(1), 'transfer'), waitZero()])),
    // Nothing read, nothing pinned.
    null as unknown as Expr,
  ]
  for (const [n, p] of open.entries())
    it(`case ${n}`, () => {
      expect(pinsOwn(p)).toBe(false)
    })
})

// ---- the intent that writes one ----

/** A liquidation through the adapter: `venue.submit` then `token.transfer`, run now, with the
 *  liquidator tied to the recipient and kept off the line's own addresses. */
const liquidation: Intent = {
  calls: [
    {
      contract: ADAPTER,
      fn: 'execute',
      where: [
        { constraint: 'pin', at: [2], to: 0 },
        { constraint: 'count', at: [0], is: 2 },
        { constraint: 'pin', at: [0, 0, 'target'], to: VENUE },
        { constraint: 'pin', at: [0, 0, 'function_name'], to: 'submit' },
        { constraint: 'pin', at: [0, 1, 'target'], to: TOKEN },
        { constraint: 'pin', at: [0, 1, 'function_name'], to: 'transfer' },
        { constraint: 'same', at: [0, 0, 'args', 0], as: [0, 1, 'args', 1] },
        { constraint: 'deny', at: [0, 1, 'args', 1], nin: [ACCOUNT, VENUE] },
        { constraint: 'count', at: [1], is: 0 },
      ],
    },
  ],
}

describe('the intent rows for a whole batch: count and same', () => {
  const expr = intentExprs(liquidation).get(ADAPTER) as Expr

  it('lower to an exact length and an argument-to-argument eq, and the rule pins the whole batch', () => {
    validate(expr, CEILINGS)
    const text = JSON.stringify(expr)
    expect(text).toContain(JSON.stringify(['eq', ['call_path', 0, true], 2]))
    expect(text).toContain(
      JSON.stringify(['eq', ['call_path', 0, 0, 'args', 0], ['call_path', 0, 1, 'args', 1]])
    )
    expect(pinsOwn(expr)).toBe(true)
  })

  it('the length only bounded, as `length` writes it, does not pin the batch', () => {
    const loose = intentExprs({
      calls: [
        {
          ...(liquidation.calls[0] as Intent['calls'][number]),
          where: (liquidation.calls[0]?.where ?? []).map((w) =>
            w.constraint === 'count' && w.at[0] === 0
              ? { constraint: 'length', at: [0], max: 2 }
              : w
          ),
        },
      ],
    }).get(ADAPTER)
    expect(pinsOwn(loose)).toBe(false)
  })

  it('synthesize_policy takes the rows, and refuses a malformed one', async () => {
    const r = await run('synthesize_policy', { network: 'testnet', intent: liquidation })
    expect(r.ok).toBe(true)
    const bad = await run('synthesize_policy', {
      network: 'testnet',
      intent: {
        calls: [
          { contract: ADAPTER, fn: 'execute', where: [{ constraint: 'count', at: [0], is: -1 }] },
        ],
      },
    })
    expect(!bad.ok && bad.error.code).toBe('INVALID_INPUT')
  })
})

// ---- the install of the keyless rule, and its binding ----

const ours: Fingerprint = {
  address: INTERP,
  grammarVersion: 7,
  wasmSha256: 'a'.repeat(64),
  matches: true,
}
const batch = intentExprs(liquidation).get(ADAPTER) as Expr
const rule: Chosen = {
  contract: ADAPTER,
  expr: batch,
  encoded: encode(batch),
  hash: hashOf(encode(batch)),
}
const input = {
  network: 'testnet' as const,
  smartAccount: ACCOUNT,
  sourceAccount: SOURCE,
  signers: [] as string[],
}
const chain = (
  kinds: Record<string, ContractKind> = { [ADAPTER]: 'null-gate adapter' },
  drafts: RuleDraft[] = []
): Chain => ({
  fingerprint: async () => ours,
  readRules: async () => ({ rules: [], complete: true, unreadable: [] }),
  build: async (d) => {
    drafts.push(d)
    return { unsignedXdr: 'AAAA' } as never
  },
  token: async () => true,
  contracts: async (a) => Object.fromEntries(a.map((x) => [x, kinds[x] ?? 'contract'])),
})
const refused = async (p: Promise<unknown>, code: string, text: RegExp) => {
  const e = await p.then(
    () => undefined,
    (x) => x
  )
  expect(e).toBeInstanceOf(Refusal)
  expect((e as Refusal).code).toBe(code)
  expect((e as Refusal).message).toMatch(text)
}

describe('planInstall: a keyless rule for an executor', () => {
  it('emits add_context_rule with no signer, and says the executor is the only way in', async () => {
    const drafts: RuleDraft[] = []
    const r = await planInstall({ ...input, executor: ADAPTER }, rule, chain(undefined, drafts))
    const d = drafts[0] as RuleDraft
    expect(d.signers).toEqual([])
    expect(d.executor).toBe(ADAPTER)
    expect(ruleArgs(d, INTERP)[3]).toEqual([])
    expect(r.authority.executor).toEqual({ address: ADAPTER, kind: 'null-gate adapter' })
    const text = lines([authority(r.authority, {})]).join('\n')
    expect(text).toMatch(/no key: the rule permits only a call its executor vouches for/)
    expect(text).toMatch(/anyone may call its execute with an immediate batch/)
    expect(text).toMatch(/the only fence/)
  })

  it('no signer and no executor, a batch left open, or an executor that is no adapter: refused', async () => {
    await refused(
      planInstall(input, rule, chain()),
      'INSTALL_BUILD_FAILED',
      /keyless rule names the `executor`/
    )
    const open = and(shape().slice(0, 2))
    await refused(
      planInstall({ ...input, executor: ADAPTER }, { ...rule, expr: open }, chain()),
      'INSTALL_BUILD_FAILED',
      /without pinning.*221/
    )
    await refused(
      planInstall({ ...input, executor: ADAPTER }, rule, chain({ [ADAPTER]: 'contract' })),
      'INSTALL_BUILD_FAILED',
      /not an execution adapter/
    )
    await refused(
      planInstall({ ...input, executor: ADAPTER }, rule, chain({ [ADAPTER]: 'absent' })),
      'INSTALL_BUILD_FAILED',
      /not deployed/
    )
    // A gated adapter never vouches for its own execute: a batch rule on it would never permit.
    await refused(
      planInstall({ ...input, executor: ADAPTER }, rule, chain({ [ADAPTER]: 'gated adapter' })),
      'INSTALL_BUILD_FAILED',
      /never vouches for its own execute/
    )
    // Without the executor in hand, the builder still refuses a rule with no signer.
    expect(() =>
      ruleArgs(
        {
          ...(rule as never),
          scope: { kind: 'default' },
          signers: [],
          admins: [SOURCE],
          name: 'x',
          validUntil: null,
          predicate: { encoded: rule.encoded, hash: rule.hash },
          nonce: 1,
        },
        INTERP
      )
    ).toThrow(/governs no key|govern no key/)
  })

  it('a keyless rule scoped elsewhere (the venue) only needs an adapter executor', async () => {
    const venue = callExpr({ contract: VENUE, fn: 'submit' })
    const r = await planInstall(
      { ...input, executor: ADAPTER },
      { contract: VENUE, expr: venue, encoded: encode(venue), hash: hashOf(encode(venue)) },
      chain()
    )
    expect(r.authority.signers).toEqual([])
  })
})

describe('planBind: the binding of a rule to an executor', () => {
  const observed = (o: Partial<ObservedRule> = {}): ObservedRule => ({
    id: 4,
    scope: { kind: 'call_contract', contract: ADAPTER },
    signers: [],
    policies: [INTERP],
    expr: batch,
    admins: [SOURCE],
    ...o,
  })
  const bindChain = (
    r: ObservedRule | undefined,
    kind: ContractKind = 'null-gate adapter'
  ): BindChain => ({
    readRule: async () => r,
    kind: async () => kind,
    fingerprint: async () => ours,
    build: async () => ({ unsignedXdr: 'BBBB' }) as never,
  })
  const i = { smartAccount: ACCOUNT, sourceAccount: SOURCE, ruleId: 4, executor: ADAPTER }

  it('binds a keyless rule that pins the whole batch, and names an executor it replaces', async () => {
    const r = await planBind(i, INTERP, bindChain(observed()))
    expect(r.unsignedXdr).toBe('BBBB')
    expect(r.binds).toMatchObject({ id: 4, executor: ADAPTER })
    expect(r).not.toHaveProperty('rebinds')
    const again = await planBind(i, INTERP, bindChain(observed({ executor: OTHER })))
    expect(again.rebinds).toBe(OTHER)
  })

  it('refuses what the interpreter would (221), or the builder cannot see or sign', async () => {
    const code = 'BIND_BUILD_FAILED'
    await refused(planBind(i, INTERP, bindChain(undefined)), code, /has no rule 4/)
    await refused(planBind(i, INTERP, bindChain(observed({ policies: [] }))), code, /not policed/)
    await refused(
      planBind(i, INTERP, bindChain(observed({ expr: undefined }))),
      code,
      /cannot be read/
    )
    await refused(
      planBind(i, INTERP, bindChain(observed({ expr: and(shape().slice(1)) }))),
      code,
      /221/
    )
    await refused(
      planBind(i, INTERP, bindChain(observed(), 'contract')),
      code,
      /not an execution adapter/
    )
    await refused(
      planBind(i, INTERP, bindChain(observed({ admins: [SOURCE, account(4)] }))),
      code,
      /signs as the source account/
    )
    await refused(
      planBind(i, INTERP, {
        ...bindChain(observed()),
        fingerprint: async () => ({ ...ours, matches: false }),
      }),
      'INTERPRETER_MISMATCH',
      /trusts/
    )
  })

  it('executorProblem: a rule scoped elsewhere needs only an adapter', () => {
    expect(executorProblem(ADAPTER, 'null-gate adapter', VENUE, null)).toBeUndefined()
    expect(executorProblem(ADAPTER, 'gated adapter', VENUE, null)).toBeUndefined()
  })
})
