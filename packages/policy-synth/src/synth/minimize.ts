import type { PredicateNode } from '../types.ts'
import { type DenyCase, generateCases } from './deny-cases.ts'
import type { EvalContext } from './evaluate.ts'
import { runHarness } from './harness.ts'

/** Remove top-level conjuncts only when the current and regenerated batteries still deny. */
export function minimize(
  predicate: PredicateNode,
  permitCtx: EvalContext,
  dimensions?: string[]
): PredicateNode {
  if (predicate.op !== 'and') return predicate

  let children = [...predicate.children]
  let index = 0

  while (index < children.length) {
    const current: PredicateNode = { op: 'and', children }
    const currentCases = generateCases(current, permitCtx, dimensions)
    const candidateChildren = children.filter((_, childIndex) => childIndex !== index)
    const candidate: PredicateNode = { op: 'and', children: candidateChildren }
    const candidateCases = generateCases(candidate, permitCtx, dimensions)
    const verificationCases = {
      permit: candidateCases.permit,
      denies: mergeDenyCases(currentCases.denies, candidateCases.denies),
    }

    if (runHarness(candidate, verificationCases).ok) {
      children = candidateChildren
      continue
    }
    index += 1
  }

  return { op: 'and', children }
}

function mergeDenyCases(current: DenyCase[], candidate: DenyCase[]): DenyCase[] {
  const merged: DenyCase[] = []
  const seen = new Set<string>()
  for (const deny of [...current, ...candidate]) {
    const key = `${deny.dimension}:${JSON.stringify(deny.ctx)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(deny)
  }
  return merged
}
