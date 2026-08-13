// src/record/validate.ts - cross-check parsed TokenMovements against the raw
// on-chain events. NOT by re-parsing.
//
// Why events-based validation matters: the parse path is the thing we are
// trying to harden. Validating parse output by re-running the parser can only
// catch a parser bug that manifests the same way twice. Cross-checking against
// the canonical event stream is what catches real drift.
//
// Skips:
//   - simulation/XDR mode: there are no raw events to compare against. The
//     orchestrator reflects the reduced certainty in parseConfidence (any
//     unknown contract or opaque ScVal reduces overall below 1) and the gate
//     refuses the recording.

import type { OnChainEvent, TokenMovement } from '../types.ts'
import { tokenMovementKey } from './decode.ts'
import { extractTokenMovements } from './movements.ts'

export interface ValidationFailure {
  code: 'MOVEMENT_PARSE_NOT_IN_EVENTS' | 'MOVEMENT_EVENT_NOT_PARSED'
  message: string
  details: unknown
}

/** Cross-check parsed movements against the raw on-chain events.
 *  Returns null when validation passes; otherwise the first failure found.
 *
 *  Mode:
 *   - on-chain mode (events.length > 0): full movement cross-check, fail-closed.
 *   - simulation/XDR mode (events.length === 0): SKIPPED - the caller surfaces
 *     the reduced certainty via parseConfidence.
 *
 *  We intentionally do NOT require every invocation to have an attributable
 *  event. A Soroban call's events are commonly emitted by inner contracts
 *  (token SACs) that are not in the auth-derived invocation tree, so a
 *  per-invocation "did it emit an event" check produces false refusals on
 *  legitimate transactions. The real guards are the movement cross-check below
 *  plus parseConfidence (unknown contracts / opaque ScVals).
 */
export function validateAgainstEvents(
  parsedMovements: TokenMovement[],
  events: OnChainEvent[]
): ValidationFailure | null {
  // Simulation/XDR mode - skip cross-check, return null (no failure).
  if (events.length === 0) return null

  // Compute the set of movements the raw events IMPLY.
  const eventMovements = extractTokenMovements(events)
  const eventKeySet = new Set(eventMovements.map(tokenMovementKey))
  const parsedKeySet = new Set(parsedMovements.map(tokenMovementKey))

  // 1. Every parsed movement must appear in the raw events.
  for (const m of parsedMovements) {
    if (!eventKeySet.has(tokenMovementKey(m))) {
      return {
        code: 'MOVEMENT_PARSE_NOT_IN_EVENTS',
        message: `parsed TokenMovement not present in raw events`,
        details: { movement: m },
      }
    }
  }

  // 2. Every raw-event movement must appear in the parsed set.
  for (const m of eventMovements) {
    if (!parsedKeySet.has(tokenMovementKey(m))) {
      return {
        code: 'MOVEMENT_EVENT_NOT_PARSED',
        message: `raw event implies a movement that the parse missed`,
        details: { movement: m },
      }
    }
  }

  return null
}
