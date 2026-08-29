// src/install/simulation-reason.test.ts - unit tests for the failed-simulation
// reason extractor.
//
// The property under test is a security one as much as a usability one. A
// simulation error names both why the chain refused the call and which host was
// asked; only the first half may reach a caller. These tests pin that split, so
// a later change that widens the extractor fails here rather than in review.

import { describe, expect, it } from 'bun:test'
import { simulationReason } from './build-install-policy'

describe('simulationReason', () => {
  it('surfaces the contract error code, which is what a caller can act on', () => {
    expect(simulationReason({ error: 'host invocation failed: Error(Contract, #3221)' })).toBe(
      ' (Error(Contract, #3221))'
    )
  })

  it('surfaces auth refusals, the likeliest cause of a failed install', () => {
    expect(simulationReason({ error: 'Error(Auth, InvalidAction)' })).toBe(
      ' (Error(Auth, InvalidAction))'
    )
  })

  it('never reflects host or URL detail back to the caller', () => {
    const reason = simulationReason({
      error:
        'call to https://soroban-testnet.stellar.org:443 from 10.0.0.4 failed: Error(Auth, InvalidAction)',
    })
    expect(reason).toBe(' (Error(Auth, InvalidAction))')
    expect(reason).not.toContain('stellar.org')
    expect(reason).not.toContain('10.0.0.4')
    expect(reason).not.toContain('443')
  })

  it('reports every distinct code once', () => {
    expect(
      simulationReason({
        error: 'Error(Contract, #9); Error(Contract, #9); Error(Storage, MissingValue)',
      })
    ).toBe(' (Error(Contract, #9), Error(Storage, MissingValue))')
  })

  it('adds nothing when there is no chain error, keeping the message stable', () => {
    expect(simulationReason({ error: 'connection reset by peer' })).toBe('')
    expect(simulationReason({ error: '' })).toBe('')
    expect(simulationReason({})).toBe('')
  })
})
