// Tranche #3: the wallet hand-off, end to end on testnet.
//
// The award asks for an install flow where `install_policy` produces an
// UnsignedInstallTx and the unsigned transaction is handed to Freighter for
// user review, signing and submission - wallet-agnostic at the MCP layer.
//
// Showing that the tool returns a base64 string proves very little. This script
// completes the round trip, doing exactly what a wallet does and nothing more:
//
//   1. `install_policy` returns `unsignedXdr`. No key is held or requested.
//   2. The envelope is parsed FROM THAT STRING ALONE, as a wallet would.
//   3. It is signed with the user's key and submitted.
//   4. The rule is read back off chain to confirm it is really there.
//   5. `revoke_policy` produces a second unsigned envelope; same round trip.
//   6. The rule is read back again to confirm it is gone.
//
// Step 2 is the load-bearing one. The signer is handed the XDR string and
// nothing else - no builder object, no in-memory transaction - so if the
// envelope were incomplete or malformed, signing or submission would fail here
// rather than in some later integration.
//
// This substitutes a keypair for the browser extension. What that does NOT
// evidence is the human clicking approve in Freighter's UI; it evidences that
// what we hand a wallet is a complete, signable, submittable Soroban envelope.
//
// Usage:
//   bun packages/policy-synth/scripts/tranche3-wallet-roundtrip.ts

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
import { runInstallPolicy, runRevokePolicy } from '../src/run/index.ts'
import { PINNED_INTERPRETER_ADDRESS_BY_NETWORK, RPC_URL_BY_NETWORK } from '../src/run/schemas.ts'
import type { PredicateNode } from '../src/types.ts'

const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const PASSPHRASE = Networks.TESTNET
const server = new rpc.Server(RPC_URL_BY_NETWORK.testnet, { allowHttp: false })
let failures = 0

function log(status: 'PASS' | 'FAIL' | 'INFO' | 'STEP' | 'RECEIPT', message: string): void {
  process.stdout.write(`${status.padEnd(7)} ${message}\n`)
}

async function friendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`)
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status}`)
}

async function submit(tx: Transaction): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    const code = sent.errorResult?.result().switch().name ?? 'unknown'
    throw new Error(`send failed: ${code}`)
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') throw new Error(`tx ${sent.hash} FAILED`)
  }
  throw new Error('did not confirm')
}

/** What a wallet does with the string the tool returned: parse, sign, submit.
 *  It is given the XDR and the network passphrase - nothing else. */
async function walletSignsAndSubmits(
  unsignedXdr: string,
  signer: Keypair
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, PASSPHRASE) as Transaction
  log('INFO', `  wallet parsed the envelope: source ${tx.source}, ${tx.operations.length} op`)
  tx.sign(signer)
  return submit(tx)
}

/** Read the rule back off chain. The install is only real if the account says
 *  so, independently of the transaction we just submitted. */
async function readRuleCount(smartAccount: string, admin: Keypair): Promise<number> {
  const tx = new TransactionBuilder(await server.getAccount(admin.publicKey()), {
    fee: '2000000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: smartAccount,
        function: 'get_context_rules_count',
        args: [],
      })
    )
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`rule count sim failed: ${sim.error}`)
  const v = sim.result?.retval
  if (!v) throw new Error('no return value from get_context_rules_count')
  return Number(v.u32())
}

async function main(): Promise<void> {
  const admin = Keypair.random()
  const agent = Keypair.random()
  await friendbot(admin.publicKey())
  log('INFO', 'The keypair below stands in for the wallet. The tools never see it.')
  log('INFO', `user wallet ${admin.publicKey()}`)

  // Deploy an account for the flow.
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
  const preparedDeploy = await server.prepareTransaction(deployTx)
  preparedDeploy.sign(admin)
  const deployed = await submit(preparedDeploy as Transaction)
  const smartAccount = Address.fromScAddress(
    deployed.returnValue?.address() as xdr.ScAddress
  ).toString()
  log('PASS', `smart account ${smartAccount}`)

  const before = await readRuleCount(smartAccount, admin)
  log('INFO', `rules on the account before install: ${before}`)

  // ---- 1. install_policy returns an unsigned envelope ----
  log('STEP', '--- install_policy -> unsigned envelope ---')
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
      name: 'wallet-roundtrip',
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
  log('PASS', `unsignedXdr returned, ${install.data.unsignedXdr.length} base64 chars`)

  // ---- 2 and 3. The wallet signs the string and submits it ----
  log('STEP', '--- the wallet signs that string and submits ---')
  const installed = await walletSignsAndSubmits(install.data.unsignedXdr, admin)
  log('RECEIPT', `add_context_rule ${installed.txHash}`)

  // ---- 4. Read it back ----
  const after = await readRuleCount(smartAccount, admin)
  log(
    after === before + 1 ? 'PASS' : 'FAIL',
    `rules on the account after install: ${after} (expected ${before + 1})`
  )
  if (after !== before + 1) failures++

  // ---- 5 and 6. revoke_policy, same round trip ----
  log('STEP', '--- revoke_policy -> unsigned envelope -> wallet -> chain ---')
  const revoke = await runRevokePolicy({
    network: 'testnet',
    smartAccount,
    sourceAccount: admin.publicKey(),
    // Fresh account: rule 0 is the admin rule the constructor created, so the
    // rule just installed is id 1. Ids are never reused, but nothing has been
    // removed from this account, so the id and the count agree here.
    ruleId: after - 1,
  })
  if (!revoke.ok) {
    log('FAIL', `revoke_policy: ${revoke.error.code} ${revoke.error.message}`)
    failures++
  } else {
    log('PASS', `unsignedXdr returned, ${revoke.data.unsignedXdr.length} base64 chars`)
    const revoked = await walletSignsAndSubmits(revoke.data.unsignedXdr, admin)
    log('RECEIPT', `revoke ${revoked.txHash}`)
    const final = await readRuleCount(smartAccount, admin)
    log(
      final === before ? 'PASS' : 'FAIL',
      `rules on the account after revoke: ${final} (expected ${before})`
    )
    if (final !== before) failures++
  }

  log('STEP', '--- summary ---')
  log('INFO', `smart account   ${smartAccount}`)
  log('INFO', `install receipt ${installed.txHash}`)
  log('STEP', failures === 0 ? '--- round trip complete ---' : `--- ${failures} FAILED ---`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 400))
  process.exit(1)
})
