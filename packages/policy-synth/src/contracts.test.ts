// What a contract signer is, read off the ledger (recorded from testnet): a contract that wears the
// adapter symbols but runs no pinned adapter build is an `unverified adapter` (SYNTH-IO-01), vouched
// for as a trusted execution adapter only when it ALSO runs a pinned build and its `prime` is this
// account. Then the two tools that act on it.

import { afterAll, describe, expect, it } from 'bun:test'
import { Address, type rpc, xdr } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, contractKinds, interpreterFor, kindOf } from './chain.ts'
import { ADAPTER_WASM } from './config.ts'
import { buildInstall, executorProblem, type RuleDraft, signerProblem } from './install.ts'
import { callExpr } from './intent.ts'
import { reviewUnsigned } from './review.ts'
import { run } from './tools.ts'
import { encode, hashOf } from './wire.ts'

// Testnet, from the review of #26: contracts that hold the adapter symbols but run an OLD adapter
// build (wasm 7f640e18..), which this package does not pin, and whose `prime` is not this account.
// Under the SYNTH-IO-01 fix both read as `unverified adapter`, not the trusted labels they wore before.
const NULL_SHAPED = 'CD5Y3SNPN3HX5S6XXYCZRQIP7U6FCQIMJJDZ7QKKSYYJG4343SYJ5SA2'
const GATED_SHAPED = 'CCXFDHD7I7NWV37GQ6JTNSGP67EXYLG3QV4GJWUQUBEUEH3IANEI2QTG'
const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const OTHER = XLM // any valid contract address that is not this account
const NOWHERE = contract(99)

/** The pinned adapter build, as the 32-byte code hash a genuine adapter's instance carries. */
const PINNED = Buffer.from([...ADAPTER_WASM][0] as string, 'hex')

const net = recorded('contracts')
afterAll(() => net.stop())
const server = connect(net.endpoint)

describe('contractKinds: an adapter is trusted only on a pinned build and this account', () => {
  it('an old, unpinned adapter build reads as an unverified adapter, not a trusted one', async () => {
    expect(await contractKinds(server, [NULL_SHAPED, GATED_SHAPED, ACCOUNT, XLM, NOWHERE])).toEqual(
      {
        [NULL_SHAPED]: 'unverified adapter',
        [GATED_SHAPED]: 'unverified adapter',
        [ACCOUNT]: 'contract',
        [XLM]: 'contract',
        [NOWHERE]: 'absent',
      }
    )
  })

  it('the kind is the instance: the adapter symbols, a pinned build, and prime == this account', () => {
    const instance = (pairs: [string, xdr.ScVal][], wasm: Buffer = PINNED) =>
      xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(wasm),
          storage: pairs.map(
            ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })
          ),
        })
      )
    const prime = new Address(ACCOUNT).toScVal()
    const otherPrime = new Address(OTHER).toScVal()
    const gate = new Address(GATED_SHAPED).toScVal()
    const nogate: [string, xdr.ScVal][] = [
      ['prime', prime],
      ['gate', xdr.ScVal.scvVoid()],
    ]
    const gated: [string, xdr.ScVal][] = [
      ['prime', prime],
      ['gate', gate],
    ]
    // Pinned build and prime == account: the trusted labels.
    expect(kindOf(instance(nogate), ACCOUNT)).toBe('null-gate adapter')
    expect(kindOf(instance(gated), ACCOUNT)).toBe('gated adapter')
    // A forged build (any other wasm) wearing the same symbols is not vouched for.
    expect(kindOf(instance(gated, Buffer.alloc(32)), ACCOUNT)).toBe('unverified adapter')
    expect(kindOf(instance(nogate, Buffer.alloc(32)), ACCOUNT)).toBe('unverified adapter')
    // A pinned build whose prime is some other account is not this account's adapter.
    expect(
      kindOf(
        instance([
          ['prime', otherPrime],
          ['gate', gate],
        ]),
        ACCOUNT
      )
    ).toBe('unverified adapter')
    // With no account to tie it to, the pinned build still classifies by its gate.
    expect(kindOf(instance(nogate))).toBe('null-gate adapter')
    expect(kindOf(instance(gated))).toBe('gated adapter')
    // Not adapter-shaped at all.
    expect(kindOf(instance([['gate', xdr.ScVal.scvVoid()]]))).toBe('contract')
    expect(
      kindOf(
        instance([
          ['prime', prime],
          ['gate', xdr.ScVal.scvU32(1)],
        ])
      )
    ).toBe('contract')
    expect(kindOf(instance([['prime', prime]]))).toBe('contract')
    expect(kindOf(instance([]))).toBe('contract')
    expect(kindOf(undefined)).toBe('absent')
  })

  it('a failed read is a retryable refusal, never a kind', async () => {
    const down = {
      getLedgerEntries: async () => {
        throw new Error('503 Service Unavailable')
      },
    } as unknown as rpc.Server
    const e = await contractKinds(down, [NULL_SHAPED]).then(
      () => undefined,
      (x) => x as { code?: string; extra?: { retryable?: boolean } }
    )
    expect(e?.code).toBe('SIMULATION_ERROR')
    expect(e?.extra?.retryable).toBe(true)
  })

  it('asks nothing for no address', async () => {
    expect(await contractKinds(server, [])).toEqual({})
  })
})

describe('SYNTH-IO-01: an unverified adapter is refused as a signer and an executor', () => {
  // The trusted labels still pass the refusal gates (the honest path); the unverified one does not.
  it('signerProblem refuses an unverified adapter, accepts a verified gated one', () => {
    expect(signerProblem(GATED_SHAPED, 'unverified adapter', XLM, null)).toMatch(
      /does not run a pinned execution-adapter build/
    )
    expect(signerProblem(NULL_SHAPED, 'unverified adapter', XLM, null)).toMatch(
      /does not run a pinned execution-adapter build/
    )
    expect(signerProblem(GATED_SHAPED, 'gated adapter', XLM, null)).toBeUndefined()
  })

  it('executorProblem refuses an unverified adapter, accepts a verified one', () => {
    expect(executorProblem(GATED_SHAPED, 'unverified adapter', XLM, null)).toMatch(
      /binding a keyless rule to it would let its own code vouch/
    )
    expect(executorProblem(GATED_SHAPED, 'gated adapter', XLM, null)).toBeUndefined()
    expect(executorProblem(NULL_SHAPED, 'null-gate adapter', XLM, null)).toBeUndefined()
  })
})

describe('install_policy and review_unsigned refuse an unverified adapter end to end', () => {
  const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
  const base = {
    network: 'testnet',
    smartAccount: ACCOUNT,
    sourceAccount: SIGNER,
    intent: {
      calls: [
        { contract: XLM, fn: 'transfer', where: [{ constraint: 'cap', at: [2], max: '500' }] },
      ],
    },
    allowOverlap: true,
  }

  // The gated-shaped contract that review #26 (and the SYNTH-IO-01 testnet PoC) had vouched for now
  // gets no free pass: a rule it signs is refused, like the no-gate-shaped one.
  for (const [name, adapter] of [
    ['the no-gate-shaped', NULL_SHAPED],
    ['the gated-shaped', GATED_SHAPED],
  ] as const) {
    it(`install_policy refuses a rule ${name} unverified adapter signs`, async () => {
      const r = await run('install_policy', { ...base, signers: [adapter] })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('INSTALL_BUILD_FAILED')
      expect(r.error.message).toMatch(/does not run a pinned execution-adapter build/)
    })
  }

  it('review_unsigned with readContracts flags both unverified adapters, vouches for neither', async () => {
    const enc = encode(
      callExpr({
        contract: XLM,
        fn: 'transfer',
        where: [{ constraint: 'cap', at: [2], max: '500' }],
      })
    )
    const draft = (signer: string): RuleDraft => ({
      scope: { kind: 'call_contract', contract: XLM },
      name: 'kinds',
      validUntil: null,
      signers: [signer],
      admins: [SIGNER],
      predicate: { encoded: enc, hash: hashOf(enc) },
      nonce: 1,
    })
    const a = { server, network: 'testnet' as const, smartAccount: ACCOUNT, sourceAccount: SIGNER }
    const interpreter = interpreterFor('testnet')
    for (const signer of [NULL_SHAPED, GATED_SHAPED]) {
      const xdrStr = (await buildInstall(a, draft(signer), interpreter)).unsignedXdr
      const r = await run('review_unsigned', {
        network: 'testnet',
        xdr: xdrStr,
        smartAccount: ACCOUNT,
        readContracts: true,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const d = r.data as { signable: boolean; problems: string[] }
      expect(d.signable).toBe(false)
      expect(d.problems.join('\n')).toMatch(/does not run a pinned execution-adapter build/)
      // Offline, the same bytes cannot say what the signer runs.
      expect(
        reviewUnsigned({ network: 'testnet', xdr: xdrStr, smartAccount: ACCOUNT }).signable
      ).toBe(false)
    }
  })
})
