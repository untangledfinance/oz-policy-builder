// Shared test data: recorded flows (fixtures/recordings) and addresses.
import { readFileSync } from 'node:fs'
import { StrKey } from '@stellar/stellar-sdk'
import type { Recording } from '../src/record.ts'

export const recording = (name: 'blend' | 'sep41' | 'soroswap'): Recording =>
  JSON.parse(readFileSync(new URL(`../fixtures/recordings/${name}.json`, import.meta.url), 'utf8'))

export const contract = (n: number): string => StrKey.encodeContract(Buffer.alloc(32, n))
export const account = (n: number): string => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n))
