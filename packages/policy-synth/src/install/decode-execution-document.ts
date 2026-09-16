import { Address, xdr } from '@stellar/stellar-sdk'
import { decodePredicate } from '../predicate/decode.ts'
import { encodePredicate } from '../predicate/encode.ts'
import type { ExecutionAuthRule, ExecutionDocument, ExecutionPath } from './scoped-execution.ts'

const MAX_BYTES = 32768
function invalid(): never {
  throw new Error('Malformed or unsupported execution document')
}
function vector(value: xdr.ScVal | undefined, max: number, min = 0): xdr.ScVal[] {
  if (!value || value.switch() !== xdr.ScValType.scvVec()) return invalid()
  const items = value.vec()
  if (!items || items.length < min || items.length > max) return invalid()
  return items
}
function symbol(value: xdr.ScVal | undefined): string {
  if (!value || value.switch() !== xdr.ScValType.scvSymbol()) return invalid()
  return value.sym().toString()
}
function fields(value: xdr.ScVal | undefined, names: string[]): Record<string, xdr.ScVal> {
  if (!value || value.switch() !== xdr.ScValType.scvMap()) return invalid()
  const entries = value.map()
  if (!entries || entries.length !== names.length) return invalid()
  const out: Record<string, xdr.ScVal> = Object.create(null)
  for (const entry of entries) {
    const name = symbol(entry.key())
    if (!names.includes(name) || Object.hasOwn(out, name)) return invalid()
    out[name] = entry.val()
  }
  return out
}
/** Bound XDR nesting before the recursive predicate decoder/encoder runs. */
function boundedTree(root: xdr.ScVal): void {
  const pending = [{ value: root, depth: 0 }]
  let count = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++count > 8192 || depth > 32) return invalid()
    if (value.switch() === xdr.ScValType.scvVec()) {
      for (const child of value.vec() ?? []) pending.push({ value: child, depth: depth + 1 })
    } else if (value.switch() === xdr.ScValType.scvMap()) {
      for (const entry of value.map() ?? []) {
        pending.push(
          { value: entry.key(), depth: depth + 1 },
          { value: entry.val(), depth: depth + 1 }
        )
      }
    }
  }
}
function predicate(value: xdr.ScVal | undefined) {
  if (!value || value.switch() !== xdr.ScValType.scvBytes()) return invalid()
  const bytes = value.bytes()
  if (!bytes.length || bytes.length > MAX_BYTES) return invalid()
  boundedTree(xdr.ScVal.fromXDR(bytes))
  const decoded = decodePredicate(bytes)
  // Reuse all grammar limits, selector requirements and scaled-ratio validation.
  encodePredicate(decoded)
  return decoded
}
function path(value: xdr.ScVal | undefined): ExecutionPath {
  return vector(value, 16, 1).map((part) => {
    const items = vector(part, 2, 2)
    const tag = symbol(items[0])
    if (tag === 'Key') return symbol(items[1])
    if (tag === 'Index' && items[1]?.switch() === xdr.ScValType.scvU32()) return items[1].u32()
    return invalid()
  })
}
/** Strict bounded decoder for grammar 6 execution_v1. Throws for malformed or
 * unsupported input; callers must retain the rule as unknown authority. */
export function decodeExecutionDocument(encoded: string | Uint8Array): ExecutionDocument {
  if (
    typeof encoded === 'string' &&
    (encoded.length > 4 * Math.ceil(MAX_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
  )
    return invalid()
  const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.from(encoded)
  if (!bytes.length || bytes.length > MAX_BYTES) return invalid()
  if (typeof encoded === 'string' && bytes.toString('base64') !== encoded) return invalid()
  const root = xdr.ScVal.fromXDR(bytes)
  boundedTree(root)
  const envelope = vector(root, 2, 2)
  if (symbol(envelope[0]) !== 'execution_v1') return invalid()
  const config = fields(envelope[1], ['executor', 'plans'])
  const executorValue = config.executor!
  if (executorValue.switch() !== xdr.ScValType.scvAddress()) return invalid()
  const executor = Address.fromScAddress(executorValue.address()).toString()
  if (!executor.startsWith('C')) return invalid()
  const plans = vector(config.plans, 8, 1).map((value) => {
    const plan = fields(value, ['steps', 'equalities'])
    let count = 0
    function auth(value: xdr.ScVal | undefined, depth: number): ExecutionAuthRule[] {
      // Includes empty children at the terminal depth, matching the contract.
      if (depth > 4) return invalid()
      return vector(value, 32).map((value) => {
        if (++count > 32) return invalid()
        const rule = fields(value, ['predicate', 'children'])
        return { predicate: predicate(rule.predicate), children: auth(rule.children, depth + 1) }
      })
    }
    return {
      steps: vector(plan.steps, 8, 1).map((value) => {
        const step = fields(value, ['predicate', 'authorizations'])
        return {
          predicate: predicate(step.predicate),
          authorizations: auth(step.authorizations, 0),
        }
      }),
      equalities: vector(plan.equalities, 32).map((value) => {
        const eq = fields(value, ['left', 'right'])
        return { left: path(eq.left), right: path(eq.right) }
      }),
    }
  })
  return { executor, plans }
}
