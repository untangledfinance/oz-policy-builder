import { describe, expect, it } from 'bun:test'
import {
  Account,
  Address,
  Networks,
  nativeToScVal,
  Operation,
  type rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { account, contract } from '../test/fixtures.ts'
import { Refusal } from './envelope.ts'
import { decodeEnvelope, recordHash } from './record.ts'

const SRC = account(7)
const fn = (c: string, name: string, ...args: xdr.ScVal[]) =>
  new xdr.InvokeContractArgs({
    contractAddress: new Address(c).toScAddress(),
    functionName: name,
    args,
  })
const amount = (n: bigint) => nativeToScVal(n, { type: 'i128' })

function invocation(root: xdr.InvokeContractArgs, ...subs: xdr.SorobanAuthorizedInvocation[]) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(root),
    subInvocations: subs,
  })
}
const entry = (who: string, inv: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(who).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: inv,
  })

function envelope(call: xdr.InvokeContractArgs, auth: xdr.SorobanAuthorizationEntry[] = []) {
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(call),
    auth,
  })
  return new TransactionBuilder(new Account(SRC, '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(0)
    .build()
}

const TOKEN = contract(2)
const POOL = contract(3)
const swap = fn(POOL, 'swap', amount(5n), new Address(account(1)).toScVal())
const pull = fn(
  TOKEN,
  'transfer',
  new Address(account(1)).toScVal(),
  new Address(POOL).toScVal(),
  amount(5n)
)

describe('decodeEnvelope', () => {
  it('reads the call, the nested call its authorisation covers, who authorised, once each', () => {
    const auth = [
      entry(account(1), invocation(swap, invocation(pull))),
      entry(account(1), invocation(swap)),
    ]
    const rec = decodeEnvelope(envelope(swap, auth).toEnvelope().toXDR('base64'), 'testnet', 42)
    expect(rec.source).toBe(SRC)
    expect(rec.ledger).toBe(42)
    expect(rec.signers).toEqual([account(1)])
    expect(rec.contexts).toEqual([
      {
        contract: POOL,
        fn: 'swap',
        args: [{ i128: '5' }, account(1)],
      },
      { contract: TOKEN, fn: 'transfer', args: [account(1), POOL, { i128: '5' }] },
    ])
  })

  it('sees through a fee bump', () => {
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      account(9),
      '200',
      envelope(swap),
      Networks.TESTNET
    )
    const rec = decodeEnvelope(bump.toEnvelope().toXDR('base64'), 'testnet')
    expect(rec.contexts[0]?.fn).toBe('swap')
  })

  it.each([
    ['not an envelope', 'AAAA'],
    [
      'a transaction that calls no contract',
      new TransactionBuilder(new Account(SRC, '0'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
        .setTimeout(0)
        .build()
        .toEnvelope()
        .toXDR('base64'),
    ],
  ])('refuses %s', (_n, b64) => expect(() => decodeEnvelope(b64, 'testnet')).toThrow(Refusal))
})

describe('recordHash', () => {
  const server = (status: string, xdrB64?: string) =>
    ({
      getTransaction: async () => ({
        status,
        ledger: 9,
        envelopeXdr: xdrB64 ? xdr.TransactionEnvelope.fromXDR(xdrB64, 'base64') : undefined,
      }),
    }) as unknown as rpc.Server
  const good = envelope(swap).toEnvelope().toXDR('base64')
  const goodHash = envelope(swap).hash().toString('hex')

  it('fetches and decodes', async () => {
    const rec = await recordHash(server('SUCCESS', good), 'testnet', goodHash)
    expect(rec.ledger).toBe(9)
    expect(rec.contexts[0]?.fn).toBe('swap')
  })
  it('refuses an envelope whose hash is not the hash asked for: the RPC answer is not trusted', async () => {
    const err = await recordHash(server('SUCCESS', good), 'testnet', 'ab'.repeat(32)).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(Refusal)
    expect(err.message).toContain(goodHash)
  })
  it('hashes under the network asked: a testnet envelope does not answer a mainnet hash', async () => {
    await expect(recordHash(server('SUCCESS', good), 'mainnet', goodHash)).rejects.toThrow(
      /not trusted/
    )
  })
  it('a fee bump answers to its own hash and to its inner transaction hash', async () => {
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      account(9),
      '200',
      envelope(swap),
      Networks.TESTNET
    )
    const b64 = bump.toEnvelope().toXDR('base64')
    for (const h of [bump.hash().toString('hex'), goodHash, goodHash.toUpperCase()]) {
      const rec = await recordHash(server('SUCCESS', b64), 'testnet', h)
      expect(rec.contexts[0]?.fn).toBe('swap')
    }
  })
  it('says when the hash is on the other network', async () => {
    const err = await recordHash(
      server('NOT_FOUND'),
      'mainnet',
      'ab'.repeat(32),
      server('SUCCESS', good)
    ).catch((e) => e)
    expect(err.message).toContain('exists on testnet')
    expect(err.extra.retryable).toBe(false)
  })
  it('a hash found nowhere may simply be too new: retryable', async () => {
    const err = await recordHash(
      server('NOT_FOUND'),
      'mainnet',
      'ab'.repeat(32),
      server('NOT_FOUND')
    ).catch((e) => e)
    expect(err.extra.retryable).toBe(true)
  })
  it('refuses a transaction that failed: it is not a flow that happened', async () => {
    await expect(recordHash(server('FAILED', good), 'testnet', goodHash)).rejects.toThrow(
      /failed on chain/
    )
  })
})
