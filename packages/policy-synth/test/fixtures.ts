// Shared test data: recorded flows (fixtures/recordings) and addresses.
import { readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import type { Intent } from '../src/intent.ts'
import type { Recording } from '../src/record.ts'

export const recording = (name: 'blend' | 'sep41' | 'soroswap'): Recording =>
  JSON.parse(readFileSync(new URL(`../fixtures/recordings/${name}.json`, import.meta.url), 'utf8'))

export const contract = (n: number): string => StrKey.encodeContract(Buffer.alloc(32, n))
export const account = (n: number): string => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n))

/** Calls through an execution adapter's `execute(calls, grants, wait)`: every call of the batch to a
 *  listed target (and function), at most `maxCalls` of them, no grants, run now. */
export const batchIntent = (p: {
  adapter: string
  targets: string[]
  functions?: string[]
  maxCalls?: number
}): Intent => ({
  calls: [
    {
      contract: p.adapter,
      fn: 'execute',
      where: [
        { constraint: 'length', at: [0], max: p.maxCalls ?? 8 },
        {
          constraint: 'each',
          at: [0],
          where: [
            { constraint: 'allow', at: ['target'], in: p.targets },
            ...(p.functions
              ? [{ constraint: 'allow' as const, at: ['function_name'], in: p.functions }]
              : []),
          ],
        },
        { constraint: 'length', at: [1], max: 0 },
        { constraint: 'pin', at: [2], to: 0 },
      ],
    },
  ],
})

/** A Blend pool `submit` for one account: one request, on one token, of a type up to 1 (withdraw),
 *  with an amount from 1 to `max`. */
export const venueIntent = (p: {
  pool: string
  token: string
  account: string
  max: string
}): Intent => {
  const request = (field: string) => [3, 0, field]
  return {
    calls: [
      {
        contract: p.pool,
        fn: 'submit',
        where: [
          { constraint: 'pin', at: [0], to: p.account },
          { constraint: 'pin', at: [1], to: p.account },
          { constraint: 'pin', at: [2], to: p.account },
          { constraint: 'length', at: [3], max: 1 },
          { constraint: 'pin', at: request('address'), to: p.token },
          { constraint: 'cap', at: request('request_type'), max: '1' },
          { constraint: 'floor', at: request('amount'), min: '1' },
          { constraint: 'cap', at: request('amount'), max: p.max },
        ],
      },
    ],
  }
}
