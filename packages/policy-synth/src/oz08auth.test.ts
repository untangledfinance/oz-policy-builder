// The two forms a Delegated signer authorises an OpenZeppelin account's `__check_auth` in: the
// 0.7.2-line digest bytes (`91a2cd56…`) and the 0.8.0 `AuthDigestPreimage` struct (`8286422f…`).
// The builder reads the account's code and signs in the form its build asks for; the review checks
// whichever form the bytes carry, and, with the account's code, that it is the one the build asks for.

import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { Address, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import { contract } from '../test/fixtures.ts'
import { recorded } from '../test/rpc.ts'
import { connect, interpreterFor } from './chain.ts'
import { accountAuth, OZ_ACCOUNT_AUTH, OZ_ACCOUNT_WASM, PASSPHRASE } from './config.ts'
import { authPreimage, buildInstall, checkAuthArg, digest, type RuleDraft } from './install.ts'
import { callExpr } from './intent.ts'
import { reviewUnsigned } from './review.ts'
import { encode, hashOf } from './wire.ts'

const V072 = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const V080 = '8286422f205951f37f4249401b403471fc432340dde6925432d31bb8a90cce27'
/** The testnet reference account, OpenZeppelin 0.8.0 (`deployments/oz-accounts.json`), and the
 *  delegated signer of its rule 0 (a throwaway key; only the public key is here). */
const ACCOUNT_080 = 'CDS2W673EV22FDZX7FB6PDSTPJ7MMPONVXAGITNC2ABBVJ65TGA2ACUL'
/** A 0.7.2-line account (`91a2cd56…`) deployed beside it with the same rule-0 signer, as the control. */
const ACCOUNT_072 = 'CBWF5WMHAVGKX6ZPTSTSEN47BD4NP4D3DXRNFWEIPMMNCOH6LHNQ4MEH'
const SIGNER = 'GCYY5FLA7M7GIO52QGF6HFGOJM5RONV3DLZOVLDM6OOMJSVQ6CG6UQD5'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const INTERP = interpreterFor('testnet')

const inv = new xdr.SorobanAuthorizedInvocation({
  function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract(3)).toScAddress(),
      functionName: 'add_context_rule',
      args: [],
    })
  ),
  subInvocations: [],
})
const nonce = xdr.Int64.fromString('42')
const sha = (b: Buffer) => createHash('sha256').update(b).digest()
const payload = (network: 'testnet' | 'mainnet' = 'testnet') =>
  sha(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: sha(Buffer.from(PASSPHRASE[network])),
        nonce,
        signatureExpirationLedger: 900,
        invocation: inv,
      })
    ).toXDR()
  )

describe('the account builds and the form each asks for', () => {
  it('every trusted build has a form, and only those: 0.7.2-line digest, 0.8.0 preimage', () => {
    expect(Object.keys(OZ_ACCOUNT_AUTH).sort()).toEqual([...OZ_ACCOUNT_WASM].sort())
    expect(accountAuth(V072)).toBe('digest')
    expect(accountAuth(V080)).toBe('preimage')
    for (const other of [undefined, '', 'ab'.repeat(32), 'constructor', '__proto__', 'toString'])
      expect(accountAuth(other)).toBeUndefined()
  })

  it('digest: sha256(signature payload ‖ XDR(rule ids)), as bytes (the 0.7.2-line account)', () => {
    const ids = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]).toXDR()
    const want = sha(Buffer.concat([payload(), ids]))
    const got = checkAuthArg('digest', 'testnet', contract(3), nonce, 900, inv, [0])
    expect(got.switch().name).toBe('scvBytes')
    expect(Buffer.from(got.bytes()).equals(want)).toBe(true)
    expect(Buffer.from(digest('testnet', nonce, 900, inv, [0])).equals(want)).toBe(true)
  })

  it('preimage: AuthDigestPreimage { account, context_rule_ids, signature_payload }, fields in name order (OZ 0.8.0)', () => {
    const got = checkAuthArg('preimage', 'testnet', contract(3), nonce, 900, inv, [0, 2])
    const want = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('account'),
        val: new Address(contract(3)).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('context_rule_ids'),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0), xdr.ScVal.scvU32(2)]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('signature_payload'),
        val: xdr.ScVal.scvBytes(payload()),
      }),
    ])
    expect(got.toXDR('base64')).toBe(want.toXDR('base64'))
    expect(authPreimage('testnet', contract(3), nonce, 900, inv, [0, 2]).toXDR('base64')).toBe(
      want.toXDR('base64')
    )
  })

  it('each form binds the network, the rule ids and (the preimage) the account', () => {
    const base = checkAuthArg('preimage', 'testnet', contract(3), nonce, 900, inv, [0])
    for (const other of [
      checkAuthArg('preimage', 'mainnet', contract(3), nonce, 900, inv, [0]),
      checkAuthArg('preimage', 'testnet', contract(4), nonce, 900, inv, [0]),
      checkAuthArg('preimage', 'testnet', contract(3), nonce, 900, inv, [1]),
      checkAuthArg('preimage', 'testnet', contract(3), nonce, 901, inv, [0]),
    ])
      expect(other.toXDR('base64')).not.toBe(base.toXDR('base64'))
    const d = checkAuthArg('digest', 'testnet', contract(3), nonce, 900, inv, [0])
    expect(
      checkAuthArg('digest', 'mainnet', contract(3), nonce, 900, inv, [0]).toXDR('base64')
    ).not.toBe(d.toXDR('base64'))
    expect(
      checkAuthArg('digest', 'testnet', contract(3), nonce, 900, inv, [1]).toXDR('base64')
    ).not.toBe(d.toXDR('base64'))
  })
})

// ---- built against the two live testnet accounts, recorded ----

const net = recorded('oz08auth')
afterAll(() => net.stop())
const server = connect(net.endpoint)
const expr = callExpr({
  contract: XLM,
  fn: 'transfer',
  where: [{ constraint: 'cap', at: [2], max: '100000' }],
})
const encoded = encode(expr)
const draft: RuleDraft = {
  scope: { kind: 'call_contract', contract: XLM },
  name: 'oz08-auth',
  validUntil: null,
  signers: [SIGNER],
  admins: [SIGNER],
  predicate: { encoded, hash: hashOf(encoded) },
  nonce: 1,
}
const args = (smartAccount: string) => ({
  server,
  network: 'testnet' as const,
  smartAccount,
  sourceAccount: SIGNER,
})
/** The source account's `__check_auth` argument in built bytes. */
const checkArg = (b64: string) => {
  const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64')
  const auth = env.v1().tx().operations()[0]?.body().invokeHostFunctionOp().auth() ?? []
  const check = auth.find(
    (e) =>
      e.credentials().switch().name === 'sorobanCredentialsSourceAccount' &&
      e.rootInvocation().function().contractFn().functionName().toString() === '__check_auth'
  )
  return check?.rootInvocation().function().contractFn().args()[0] as xdr.ScVal
}
/** The same bytes with the `__check_auth` argument replaced by `arg`. */
const withArg = (b64: string, arg: xdr.ScVal) => {
  const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64')
  const auth = env.v1().tx().operations()[0]?.body().invokeHostFunctionOp().auth() ?? []
  for (const e of auth) {
    const fn = e.rootInvocation().function()
    if (
      e.credentials().switch().name === 'sorobanCredentialsSourceAccount' &&
      fn.contractFn().functionName().toString() === '__check_auth'
    )
      fn.contractFn().args([arg])
  }
  return env.toXDR('base64')
}
const accountEntry = (b64: string) => {
  const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64')
  const auth = env.v1().tx().operations()[0]?.body().invokeHostFunctionOp().auth() ?? []
  return auth.find((e) => e.credentials().switch().name === 'sorobanCredentialsAddress')
}

describe('buildInstall signs in the form the account build asks for, read live', () => {
  it('the 0.8.0 account (8286422f): the preimage struct, and the account accepts it in simulation', async () => {
    const b = await buildInstall(args(ACCOUNT_080), draft, INTERP)
    const arg = checkArg(b.unsignedXdr)
    expect(arg.switch().name).toBe('scvMap')
    const own = accountEntry(b.unsignedXdr) as xdr.SorobanAuthorizationEntry
    const c = own.credentials().address()
    const want = authPreimage(
      'testnet',
      ACCOUNT_080,
      c.nonce(),
      c.signatureExpirationLedger(),
      own.rootInvocation(),
      [0]
    )
    expect(arg.toXDR('base64')).toBe(want.toXDR('base64'))
    const r = reviewUnsigned({ network: 'testnet', xdr: b.unsignedXdr, smartAccount: ACCOUNT_080 })
    expect(r.problems).toEqual([])
    expect(r.signable).toBe(true)
    expect(r.auth?.form).toBe('preimage')
    expect(r.review.join('\n')).toMatch(/signed as the OpenZeppelin 0\.8\.0 preimage/)
    // With the account's code read, the form is the one its build asks for.
    const read = reviewUnsigned({
      network: 'testnet',
      xdr: b.unsignedXdr,
      smartAccount: ACCOUNT_080,
      accountCode: { wasmSha256: V080 },
    })
    expect(read.problems).toEqual([])
  })

  it('the 0.7.2-line account (91a2cd56): the digest bytes, as before', async () => {
    const b = await buildInstall(args(ACCOUNT_072), draft, INTERP)
    const arg = checkArg(b.unsignedXdr)
    expect(arg.switch().name).toBe('scvBytes')
    const own = accountEntry(b.unsignedXdr) as xdr.SorobanAuthorizationEntry
    const c = own.credentials().address()
    expect(
      Buffer.from(arg.bytes()).equals(
        digest('testnet', c.nonce(), c.signatureExpirationLedger(), own.rootInvocation(), [0])
      )
    ).toBe(true)
    const r = reviewUnsigned({
      network: 'testnet',
      xdr: b.unsignedXdr,
      smartAccount: ACCOUNT_072,
      accountCode: { wasmSha256: V072 },
    })
    expect(r.problems).toEqual([])
    expect(r.auth?.form).toBe('digest')
  })

  it('the review: a form the build does not ask for, an unknown build, or an unreadable code is a problem', async () => {
    const b = await buildInstall(args(ACCOUNT_080), draft, INTERP)
    const own = accountEntry(b.unsignedXdr) as xdr.SorobanAuthorizationEntry
    const c = own.credentials().address()
    // The same entry signed in the 0.7.2 form, consistently: offline it is a well-formed digest...
    const swapped = withArg(
      b.unsignedXdr,
      xdr.ScVal.scvBytes(
        digest('testnet', c.nonce(), c.signatureExpirationLedger(), own.rootInvocation(), [0])
      )
    )
    const offline = reviewUnsigned({ network: 'testnet', xdr: swapped, smartAccount: ACCOUNT_080 })
    expect(offline.auth?.form).toBe('digest')
    // ...and with the account's code read, the account would refuse it.
    const wrong = reviewUnsigned({
      network: 'testnet',
      xdr: swapped,
      smartAccount: ACCOUNT_080,
      accountCode: { wasmSha256: V080 },
    })
    expect(wrong.signable).toBe(false)
    expect(wrong.problems).toContainEqual(
      expect.stringMatching(
        /in the OpenZeppelin 0\.7\.2-line digest form, but CDS2W673\w+ runs a build that asks for the OpenZeppelin 0\.8\.0 preimage: the account would refuse it/
      )
    )
    const unknown = reviewUnsigned({
      network: 'testnet',
      xdr: b.unsignedXdr,
      smartAccount: ACCOUNT_080,
      accountCode: { wasmSha256: 'ab'.repeat(32) },
    })
    expect(unknown.problems).toContainEqual(
      expect.stringMatching(/not an OpenZeppelin smart account build this package signs for/)
    )
    const unread = reviewUnsigned({
      network: 'testnet',
      xdr: b.unsignedXdr,
      smartAccount: ACCOUNT_080,
      accountCode: { error: 'no available server' },
    })
    expect(unread.problems).toContainEqual(
      "the account's code could not be read (no available server)"
    )
    // A preimage that names another account, or other rule ids, does not match.
    for (const bad of [
      authPreimage(
        'testnet',
        ACCOUNT_072,
        c.nonce(),
        c.signatureExpirationLedger(),
        own.rootInvocation(),
        [0]
      ),
      authPreimage(
        'testnet',
        ACCOUNT_080,
        c.nonce(),
        c.signatureExpirationLedger(),
        own.rootInvocation(),
        [1]
      ),
      authPreimage(
        'mainnet',
        ACCOUNT_080,
        c.nonce(),
        c.signatureExpirationLedger(),
        own.rootInvocation(),
        [0]
      ),
      xdr.ScVal.scvVec([]),
    ]) {
      const r = reviewUnsigned({
        network: 'testnet',
        xdr: withArg(b.unsignedXdr, bad),
        smartAccount: ACCOUNT_080,
      })
      expect(r.problems).toContainEqual(expect.stringMatching(/__check_auth does not match/))
      expect(r.auth?.form).toBeUndefined()
    }
  })

  it('the bytes are unsigned, and carry a time bound', async () => {
    const b = await buildInstall(args(ACCOUNT_080), draft, INTERP)
    const tx = TransactionBuilder.fromXDR(b.unsignedXdr, PASSPHRASE.testnet)
    expect(tx.signatures).toHaveLength(0)
    expect(b.validBefore).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
})
