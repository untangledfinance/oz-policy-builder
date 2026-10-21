// What the chain refuses in the build's own simulation, reaching the caller as
// INSTALL_BUILD_FAILED: OpenZeppelin's add_context_rule (#3010 over 15 signers, #3007 a signer
// twice) and the interpreter's install (#209 no admin). 4.0.0 leaves #3010 and #209 to the chain.
// The package refuses a signer twice first, in planInstall, so #3007 is the chain's second line,
// shown here through buildInstall. Simulation only: nothing is signed or sent. Replays a live
// testnet run; OPB_LIVE=1 bun test src/handover.test.ts records it again.

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { account, contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { buildInstall, type RuleDraft } from './install.ts'
import { callExpr } from './intent.ts'
import { encode, hashOf } from './wire.ts'

setDefaultTimeout(30_000)
const net = recorded('handover')
afterAll(() => net.stop())

// The live testnet account the install tests build against, and a signer of its rule 0.
const ACCOUNT = 'CASJ5GECFWVHCOJHFPE3TJKHLZNBUYNBJ4UAK6JRWHU2HEL3WFGMGM5P'
const SIGNER = 'GAT7JHM4ZCIRIRUEUGPLHARCKDYDC73KN27VABHW5HGAJGZ37ZCWBCSB'
const TOKEN = contract(7)
const INTERP = interpreterFor('testnet')
const encoded = encode(
  callExpr({ contract: TOKEN, fn: 'transfer', where: [{ constraint: 'cap', at: [2], max: '500' }] })
)
const draft = (o: Partial<RuleDraft> = {}): RuleDraft => ({
  scope: { kind: 'call_contract', contract: TOKEN },
  name: 'handover',
  validUntil: null,
  signers: [SIGNER],
  admins: [SIGNER],
  predicate: { encoded, hash: hashOf(encoded) },
  nonce: 1,
  ...o,
})
const args = {
  server: connect(net.endpoint),
  network: 'testnet' as const,
  smartAccount: ACCOUNT,
  sourceAccount: SIGNER,
}

describe('the chain refuses what 4.0.0 no longer refuses before the build', () => {
  it('the control (one signer, one admin) builds, so each refusal below is its one change', async () => {
    const b = await buildInstall(args, draft(), INTERP)
    expect(b.unsignedXdr.length).toBeGreaterThan(0)
  })
  it.each<[string, Partial<RuleDraft>, string]>([
    ['a signer twice: OpenZeppelin DuplicateSigner', { signers: [SIGNER, SIGNER] }, '#3007'],
    [
      'sixteen signers: OpenZeppelin TooManySigners',
      { signers: [SIGNER, ...Array.from({ length: 15 }, (_, i) => account(i + 1))] },
      '#3010',
    ],
    ['no admin: the interpreter EmptySignerSet', { admins: [] }, '#209'],
  ])('%s', async (_n, o, code) => {
    const e = await buildInstall(args, draft(o), INTERP).then(
      () => undefined,
      (x: Error & { code?: string }) => x
    )
    expect(e?.code).toBe('INSTALL_BUILD_FAILED')
    expect(e?.message).toContain(`Error(Contract, ${code})`)
  })
})
