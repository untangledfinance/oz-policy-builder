// Tranche #3 walkthrough runner - produces the on-chain evidence the award asks
// for: a testnet `add_context_rule` receipt and a deny-case run output for each
// of the three documented walkthroughs.
//
//   1. Blend yield-claim delegation      spending_limit(15.3 XLM,  86400s)
//   2. SEP-41 subscription billing       spending_limit(100 USDC, 2592000s)
//   3. Bounded SoroSwap delegation       generated slippage-cap policy (Path B)
//
// PERIODS ARE LEDGERS, NOT SECONDS. OpenZeppelin's `spending_limit` carries
// `{ period_ledgers, spending_limit }`. Stellar closes a ledger in about five
// seconds, so the award's seconds are converted and the conversion is printed
// with every run: 86400s -> 17280 ledgers, 2592000s -> 518400 ledgers. The
// chain enforces the ledger count; the seconds are an approximation of it and
// are reported as one.
//
// WHAT `spending_limit` METERS. It reads the amount from `args[2]` of a call
// named exactly `transfer` (policies/spending_limit.rs at OZ tag v0.7.2) and
// refuses any context rule type other than `CallContract`. So walkthroughs 1
// and 2 are pinned to the token contract whose transfers the cap meters. That
// is a property of the OZ primitive, not a simplification made for the demo.
//
// WALKTHROUGH 3 IS DIFFERENT, deliberately. A slippage floor bounds one
// argument of a call against another, which needs a target contract carrying a
// swap-shaped signature. No SoroSwap testnet router address is published, and
// this repo pins none, so the walkthrough installs the real rule on chain -
// producing a real receipt - and takes its deny from the deny-case harness
// rather than inventing an address. The report says so rather than implying an
// on-chain swap happened.
//
// Usage:
//   bun packages/policy-synth/scripts/tranche3-walkthroughs.ts --network testnet

import { createHash } from 'node:crypto'
import {
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  accountEntry,
  authDigest,
  authPayload,
  delegatedSigner,
  delegatedSignerEntry,
  signaturePayload,
} from '../src/install/oz-auth.ts'
import { encodePredicate } from '../src/predicate/encode.ts'
import {
  PINNED_INTERPRETER_ADDRESS_BY_NETWORK,
  PINNED_INTERPRETER_GRAMMAR_VERSION,
  PINNED_OZ_POLICY_ADDRESS_BY_NETWORK,
  RPC_URL_BY_NETWORK,
} from '../src/run/schemas.ts'
import type { PredicateNode } from '../src/types.ts'

const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const FEE = '2000000'
const TIMEOUT = 120
const PASSPHRASE = Networks.TESTNET
const RPC_URL = RPC_URL_BY_NETWORK.testnet
const INTERPRETER = PINNED_INTERPRETER_ADDRESS_BY_NETWORK.testnet
const SPENDING_LIMIT = PINNED_OZ_POLICY_ADDRESS_BY_NETWORK.testnet.spending_limit
/** `SpendingLimitError::SpendingLimitExceeded`. */
const SPENDING_LIMIT_EXCEEDED = 3221
/** Stellar closes a ledger in about five seconds. */
const SECONDS_PER_LEDGER = 5

const server = new rpc.Server(RPC_URL, { allowHttp: false })
const receipts: Array<Record<string, string>> = []

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
    throw new Error(`send failed: ${code} ${sent.errorResult?.toXDR('base64')}`)
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return got
    if (got.status === 'FAILED') {
      throw new Error(`tx ${sent.hash} FAILED: ${got.resultXdr?.toXDR('base64')}`)
    }
  }
  throw new Error(`tx ${sent.hash} did not confirm`)
}

async function withSeqRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (i >= 3 || !String(e).includes('txBadSeq')) throw e
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
}

function i128(v: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(v) }))
}

function interpreterParams(predicate: PredicateNode, nonce: number): xdr.ScVal {
  const { encodedPredicate, predicateHash } = encodePredicate(predicate)
  const bytes = Buffer.from(encodedPredicate, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== predicateHash) {
    throw new Error('predicate hash mismatch')
  }
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('grammar_version'),
      val: xdr.ScVal.scvU32(PINNED_INTERPRETER_GRAMMAR_VERSION),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('install_nonce'), val: xdr.ScVal.scvU32(nonce) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('predicate'), val: xdr.ScVal.scvBytes(bytes) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('predicate_hash'),
      val: xdr.ScVal.scvBytes(Buffer.from(predicateHash, 'hex')),
    }),
  ])
}

function spendingLimitParams(limit: bigint, periodLedgers: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('period_ledgers'),
      val: xdr.ScVal.scvU32(periodLedgers),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('spending_limit'), val: i128(limit) }),
  ])
}

/** `Map<Address, Val>` sorted by the key's XDR bytes, as the host requires.
 *
 *  Hand-built because `buildAddContextRuleArgs` once took interpreter policies
 *  only, and refused rather than silently dropping the rest - dropping them
 *  would have installed these rules without their spend caps. Since 1.1.0 the
 *  builder encodes `spending_limit` itself, so this map is no longer the only
 *  route. It is kept deliberately: these walkthroughs are EVIDENCE, and an
 *  independent encoding is what makes the recorded receipts a check on the
 *  builder rather than a restatement of it. */
function policiesMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const mapped = entries.map(
    ([addr, params]) => new xdr.ScMapEntry({ key: Address.fromString(addr).toScVal(), val: params })
  )
  mapped.sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()))
  return xdr.ScVal.scvMap(mapped)
}

async function invokeAsAccountOnce(opts: {
  kp: Keypair
  smartAccount: string
  contract?: string
  fnName: string
  args: xdr.ScVal[]
  contextRuleIds: number[]
}): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { kp, smartAccount, fnName, args, contextRuleIds } = opts
  const target = opts.contract ?? smartAccount
  const built = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(target).call(fnName, ...args))
    .setTimeout(TIMEOUT)
    .build()

  const sim = await server.simulateTransaction(built)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`)

  const latest = await server.getLatestLedger()
  const expLedger = latest.sequence + 100
  const own = (sim.result?.auth ?? []).find(
    (e) =>
      e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(e.credentials().address().address()).toString() === smartAccount
  )
  if (!own) throw new Error('no address-credential entry for the account')

  const digest = authDigest(
    signaturePayload(
      PASSPHRASE,
      own.credentials().address().nonce(),
      expLedger,
      own.rootInvocation()
    ),
    contextRuleIds
  )
  const entries = [
    accountEntry(
      own,
      expLedger,
      authPayload([kp.publicKey()], contextRuleIds, () => Buffer.alloc(0))
    ),
    delegatedSignerEntry(smartAccount, digest),
  ]

  const authed = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: target, function: fnName, args, auth: entries })
    )
    .setTimeout(TIMEOUT)
    .build()
  const sim2 = await server.simulateTransaction(authed)
  if (rpc.Api.isSimulationError(sim2)) throw new Error(`authorised sim failed: ${sim2.error}`)
  const prepared = rpc.assembleTransaction(authed, sim2).build()
  prepared.sign(kp)
  return submit(prepared)
}

const invokeAsAccount = (o: Parameters<typeof invokeAsAccountOnce>[0]) =>
  withSeqRetry(() => invokeAsAccountOnce(o))

/** Deploy a fresh OZ smart account with `admin` on rule 0 (unpoliced). */
async function deployAccount(admin: Keypair): Promise<string> {
  const deployed = await withSeqRetry(async () => {
    const tx = new TransactionBuilder(await server.getAccount(admin.publicKey()), {
      fee: FEE,
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
      .setTimeout(TIMEOUT)
      .build()
    const prepared = await server.prepareTransaction(tx)
    prepared.sign(admin)
    return submit(prepared)
  })
  return Address.fromScAddress(deployed.returnValue?.address() as xdr.ScAddress).toString()
}

const pinTransferOn = (token: string): PredicateNode => ({
  op: 'and',
  children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
    {
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: token },
    },
  ],
})

/** Walkthroughs 1 and 2 share a shape: a capped delegation over one token. */
async function cappedDelegation(opts: {
  n: number
  title: string
  token: string
  capRaw: bigint
  capLabel: string
  periodSeconds: number
  permitRaw: bigint
  permitLabel: string
  denyRaw: bigint
  denyLabel: string
  fundAccount: (smartAccount: string) => Promise<void>
  /** Where the delegated transfer sends to. A non-native SEP-41 asset needs the
   *  destination to hold a trustline, so walkthrough 2 supplies a merchant
   *  account that has one; the native SAC does not, so walkthrough 1 omits it
   *  and the admin receives. */
  destination?: string
}): Promise<void> {
  const periodLedgers = Math.round(opts.periodSeconds / SECONDS_PER_LEDGER)
  log('STEP', `--- Walkthrough ${opts.n}: ${opts.title} ---`)
  log(
    'INFO',
    `cap ${opts.capLabel} per ${opts.periodSeconds}s -> period_ledgers ${periodLedgers} (~${SECONDS_PER_LEDGER}s/ledger, approximate)`
  )
  log('INFO', `token ${opts.token}`)

  const admin = Keypair.random()
  const agent = Keypair.random()
  await friendbot(admin.publicKey())
  await friendbot(agent.publicKey())
  const smartAccount = await deployAccount(admin)
  log('PASS', `smart account ${smartAccount}`)
  await opts.fundAccount(smartAccount)
  log('PASS', 'account funded')

  const ruleArgs = [
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('CallContract'),
      Address.fromString(opts.token).toScVal(),
    ]),
    xdr.ScVal.scvString(`wt${opts.n}-capped`),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([delegatedSigner(agent.publicKey())]),
    policiesMap([
      [INTERPRETER, interpreterParams(pinTransferOn(opts.token), 1)],
      [SPENDING_LIMIT, spendingLimitParams(opts.capRaw, periodLedgers)],
    ]),
  ]
  const installed = await invokeAsAccount({
    kp: admin,
    smartAccount,
    fnName: 'add_context_rule',
    args: ruleArgs,
    contextRuleIds: [0],
  })
  const installHash = installed.txHash
  log('RECEIPT', `add_context_rule ${installHash}`)
  receipts.push({
    walkthrough: String(opts.n),
    title: opts.title,
    smartAccount,
    addContextRule: installHash,
    token: opts.token,
    cap: opts.capLabel,
    periodLedgers: String(periodLedgers),
  })

  const dest = Address.fromString(opts.destination ?? admin.publicKey()).toScVal()
  const transferArgs = (v: bigint) => [Address.fromString(smartAccount).toScVal(), dest, i128(v)]

  let permitHash = ''
  try {
    const r = await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: opts.token,
      fnName: 'transfer',
      args: transferArgs(opts.permitRaw),
      contextRuleIds: [1],
    })
    permitHash = r.txHash
    log('PASS', `PERMIT ${opts.permitLabel} under the cap -> ${permitHash}`)
  } catch (e) {
    log('FAIL', `permit rejected, walkthrough inconclusive: ${String(e).slice(0, 240)}`)
    process.exit(1)
  }

  try {
    await invokeAsAccount({
      kp: agent,
      smartAccount,
      contract: opts.token,
      fnName: 'transfer',
      args: transferArgs(opts.denyRaw),
      contextRuleIds: [1],
    })
    log('FAIL', `DENY CASE PERMITTED: ${opts.denyLabel} passed a ${opts.capLabel} cap`)
    process.exit(1)
  } catch (e) {
    const code = Number(String(e).match(/#(\d+)/)?.[1] ?? Number.NaN)
    if (code !== SPENDING_LIMIT_EXCEEDED) {
      log('FAIL', `denied by #${code || '(no code)'}, expected #${SPENDING_LIMIT_EXCEEDED}`)
      log('FAIL', String(e).slice(0, 240))
      process.exit(1)
    }
    log('PASS', `DENY ${opts.denyLabel} over the cap -> #${code} SpendingLimitExceeded`)
    const last = receipts[receipts.length - 1]
    if (last) {
      last.permit = permitHash
      last.denyCode = `#${code}`
      last.denyDescription = `${opts.denyLabel} over a ${opts.capLabel} cap`
    }
  }
}

async function main(): Promise<void> {
  log('INFO', 'Tranche #3 walkthroughs, Stellar testnet')
  log('INFO', `interpreter    ${INTERPRETER} (grammar ${PINNED_INTERPRETER_GRAMMAR_VERSION})`)
  log('INFO', `spending_limit ${SPENDING_LIMIT} (OZ v0.7.2, third-party, unaudited by us)`)
  log('INFO', '')

  const nativeSac = Asset.native().contractId(PASSPHRASE)

  // ---- 1. Blend yield-claim delegation: 15.3 XLM per 86400s ----
  await cappedDelegation({
    n: 1,
    title: 'Blend yield-claim delegation',
    token: nativeSac,
    capRaw: 153_000_000n,
    capLabel: '15.3 XLM',
    periodSeconds: 86400,
    permitRaw: 10_000_000n,
    permitLabel: '1 XLM',
    denyRaw: 200_000_000n,
    denyLabel: '20 XLM',
    fundAccount: async (smartAccount) => {
      const funder = Keypair.random()
      await friendbot(funder.publicKey())
      await withSeqRetry(async () => {
        const tx = new TransactionBuilder(await server.getAccount(funder.publicKey()), {
          fee: FEE,
          networkPassphrase: PASSPHRASE,
        })
          .addOperation(
            new Contract(nativeSac).call(
              'transfer',
              Address.fromString(funder.publicKey()).toScVal(),
              Address.fromString(smartAccount).toScVal(),
              i128(500_000_000n)
            )
          )
          .setTimeout(TIMEOUT)
          .build()
        const p = await server.prepareTransaction(tx)
        p.sign(funder)
        return submit(p)
      })
    },
  })
  log('INFO', '')

  // ---- 2. SEP-41 subscription billing: 100 USDC per 2592000s ----
  // A testnet asset with code USDC, issued by a key generated for this run.
  // It is NOT Circle USDC; it is a SEP-41 token that behaves like one, and the
  // report names the issuer so nobody mistakes it for the real asset.
  const issuer = Keypair.random()
  await friendbot(issuer.publicKey())
  const usdc = new Asset('USDC', issuer.publicKey())
  const usdcSac = usdc.contractId(PASSPHRASE)
  log('INFO', `testnet USDC issuer ${issuer.publicKey()} (NOT Circle USDC)`)
  await withSeqRetry(async () => {
    const tx = new TransactionBuilder(await server.getAccount(issuer.publicKey()), {
      fee: FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.createStellarAssetContract({ asset: usdc }))
      .setTimeout(TIMEOUT)
      .build()
    const p = await server.prepareTransaction(tx)
    p.sign(issuer)
    return submit(p)
  })
  log('PASS', `USDC SAC deployed ${usdcSac}`)

  // The merchant being paid. A non-native SEP-41 asset requires the receiving
  // classic account to hold a trustline, so establish one; without it the
  // transfer fails `#13` at the token, which would look like a policy refusal
  // and prove nothing about the cap.
  const merchant = Keypair.random()
  await friendbot(merchant.publicKey())
  await withSeqRetry(async () => {
    const tx = new TransactionBuilder(await server.getAccount(merchant.publicKey()), {
      fee: FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(TIMEOUT)
      .build()
    tx.sign(merchant)
    return submit(tx)
  })
  log('PASS', `merchant ${merchant.publicKey()} trustline established`)

  await cappedDelegation({
    n: 2,
    destination: merchant.publicKey(),
    title: 'SEP-41 subscription billing',
    token: usdcSac,
    capRaw: 1_000_000_000n,
    capLabel: '100 USDC',
    periodSeconds: 2592000,
    permitRaw: 100_000_000n,
    permitLabel: '10 USDC',
    denyRaw: 2_000_000_000n,
    denyLabel: '200 USDC',
    fundAccount: async (smartAccount) => {
      await withSeqRetry(async () => {
        const tx = new TransactionBuilder(await server.getAccount(issuer.publicKey()), {
          fee: FEE,
          networkPassphrase: PASSPHRASE,
        })
          .addOperation(
            new Contract(usdcSac).call(
              'mint',
              Address.fromString(smartAccount).toScVal(),
              i128(5_000_000_000n)
            )
          )
          .setTimeout(TIMEOUT)
          .build()
        const p = await server.prepareTransaction(tx)
        p.sign(issuer)
        return submit(p)
      })
    },
  })
  log('INFO', '')

  // ---- 3. Bounded SoroSwap delegation: generated slippage cap (Path B) ----
  log('STEP', '--- Walkthrough 3: Bounded SoroSwap delegation (slippage cap, Path B) ---')
  const SOROSWAP_ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'
  const slippage: PredicateNode = {
    op: 'and',
    children: [
      { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'swap' } },
      {
        op: 'eq',
        left: { kind: 'call_contract' },
        right: { kind: 'literal_address', value: SOROSWAP_ROUTER },
      },
      {
        op: 'gte',
        left: { kind: 'call_arg', index: 1 },
        right: { kind: 'call_arg_scaled', index: 0, num: '99', den: '100' },
      },
    ],
  }
  const enc = encodePredicate(slippage)
  log('INFO', `predicate: swap on ${SOROSWAP_ROUTER}, out >= in * 99/100`)
  log('INFO', `predicate hash ${enc.predicateHash}`)

  const admin3 = Keypair.random()
  const agent3 = Keypair.random()
  await friendbot(admin3.publicKey())
  await friendbot(agent3.publicKey())
  const account3 = await deployAccount(admin3)
  log('PASS', `smart account ${account3}`)

  const installed3 = await invokeAsAccount({
    kp: admin3,
    smartAccount: account3,
    fnName: 'add_context_rule',
    args: [
      xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('CallContract'),
        Address.fromString(SOROSWAP_ROUTER).toScVal(),
      ]),
      xdr.ScVal.scvString('wt3-slippage'),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([delegatedSigner(agent3.publicKey())]),
      policiesMap([[INTERPRETER, interpreterParams(slippage, 1)]]),
    ],
    contextRuleIds: [0],
  })
  log('RECEIPT', `add_context_rule ${installed3.txHash}`)
  receipts.push({
    walkthrough: '3',
    title: 'Bounded SoroSwap delegation (slippage cap, Path B)',
    smartAccount: account3,
    addContextRule: installed3.txHash,
    token: SOROSWAP_ROUTER,
    cap: 'out >= in * 99/100',
    predicateHash: enc.predicateHash,
  })
  log(
    'INFO',
    'permit/deny for this rule come from the deny-case harness: no SoroSwap testnet router is published, so there is no on-chain swap to submit.'
  )

  log('INFO', '')
  log('STEP', '--- Receipts ---')
  process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`)
}

main().catch((e) => {
  log('FAIL', String(e).slice(0, 500))
  process.exit(1)
})
