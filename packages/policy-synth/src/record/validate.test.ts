import { describe, expect, it } from 'bun:test'
import type { OnChainEvent, TokenMovement } from '../types.ts'
import { validateAgainstEvents } from './validate.ts'

const TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'

function movement(over: Partial<TokenMovement> = {}): TokenMovement {
  return {
    token: TOKEN,
    from: 'GFROM',
    to: 'GTO',
    amount: '100',
    ...over,
  }
}

function event(over: Partial<OnChainEvent> = {}): OnChainEvent {
  return {
    contract: TOKEN,
    topics: ['transfer', 'GFROM', 'GTO'],
    data: { type: 'i128', value: '100' },
    ...over,
  }
}

describe('validateAgainstEvents', () => {
  it('passes when parsed movements match the events exactly', () => {
    expect(validateAgainstEvents([movement()], [event()])).toBeNull()
  })

  it('skips validation in simulation mode (no events)', () => {
    const corrupt = movement({ amount: '999' })
    expect(validateAgainstEvents([corrupt], [])).toBeNull()
  })

  it('flags a parsed movement absent from the raw events', () => {
    const parsed = movement({ amount: '999' })
    const failure = validateAgainstEvents([parsed], [event()])
    expect(failure?.code).toBe('MOVEMENT_PARSE_NOT_IN_EVENTS')
    expect(failure?.details).toEqual({ movement: parsed })
  })

  it('flags an event movement absent from the parsed set', () => {
    const parsed = movement()
    const extra = movement({ amount: '999' })
    const matchingEvent = event()
    const extraEvent = event({
      topics: ['transfer', 'GFROM', 'GTO'],
      data: { type: 'i128', value: '999' },
    })
    const failure = validateAgainstEvents([parsed], [matchingEvent, extraEvent])
    expect(failure?.code).toBe('MOVEMENT_EVENT_NOT_PARSED')
    expect(failure?.details).toEqual({ movement: extra })
  })

  it('passes when there are no movements to cross-check (e.g. only system events)', () => {
    const sysEvent: OnChainEvent = {
      contract: '',
      topics: ['something'],
      data: { type: 'symbol', value: 'x' },
    }
    expect(validateAgainstEvents([], [sysEvent])).toBeNull()
  })
})
