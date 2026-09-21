// Why exactly does the single-signature classic payment get rejected?
// "txFailed" would mean auth PASSED and the operation failed - a very
// different (and alarming) story from "txBadAuth". Decode it properly.

import { Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, rpc } from '@stellar/stellar-sdk'

const NETWORK = Networks.TESTNET
const server = new rpc.Server('https://soroban-testnet.stellar.org')

const fb = async (pk: string) => {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`)
}

const custody = Keypair.random()
const cosign = Keypair.random()
const dest = Keypair.random()

console.log('custody', custody.publicKey())
await Promise.all([fb(custody.publicKey()), fb(dest.publicKey())])

async function send(ops: any, signers: Keypair[]) {
  const acct = await server.getAccount(custody.publicKey())
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(ops)
    .setTimeout(120)
    .build()
  for (const s of signers) tx.sign(s)
  try {
    const sent = await server.sendTransaction(tx)
    if (sent.errorResult) {
      const r = sent.errorResult
      console.log('  status      :', sent.status)
      console.log('  result code :', r.result().switch().name)
      console.log('  feeCharged  :', r.feeCharged().toString())
      try {
        const inner = r.result().results?.()
        if (inner) for (const o of inner) console.log('  op result   :', o.tr?.().switch?.().name ?? o.switch().name)
      } catch (e) {
        console.log('  (no op results - transaction never reached operation stage)')
      }
      console.log('  raw xdr     :', r.toXDR('base64'))
      return
    }
    // Wait for a FINAL status; PENDING only means "queued".
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const got: any = await server.getTransaction(sent.hash)
      if (got.status === 'SUCCESS') {
        console.log('  status      : SUCCESS', sent.hash)
        return
      }
      if (got.status === 'FAILED') {
        let code = 'FAILED'
        try {
          code = got.resultXdr.result().switch().name
        } catch {}
        console.log('  status      : FAILED   result code:', code, sent.hash)
        return
      }
    }
    console.log('  status      : TIMEOUT', sent.status, sent.hash)
  } catch (e: any) {
    console.log('  threw:', e?.message ?? e)
  }
}

// Baseline: default thresholds, single signature -> must succeed
console.log('\n1. BEFORE setOptions (default thresholds), payment signed by master only:')
await send(Operation.payment({ destination: dest.publicKey(), asset: Asset.native(), amount: '1' }), [custody])

console.log('\n2. Applying master=10, cosign=10, low=10 med=20 high=20 ...')
await send(
  Operation.setOptions({
    masterWeight: 10,
    lowThreshold: 10,
    medThreshold: 20,
    highThreshold: 20,
    signer: { ed25519PublicKey: cosign.publicKey(), weight: 10 },
  }),
  [custody],
)

console.log('\n3. AFTER setOptions, payment signed by master only (weight 10 vs med 20):')
await send(Operation.payment({ destination: dest.publicKey(), asset: Asset.native(), amount: '1' }), [custody])

console.log('\n4. AFTER setOptions, payment signed by BOTH (weight 20 vs med 20):')
await send(Operation.payment({ destination: dest.publicKey(), asset: Asset.native(), amount: '1' }), [custody, cosign])

console.log('\n5. AFTER setOptions, setOptions signed by master only (weight 10 vs HIGH 20):')
await send(Operation.setOptions({ medThreshold: 1 }), [custody])
