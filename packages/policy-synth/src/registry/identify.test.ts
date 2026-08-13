import { describe, expect, it } from 'bun:test'
import { Address } from '@stellar/stellar-sdk'
import type { ScVal } from '../types.ts'
import { identifyProtocol } from './identify.ts'

// Tiny helper to keep the test bodies readable. We DO NOT typecheck the
// shapes here; the production code does that.
const addr = (s: string): ScVal => ({ type: 'address', value: s })
const i128 = (s: string): ScVal => ({ type: 'i128', value: s })
const u32 = (n: number): ScVal => ({ type: 'u32', value: String(n) })
const u64 = (s: string): ScVal => ({ type: 'u64', value: s })
const sym = (s: string): ScVal => ({ type: 'symbol', value: s })
const vec = (items: ScVal[]): ScVal => ({ type: 'vec', value: items })

describe('identifyProtocol', () => {
  it('recognises a SEP-41 transfer by interface for any token address', () => {
    const result = identifyProtocol(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      'transfer',
      [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        i128('100'),
      ]
    )
    expect(result).not.toBeNull()
    expect(result?.protocol).toBe('sep41')
    expect(result?.fn).toBe('transfer')
  })

  it('recognises SEP-41 mint/burn/approve by interface (no network needed)', () => {
    expect(
      identifyProtocol('CSOMEOTHERTOKEN', 'mint', [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        i128('100'),
      ])?.protocol
    ).toBe('sep41')
    expect(
      identifyProtocol('CSOMEOTHERTOKEN', 'burn', [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        i128('100'),
      ])?.protocol
    ).toBe('sep41')
    expect(
      identifyProtocol('CSOMEOTHERTOKEN', 'approve', [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        i128('100'),
        u32(0),
      ])?.protocol
    ).toBe('sep41')
  })

  it('recognises a pinned Blend mainnet pool-factory address by address when method is in ABI', () => {
    // Factory calls would normally hit `submit` (forwarded) or pool-management
    // fns; the interface recognition path also catches `submit` on the pool
    // contract itself, but for the factory the address recognition path applies
    // with FIX 4's "method must be in the protocol's ABI" rule.
    const result = identifyProtocol(
      'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU',
      'submit',
      [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        vec([]),
      ],
      'mainnet'
    )
    expect(result?.protocol).toBe('blend')
    expect(result?.fn).toBe('submit')
  })

  it('recognises Blend pool submit by interface (any pool address) when arg shape matches', () => {
    // Real Blend pool calls hit per-pool instances (NOT the factory). The
    // interface recognition path must catch this when the (method, args) shape
    // matches the pool's ABI.
    const pool = Address.contract(Buffer.alloc(32, 0x77)).toString()
    const result = identifyProtocol(
      pool,
      'submit',
      [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        vec([]),
      ],
      'mainnet'
    )
    expect(result?.protocol).toBe('blend')
    expect(result?.fn).toBe('submit')
  })

  it('recognises Blend pool claim by interface when arg shape matches', () => {
    const pool = Address.contract(Buffer.alloc(32, 0x78)).toString()
    const result = identifyProtocol(
      pool,
      'claim',
      [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        vec([u32(0)]),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
      ],
      'mainnet'
    )
    expect(result?.protocol).toBe('blend')
    expect(result?.fn).toBe('claim')
  })

  it('recognises a pinned SoroSwap mainnet router address by address when method is in ABI', () => {
    const result = identifyProtocol(
      'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
      'swap_exact_tokens_for_tokens',
      [
        i128('100'),
        i128('90'),
        vec([
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        ]),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        u64('1700000000'),
      ],
      'mainnet'
    )
    expect(result?.protocol).toBe('soroswap')
    expect(result?.fn).toBe('swap_exact_tokens_for_tokens')
  })

  it('returns null for an unknown contract AND unknown method', () => {
    expect(
      identifyProtocol('CRANDOMCONTRACT', 'completely_unknown_fn', [sym('anything')])
    ).toBeNull()
  })

  it('returns null for an unknown contract even when the method name looks like Blend/SoroSwap', () => {
    // Blend/SoroSwap are recognised by address only (SoroSwap) or by
    // interface (Blend, with arg-shape check). An arbitrary contract calling
    // `swap_exact_tokens_for_tokens` with the wrong arg shape is NOT
    // identified.
    expect(
      identifyProtocol('CRANDOMCONTRACT', 'swap_exact_tokens_for_tokens', [i128('100')], 'mainnet')
    ).toBeNull()
    // A method named `submit` with the wrong arg count also fails closed.
    expect(identifyProtocol('CRANDOMCONTRACT', 'submit', [], 'mainnet')).toBeNull()
  })

  it('returns null for a pinned mainnet contract when network is omitted', () => {
    // Address-based recognition is network-scoped; without a network we
    // cannot claim recognition for a Blend/SoroSwap contract.
    expect(
      identifyProtocol(
        'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
        'swap_exact_tokens_for_tokens',
        [
          i128('100'),
          i128('90'),
          vec([]),
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
          u64('1700000000'),
        ]
      )
    ).toBeNull()
  })

  it('recognises Blend submit by interface on testnet too (interface is network-agnostic)', () => {
    // Interface recognition is network-agnostic: a contract calling `submit`
    // with the right arg shape is recognised as Blend regardless of the
    // pinned-address set (which is mainnet-only). The address pin only adds
    // recognition for additional methods not in the interface ABI.
    expect(
      identifyProtocol(
        'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU',
        'submit',
        [
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
          vec([]),
        ],
        'testnet'
      )?.protocol
    ).toBe('blend')
  })

  // ===== fail-closed: prototype-chain + shape validation =====
  // The `in` operator walks the prototype chain; without Object.hasOwn,
  // methods like `constructor` or `toString` would be falsely recognised.

  it('does not recognise `constructor` as a method (prototype chain fail-closed)', () => {
    expect(
      identifyProtocol('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'constructor', [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        i128('100'),
      ])
    ).toBeNull()
  })

  it('does not recognise `toString` as a method (prototype chain fail-closed)', () => {
    expect(
      identifyProtocol('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'toString', [])
    ).toBeNull()
  })

  it('does not recognise `hasOwnProperty` as a method (prototype chain fail-closed)', () => {
    expect(
      identifyProtocol(
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        'hasOwnProperty',
        [sym('transfer')]
      )
    ).toBeNull()
  })

  it('does not recognise a SEP-41 transfer with the wrong arg arity', () => {
    // Only 2 args - too few for `transfer(from, to, amount)`.
    expect(
      identifyProtocol('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'transfer', [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
      ])
    ).toBeNull()
  })

  it('does not recognise a SEP-41 transfer with the wrong arg types', () => {
    // (from, to, amount) but `amount` is a symbol, not an i128.
    expect(
      identifyProtocol('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'transfer', [
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        sym('100'),
      ])
    ).toBeNull()
  })

  it('does not recognise a pinned SoroSwap router address with an UNKNOWN method (FIX 4)', () => {
    // FIX 4: a pinned address alone is NOT enough - the method must also be
    // in that protocol's ABI.
    expect(
      identifyProtocol(
        'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
        'completely_unknown_method',
        [],
        'mainnet'
      )
    ).toBeNull()
  })

  it('does not recognise a pinned Blend factory address with an UNKNOWN method (FIX 4)', () => {
    expect(
      identifyProtocol(
        'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU',
        'deploy_some_pool',
        [],
        'mainnet'
      )
    ).toBeNull()
  })

  // ===== OZ smart-account interface recognition =====
  // Every user's smart account has its own C-address; per-deployment
  // pinning is impossible. Recognition must work by interface, the same
  // way SEP-41 is recognised by interface for any token address.

  it('recognises `batch_add_signer` as OZ regardless of the contract address', () => {
    // Same shape, two arbitrary addresses - both should be recognised.
    const result = identifyProtocol('CB35MK6W...MYYJR2', 'batch_add_signer', [
      u32(1),
      vec([
        sym('Delegated'),
        addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
      ]),
    ])
    expect(result).not.toBeNull()
    expect(result?.protocol).toBe('oz_account')
    expect(result?.fn).toBe('batch_add_signer')

    // A DIFFERENT (random) address invoking the same shape is also recognised.
    const other = identifyProtocol(
      'CDZJNVXZ7EXAMPLEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
      'batch_add_signer',
      [
        u32(0),
        vec([
          sym('Delegated'),
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        ]),
      ]
    )
    expect(other?.protocol).toBe('oz_account')
  })

  it('recognises `batch_remove_signer` and `remove_context_rule` as OZ', () => {
    expect(
      identifyProtocol('CB35MK6W...MYYJR2', 'batch_remove_signer', [
        u32(1),
        vec([addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO')]),
      ])?.protocol
    ).toBe('oz_account')

    expect(identifyProtocol('CB35MK6W...MYYJR2', 'remove_context_rule', [u32(0)])?.protocol).toBe(
      'oz_account'
    )
  })

  it('does not recognise OZ methods with a wrong arg shape (fail-closed)', () => {
    // `batch_add_signer` requires (u32, vec) - off-by-one arg count fails.
    expect(identifyProtocol('CB35MK6W...MYYJR2', 'batch_add_signer', [u32(1)])).toBeNull()

    // Wrong type for the first arg (symbol instead of u32) fails closed.
    expect(
      identifyProtocol('CB35MK6W...MYYJR2', 'batch_add_signer', [
        sym('rule_id'),
        vec([
          sym('Delegated'),
          addr('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACJBO'),
        ]),
      ])
    ).toBeNull()

    // Wrong type for the second arg (u32 instead of vec) fails closed.
    expect(identifyProtocol('CB35MK6W...MYYJR2', 'batch_add_signer', [u32(1), u32(99)])).toBeNull()

    // `remove_context_rule` requires (u32) - empty arg list fails closed.
    expect(identifyProtocol('CB35MK6W...MYYJR2', 'remove_context_rule', [])).toBeNull()
  })
})
