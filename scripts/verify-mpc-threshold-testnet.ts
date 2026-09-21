// Prove (or refute) the "one-way valve" custody design on live TESTNET.
//
// Claim under test: a classic G account configured with
//   master (the "MPC key") weight 10, a break-glass signer weight 10,
//   low 10 / medium 20 / high 20
// loses UNILATERAL authority over its own funds, on BOTH rails:
//
//   A  classic `payment`, one signature                  -> must FAIL
//   A2 classic `payment`, both signatures                -> must SUCCEED (setup sanity)
//   B  Soroban `approve` auth entry, one signature       -> must FAIL   <-- load bearing
//   C  Soroban `approve` auth entry, both signatures     -> must SUCCEED
//   D  spender `transfer_from`, NO custody signature     -> must SUCCEED
//
// B is the one derived from CAP-46-11 ("Medium signature threshold has to be
// reached") rather than observed. If B passes when it should fail, the design
// has a back door and must be redesigned.
//
// Simulation does NOT verify signatures, so every case is really submitted.

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'

const RPC_URL = 'https://soroban-testnet.stellar.org'
const NETWORK = Networks.TESTNET
const server = new rpc.Server(RPC_URL)

const log = (tag: string, msg: string) => console.log(`[${tag}] ${msg}`)

async function friendbot(pk: string) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`)
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`)
}

async function loadAccount(pk: string): Promise<Account> {
  return await server.getAccount(pk)
}

/** Submit and wait. Returns {ok, status, detail}. Never throws on rejection. */
async function submit(tx: any): Promise<{ ok: boolean; status: string; detail: string; hash?: string }> {
  let sent
  try {
    sent = await server.sendTransaction(tx)
  } catch (e: any) {
    return { ok: false, status: 'SEND_THREW', detail: String(e?.message ?? e) }
  }
  if (sent.status === 'ERROR' || sent.status === 'DUPLICATE') {
    const detail = sent.errorResult ? sent.errorResult.result().switch().name : JSON.stringify(sent)
    return { ok: false, status: sent.status, detail, hash: sent.hash }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') return { ok: true, status: 'SUCCESS', detail: '', hash: sent.hash }
    if (got.status === 'FAILED') {
      let detail = 'FAILED'
      try {
        detail = (got as any).resultXdr?.result?.().switch?.().name ?? 'FAILED'
      } catch {}
      return { ok: false, status: 'FAILED', detail, hash: sent.hash }
    }
  }
  return { ok: false, status: 'TIMEOUT', detail: 'not found in 30s', hash: sent.hash }
}

/** Classic transaction: build, sign with the given keypairs, submit. */
async function classicTx(sourcePk: string, op: xdr.Operation, signers: Keypair[]) {
  const acct = await loadAccount(sourcePk)
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op)
    .setTimeout(120)
    .build()
  for (const s of signers) tx.sign(s)
  return await submit(tx)
}

/**
 * Sign one SorobanAuthorizationEntry whose credentials are an ACCOUNT address,
 * exactly as CAP-46-11 prescribes: an SCVal::Vec of AccountEd25519Signature
 * maps { public_key, signature }, sorted ascending by public key, no dupes.
 */
function signAccountAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signers: Keypair[],
  validUntilLedger: number,
): xdr.SorobanAuthorizationEntry {
  const creds = entry.credentials().address()
  creds.signatureExpirationLedger(validUntilLedger)

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(NETWORK)),
      nonce: creds.nonce(),
      signatureExpirationLedger: validUntilLedger,
      invocation: entry.rootInvocation(),
    }),
  )
  const payload = hash(preimage.toXDR())

  const sigs = signers
    .map((kp) => ({ pk: kp.rawPublicKey(), sig: kp.sign(payload) }))
    .sort((a, b) => Buffer.compare(a.pk, b.pk))
    .map(({ pk, sig }) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('public_key'),
          val: xdr.ScVal.scvBytes(pk),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('signature'),
          val: xdr.ScVal.scvBytes(sig),
        }),
      ]),
    )

  creds.signature(xdr.ScVal.scvVec(sigs))
  return entry
}

function invokeOp(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[],
): xdr.Operation {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: fnName,
        args,
      }),
    ),
    auth,
  })
}

/**
 * Build a Soroban invocation, take the auth entries the simulation says are
 * required, sign the ACCOUNT-credential ones with `authSigners`, reassemble
 * and submit signed by `txSigner` only.
 */
async function sorobanTx(
  txSourceKp: Keypair,
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  authSigners: Keypair[],
  /** Submit even if the enforcing simulation refuses, so the REJECTION comes
   *  from consensus rather than from the RPC declining to prepare. */
  forceSubmit = false,
) {
  const sequence = (await loadAccount(txSourceKp.publicKey())).sequenceNumber()
  const latest = await server.getLatestLedger()
  const validUntil = latest.sequence + 100

  const probe = new TransactionBuilder(new Account(txSourceKp.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(invokeOp(contractId, fnName, args, []))
    .setTimeout(120)
    .build()

  const sim = await server.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) {
    return { ok: false, status: 'SIM_ERROR', detail: sim.error }
  }
  const required = (sim as any).result?.auth ?? []

  const signedAuth = required.map((e: xdr.SorobanAuthorizationEntry) => {
    if (e.credentials().switch().name === 'sorobanCredentialsAddress') {
      const addr = e.credentials().address().address()
      if (addr.switch().name === 'scAddressTypeAccount') {
        return signAccountAuthEntry(e, authSigners, validUntil)
      }
    }
    return e
  })

  const withAuth = new TransactionBuilder(new Account(txSourceKp.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(invokeOp(contractId, fnName, args, signedAuth))
    .setTimeout(120)
    .build()

  const sim2 = await server.simulateTransaction(withAuth)
  if (rpc.Api.isSimulationError(sim2)) {
    if (!forceSubmit) return { ok: false, status: 'SIM_ERROR_2', detail: sim2.error }
    console.log('        (enforcing simulation refused; forcing submission anyway)')
  }

  // On a forced run the enforcing simulation produced no resources, so borrow
  // the footprint from the unsigned probe - the invocation is identical.
  const prepared = rpc.assembleTransaction(withAuth, rpc.Api.isSimulationError(sim2) ? sim : sim2).build()

  // assembleTransaction can substitute the simulation's own auth; put ours back.
  const op = prepared.operations[0] as any
  if (op.auth && signedAuth.length) op.auth = signedAuth

  const final = TransactionBuilder.fromXDR(prepared.toXDR(), NETWORK) as any
  final.sign(txSourceKp)
  return await submit(final)
}

function verdict(name: string, expectOk: boolean, got: { ok: boolean; status: string; detail: string }) {
  const pass = got.ok === expectOk
  const want = expectOk ? 'SUCCEED' : 'FAIL'
  console.log(
    `\n${pass ? '  PASS' : '  ** UNEXPECTED **'}  ${name}\n` +
      `        expected: ${want}   got: ${got.ok ? 'SUCCESS' : `${got.status} / ${got.detail}`}`,
  )
  return pass
}

async function main() {
  console.log('=== MPC one-way valve: live testnet check ===\n')

  const custody = Keypair.random() // the "MPC key" (account master key)
  const cosign = Keypair.random() // break-glass signer
  const spender = Keypair.random() // stands in for Prime
  const dest = Keypair.random()

  log('SETUP', `custody ${custody.publicKey()}`)
  log('SETUP', `cosign  ${cosign.publicKey()}`)
  log('SETUP', `spender ${spender.publicKey()}`)
  log('SETUP', `dest    ${dest.publicKey()}`)

  await Promise.all([
    friendbot(custody.publicKey()),
    friendbot(spender.publicKey()),
    friendbot(dest.publicKey()),
  ])
  log('SETUP', 'funded by friendbot')

  // Thresholds: low 10, medium 20, high 20. Master 10, cosign 10.
  const setup = await classicTx(
    custody.publicKey(),
    Operation.setOptions({
      masterWeight: 10,
      lowThreshold: 10,
      medThreshold: 20,
      highThreshold: 20,
      signer: { ed25519PublicKey: cosign.publicKey(), weight: 10 },
    }),
    [custody],
  )
  if (!setup.ok) throw new Error(`setup failed: ${setup.status} ${setup.detail}`)
  log('SETUP', `thresholds applied  tx ${setup.hash}`)

  const acct = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${custody.publicKey()}`)).json()
  log('SETUP', `thresholds now ${JSON.stringify(acct.thresholds)}`)
  log('SETUP', `signers ${JSON.stringify(acct.signers.map((s: any) => ({ k: s.key.slice(0, 6), w: s.weight })))}`)

  const sac = Asset.native().contractId(NETWORK)
  log('SETUP', `native SAC ${sac}`)

  const results: boolean[] = []

  // ---- A: classic payment, ONE signature -> must FAIL
  const a = await classicTx(
    custody.publicKey(),
    Operation.payment({ destination: dest.publicKey(), asset: Asset.native(), amount: '1' }),
    [custody],
  )
  results.push(verdict('A  classic payment, custody signature only', false, a))

  // ---- A3: accountMerge, ONE signature -> must FAIL (high threshold)
  const a3 = await classicTx(
    custody.publicKey(),
    Operation.accountMerge({ destination: dest.publicKey() }),
    [custody],
  )
  results.push(verdict('A3 accountMerge, custody signature only', false, a3))

  // ---- A4: lower the thresholds with ONE signature -> must FAIL (high).
  // The load-bearing case for every other refusal here: if the custody key
  // could drop medThreshold to 10 on its own, it would then satisfy every
  // other row unaided and the whole arrangement would be decorative.
  const a4 = await classicTx(
    custody.publicKey(),
    Operation.setOptions({ medThreshold: 10, highThreshold: 10 }),
    [custody],
  )
  results.push(verdict('A4 setOptions lowering thresholds, custody signature only', false, a4))

  // ---- A2: classic payment, BOTH -> must SUCCEED
  const a2 = await classicTx(
    custody.publicKey(),
    Operation.payment({ destination: dest.publicKey(), asset: Asset.native(), amount: '1' }),
    [custody, cosign],
  )
  results.push(verdict('A2 classic payment, both signatures', true, a2))

  const approveArgs = (amount: bigint, expLedger: number) => [
    new Address(custody.publicKey()).toScVal(),
    new Address(spender.publicKey()).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
    xdr.ScVal.scvU32(expLedger),
  ]

  const latest = await server.getLatestLedger()
  const expLedger = latest.sequence + 5000

  // ---- B: Soroban approve auth entry, ONE signature -> must FAIL
  const b = await sorobanTx(spender, sac, 'approve', approveArgs(50_000_000n, expLedger), [custody], true)
  results.push(verdict('B  Soroban approve, custody signature only  <-- load bearing', false, b as any))

  // ---- C: Soroban approve auth entry, BOTH -> must SUCCEED
  const c = await sorobanTx(spender, sac, 'approve', approveArgs(50_000_000n, expLedger), [custody, cosign])
  results.push(verdict('C  Soroban approve, both signatures', true, c as any))

  // ---- D: spender transfer_from, NO custody signature -> must SUCCEED
  const d = await sorobanTx(
    spender,
    sac,
    'transfer_from',
    [
      new Address(spender.publicKey()).toScVal(),
      new Address(custody.publicKey()).toScVal(),
      new Address(dest.publicKey()).toScVal(),
      nativeToScVal(10_000_000n, { type: 'i128' }),
    ],
    [],
  )
  results.push(verdict('D  transfer_from by spender, no custody signature', true, d as any))

  console.log(`\n=== ${results.filter(Boolean).length}/${results.length} as predicted ===`)
  console.log(`custody account: https://stellar.expert/explorer/testnet/account/${custody.publicKey()}`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
