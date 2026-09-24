// `prime accounts` - the custody account itself: Gate 3.
//
// Two signers at weight 10 against a medium and high threshold of 20, so no
// single key moves value, grants a limit, weakens the settings, or closes the
// account. `low` stays at 10 so the account can still source its own
// transactions and manage trustlines.

import { BASE_FEE, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { C, custodyPk, horizon, PASSPHRASE, secrets } from './chain.ts'

type Flags = Record<string, string | boolean>

const WEIGHT = 10
const MED = 20
const HIGH = 20

export async function accountsSetup(flags: Flags): Promise<void> {
  const dry = flags['dry-run'] === true
  const s = secrets()
  const cosigner = typeof flags.cosigner === 'string' ? flags.cosigner : s.cosign.publicKey()

  const acct: any = await horizon.loadAccount(custodyPk())
  console.log(C.bold('\nCustody account'))
  console.log(`  ${C.dim('account'.padEnd(20, '.'))} ${custodyPk()}`)
  console.log(
    `  ${C.dim('thresholds now'.padEnd(20, '.'))} low ${acct.thresholds.low_threshold} / med ${acct.thresholds.med_threshold} / high ${acct.thresholds.high_threshold}`
  )
  for (const sg of acct.signers) {
    console.log(`  ${C.dim('signer now'.padEnd(20, '.'))} ${sg.key} weight ${sg.weight}`)
  }
  console.log(C.bold('\nWould become'))
  console.log(`  ${C.dim('thresholds'.padEnd(20, '.'))} low ${WEIGHT} / med ${MED} / high ${HIGH}`)
  console.log(`  ${C.dim('treasury key'.padEnd(20, '.'))} ${custodyPk()} weight ${WEIGHT}`)
  console.log(`  ${C.dim('second key'.padEnd(20, '.'))} ${cosigner} weight ${WEIGHT}`)
  console.log(`  ${C.dim('effect'.padEnd(20, '.'))} one key alone can no longer move value`)

  if (dry) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }

  const tx = new TransactionBuilder(await horizon.loadAccount(custodyPk()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.setOptions({
        masterWeight: WEIGHT,
        lowThreshold: WEIGHT,
        medThreshold: MED,
        highThreshold: HIGH,
        signer: { ed25519PublicKey: cosigner, weight: WEIGHT },
      })
    )
    .setTimeout(60)
    .build()
  tx.sign(s.custody)
  await horizon.submitTransaction(tx)
  console.log(C.green('\n  Gate 3 is now in force.'))
}

export async function accountsInfo(flags: Flags): Promise<void> {
  const acct: any = await horizon.loadAccount(custodyPk())
  const native = acct.balances.find((b: any) => b.asset_type === 'native')
  const signers = acct.signers.map((s: any) => ({ key: s.key, weight: s.weight }))
  const total = signers.reduce((n: number, s: any) => n + s.weight, 0)

  const out = {
    account: custodyPk(),
    balance: native?.balance ?? '0',
    thresholds: {
      low: acct.thresholds.low_threshold,
      medium: acct.thresholds.med_threshold,
      high: acct.thresholds.high_threshold,
    },
    signers,
    totalWeight: total,
    singleKeyCanMoveValue: signers.some((s: any) => s.weight >= acct.thresholds.med_threshold),
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2))
    return
  }
  console.log(C.bold('\nCustody account'))
  console.log(`  ${C.dim('account'.padEnd(24, '.'))} ${out.account}`)
  console.log(`  ${C.dim('XLM balance'.padEnd(24, '.'))} ${out.balance}`)
  console.log(C.bold('\nGate 3 — who can change anything'))
  console.log(
    `  ${C.dim('thresholds'.padEnd(24, '.'))} low ${out.thresholds.low} / med ${out.thresholds.medium} / high ${out.thresholds.high}`
  )
  for (const sg of out.signers) {
    console.log(`  ${C.dim('signer'.padEnd(24, '.'))} ${sg.key}  weight ${sg.weight}`)
  }
  console.log(`  ${C.dim('total weight'.padEnd(24, '.'))} ${out.totalWeight}`)
  console.log(
    `  ${C.dim('one key alone'.padEnd(24, '.'))} ${
      out.singleKeyCanMoveValue
        ? C.amber('CAN move value — Gate 3 is not in force')
        : C.green('cannot move value, grant a limit, or close the account')
    }`
  )
}
