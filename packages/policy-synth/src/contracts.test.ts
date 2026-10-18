// What a contract signer is, read off the ledger (recorded from testnet): an execution adapter with no
// gate (the review of #26 had one sign a rule and an agent spend five times its cap), a gated adapter,
// an account, a contract that is not there. Then the two tools that act on it.

import { afterAll, describe, expect, it } from 'bun:test'
import { Address, type rpc, xdr } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, contractKinds, kindOf } from './chain.ts'
import { buildInstall, type RuleDraft } from './install.ts'
import { callExpr } from './intent.ts'
import { reviewUnsigned } from './review.ts'
import { run } from './tools.ts'
import { encode, hashOf } from './wire.ts'

/** Testnet, from the review of #26 (`review-opb26-evidence/probes-testnet.log`): a v5 adapter
 *  created with no gate, and one bound to a custody gate. */
const NULL_ADAPTER = 'CD5Y3SNPN3HX5S6XXYCZRQIP7U6FCQIMJJDZ7QKKSYYJG4343SYJ5SA2'
const GATED_ADAPTER = 'CCXFDHD7I7NWV37GQ6JTNSGP67EXYLG3QV4GJWUQUBEUEH3IANEI2QTG'
const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const NOWHERE = contract(99)

const net = recorded('contracts')
afterAll(() => net.stop())
const server = connect(net.endpoint)

describe('contractKinds: read off the instance, never off a code hash', () => {
  it('names the adapter with no gate, and only it', async () => {
    expect(
      await contractKinds(server, [NULL_ADAPTER, GATED_ADAPTER, ACCOUNT, XLM, NOWHERE])
    ).toEqual({
      [NULL_ADAPTER]: 'null-gate adapter',
      [GATED_ADAPTER]: 'contract',
      [ACCOUNT]: 'contract',
      [XLM]: 'contract',
      [NOWHERE]: 'absent',
    })
  })

  it('the kind is the instance storage: a void gate beside a prime, nothing else', () => {
    const instance = (pairs: [string, xdr.ScVal][]) =>
      xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
          storage: pairs.map(
            ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })
          ),
        })
      )
    const prime = new Address(ACCOUNT).toScVal()
    const gate = new Address(GATED_ADAPTER).toScVal()
    expect(
      kindOf(
        instance([
          ['prime', prime],
          ['gate', xdr.ScVal.scvVoid()],
        ])
      )
    ).toBe('null-gate adapter')
    expect(
      kindOf(
        instance([
          ['prime', prime],
          ['gate', gate],
        ])
      )
    ).toBe('contract')
    expect(kindOf(instance([['gate', xdr.ScVal.scvVoid()]]))).toBe('contract')
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
    const e = await contractKinds(down, [NULL_ADAPTER]).then(
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

describe('install_policy and review_unsigned with a contract signer', () => {
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

  it('install_policy refuses a rule the null-gate adapter signs', async () => {
    const r = await run('install_policy', { ...base, signers: [NULL_ADAPTER] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(r.error.message).toMatch(/is an execution adapter bound to no gate/)
  })

  it('install_policy builds a rule a gated adapter signs', async () => {
    const r = await run('install_policy', { ...base, signers: [GATED_ADAPTER] })
    expect(r.ok).toBe(true)
  })

  it('review_unsigned with readContracts flags the null-gate adapter and passes the gated one', async () => {
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
    const interpreter = 'CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT'
    for (const [signer, signable] of [
      [NULL_ADAPTER, false],
      [GATED_ADAPTER, true],
    ] as const) {
      const xdr = (await buildInstall(a, draft(signer), interpreter)).unsignedXdr
      const r = await run('review_unsigned', {
        network: 'testnet',
        xdr,
        smartAccount: ACCOUNT,
        readContracts: true,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const d = r.data as { signable: boolean; problems: string[] }
      expect(d.signable).toBe(signable)
      if (!signable) expect(d.problems.join('\n')).toMatch(/bound to no gate/)
      // Offline, the same bytes cannot say what the signer runs.
      expect(reviewUnsigned({ network: 'testnet', xdr, smartAccount: ACCOUNT }).signable).toBe(
        false
      )
      // And the tool reads nothing unless asked.
      let asked = 0
      const counter = Bun.serve({
        port: 0,
        fetch: () => {
          asked++
          return new Response('no', { status: 503 })
        },
      })
      const before = process.env.POLICY_BUILDER_RPC_URL_TESTNET
      process.env.POLICY_BUILDER_RPC_URL_TESTNET = `http://127.0.0.1:${counter.port}`
      try {
        const off = await run('review_unsigned', { network: 'testnet', xdr, smartAccount: ACCOUNT })
        expect(off.ok && (off.data as { signable: boolean }).signable).toBe(false)
        expect(asked).toBe(0)
      } finally {
        process.env.POLICY_BUILDER_RPC_URL_TESTNET = before
        counter.stop(true)
      }
    }
  })
})
