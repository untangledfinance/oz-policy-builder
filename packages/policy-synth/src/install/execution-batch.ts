import { createHash } from 'node:crypto'
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import type { PredicateLeaf, PredicateNode } from '../types.ts'

/** Linked i128 slots in the projected arguments. Bounds are inclusive/exclusive. */
export interface ExecutionAmountConstraint {
  slots: number[]
  min: string
  maxExclusive: string
}

function digestLimbs(value: xdr.ScVal): xdr.ScVal[] {
  const h = createHash('sha256').update(value.toXDR()).digest()
  return [h.subarray(0, 16), h.subarray(16)].map((part) =>
    nativeToScVal(BigInt.asIntN(128, BigInt('0x' + part.toString('hex'))), { type: 'i128' })
  )
}

function project(request: xdr.ScVal) {
  const fields = request.switch().name === 'scvVec' ? request.vec() : null
  if (
    !fields ||
    fields.length !== 4 ||
    fields[0]!.switch().name !== 'scvAddress' ||
    fields[1]!.switch().name !== 'scvAddress' ||
    fields[2]!.switch().name !== 'scvVec' ||
    fields[3]!.switch().name !== 'scvVec'
  ) {
    throw new Error('Expected [Prime, interpreter, calls, additional Prime contexts]')
  }
  const shape: number[] = [1]
  const leaves: xdr.ScVal[] = []
  const i128Slots = new Set<number>()
  function walk(value: xdr.ScVal, depth: number) {
    if (depth > 16 || shape.length >= 2048 || leaves.length >= 256)
      throw new Error('Projection size')
    const type = value.switch().name
    if (type === 'scvVec') {
      const items = value.vec()
      if (!items) throw new Error('Null vector')
      shape.push(0, items.length)
      for (const item of items) walk(item, depth + 1)
    } else if (type === 'scvMap') {
      const entries = value.map()
      if (!entries) throw new Error('Null map')
      shape.push(1, entries.length)
      for (const entry of entries) {
        walk(entry.key(), depth + 1)
        walk(entry.val(), depth + 1)
      }
    } else {
      const tag =
        ({ scvU32: 2, scvI128: 3, scvAddress: 4, scvSymbol: 5 } as Record<string, number>)[type] ??
        6
      shape.push(tag)
      if (tag === 6) leaves.push(...digestLimbs(value))
      else {
        if (tag === 3) i128Slots.add(leaves.length + 2)
        leaves.push(value)
      }
    }
    if (shape.length > 2048 || leaves.length > 256) throw new Error('Projection size')
  }
  walk(request, 0)
  return {
    args: [...digestLimbs(xdr.ScVal.scvVec(shape.map(xdr.ScVal.scvU32))), ...leaves],
    i128Slots,
  }
}

/** Matches the adapter's policy_args, including both authorization lists.
 * request is the canonical ScVal tuple [Prime, interpreter, calls, prime_contexts].
 * prime_contexts contains only ADDITIONAL nested contexts; direct calls are derived.
 */
export function projectExecutionRequest(request: xdr.ScVal): xdr.ScVal[] {
  return project(request).args
}

function literal(value: xdr.ScVal): PredicateLeaf {
  switch (value.switch().name) {
    case 'scvAddress':
      return { kind: 'literal_address', value: Address.fromScVal(value).toString() }
    case 'scvSymbol':
      return { kind: 'literal_symbol', value: value.sym().toString() }
    case 'scvU32':
      return { kind: 'literal_u32', value: value.u32() }
    case 'scvI128':
      return { kind: 'literal_i128', value: String(scValToNative(value)) }
    default:
      throw new Error('Unsupported projected scalar')
  }
}

/** Install on an adapter-scoped v5 root rule; bind root and ALL child rules.
 * Every field is exact by default. Explicit amount groups permit bounded, equal
 * numeric changes while retaining all target, recipient, type and shape checks.
 */
export function buildExecutionBatchPolicy(
  request: xdr.ScVal,
  amounts: ExecutionAmountConstraint[] = []
) {
  const { args, i128Slots } = project(request)
  const variables = new Set<number>()
  const children: PredicateNode[] = [
    {
      op: 'eq',
      left: { kind: 'call_fn' },
      right: { kind: 'literal_symbol', value: 'execute' },
    },
  ]
  for (const group of amounts) {
    const min = BigInt(group.min)
    const max = BigInt(group.maxExclusive)
    if (!group.slots.length || max <= min) throw new Error('Invalid amount bounds')
    const first = group.slots[0]!
    for (const slot of group.slots) {
      if (!i128Slots.has(slot) || variables.has(slot)) throw new Error('Invalid amount slot')
      const value = BigInt(scValToNative(args[slot]!))
      if (value < min || value >= max || value !== BigInt(scValToNative(args[first]!))) {
        throw new Error('Example does not satisfy linked amount bounds')
      }
      variables.add(slot)
      const left: PredicateLeaf = { kind: 'call_arg', index: slot }
      children.push(
        { op: 'gte', left, right: { kind: 'literal_i128', value: min.toString() } },
        { op: 'lt', left, right: { kind: 'literal_i128', value: max.toString() } }
      )
      if (slot !== first)
        children.push({
          op: 'eq',
          left,
          right: { kind: 'call_arg_scaled', index: first, num: '1', den: '1' },
        })
    }
  }
  args.forEach((value, index) => {
    if (!variables.has(index))
      children.push({
        op: 'eq',
        left: { kind: 'call_arg', index },
        right: literal(value),
      })
  })
  const predicate: PredicateNode = { op: 'and', children }
  return {
    grammarVersion: 5 as const,
    predicate,
    ...encodePredicate(predicate),
    projectedArgs: args,
  }
}
