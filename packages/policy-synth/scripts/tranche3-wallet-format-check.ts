// Tranche #3: is the `add_context_rule` envelope wallet-agnostic in fact?
//
// The award asks us to confirm the transaction format is compatible with a
// smart-account-supporting wallet beyond Freighter. Talking to the C-Address
// cohort is outreach and cannot be scripted. The TECHNICAL half can be:
// decode the envelope `install_policy` actually produces and check it contains
// nothing that only one wallet could handle.
//
// A wallet can sign what we hand it if, and only if, the envelope is:
//   - a standard Soroban `InvokeHostFunction` operation,
//   - carrying standard `SorobanAuthorizationEntry` auth,
//   - with the resource footprint already attached (so the wallet need not
//     simulate),
//   - and no custom, vendor or extension field anywhere.
//
// Anything Freighter-specific would show up here as an unexpected operation
// type, a missing footprint, or an auth credential the SDK cannot classify.
//
// Read-only apart from deploying one throwaway account to install against.

import {
  Address,
  Keypair,
  Networks,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { delegatedSigner } from '../src/install/oz-auth.ts'
import { encodePredicate } from '../src/predicate/encode.ts'
import { runInstallPolicy } from '../src/run/index.ts'
import { PINNED_INTERPRETER_ADDRESS_BY_NETWORK, RPC_URL_BY_NETWORK } from '../src/run/schemas.ts'
import type { PredicateNode } from '../src/types.ts'

const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const PASSPHRASE = Networks.TESTNET
const server = new rpc.Server(RPC_URL_BY_NETWORK.testnet, { allowHttp: false })
let failures = 0

function log(status: 'PASS' | 'FAIL' | 'INFO' | 'STEP', message: string): void {
  process.stdout.write(`${status.padEnd(5)} ${message}\n`)
}

function check(label: string, ok: boolean, detail: string): void {
  log(ok ? 'PASS' : 'FAIL', `${label}: ${detail}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  const admin = Keypair.random()
  const agent = Keypair.random()
  const res = await fetch(`https://friendbot.stellar.org/?addr=${admin.publicKey()}`)
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status}`)

  const deployTx = new TransactionBuilder(await server.getAccount(admin.publicKey()), {
    fee: '2000000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(admin.publicKey()),
        wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
        constructorArgs: [
          xdr.ScVal.scvVec([delegatedSigner(admin.publicKey())]),
          xdr.ScVal.scvMap([]),
        ],
      })
    )
    .setTimeout(120)
    .build()
  const prep = await server.prepareTransaction(deployTx)
  prep.sign(admin)
  const sent = await server.sendTransaction(prep as Transaction)
  let smartAccount = ''
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') {
      smartAccount = Address.fromScAddress(got.returnValue?.address() as xdr.ScAddress).toString()
      break
    }
    if (got.status === 'FAILED') throw new Error('deploy failed')
  }
  if (!smartAccount) throw new Error('deploy did not confirm')
  log('INFO', `smart account ${smartAccount}`)

  const predicate: PredicateNode = {
    op: 'eq',
    left: { kind: 'call_fn' },
    right: { kind: 'literal_symbol', value: 'transfer' },
  }
  const install = await runInstallPolicy({
    network: 'testnet',
    smartAccount,
    sourceAccount: admin.publicKey(),
    rule: {
      contextRuleType: { kind: 'default' },
      name: 'format-check',
      validUntilLedger: null,
      signers: [{ kind: 'delegated', address: agent.publicKey() }],
      policies: [
        {
          kind: 'interpreter',
          interpreterAddress: PINNED_INTERPRETER_ADDRESS_BY_NETWORK.testnet,
          predicateBlobBase64: encodePredicate(predicate).encodedPredicate,
        },
      ],
    },
    installNonce: 1,
  })
  if (!install.ok) {
    log('FAIL', `install_policy: ${install.error.code} ${install.error.message}`)
    process.exit(1)
  }

  log('STEP', '--- decoding the envelope a wallet would receive ---')
  // Parsed with the stock SDK from the base64 alone, which is all a wallet has.
  const tx = TransactionBuilder.fromXDR(install.data.unsignedXdr, PASSPHRASE) as Transaction
  const envelope = tx.toEnvelope()

  check(
    'envelope type',
    envelope.switch().name === 'envelopeTypeTx',
    `${envelope.switch().name} (standard v1 transaction, not a fee-bump or legacy envelope)`
  )
  check('operations', tx.operations.length === 1, `${tx.operations.length}`)
  const op = tx.operations[0]
  check(
    'operation type',
    op?.type === 'invokeHostFunction',
    `${op?.type} (the standard Soroban operation every wallet already handles)`
  )

  const v1 = envelope.v1()
  const hostFn = v1.tx().operations()[0]?.body().invokeHostFunctionOp()
  check(
    'host function type',
    hostFn?.hostFunction().switch().name === 'hostFunctionTypeInvokeContract',
    `${hostFn?.hostFunction().switch().name}`
  )
  const invoked = hostFn?.hostFunction().invokeContract()
  check(
    'function invoked',
    invoked?.functionName().toString() === 'add_context_rule',
    `${invoked?.functionName().toString()}`
  )

  const auth = hostFn?.auth() ?? []
  check('auth entries', auth.length >= 1, `${auth.length}`)
  const credTypes = auth.map((a) => a.credentials().switch().name)
  check(
    'auth credential types are standard',
    credTypes.every(
      (c) => c === 'sorobanCredentialsAddress' || c === 'sorobanCredentialsSourceAccount'
    ),
    credTypes.join(', ')
  )

  // The footprint being present is what lets a wallet sign without simulating.
  const sorobanData = v1.tx().ext().sorobanData()
  const ro = sorobanData?.resources().footprint().readOnly().length ?? 0
  const rw = sorobanData?.resources().footprint().readWrite().length ?? 0
  check(
    'resource footprint attached',
    ro + rw > 0,
    `${ro} read-only, ${rw} read-write entries - the wallet does not need to simulate`
  )
  check(
    'resource fee set',
    (sorobanData?.resourceFee().toString() ?? '0') !== '0',
    `${sorobanData?.resourceFee().toString()} stroops`
  )

  check('signatures present', v1.signatures().length === 0, `${v1.signatures().length} (unsigned)`)

  // Round-trip the XDR: what a wallet re-serialises must equal what we sent.
  const reencoded = tx.toXDR()
  check(
    'XDR round-trips byte-identically',
    reencoded === install.data.unsignedXdr,
    reencoded === install.data.unsignedXdr ? 'yes' : 'NO - re-serialising changed the bytes'
  )

  log('STEP', '--- what this does and does not establish ---')
  log('INFO', 'Establishes: the envelope is a stock Soroban InvokeHostFunction with standard auth')
  log('INFO', 'and a complete footprint, so any wallet able to sign Soroban can sign it.')
  log('INFO', 'Does NOT establish: that a specific second wallet has been tested. That needs')
  log('INFO', 'the C-Address cohort outreach, which is not a scriptable step.')

  log('STEP', failures === 0 ? '--- format is wallet-agnostic ---' : `--- ${failures} FAILED ---`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 400))
  process.exit(1)
})
