// Protocols as data: what each argument of a known call IS, so a recording can be
// turned into the rule a person means (pin who, cap how much, ignore a deadline)
// rather than a pin on every recorded byte. Adding a protocol is adding rows.
//
// A kind names an argument's role and the value shape it must have to be taken
// for it; a call is identified by its function name and by every argument having
// the shape its row says (the interface, not an address, so any SEP-41 token and
// any Blend pool is recognised).

import type { Intent } from './intent.ts'
import { isAddress, type Val } from './wire.ts'

export type Kind = 'who' | 'amount' | 'min' | 'time' | 'exact' | 'requests'

const isNum = (v: Val, ...tags: string[]) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && tags.some((t) => t in v)

/** The shape each kind of argument has. */
export const SHAPE: Record<Kind, (v: Val) => boolean> = {
  who: isAddress,
  amount: (v) => isNum(v, 'i128'),
  min: (v) => isNum(v, 'i128'),
  time: (v) => typeof v === 'number' || isNum(v, 'u64'),
  exact: () => true,
  requests: (v) =>
    Array.isArray(v) && v.every((e) => typeof e === 'object' && e !== null && 'map' in e),
}

type Row = [name: string, kind: Kind][]

const SEP41: Record<string, Row> = {
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
}
const BLEND: Record<string, Row> = {
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
}
const SOROSWAP: Record<string, Row> = {
  swap_exact_tokens_for_tokens: [
    ['amount_in', 'amount'],
    ['amount_out_min', 'min'],
    ['path', 'exact'],
    ['to', 'who'],
    ['deadline', 'time'],
  ],
  swap_tokens_for_exact_tokens: [
    ['amount_out', 'amount'],
    ['amount_in_max', 'min'],
    ['path', 'exact'],
    ['to', 'who'],
    ['deadline', 'time'],
  ],
}

/** Function name -> the protocols that use it, in the order they are tried. */
export const PROTOCOLS: Record<string, Record<string, Row>> = {
  sep41: SEP41,
  blend: BLEND,
  soroswap: SOROSWAP,
}

export interface Known {
  protocol: string
  args: Row
}

/** The row for a call, or null: an unknown function, or arguments that do not
 *  have the shape the row says (never guess a role from a name alone). */
export function identify(fn: string, args: Val[]): Known | null {
  for (const [protocol, fns] of Object.entries(PROTOCOLS)) {
    const row = fns[fn]
    if (row && row.length === args.length && row.every(([, k], i) => SHAPE[k](args[i] as Val))) {
      return { protocol, args: row }
    }
  }
  return null
}

// ---- declaration templates: a mandate is an Intent with parameters ----

export interface Templates {
  /** Calls through the execution adapter's `execute(calls, grants, wait)`: every
   *  call of the batch goes to a listed target (and function), the batch has at
   *  most `maxCalls` calls, no grants, and runs now (`wait` is 0). The adapter's
   *  `Call` is a map with `target` and `function_name`. */
  adapter_batch: { adapter: string; targets: string[]; functions?: string[]; maxCalls?: number }
  /** A Blend pool `submit` for one account: the position, spender and receiver are
   *  pinned, exactly one request, on one token, of a type up to `maxType` (0 supply,
   *  1 withdraw), with an amount from 1 to below `max`. */
  blend_venue: {
    pool: string
    token: string
    account: string
    spender?: string
    receiver?: string
    max: string
    maxType?: number
  }
}

export const TEMPLATES: { [K in keyof Templates]: (p: Templates[K]) => Intent } = {
  adapter_batch: (p) => ({
    calls: [
      {
        contract: p.adapter,
        fn: 'execute',
        where: [
          { rule: 'length', at: [0], max: p.maxCalls ?? 8 },
          {
            rule: 'each',
            at: [0],
            where: [
              { rule: 'allow', at: ['target'], in: p.targets },
              ...(p.functions
                ? [{ rule: 'allow' as const, at: ['function_name'], in: p.functions }]
                : []),
            ],
          },
          { rule: 'length', at: [1], max: 0 },
          { rule: 'pin', at: [2], to: 0 },
        ],
      },
    ],
  }),
  blend_venue: (p) => {
    const request = (field: string) => [3, 0, field]
    return {
      calls: [
        {
          contract: p.pool,
          fn: 'submit',
          where: [
            { rule: 'pin', at: [0], to: p.account },
            { rule: 'pin', at: [1], to: p.spender ?? p.account },
            { rule: 'pin', at: [2], to: p.receiver ?? p.account },
            { rule: 'length', at: [3], max: 1 },
            { rule: 'pin', at: request('address'), to: p.token },
            { rule: 'cap', at: request('request_type'), max: String(p.maxType ?? 1) },
            { rule: 'floor', at: request('amount'), min: '1' },
            { rule: 'cap', at: request('amount'), max: (BigInt(p.max) - 1n).toString() },
          ],
        },
      ],
    }
  },
}
