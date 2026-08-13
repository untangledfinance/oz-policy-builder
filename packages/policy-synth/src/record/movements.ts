// src/record/movements.ts - raw on-chain contract events -> TokenMovement[].
//
// SEP-41 / SAC `transfer` / `mint` / `burn` events emit topics shaped as:
//   topics[0] = Symbol("transfer") | "mint" | "burn"
//   topics[1] = Address (from)            (transfer only - omitted for mint; burn "from" is the caller)
//   topics[2] = Address (to)               (transfer + mint; burn uses a single from)
//   data      = Vec<ScVal> { Address to, I128 amount }  (for transfer on classic SAC)
//                OR I128 amount directly                 (for some token flavours)
//
// We accept both shapes; the validator reuses these as keys to cross-check
// against the parsed invocation args.

import type { xdr } from '@stellar/stellar-sdk'
import type { OnChainEvent, TokenMovement } from '../types.ts'
import { decodeScAddressToAnyStrkey, i128PartsToBigInt, u64PartsToBigInt } from './decode.ts'

const TRANSFER = 'transfer'
const MINT = 'mint'
const BURN = 'burn'

/** Extract TokenMovement[] from a list of raw on-chain events. Pure: no IO,
 *  no network. Non-movement events are ignored; malformed movement events are
 *  recorded as opaque so the recorder can fail closed. */
export function extractTokenMovements(
  events: OnChainEvent[],
  opaqueScVals: Array<{ path: string; type: string }> = []
): TokenMovement[] {
  const out: TokenMovement[] = []
  events.forEach((evt, index) => {
    try {
      const moved = parseSingleEvent(evt)
      if (moved) {
        out.push(moved)
      } else if (isMovementEvent(evt)) {
        opaqueScVals.push({ path: `events[${index}]`, type: movementDecodeFailure(evt) })
      }
    } catch {
      opaqueScVals.push({ path: `events[${index}]`, type: 'undecodable-token-movement' })
    }
  })
  return out
}

function isMovementEvent(evt: OnChainEvent): boolean {
  const op = evt.topics[0]
  return op === TRANSFER || op === MINT || op === BURN
}

function movementDecodeFailure(evt: OnChainEvent): string {
  const address = evt.topics.slice(1).find((topic) => topic.startsWith('M'))
  return address ? 'unsupported-muxed-address-topic' : 'undecodable-token-movement'
}

function parseSingleEvent(evt: OnChainEvent): TokenMovement | null {
  const [head, second, third] = evt.topics
  if (!head) return null
  const op = head
  if (op !== TRANSFER && op !== MINT && op !== BURN) return null

  // Read the `amount` from the event data; the contract address is the emitter.
  const token = evt.contract
  if (!token) return null

  const amount = readAmount(evt.data)
  if (amount === null) return null

  if (op === TRANSFER) {
    // topics[1] = from, topics[2] = to
    const from = second ? addressTopic(second) : null
    const to = third ? addressTopic(third) : null
    if (!from || !to) return null
    return { token, from, to, amount }
  }
  if (op === MINT) {
    // topics[1] = admin (optional), topics[2] = to (sometimes). Some SEP-41 mints
    // only emit one address topic. Best-effort: prefer topics[2], then data.to.
    const to = third ? addressTopic(third) : readDataAddress(evt.data, 0)
    if (!to) return null
    return { token, from: 'mint', to, amount }
  }
  // BURN
  // topics[1] = from (the burned holder). Some burns also surface a "from" in data.
  const from = second ? addressTopic(second) : readDataAddress(evt.data, 0)
  if (!from) return null
  return { token, from, to: 'burn', amount }
}

/** Read an I128 amount from an event data ScVal. Supports:
 *    - data is I128 directly
 *    - data is U64 (fallback for amount fields encoded as u64)
 *    - data is a Vec whose [0] (or [1] for SAC transfer) is I128 / U64
 *    - data is a Vec whose [0] is a Map { 'amount': I128 | U64 }
 *    - data is a Map whose entry with key "amount" is I128 / U64
 *
 *  The Map shapes are the canonical data layout for SAC/SEP-41 `transfer`,
 *  `mint`, and `burn` events on Stellar mainnet, e.g. the USDC SAC and every
 *  Stellar Asset Contract. The key `amount` is the SEP-41-defined field name
 *  (verified empirically against txs 112d2392..., eb39f493..., 50d36f5c...
 *  where the data is `Map { amount: I128, to_muxed_id: ... }`). The other
 *  Map entries we observe in the wild (to_muxed_id, from_muxed_id) are
 *  muxed-address adjuncts that the recorder does not support as topic
 *  addresses; they are ignored here on purpose. A Map without an `amount`
 *  entry, or with an `amount` entry that is not I128/U64, returns null
 *  (fail-closed). */
export function readAmount(data: OnChainEvent['data']): string | null {
  if (data.type === 'i128') return data.value
  if (data.type === 'u64') return data.value
  if (data.type === 'map') return readAmountFromMap(data.value)
  if (data.type !== 'vec') return null
  // Vec shape: walk the elements and accept the first I128/U64 OR a Map whose
  // 'amount' entry is I128/U64. SAC transfer event data is sometimes
  // Vec<Address, I128> and sometimes Vec<Map{amount: I128}, ...>; both reach
  // the same code path below.
  for (const item of data.value) {
    if (item.type === 'i128') return item.value
    if (item.type === 'u64') return item.value
    if (item.type === 'map') {
      const fromMap = readAmountFromMap(item.value)
      if (fromMap !== null) return fromMap
    }
  }
  return null
}

/** Try to extract an I128/U64 amount from a Map's `amount` entry. Returns
 *  null when the Map lacks an `amount` key or the entry is not a numeric
 *  ScVal kind this recorder understands. */
function readAmountFromMap(
  entries: Array<{ key: string; val: OnChainEvent['data'] }>
): string | null {
  for (const entry of entries) {
    if (entry.key !== 'amount') continue
    if (entry.val.type === 'i128') return entry.val.value
    if (entry.val.type === 'u64') return entry.val.value
    return null
  }
  return null
}

/** Extract a single address from an event data ScVal at the given vec index. */
function readDataAddress(data: OnChainEvent['data'], index: number): string | null {
  if (data.type !== 'vec') return null
  const item = data.value[index]
  if (item?.type !== 'address') return null
  return item.value
}

/** Convert a topic-string back into an address strkey if it looks like one.
 *  Topics we previously encoded as `<kind>` (non-address fallback) are left
 *  alone. */
function addressTopic(s: string): string | null {
  if (s.startsWith('G') || s.startsWith('C')) return s
  return null
}

/** Re-decode a single ContractEvent body into a TokenMovement-shaped tuple,
 *  given the raw xdr.ScVal form (NOT the OnChainEvent subset). Used by the
 *  integration test to compare against the parse path without depending on
 *  the OnChainEvent subset. */
export function parseContractEventToMovement(
  emitterC: string,
  body: xdr.ContractEventV0
): TokenMovement | null {
  const topics = body.topics()
  if (topics.length === 0) return null
  const head = topics[0]
  if (!head) return null
  const op = head.switch().name === 'scvSymbol' ? head.sym().toString() : ''
  if (op !== TRANSFER && op !== MINT && op !== BURN) return null

  const data = body.data()
  const amountScval = pickAmountScval(data)
  const amount = amountScval
    ? amountScval.switch().name === 'scvI128'
      ? i128PartsToBigInt(amountScval.i128()).toString()
      : amountScval.switch().name === 'scvU64'
        ? u64PartsToBigInt(amountScval.u64()).toString()
        : null
    : null
  if (amount === null) return null

  if (op === TRANSFER) {
    const from =
      topics[1] && topics[1].switch().name === 'scvAddress'
        ? decodeScAddressToAnyStrkey(topics[1].address())
        : null
    const to =
      topics[2] && topics[2].switch().name === 'scvAddress'
        ? decodeScAddressToAnyStrkey(topics[2].address())
        : null
    if (!from || !to) return null
    return { token: emitterC, from, to, amount }
  }
  if (op === MINT) {
    const to =
      topics[2] && topics[2].switch().name === 'scvAddress'
        ? decodeScAddressToAnyStrkey(topics[2].address())
        : null
    if (!to) return null
    return { token: emitterC, from: 'mint', to, amount }
  }
  // BURN
  const from =
    topics[1] && topics[1].switch().name === 'scvAddress'
      ? decodeScAddressToAnyStrkey(topics[1].address())
      : null
  if (!from) return null
  return { token: emitterC, from, to: 'burn', amount }
}

function pickAmountScval(data: xdr.ScVal): xdr.ScVal | null {
  const kind = data.switch().name
  if (kind === 'scvI128' || kind === 'scvU64') return data
  if (kind !== 'scvVec') return null
  const arr = data.vec() ?? []
  for (const item of arr) {
    const k = item.switch().name
    if (k === 'scvI128' || k === 'scvU64') return item
  }
  return null
}
