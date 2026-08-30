// Tranche #3 evidence for the MCP tool surface.
//
// Three things the award asks to be shown functional:
//
//   1. `install_policy` produces an UnsignedInstallTx. The Freighter hand-off IS
//      this: base64 transaction XDR is returned and no key is ever held or
//      requested. The wallet reviews, signs and submits. Nothing here is
//      specific to Freighter, which is what "wallet-agnostic at the MCP layer"
//      means - any wallet that can sign a Soroban envelope can complete it.
//   2. `verify_policy` runs the permit case AND the generated deny battery, and
//      reports `ok` only when the recorded call is permitted and every deny case
//      is denied.
//   3. Walkthrough 3's permit and deny. The slippage floor bounds one argument
//      against another, so it needs a swap-shaped call; no SoroSwap testnet
//      router address is published, so the verdicts come from here rather than
//      from an invented on-chain address.
//
// Driven from the repo's own reference recordings, the same join an MCP client
// makes: synthesize with `explain`, feed the returned predicate tree back in.
//
// Nothing is signed and nothing is submitted by the tools under test.
// `install_policy` simulates in order to build the envelope and returns it
// unsigned. One throwaway smart account IS deployed first, because the tool
// simulates `add_context_rule` against a real account and needs a real admin to
// simulate as - handing it an account it does not administer fails auth, which
// would prove nothing about the tool.

import { readFileSync } from 'node:fs'
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
import {
  runInstallPolicy,
  runSimulatePolicy,
  runSynthesizePolicy,
  runVerifyPolicy,
} from '../src/run/index.ts'
import { PINNED_INTERPRETER_ADDRESS_BY_NETWORK, RPC_URL_BY_NETWORK } from '../src/run/schemas.ts'
import type { PredicateNode, RecordedTransaction } from '../src/types.ts'

function log(status: 'PASS' | 'FAIL' | 'INFO' | 'STEP', message: string): void {
  process.stdout.write(`${status.padEnd(5)} ${message}\n`)
}

const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0x01)).toString()
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const server = new rpc.Server(RPC_URL_BY_NETWORK.testnet, { allowHttp: false })
let failures = 0

/** Deploy a throwaway OZ smart account so `install_policy` has an account it
 *  can legitimately simulate an admin install against. */
async function deployThrowawayAccount(admin: Keypair): Promise<string> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${admin.publicKey()}`)
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status}`)
  const tx = new TransactionBuilder(await server.getAccount(admin.publicKey()), {
    fee: '2000000',
    networkPassphrase: Networks.TESTNET,
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
  const prepared = await server.prepareTransaction(tx)
  prepared.sign(admin)
  const sent = await server.sendTransaction(prepared as Transaction)
  if (sent.status === 'ERROR') throw new Error('deploy send failed')
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') {
      return Address.fromScAddress(got.returnValue?.address() as xdr.ScAddress).toString()
    }
    if (got.status === 'FAILED') throw new Error('deploy failed')
  }
  throw new Error('deploy did not confirm')
}

function recording(name: string): RecordedTransaction {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/recordings/${name}.json`, import.meta.url), 'utf8')
  )
  return (raw.data ?? raw) as RecordedTransaction
}

async function synthesise(
  name: string
): Promise<{ tx: RecordedTransaction; predicate: PredicateNode }> {
  const tx = recording(name)
  const res = await runSynthesizePolicy({
    source: 'recording',
    network: 'mainnet',
    recordedTx: tx,
    explain: true,
    userResponses: { validUntilLedger: 200_000_000 },
    interpreter: { smartAccountAddress: SMART_ACCOUNT, installNonce: 1 },
  })
  if (!res.ok) throw new Error(`synthesis failed: ${res.error.code} ${res.error.message}`)
  const predicate = res.explain?.predicateTree
  if (!predicate) throw new Error('synthesis returned no predicate tree')
  return { tx, predicate }
}

async function main(): Promise<void> {
  // ---- 1. install_policy: the unsigned transaction handed to the wallet ----
  log('STEP', '--- install_policy: the UnsignedInstallTx handed to Freighter ---')
  const { predicate: sep41Predicate } = await synthesise('demo-rec-sep41')
  const admin = Keypair.random()
  const agent = Keypair.random()
  const account = await deployThrowawayAccount(admin)
  log('INFO', `throwaway account ${account}, admin ${admin.publicKey()}`)
  const install = await runInstallPolicy({
    network: 'testnet',
    smartAccount: account,
    sourceAccount: admin.publicKey(),
    rule: {
      contextRuleType: { kind: 'default' },
      name: 'freighter-handoff',
      validUntilLedger: null,
      signers: [{ kind: 'delegated', address: agent.publicKey() }],
      policies: [
        {
          kind: 'interpreter',
          interpreterAddress: PINNED_INTERPRETER_ADDRESS_BY_NETWORK.testnet,
          predicateBlobBase64: encodePredicate(sep41Predicate).encodedPredicate,
        },
      ],
    },
    installNonce: 1,
  })
  if (install.ok) {
    const d = install.data
    log('PASS', `unsignedXdr returned, ${d.unsignedXdr.length} base64 chars`)
    log('INFO', `  starts       ${d.unsignedXdr.slice(0, 44)}...`)
    log('INFO', `  smartAccount ${d.smartAccount}`)
    log('INFO', `  sourceAccount (must sign) ${d.sourceAccount}`)
    log('INFO', '  the tool holds no key and submits nothing; the wallet does both')
  } else {
    log('FAIL', `install_policy: ${install.error.code} ${install.error.message}`)
    failures++
  }

  // ---- 2. verify_policy across all three reference recordings ----
  log('STEP', '--- verify_policy: permit case plus the generated deny battery ---')
  for (const name of ['demo-rec-sep41', 'demo-rec-blend', 'demo-rec-soroswap']) {
    const { tx, predicate } = await synthesise(name)
    const res = runVerifyPolicy({ predicate, permitTx: tx })
    if (!res.ok) {
      log('FAIL', `${name}: ${res.error.code} ${res.error.message}`)
      failures++
      continue
    }
    const d = res.data
    const denied = d.denies.filter((c) => c.denied).length
    log(
      d.ok ? 'PASS' : 'FAIL',
      `${name}: ok=${d.ok} permitted=${d.permit.permitted} denies=${denied}/${d.denies.length} dimensionsCovered=${d.dimensionsCovered}`
    )
    log('INFO', `  dimensions: ${d.denies.map((c) => c.dimension).join(', ')}`)
    if (!d.ok || denied !== d.denies.length) failures++
  }

  // ---- 3. Walkthrough 3: the slippage floor, permit and deny ----
  log('STEP', '--- Walkthrough 3: slippage floor, out >= in * 99/100 ---')
  const swapTx = recording('demo-rec-soroswap')
  const inv = swapTx.invocations[0]
  if (!inv) throw new Error('soroswap recording carries no invocation')
  log('INFO', `recorded call: ${inv.fn} on ${inv.contract}`)
  log('INFO', `recorded args: ${JSON.stringify(inv.args).slice(0, 160)}`)

  const slippage: PredicateNode = {
    op: 'and',
    children: [
      { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: inv.fn } },
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: inv.contract },
      },
      {
        op: 'gte',
        left: { kind: 'call_arg', index: 1 },
        right: { kind: 'call_arg_scaled', index: 0, num: '99', den: '100' },
      },
    ],
  }

  const withArgs = (amountIn: string, amountOut: string): RecordedTransaction => ({
    ...swapTx,
    invocations: [
      {
        ...inv,
        args: [
          { type: 'i128', value: amountIn },
          { type: 'i128', value: amountOut },
          ...(inv.args?.slice(2) ?? []),
        ],
      },
      ...swapTx.invocations.slice(1),
    ],
  })

  const verdict = (amountIn: string, amountOut: string): string => {
    const r = runSimulatePolicy({ predicate: slippage, permitTx: withArgs(amountIn, amountOut) })
    if (!r.ok) return `ERROR ${r.error.code}`
    const d = r.data
    return d.permitted ? 'PERMIT' : `DENY ${d.reason ?? ''}`.trim()
  }

  const cases: Array<[string, string, string, 'PERMIT' | 'DENY']> = [
    ['1000000000', '995000000', '99.5% of input', 'PERMIT'],
    ['1000000000', '990000000', '99.0%, exactly at the floor', 'PERMIT'],
    ['1000000000', '989999999', 'one stroop under the floor', 'DENY'],
    ['1000000000', '900000000', '90% of input', 'DENY'],
  ]
  for (const [amountIn, amountOut, label, expected] of cases) {
    const got = verdict(amountIn, amountOut)
    const ok = expected === 'PERMIT' ? got === 'PERMIT' : got.startsWith('DENY')
    log(ok ? 'PASS' : 'FAIL', `out ${amountOut} (${label}) -> ${got}`)
    if (!ok) failures++
  }

  log('STEP', failures === 0 ? '--- all checks passed ---' : `--- ${failures} FAILED ---`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 500))
  process.exit(1)
})
