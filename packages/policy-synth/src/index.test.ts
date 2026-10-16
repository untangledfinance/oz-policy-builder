import { expect, it } from 'bun:test'
import * as api from './index.ts'

it('the public surface is the tools, the codec, the card, the pins and Refusal, and nothing else', () => {
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
      'fromScVal',
      'hashOf',
      'run',
      'toScVal',
      'validate',
    ].sort()
  )
})
