import { describe, expect, it } from 'bun:test'
import {
  Account,
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  decodeEnvelope,
  decodeEnvelopeXdr,
  decodeScAddressToAnyStrkey,
  i128PartsToBigInt,
  scValToSubset,
  u128PartsToBigInt,
} from './decode.ts'

/** Build a SEP-41 transfer invoke-host-function transaction with a synthetic
 *  source/contract/from/to. Returns the envelope XDR (base64) + the SDK-built
 *  envelope (so tests can compare decoded fields without round-tripping). */
function buildTransferTx(
  opts: {
    sourceSecret?: string
    contractId?: string
    from?: string
    to?: string
    amount?: bigint
  } = {}
) {
  const sourceKp = opts.sourceSecret ? Keypair.fromSecret(opts.sourceSecret) : Keypair.random()
  const acc = new Account(sourceKp.publicKey(), '0')
  const contractId = opts.contractId ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
  const fromKp = Keypair.random()
  const toKp = Keypair.random()
  const fromAddr = Address.fromString(opts.from ?? fromKp.publicKey())
  const toAddr = Address.fromString(opts.to ?? toKp.publicKey())
  const amount = opts.amount ?? 100n

  const op = Operation.invokeContractFunction({
    contract: contractId,
    function: 'transfer',
    args: [
      nativeToScVal(fromAddr),
      nativeToScVal(toAddr),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString('0'),
          lo: xdr.Uint64.fromString(amount.toString()),
        })
      ),
    ],
    auth: [],
  })
  const tx = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  const env = tx.toEnvelope()
  return {
    tx,
    env,
    envXdr: env.toXDR().toString('base64'),
    source: sourceKp.publicKey(),
    contractId,
    fromAddr,
    toAddr,
  }
}

describe('decodeEnvelope / decodeEnvelopeXdr', () => {
  it('decodes a SEP-41 transfer invoke-host-function envelope', () => {
    const { env, source, contractId, fromAddr, toAddr } = buildTransferTx()
    const decoded = decodeEnvelope(env)
    expect(decoded.sourceAccount).toBe(source)
    expect(decoded.invocations.length).toBe(1)
    const inv = decoded.invocations[0]
    expect(inv).toBeDefined()
    expect(inv?.contract).toBe(contractId)
    expect(inv?.fn).toBe('transfer')
    expect(inv?.args[0]).toEqual({ type: 'address', value: fromAddr.toString() })
    expect(inv?.args[1]).toEqual({ type: 'address', value: toAddr.toString() })
    expect(inv?.args[2]).toEqual({ type: 'i128', value: '100' })
    expect(decoded.opaqueScVals.length).toBe(0)
  })

  it('round-trips a synthetic envelope via base64 XDR', () => {
    const { envXdr, source, fromAddr } = buildTransferTx({ amount: 42n })
    const decoded = decodeEnvelopeXdr(envXdr)
    expect(decoded.sourceAccount).toBe(source)
    expect(decoded.invocations[0]?.args[0]).toEqual({
      type: 'address',
      value: fromAddr.toString(),
    })
    expect(decoded.invocations[0]?.args[2]).toEqual({ type: 'i128', value: '42' })
  })

  it('records unknown contracts (no-abi) for an unrecognised contract + fn', () => {
    // A SEP-41 transfer is now recognised by interface (any token address).
    // To exercise the v1 unknown path we build against a contract+fn pair
    // that is in neither the pinned set nor a known interface.
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    // Synthesise a valid, unpinned contract strkey from a fixed 32-byte hash.
    const contractId = Address.contract(Buffer.alloc(32, 0x99)).toString()
    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: 'completely_unknown_fn',
      args: [],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const decoded = decodeEnvelope(tx.toEnvelope(), [], [], 0, undefined, 'testnet')
    expect(decoded.unknownContracts.length).toBe(1)
    expect(decoded.unknownContracts[0]?.contract).toBe(contractId)
    expect(decoded.unknownContracts[0]?.reason).toBe('no-abi')
    expect(decoded.knownContracts.length).toBe(0)
  })

  it('recognises a SEP-41 transfer by interface (any token address) as known', () => {
    const { env, contractId } = buildTransferTx()
    const decoded = decodeEnvelope(env, [], [], 0, undefined, 'testnet')
    expect(decoded.knownContracts).toContain(contractId)
    expect(decoded.unknownContracts.length).toBe(0)
  })

  it('recognises a pinned mainnet Blend pool-factory address as known when network=mainnet', () => {
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const blendFactory = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
    const op = Operation.invokeContractFunction({
      contract: blendFactory,
      function: 'submit',
      args: [
        xdr.ScVal.scvAddress(Address.fromString(Keypair.random().publicKey()).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(Keypair.random().publicKey()).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(Keypair.random().publicKey()).toScAddress()),
        xdr.ScVal.scvVec([]),
      ],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const decoded = decodeEnvelope(tx.toEnvelope(), [], [], 0, undefined, 'mainnet')
    expect(decoded.knownContracts).toContain(blendFactory)
    expect(decoded.unknownContracts.length).toBe(0)
  })

  it('does NOT recognise a pinned mainnet address when network=testnet', () => {
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const blendFactory = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
    const op = Operation.invokeContractFunction({
      contract: blendFactory,
      function: 'submit',
      args: [],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const decoded = decodeEnvelope(tx.toEnvelope(), [], [], 0, undefined, 'testnet')
    // Blend pool factory is mainnet-pinned only; on testnet the same address
    // is not in the registry -> still unknown.
    expect(decoded.unknownContracts).toContainEqual({
      contract: blendFactory,
      reason: 'no-abi',
    })
  })

  it('marks known contracts when an ABI hint is supplied', () => {
    const { env, contractId } = buildTransferTx()
    const decoded = decodeEnvelope(env, [], [], 0, new Set([contractId]))
    expect(decoded.knownContracts).toContain(contractId)
    expect(decoded.unknownContracts.length).toBe(0)
  })

  it('extracts envelope-level signature hints as hex-prefixed signer placeholders', () => {
    const { env } = buildTransferTx()
    // Build an envelope WITH a signature attached.
    const tx = env.value().tx()
    const hint = Buffer.alloc(4, 0xab)
    const sig = Buffer.alloc(64, 0xcd)
    const decorated = new xdr.DecoratedSignature({ hint, signature: sig })
    env.value().signatures().push(decorated)
    const decoded = decodeEnvelope(env)
    const found = decoded.signers.find((s) => s === `hint:${hint.toString('hex')}`)
    expect(found).toBeDefined()
    void tx
  })

  it('captures sub-invocations from InvokerContractAuthEntry (diagnostic only)', () => {
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const subContractC = Address.contract(Buffer.alloc(32, 0x42)).toString()

    const grandchildContract = Address.contract(Buffer.alloc(32, 0x43)).toString()
    const grandchild = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(grandchildContract).toScAddress(),
          functionName: 'burn',
          args: [],
        })
      ),
      subInvocations: [],
    })
    const subInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: xdr.ScAddress.scAddressTypeContract(
            Buffer.from(
              Address.contract(Buffer.alloc(32, 0x42))
                .toScAddress()
                .contractId() as unknown as Uint8Array
            )
          ),
          functionName: 'mint',
          args: [xdr.ScVal.scvSymbol('to'), xdr.ScVal.scvSymbol('amount')],
        })
      ),
      subInvocations: [grandchild],
    })
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: subInvocation,
    })

    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: 'swap',
      args: [],
      auth: [authEntry],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const env = tx.toEnvelope()
    const decoded = decodeEnvelope(env)
    expect(decoded.invocations.length).toBe(1)
    const sub = decoded.invocations[0]?.subInvocations
    expect(sub?.length).toBe(1)
    expect(sub?.[0]?.contract).toBe(subContractC)
    expect(sub?.[0]?.fn).toBe('mint')
    expect(sub?.[0]?.subInvocations[0]?.contract).toBe(grandchildContract)
    expect(sub?.[0]?.subInvocations[0]?.fn).toBe('burn')
    expect(decoded.authEntries).toEqual([
      { authorizingAddress: null, contract: subContractC, fn: 'mint' },
    ])
  })

  it('caps deeply nested auth trees and records truncation as opaque', () => {
    const acc = new Account(Keypair.random().publicKey(), '0')
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    let nested: xdr.SorobanAuthorizedInvocation | undefined
    for (let depth = 17; depth >= 0; depth -= 1) {
      nested = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: `level_${depth}`,
            args: [],
          })
        ),
        subInvocations: nested ? [nested] : [],
      })
    }
    if (!nested) throw new Error('failed to build auth tree')
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: nested,
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: 'root',
          args: [],
          auth: [authEntry],
        })
      )
      .setTimeout(30)
      .build()

    const decoded = decodeEnvelope(tx.toEnvelope())
    expect(decoded.opaqueScVals).toContainEqual({
      path: expect.stringContaining('subInvocations'),
      type: 'auth-tree-depth-exceeded',
    })
  })

  it('decodes a fee-bump envelope via its inner v1 transaction', () => {
    const feeSourceKp = Keypair.random()
    const inner = buildTransferTx({ amount: 7n })
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSourceKp,
      '200',
      inner.tx,
      Networks.TESTNET
    )
    const feeBumpEnv = feeBump.toEnvelope()
    expect(feeBumpEnv.switch().name).toBe('envelopeTypeTxFeeBump')

    const decodedWrapped = decodeEnvelope(feeBumpEnv)
    const decodedInner = decodeEnvelope(inner.env)

    // sourceAccount + invocations come from the INNER v1 tx, not the
    // fee-bump fee source.
    expect(decodedWrapped.sourceAccount).toBe(inner.source)
    expect(decodedWrapped.sourceAccount).toBe(decodedInner.sourceAccount)
    expect(decodedWrapped.sourceAccount).not.toBe(feeSourceKp.publicKey())
    expect(decodedWrapped.invocations).toEqual(decodedInner.invocations)
    // Fee-bump signers = inner tx signers (envelope-level hint bytes are
    // synthesised from the inner envelope).
    expect([...decodedWrapped.signers].sort()).toEqual([...decodedInner.signers].sort())
  })

  it('decodes a soroban-auth address credential as a strkey signer', () => {
    const signerKp = Keypair.random()
    const signerStrkey = signerKp.publicKey()
    const signerAddr = Address.fromString(signerStrkey)
    const acc = new Account(Keypair.random().publicKey(), '0')
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: signerAddr.toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: xdr.ScAddress.scAddressTypeContract(
              Buffer.from(
                Address.fromString(contractId).toScAddress().contractId() as unknown as Uint8Array
              )
            ),
            functionName: 'noop',
            args: [],
          })
        ),
        subInvocations: [],
      }),
    })
    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: 'transfer',
      args: [],
      auth: [authEntry],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const decoded = decodeEnvelope(tx.toEnvelope())
    expect(decoded.signers).toContain(signerStrkey)
    expect(decoded.authEntries).toEqual([
      { authorizingAddress: signerStrkey, contract: contractId, fn: 'noop' },
    ])
  })
})

describe('scValToSubset', () => {
  it('records opaque ScVals into the diagnostic list', () => {
    const opaque: Array<{ path: string; type: string }> = []
    const val = xdr.ScVal.scvString('opaque-string-value')
    const mapped = scValToSubset(val, 'p', opaque)
    expect(mapped).toEqual({ type: 'other', value: 'scvString' })
    expect(opaque).toEqual([{ path: 'p', type: 'scvString' }])
  })

  it('maps scvVec children recursively', () => {
    const opaque: Array<{ path: string; type: string }> = []
    const val = xdr.ScVal.scvVec([xdr.ScVal.scvU32(7), xdr.ScVal.scvString('hello')])
    const mapped = scValToSubset(val, 'root', opaque)
    expect(mapped).toEqual({
      type: 'vec',
      value: [
        { type: 'u32', value: '7' },
        { type: 'other', value: 'scvString' },
      ],
    })
    // Only the unrecognised scvString child is opaque; u32 is now a first-class
    // subset member.
    expect(opaque.length).toBe(1)
  })

  it('caps ScVal recursion depth and records the over-depth branch as opaque', () => {
    // Build a vec nested deeper than MAX_SCVAL_DEPTH. Without the cap this
    // would RangeError the JS stack (the SDK's XDR writer tolerates a few
    // hundred levels; the decoder's chained call to `scValToSubset` is the
    // exact path that must be hardened). With the cap, the over-depth branch
    // is surfaced as `{type:'other', value:'depth-exceeded'}` and recorded in
    // opaqueScVals so the recorder's parseConfidence gate fires fail-closed.
    const opaque: Array<{ path: string; type: string }> = []
    let current: xdr.ScVal = xdr.ScVal.scvU32(0)
    for (let i = 0; i < 200; i++) {
      current = xdr.ScVal.scvVec([current])
    }
    const mapped = scValToSubset(current, 'root', opaque)
    // The top-level vec is shaped correctly (cloned as a `vec` shell).
    expect(mapped.type).toBe('vec')
    if (mapped.type !== 'vec') return
    // Walk down the vec chain until we hit the opaque 'depth-exceeded' terminal.
    let node: { type: string; value: unknown } = mapped
    let depth = 0
    while (node.type === 'vec' && Array.isArray(node.value)) {
      const next = (node.value as Array<{ type: string; value: unknown }>)[0]
      if (!next) break
      node = next
      depth += 1
      if (node.type === 'other') break
    }
    expect(node.type).toBe('other')
    // depth should be capped at MAX_SCVAL_DEPTH (the over-depth branch is
    // collapsed to a single opaque, not a chain of nested vecs).
    expect(depth).toBeLessThan(200)
    // Opaque diagnostic was recorded.
    expect(opaque.some((o) => o.type === 'depth-exceeded')).toBe(true)
  })
})

describe('decodeEnvelope - deeply nested vec arg', () => {
  it('does not throw on a vec arg deeper than MAX_SCVAL_DEPTH and surfaces the over-depth as opaque', () => {
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    let deep: xdr.ScVal = xdr.ScVal.scvU32(0)
    for (let i = 0; i < 200; i++) deep = xdr.ScVal.scvVec([deep])
    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: 'explode',
      args: [deep],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    // Must NOT throw - the recorder collapses over-depth branches to opaque.
    const decoded = decodeEnvelope(tx.toEnvelope())
    expect(decoded.invocations.length).toBe(1)
    expect(decoded.opaqueScVals.some((o) => o.type === 'depth-exceeded')).toBe(true)
  })
})

describe('i128PartsToBigInt / u128PartsToBigInt', () => {
  it('handles a positive small value', () => {
    const val = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString('0'),
        lo: xdr.Uint64.fromString('100'),
      })
    )
    expect(i128PartsToBigInt(val.i128())).toBe(100n)
  })

  it('handles a negative value that crosses the 64-bit boundary', () => {
    const val = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString('-1'),
        lo: xdr.Uint64.fromString('18446744073709551615'),
      })
    )
    expect(i128PartsToBigInt(val.i128())).toBe(-1n)
  })

  it('handles a large positive value that exceeds 2^63', () => {
    const val = xdr.ScVal.scvU128(
      new xdr.UInt128Parts({
        hi: xdr.Uint64.fromString('1'),
        lo: xdr.Uint64.fromString('0'),
      })
    )
    expect(u128PartsToBigInt(val.u128())).toBe(2n ** 64n)
  })
})

describe('decodeScAddressToAnyStrkey', () => {
  it('decodes a contract address to a C... strkey', () => {
    const c = Address.contract(Buffer.alloc(32, 0x42))
    const got = decodeScAddressToAnyStrkey(c.toScAddress())
    expect(got?.startsWith('C')).toBe(true)
  })
  it('decodes an account address to a G... strkey', () => {
    const kp = Keypair.random()
    const a = Address.fromString(kp.publicKey())
    const got = decodeScAddressToAnyStrkey(a.toScAddress())
    expect(got).toBe(kp.publicKey())
  })
})
