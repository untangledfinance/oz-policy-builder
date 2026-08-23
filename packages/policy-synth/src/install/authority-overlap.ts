// src/install/authority-overlap.ts - cross-rule authority analysis.
//
// An OZ smart account selects a context rule by CALLER DECLARATION and enforces
// only the policies of the rule that was named. A signer belonging to several
// rules therefore picks which one applies, so for any given call their
// authority is the MAXIMUM over the matching rules, never the intersection.
//
// The consequence is the one that catches people: installing a second, tighter
// rule restricts nothing. A key that also sits on an unpoliced rule is not
// constrained at all - it names that rule and the predicate never runs. This
// module detects that at install time, before the caller acts on a policy that
// looks binding and is not.
//
// Not theoretical. Proven on chain 2026-08-22: the same key, the same account
// and the same forbidden call was denied `#100` naming the policed rule and
// PERMITTED naming an unpoliced one. It happened in this project's own end-to-
// end harness, written by the author of the grammar, and was caught by review
// rather than by tooling - which is why the tooling now exists.
//
// Adapted to grammar 3 from the version published in `@crediolabs/policy-synth`
// 0.2.0, which came from a different repository and was lost when the npm
// lineage moved here. `or` and `not` are gone from the grammar, so the cases
// handling them are gone too; oracle bounds are gone from the stored document.
//
// Pure: no network. The caller supplies the account's rules.

import type { PredicateLeaf, PredicateNode, SignerDraft } from '../types.ts'

/** Wildcard component of a `Selector`: the predicate does not pin this half. */
export const ANY = '*'

/** A (contract, function) pair a predicate may permit. `ANY` in either half
 *  means unconstrained, so `{contract: ANY, fn: ANY}` is "any call at all". */
export interface Selector {
  contract: string
  fn: string
}

export type ContextType =
  | { kind: 'default' }
  | { kind: 'call_contract'; contract: string }
  | { kind: 'create_contract'; wasmHash: string }

/** How much can be said about a neighbouring rule.
 *  - `interpreter`: policed by our interpreter and the predicate was readable,
 *    so its authority is known exactly.
 *  - `foreign`: policed by some other contract. The address is visible, the
 *    semantics are not, so it needs review by hand.
 *  - `unpoliced`: no policy at all. Whatever its context type allows, its
 *    signers may do without constraint. */
export type RuleClass = 'interpreter' | 'foreign' | 'unpoliced'

export interface ObservedRule {
  id: number
  contextType: ContextType
  signers: SignerDraft[]
  /** Policy contract addresses attached to the rule, in OZ's order. */
  policyAddresses: string[]
  /** Decoded predicate. Present only when the rule is policed by OUR
   *  interpreter and the stored document was readable. */
  predicate?: PredicateNode
}

export interface IntendedInstall {
  /** Rule the predicate is being installed onto. A re-install onto the same
   *  id REPLACES its predicate rather than adding a second source of
   *  authority, so that id is skipped. */
  ruleId: number
  contextType: ContextType
  signers: SignerDraft[]
  predicate: PredicateNode
}

export type OverlapSeverity =
  /** A neighbouring rule imposes no constraint at all on the shared calls. */
  | 'bypass'
  /** A neighbouring policy exists but what it permits cannot be read. */
  | 'unknown'
  /** Both rules are ours. The new rule will not restrict the shared calls,
   *  because the signer names whichever is more permissive. */
  | 'not-restricting'

export interface AuthorityOverlap {
  ruleId: number
  ruleClass: RuleClass
  severity: OverlapSeverity
  /** Signers present in BOTH rules. An overlap is only reachable by a signer
   *  who can name both, so a rule sharing no signer is not a collision. */
  sharedSigners: SignerDraft[]
  /** The selectors both rules can serve. Non-empty by construction. */
  sharedSelectors: Selector[]
  advice: string
}

// ---- signer identity ----

/** Canonical key for signer equality. Mirrors OZ's `Signer` enum: a delegated
 *  signer is its address, an external signer is the verifier plus the key
 *  bytes, since one verifier may hold many keys. */
export function signerKey(s: SignerDraft): string {
  return s.kind === 'delegated' ? `delegated:${s.address}` : `external:${s.verifier}:${s.keyBytes}`
}

function sharedSigners(a: SignerDraft[], b: SignerDraft[]): SignerDraft[] {
  const bKeys = new Set(b.map(signerKey))
  return a.filter((s) => bKeys.has(signerKey(s)))
}

// ---- selector extraction ----

const WILDCARD: Selector = { contract: ANY, fn: ANY }

function selectorKey(s: Selector): string {
  return `${s.contract} ${s.fn}`
}

function dedupe(sels: Selector[]): Selector[] {
  const seen = new Map<string, Selector>()
  for (const s of sels) seen.set(selectorKey(s), s)
  return [...seen.values()]
}

/** Intersect one pair. `ANY` absorbs, equal literals survive, and two
 *  different literals cannot both hold for a single call. */
function intersectOne(a: Selector, b: Selector): Selector | null {
  const contract =
    a.contract === ANY
      ? b.contract
      : b.contract === ANY
        ? a.contract
        : a.contract === b.contract
          ? a.contract
          : null
  if (contract === null) return null
  const fn = a.fn === ANY ? b.fn : b.fn === ANY ? a.fn : a.fn === b.fn ? a.fn : null
  if (fn === null) return null
  return { contract, fn }
}

/** Intersection of two selector SETS: every compatible pairing survives. */
export function intersectSelectors(a: Selector[], b: Selector[]): Selector[] {
  const out: Selector[] = []
  for (const x of a) {
    for (const y of b) {
      const hit = intersectOne(x, y)
      if (hit) out.push(hit)
    }
  }
  return dedupe(out)
}

function literalAddress(leaf: PredicateLeaf): string | null {
  return leaf.kind === 'literal_address' ? leaf.value : null
}

function literalSymbol(leaf: PredicateLeaf): string | null {
  return leaf.kind === 'literal_symbol' ? leaf.value : null
}

/** Selector pinned by a single `eq`, whichever side the literal sits on. */
function selectorFromEq(left: PredicateLeaf, right: PredicateLeaf): Selector | null {
  if (left.kind === 'call_contract') {
    const addr = literalAddress(right)
    return addr === null ? null : { contract: addr, fn: ANY }
  }
  if (right.kind === 'call_contract') {
    const addr = literalAddress(left)
    return addr === null ? null : { contract: addr, fn: ANY }
  }
  if (left.kind === 'call_fn') {
    const sym = literalSymbol(right)
    return sym === null ? null : { contract: ANY, fn: sym }
  }
  if (right.kind === 'call_fn') {
    const sym = literalSymbol(left)
    return sym === null ? null : { contract: ANY, fn: sym }
  }
  return null
}

/**
 * The set of `(contract, fn)` selectors a predicate may permit.
 *
 * A deliberate OVER-approximation: every call the predicate actually permits is
 * covered by some returned selector, and unrecognised structure widens to the
 * wildcard rather than narrowing. That direction is what makes the emptiness
 * test sound. A call carries exactly one `(contract, fn)`, so if two
 * predicates' over-approximations do not intersect, no single call can be
 * routed to either and the rules provably cannot collide.
 *
 * Narrowing instead would be the fail-OPEN direction: it would let this report
 * "no overlap" for rules that do collide.
 */
export function permittedSelectors(node: PredicateNode): Selector[] {
  switch (node.op) {
    case 'and': {
      // Every conjunct must hold at once, so the permitted set is the
      // intersection. Intersecting over-approximations stays one.
      let acc: Selector[] = [WILDCARD]
      for (const child of node.children) acc = intersectSelectors(acc, permittedSelectors(child))
      return acc
    }
    case 'or': {
      // Any branch may hold, so the permitted set is the UNION. A union of
      // over-approximations is still an over-approximation, so this keeps the
      // fail-safe direction while staying tighter than the wildcard the
      // default branch would give. Precision matters here: `or` is how a
      // policy says "pair A or pair B", and widening that to the wildcard
      // would report an overlap against every rule on the account.
      const acc: Selector[] = []
      for (const child of node.children) acc.push(...permittedSelectors(child))
      return dedupe(acc)
    }
    case 'eq': {
      const sel = selectorFromEq(node.left, node.right)
      return sel === null ? [WILDCARD] : [sel]
    }
    case 'in': {
      // Set membership over the selector halves: `call_fn in {a, b}` permits
      // both. A haystack element that is not the matching literal kind makes
      // the node uninformative rather than narrower.
      if (node.needle.kind === 'call_contract') {
        const addrs = node.haystack.map(literalAddress)
        if (addrs.some((a) => a === null)) return [WILDCARD]
        return dedupe((addrs as string[]).map((a) => ({ contract: a, fn: ANY })))
      }
      if (node.needle.kind === 'call_fn') {
        const syms = node.haystack.map(literalSymbol)
        if (syms.some((s) => s === null)) return [WILDCARD]
        return dedupe((syms as string[]).map((s) => ({ contract: ANY, fn: s })))
      }
      return [WILDCARD]
    }
    default:
      // `lte` binds an amount, never the selector.
      return [WILDCARD]
  }
}

/** Selectors a context type admits, before the predicate narrows them. */
export function selectorsForContextType(ct: ContextType): Selector[] {
  switch (ct.kind) {
    case 'default':
      return [WILDCARD]
    case 'call_contract':
      return [{ contract: ct.contract, fn: ANY }]
    case 'create_contract':
      // A contract-creation context is a different `Context` shape. The
      // interpreter refuses anything that is not `Context::Contract`, and a
      // creation rule can never serve a call, so it shares no selector.
      return []
  }
}

/** What a rule can actually authorise: its context type narrowed by its
 *  predicate. An unpoliced or unreadable rule contributes no narrowing. */
export function effectiveSelectors(rule: ObservedRule): Selector[] {
  const fromType = selectorsForContextType(rule.contextType)
  if (!rule.predicate) return fromType
  return intersectSelectors(fromType, permittedSelectors(rule.predicate))
}

function classifyRule(rule: ObservedRule): RuleClass {
  if (rule.policyAddresses.length === 0) return 'unpoliced'
  return rule.predicate ? 'interpreter' : 'foreign'
}

function adviceFor(cls: RuleClass, ruleId: number): string {
  switch (cls) {
    case 'unpoliced':
      return `rule ${ruleId} has no policy attached, so a shared signer may make these calls with no constraint at all - the predicate you are installing will never run for them. Remove the shared signer from rule ${ruleId}, or attach a policy to it.`
    case 'foreign':
      return `rule ${ruleId} is policed by a contract this tool cannot decode, so its authority over these calls is unknown. Review it by hand before relying on the new rule.`
    case 'interpreter':
      return `a shared signer may name rule ${ruleId} instead, so the new rule will not restrict these calls. To TIGHTEN, edit rule ${ruleId} itself rather than adding a second rule. To ADD a separate capability, keep both and expect neither to constrain the other.`
  }
}

/**
 * Every existing rule a signer of the intended install could name instead.
 *
 * A rule collides when it shares at least one signer AND at least one selector.
 * Both are needed for the signer to have a choice: same signer but disjoint
 * calls means no call can be rerouted, and same calls but no shared signer
 * means nobody can reroute them.
 */
export function findAuthorityOverlaps(args: {
  intended: IntendedInstall
  existing: ObservedRule[]
}): AuthorityOverlap[] {
  const intendedSelectors = intersectSelectors(
    selectorsForContextType(args.intended.contextType),
    permittedSelectors(args.intended.predicate)
  )
  const out: AuthorityOverlap[] = []

  for (const rule of args.existing) {
    if (rule.id === args.intended.ruleId) continue

    const shared = sharedSigners(args.intended.signers, rule.signers)
    if (shared.length === 0) continue

    const sharedSelectors = intersectSelectors(intendedSelectors, effectiveSelectors(rule))
    if (sharedSelectors.length === 0) continue

    const ruleClass = classifyRule(rule)
    out.push({
      ruleId: rule.id,
      ruleClass,
      severity:
        ruleClass === 'unpoliced'
          ? 'bypass'
          : ruleClass === 'foreign'
            ? 'unknown'
            : 'not-restricting',
      sharedSigners: shared,
      sharedSelectors,
      advice: adviceFor(ruleClass, rule.id),
    })
  }

  return out
}
