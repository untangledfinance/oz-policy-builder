import { expect, it } from 'bun:test'
import * as api from './index.ts'

it('the public surface is the tools, the codec, the card, the owner-side review (and readFollowed), the pins, Refusal and ruleArgs, and nothing else', () => {
  expect(Object.keys(api).sort()).toEqual(
    [
      'CEILINGS',
      'DECODE_LIMITS',
      'GRAMMAR_VERSION',
      'INTERPRETER',
      'INTERPRETERS',
      'INTERPRETER_WASM',
      'PASSPHRASE',
      'POLICY_CONTRACTS',
      'RPC_URL',
      'Refusal',
      'SPENDING_LIMIT',
      'TOOLS',
      'WireError',
      'card',
      'decode',
      'encode',
      'encodeReference',
      'fromScVal',
      'hashOf',
      'readFollowed',
      'readsOf',
      'referenceOf',
      'reviewUnsigned',
      'ruleArgs',
      'run',
      'toScVal',
      'validate',
    ].sort()
  )
})
