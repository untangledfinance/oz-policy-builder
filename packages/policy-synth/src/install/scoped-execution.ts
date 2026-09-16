import { Address, xdr } from '@stellar/stellar-sdk'
import { createHash } from 'node:crypto'
import { encodePredicate } from '../predicate/encode.js'
import type { PredicateNode, PredicateLeaf } from '../types.js'
import type { BlendExecutionMandateParams } from './venue-execution-mandate.js'

export interface ExecutionAuthRule {
  predicate: PredicateNode
  children: ExecutionAuthRule[]
}
export interface ExecutionStep {
  predicate: PredicateNode
  authorizations: ExecutionAuthRule[]
}
/** Index into a vector or key in a symbol-keyed map, starting at calls. */
export type ExecutionPath = (number | string)[]
export interface ExecutionPlan {
  steps: ExecutionStep[]
  equalities: { left: ExecutionPath; right: ExecutionPath }[]
}
export interface ExecutionDocument {
  executor: string
  plans: ExecutionPlan[]
}
const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const vec = (v: xdr.ScVal[]) => xdr.ScVal.scvVec(v)
const map = (m: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(m)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: m[k]! }))
  )
function bounded(n: number, max: number, empty = false) {
  if (!Number.isSafeInteger(n) || n < (empty ? 0 : 1) || n > max)
    throw new Error('execution document exceeds structural limits')
}
function contract(s: string) {
  if (!s.startsWith('C')) throw new Error('executor must be a contract')
  return new Address(s).toScVal()
}
const bytes = (p: PredicateNode) =>
  xdr.ScVal.scvBytes(Buffer.from(encodePredicate(p).encodedPredicate, 'base64'))
export function encodeExecutionDocument(doc: ExecutionDocument) {
  bounded(doc.plans.length, 8)
  const executor = contract(doc.executor)
  const path = (parts: ExecutionPath) => {
    bounded(parts.length, 16)
    return vec(
      parts.map((p) => {
        if (typeof p === 'string') return vec([sym('Key'), sym(p)])
        if (!Number.isSafeInteger(p) || p < 0 || p > 0xffffffff)
          throw new Error('invalid execution path index')
        return vec([sym('Index'), xdr.ScVal.scvU32(p)])
      })
    )
  }
  const plans = doc.plans.map((p) => {
    bounded(p.steps.length, 8)
    bounded(p.equalities.length, 32, true)
    let count = 0
    const auth = (rules: ExecutionAuthRule[], depth: number): xdr.ScVal => {
      if (depth > 4) throw new Error('authorization depth exceeds limit')
      return vec(
        rules.map((r) => {
          if (++count > 32) throw new Error('authorization count exceeds limit')
          return map({ predicate: bytes(r.predicate), children: auth(r.children, depth + 1) })
        })
      )
    }
    return map({
      steps: vec(
        p.steps.map((s) =>
          map({ predicate: bytes(s.predicate), authorizations: auth(s.authorizations, 0) })
        )
      ),
      equalities: vec(
        p.equalities.map((eq) => map({ left: path(eq.left), right: path(eq.right) }))
      ),
    })
  })
  const wire = vec([sym('execution_v1'), map({ executor, plans: vec(plans) })]).toXDR()
  bounded(wire.length, 32768)
  return {
    grammarVersion: 6 as const,
    encodedPredicate: wire.toString('base64'),
    predicateHash: createHash('sha256').update(wire).digest('hex'),
  }
}
const eq = (left: PredicateLeaf, right: PredicateLeaf): PredicateNode => ({ op: 'eq', left, right })
const a = (value: string): PredicateLeaf => ({ kind: 'literal_address', value })
const s = (value: string): PredicateLeaf => ({ kind: 'literal_symbol', value })
const u = (value: number): PredicateLeaf => ({ kind: 'literal_u32', value })
const i = (value: string): PredicateLeaf => ({ kind: 'literal_i128', value })
const arg = (index: number): PredicateLeaf => ({ kind: 'call_arg', index })
const field = (field: string): PredicateLeaf => ({
  kind: 'call_arg_field',
  index: 3,
  element: 0,
  field,
})
const and = (...children: PredicateNode[]): PredicateNode => ({ op: 'and', children })
/** Predicates remain in the existing interpreter; the adapter knows no Blend ABI. */
export function scopedBlendExecutionPlans(p: BlendExecutionMandateParams): ExecutionPlan[] {
  contract(p.prime)
  contract(p.executor)
  contract(p.token)
  contract(p.pool)
  new Address(p.custody)
  const cap = BigInt(p.maxAmountBaseUnits)
  if (cap <= 0n || cap >= 1n << 127n) throw new Error('invalid positive i128 amount cap')
  const bounds = (leaf: PredicateLeaf): PredicateNode[] => [
    { op: 'gt', left: leaf, right: i('0') },
    { op: 'lt', left: leaf, right: i(cap.toString()) },
  ]
  const identity = (target: string, name: string): PredicateNode[] => [
    eq({ kind: 'call_contract' }, a(target)),
    eq({ kind: 'call_fn' }, s(name)),
  ]
  const pull = and(
    ...identity(p.token, 'transfer_from'),
    eq(arg(0), a(p.prime)),
    eq(arg(1), a(p.custody)),
    eq(arg(2), a(p.executor)),
    ...bounds(arg(3))
  )
  const submit = (kind: number) =>
    and(
      ...identity(p.pool, 'submit'),
      eq(arg(0), a(p.prime)),
      eq(arg(1), a(p.executor)),
      eq(arg(2), a(p.custody)),
      eq({ kind: 'call_arg_len', index: 3 }, u(1)),
      eq(field('address'), a(p.token)),
      eq(field('request_type'), u(kind)),
      ...bounds(field('amount'))
    )
  const transfer = and(
    ...identity(p.token, 'transfer'),
    eq(arg(0), a(p.executor)),
    eq(arg(1), a(p.pool)),
    ...bounds(arg(2))
  )
  return [
    {
      steps: [
        { predicate: pull, authorizations: [] },
        { predicate: submit(0), authorizations: [{ predicate: transfer, children: [] }] },
      ],
      equalities: [
        { left: [0, 'args', 3], right: [1, 'args', 3, 0, 'amount'] },
        { left: [0, 'args', 3], right: [1, 'executor_authorizations', 0, 1, 'context', 'args', 2] },
      ],
    },
    { steps: [{ predicate: submit(1), authorizations: [] }], equalities: [] },
  ]
}
export function buildScopedBlendExecutionPolicy(p: BlendExecutionMandateParams) {
  return encodeExecutionDocument({ executor: p.executor, plans: scopedBlendExecutionPlans(p) })
}
