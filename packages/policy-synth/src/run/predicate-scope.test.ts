// src/run/predicate-scope.test.ts - the rule built by `install_policy`'s
// `fromPredicate` form is scoped to whatever contract its predicate pins.
//
// Scope is derived rather than passed so it cannot drift from what the
// predicate actually checks. The failure this guards against is silent and
// one-directional: a rule scoped WIDER than its predicate still installs, and
// still reads correctly in the response.

import { describe, expect, it } from 'bun:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { PredicateNode } from '../types.ts'
import { contextTypeForPredicate, runInstallPolicy } from './index.ts'

const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const OTHER = 'CDEG66TYZB2RTKRSIEA4UTFMRXOYESCEQUKWS7R2JN357PJDSY272PFK'

const pinContract = (contract: string): PredicateNode => ({
  op: 'eq',
  left: { kind: 'call_contract' },
  right: { kind: 'literal_address', value: contract },
})

const pinFn: PredicateNode = {
  op: 'eq',
  left: { kind: 'call_fn' },
  right: { kind: 'literal_symbol', value: 'transfer' },
}

describe('contextTypeForPredicate', () => {
  it('scopes to the contract a top-level conjunct pins', () => {
    expect(contextTypeForPredicate({ op: 'and', children: [pinFn, pinContract(TOKEN)] })).toEqual({
      kind: 'call_contract',
      contract: TOKEN,
    })
  })

  it('scopes to the contract when the predicate is that pin alone', () => {
    expect(contextTypeForPredicate(pinContract(TOKEN))).toEqual({
      kind: 'call_contract',
      contract: TOKEN,
    })
  })

  it('leaves a predicate that pins no contract account-wide, which is what it means', () => {
    expect(contextTypeForPredicate({ op: 'and', children: [pinFn] })).toEqual({ kind: 'default' })
  })

  it('does NOT scope to a pin under an `or`, because the other branch is not covered by it', () => {
    expect(
      contextTypeForPredicate({ op: 'or', children: [pinContract(TOKEN), pinContract(OTHER)] })
    ).toEqual({ kind: 'default' })
  })
})

describe('install_policy fromPredicate', () => {
  it('rejects a predicate it cannot decode rather than installing a default rule', async () => {
    const res = await runInstallPolicy({
      smartAccount: OTHER,
      sourceAccount: Keypair.random().publicKey(),
      installNonce: 1,
      fromPredicate: {
        encodedPredicate: 'not-base64-predicate',
        signers: [Keypair.random().publicKey()],
      },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
  })
})
