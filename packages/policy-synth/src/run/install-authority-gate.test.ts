// src/run/install-authority-gate.test.ts - installing a rule that cannot bind
// is refused, not merely reported.
//
// An OZ account resolves a call against the rule the caller NAMES, taking the
// MAXIMUM authority over the rules a key sits on rather than the intersection.
// So a key that also sits on a rule with no policy is unconstrained: it names
// that rule and the new predicate never runs. The scan already detected this
// and the install still returned ok, leaving the whole protection to a caller
// reading `data.authorityScan` - and the caller here is usually an agent that
// checks whether the call succeeded.
//
// The line drawn: refuse only what is PROVED. `bypass` is proved from data in
// hand (the neighbour has no policy at all). `unknown` means the neighbour is
// policed by a contract this tool cannot decode, which is not the same as
// unsafe, so it stays advisory.

import { describe, expect, it } from 'bun:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { AuthorityOverlap } from '../install/authority-overlap.ts'
import { authorityBypassRefusal } from './index.ts'

const SIGNER = Keypair.random().publicKey()

function overlap(severity: AuthorityOverlap['severity'], ruleId: number): AuthorityOverlap {
  return {
    ruleId,
    ruleClass: severity === 'bypass' ? 'unpoliced' : 'foreign',
    severity,
    sharedSigners: [{ kind: 'delegated', address: SIGNER }],
    sharedSelectors: [{ contract: 'CDEG66TY', fn: 'transfer' }],
    advice: `rule ${ruleId} has no policy attached.`,
  } as AuthorityOverlap
}

describe('authorityBypassRefusal', () => {
  it('refuses a proven bypass and names the rule to fix', () => {
    const msg = authorityBypassRefusal([overlap('bypass', 0)], undefined)
    expect(msg).toBeDefined()
    expect(msg).toContain('rule 0')
    expect(msg).toContain('allowAuthorityOverlap')
  })

  it('proceeds when the caller opts in deliberately', () => {
    expect(authorityBypassRefusal([overlap('bypass', 0)], true)).toBeUndefined()
  })

  // "Cannot decode" is not "unsafe". Refusing here would block installs on a
  // guess, and the neighbour may be tighter than the rule being installed.
  it('does not refuse a neighbour it merely cannot decode', () => {
    expect(authorityBypassRefusal([overlap('unknown', 3)], undefined)).toBeUndefined()
  })

  it('does not refuse when the scan found nothing', () => {
    expect(authorityBypassRefusal([], undefined)).toBeUndefined()
  })

  // `null` is NOT CHECKED - the account read failed or was incomplete. That is
  // an absence of evidence, not evidence of a bypass, and refusing on it would
  // make every RPC hiccup a failed install.
  it('does not refuse on an unchecked scan', () => {
    expect(authorityBypassRefusal(null, undefined)).toBeUndefined()
  })

  it('reports every proven bypass, not just the first', () => {
    const msg = authorityBypassRefusal([overlap('bypass', 0), overlap('bypass', 4)], undefined)
    expect(msg).toContain('rule 0, 4')
  })
})
