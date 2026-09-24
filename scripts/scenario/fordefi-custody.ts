// Testnet ONLY. Builds the custody wallet the Prime demo is told to assume:
// a Fordefi-shaped classic Stellar account with three signers weighted
// 10 / 5 / 5 and a MEDIUM threshold of 20, so no two of them can move value.
//
// WHY 20 AND NOT 16. Twenty is the sum of all three weights, so the medium
// threshold is only met when every signer signs. Sixteen would also exclude
// the two lightest, but 10 + 5 = 15 and 10 + 5 = 15 are the interesting near
// misses - at 16 the heavy key plus either light key still falls short, and
// at 20 so does any pair. Setting it to the full sum states "all three" in
// the one place stellar-core enforces it.
//
// THE MASTER KEY IS RETIRED (weight 0). Left at its default of 1 the account
// would have a fourth signer nobody listed, and on a custody wallet that is
// the whole story: the point of the weights is that the set is closed.
//
// Keys are written to scripts/.env, which is gitignored. Disposable testnet
// keys only; nothing here reads a production secret.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

const HORIZON = 'https://horizon-testnet.stellar.org'
const horizon = new Horizon.Server(HORIZON)
const STATE = `${import.meta.dir}/../.scenario-state.json`

/** 10 / 5 / 5, and a medium threshold equal to their sum. */
export const CUSTODY_WEIGHTS = [10, 5, 5] as const
export const CUSTODY_MED_THRESHOLD = 20

async function friendbot(pk: string): Promise<void> {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  // 400 is "already funded", which is success for our purposes.
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status} for ${pk}`)
}

interface State {
  custody: { secret: string; signers: string[] }
  primeSigners: string[]
  [k: string]: unknown
}

function load(): State {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, 'utf8')) as State
  return {
    custody: { secret: Keypair.random().secret(), signers: [] },
    primeSigners: [],
  }
}

function save(s: State): void {
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
}

export async function provision(): Promise<State> {
  const state = load()
  const custody = Keypair.fromSecret(state.custody.secret)

  // Three signer keys for the custody wallet, plus three for the Prime. The
  // Prime set is generated here rather than reused so the "3 new signers"
  // case has keys; the overlap cases pick from both lists.
  const signerSecrets: string[] =
    (state.custody.signers as string[]).length === 3
      ? (state.custody.signers as string[])
      : [Keypair.random().secret(), Keypair.random().secret(), Keypair.random().secret()]
  state.custody.signers = signerSecrets

  const primeSecrets: string[] =
    state.primeSigners.length === 3
      ? state.primeSigners
      : [Keypair.random().secret(), Keypair.random().secret(), Keypair.random().secret()]
  state.primeSigners = primeSecrets
  save(state)

  await friendbot(custody.publicKey())
  // Every signer needs its own funded account: a signer pays its own fee when
  // it is the source of a co-signed envelope, and the app's queue sources
  // from whoever is completing the ceremony.
  for (const s of [...signerSecrets, ...primeSecrets]) {
    await friendbot(Keypair.fromSecret(s).publicKey())
  }

  const account = await horizon.loadAccount(custody.publicKey())
  const already = account.signers.filter((s) => s.key !== custody.publicKey())
  if (already.length === 3 && account.thresholds.med_threshold === CUSTODY_MED_THRESHOLD) {
    console.log('custody already configured')
    return state
  }

  // ONE TRANSACTION, and the order inside it matters: the master key is
  // retired LAST. Dropping it first would leave the remaining operations
  // unauthorised by a key that no longer counts, and the whole envelope is
  // signed by the master key as it stands at submission - so the retirement
  // has to be the final change.
  let builder = new TransactionBuilder(account, {
    fee: '10000',
    networkPassphrase: Networks.TESTNET,
  })
  signerSecrets.forEach((secret, i) => {
    builder = builder.addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: Keypair.fromSecret(secret).publicKey(),
          weight: CUSTODY_WEIGHTS[i]!,
        },
      })
    )
  })
  const tx = builder
    .addOperation(
      Operation.setOptions({
        masterWeight: 0,
        lowThreshold: 1,
        medThreshold: CUSTODY_MED_THRESHOLD,
        highThreshold: CUSTODY_MED_THRESHOLD,
      })
    )
    .setTimeout(120)
    .build()
  tx.sign(custody)
  const res = await horizon.submitTransaction(tx)
  console.log('custody configured:', res.hash)
  return state
}

export async function report(): Promise<void> {
  const state = load()
  const custody = Keypair.fromSecret(state.custody.secret)
  const account = await horizon.loadAccount(custody.publicKey())
  console.log('custody wallet :', custody.publicKey())
  console.log('thresholds     :', JSON.stringify(account.thresholds))
  for (const s of account.signers) console.log(`  signer ${s.key} weight ${s.weight}`)
  console.log('prime signer candidates:')
  for (const s of state.primeSigners) console.log(`  ${Keypair.fromSecret(s).publicKey()}`)
}

/**
 * The assets the demo swaps INTO, and why custody needs a trustline for each.
 *
 * A swap funded in XLM pays out something else, and the last leg of the batch
 * sends that to the custody account. A classic asset cannot reach a `G...`
 * without a trustline, so without these the batch reverts on its final call -
 * after the gate has already released and the pool has already swapped.
 *
 * Contracts are exempt: the adapter holds the same asset mid-batch with no
 * trustline at all, because a `C...` balance lives in the asset contract's
 * own storage. Only the classic account at the end of the chain needs one.
 *
 * Each one is a MEDIUM-threshold operation, so establishing them is itself a
 * three-signature ceremony on this wallet.
 */
export const DEMO_OUT_ASSETS = [
  { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  { code: 'USDT', issuer: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER' },
  { code: 'AQUA', issuer: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER' },
] as const

export async function trustlines(): Promise<void> {
  const state = load()
  const custody = Keypair.fromSecret(state.custody.secret)
  const signers = (state.custody.signers as string[]).map((s) => Keypair.fromSecret(s))
  const account = await horizon.loadAccount(custody.publicKey())
  const held = new Set(
    account.balances
      .filter((b): b is typeof b & { asset_code: string } => 'asset_code' in b)
      .map((b) => b.asset_code)
  )
  const missing = DEMO_OUT_ASSETS.filter((a) => !held.has(a.code))
  if (missing.length === 0) {
    console.log('trustlines already established')
    return
  }
  let builder = new TransactionBuilder(account, {
    fee: String(1000 * missing.length),
    networkPassphrase: Networks.TESTNET,
  })
  for (const a of missing) {
    builder = builder.addOperation(Operation.changeTrust({ asset: new Asset(a.code, a.issuer) }))
  }
  const tx = builder.setTimeout(120).build()
  // All three. Two would be 15 of the 20 this account requires, and the
  // network refuses it with `op_bad_auth` - which is the property under test
  // every time this scenario signs anything.
  for (const s of signers) tx.sign(s)
  const res = await horizon.submitTransaction(tx)
  console.log(`trustlines established (${missing.map((a) => a.code).join(', ')}):`, res.hash)
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? 'provision'
  if (cmd === 'provision') {
    await provision()
    await trustlines()
  }
  if (cmd === 'trustlines') await trustlines()
  if (cmd === 'proposer') await proposerWeight()
  await report()
}

/**
 * Give the master key weight 1, so it can PROPOSE without being able to approve.
 *
 * Retired to 0, the master key is not a signer at all - and a wallet that is
 * not a signer cannot even start a queue: the app refuses with "this wallet is
 * not a signer for the Stellar account that still needs approval", which is
 * correct and leaves nobody able to open a transaction for this account.
 *
 * A Fordefi wallet does not have this problem: it presents the custody
 * ACCOUNT and collects its own quorum internally, so the connected address is
 * already the account. A plain key cannot do that, so the account needs one
 * key that can put a transaction on the table.
 *
 * THE THRESHOLD IS UNCHANGED, and that is what keeps the property. Weights
 * become 1 + 10 + 5 + 5 = 21 against a medium threshold of 20, so:
 *
 *   all three signers          10 + 5 + 5 = 20   meets it
 *   master plus any two        1 + 10 + 5 = 16   does not
 *   master alone                            1    does not
 *
 * The master key can open a transaction and nothing else. Every signature
 * that authorises anything still comes from the three signers.
 */
export async function proposerWeight(): Promise<void> {
  const state = load()
  const custody = Keypair.fromSecret(state.custody.secret)
  const signers = (state.custody.signers as string[]).map((s) => Keypair.fromSecret(s))
  const account = await horizon.loadAccount(custody.publicKey())
  const master = account.signers.find((s) => s.key === custody.publicKey())
  if (master?.weight === 1) {
    console.log('master key already carries proposer weight')
    return
  }
  const tx = new TransactionBuilder(account, { fee: '10000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.setOptions({ masterWeight: 1 }))
    .setTimeout(120)
    .build()
  for (const s of signers) tx.sign(s)
  const res = await horizon.submitTransaction(tx)
  console.log('master key given proposer weight 1:', res.hash)
}
