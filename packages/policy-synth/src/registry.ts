// Protocols as data: what each argument of a known call IS, so a recording can be
// turned into the rule a person means (pin who, cap how much, ignore a deadline)
// rather than a pin on every recorded byte. Adding a protocol is adding rows.
//
// A kind names an argument's role and the value shape it must have to be taken
// for it; a call is identified by its function name and by every argument having
// the shape its row says (the interface, not an address, so any SEP-41 token and
// any Blend pool is recognised).

import { isAddress, isMap, isTagged, type Val } from './wire.ts'

export type Kind = 'who' | 'amount' | 'min' | 'free' | 'time' | 'exact' | 'requests'

const isNum = (v: Val, ...tags: string[]) => isTagged(v) && tags.some((t) => t in v)

/** The shape each kind of argument has. */
export const SHAPE: Record<Kind, (v: Val) => boolean> = {
  who: isAddress,
  amount: (v) => isNum(v, 'i128'),
  min: (v) => isNum(v, 'i128'),
  free: (v) => isNum(v, 'i128'),
  time: (v) => typeof v === 'number' || isNum(v, 'u64'),
  exact: () => true,
  // `'map' in []` holds (Array.prototype.map): an element must be a `{map}` value, not a vec.
  requests: (v) => Array.isArray(v) && v.every(isMap),
}

type Row = [name: string, kind: Kind][]

/** Function name -> the protocols that use it, in the order they are tried. */
export const PROTOCOLS: Record<string, Record<string, Row>> = {
  sep41: {
    transfer: [
      ['from', 'who'],
      ['to', 'who'],
      ['amount', 'amount'],
    ],
    approve: [
      ['from', 'who'],
      ['spender', 'who'],
      ['amount', 'amount'],
      ['expiration_ledger', 'time'],
    ],
    mint: [
      ['to', 'who'],
      ['amount', 'amount'],
    ],
    burn: [
      ['from', 'who'],
      ['amount', 'amount'],
    ],
  },
  blend: {
    submit: [
      ['from', 'who'],
      ['spender', 'who'],
      ['to', 'who'],
      ['requests', 'requests'],
    ],
    claim: [
      ['from', 'who'],
      ['reserve_token_ids', 'exact'],
      ['to', 'who'],
    ],
  },
  soroswap: {
    swap_exact_tokens_for_tokens: [
      ['amount_in', 'amount'],
      ['amount_out_min', 'min'],
      ['path', 'exact'],
      ['to', 'who'],
      ['deadline', 'time'],
    ],
    swap_tokens_for_exact_tokens: [
      ['amount_out', 'free'], // the exact output: its input is what is capped
      ['amount_in_max', 'amount'],
      ['path', 'exact'],
      ['to', 'who'],
      ['deadline', 'time'],
    ],
    swap_exact_in_for_tokens: [
      ['amount_in', 'amount'],
      ['amount_out_min', 'min'],
      ['path', 'exact'],
      ['to', 'who'],
    ],
  },
}

export interface Known {
  protocol: string
  args: Row
}

/** The row for a call, or null: an unknown function, or arguments that do not
 *  have the shape the row says (never guess a role from a name alone). */
export function identify(fn: string, args: Val[]): Known | null {
  for (const [protocol, fns] of Object.entries(PROTOCOLS)) {
    // Own keys only: `constructor` and `toString` are on every object.
    const row = Object.hasOwn(fns, fn) ? fns[fn] : undefined
    if (row && row.length === args.length && row.every(([, k], i) => SHAPE[k](args[i] as Val))) {
      return { protocol, args: row }
    }
  }
  return null
}
