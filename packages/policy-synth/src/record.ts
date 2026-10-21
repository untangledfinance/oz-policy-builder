// Record a transaction: its signed envelope (from the network by hash, or given
// as XDR) decoded into the calls it authorises. Nothing is inferred here; what a
// call MEANS is `synth.ts` and the registry's business.

import {
  Address,
  encodeMuxedAccountToAddress,
  FeeBumpTransaction,
  type rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { type Network, PASSPHRASE } from './config.ts'
import { Refusal } from './envelope.ts'
import { fromScVal, type Val } from './wire.ts'

export interface Call {
  contract: string
  fn: string
  args: Val[]
}

export interface Recording {
  network: Network
  /** The transaction's source account. */
  source: string
  ledger: number
  /** Accounts that authorised the call with address credentials. */
  signers: string[]
  /** The call the transaction makes first, then every other call its authorisation
   *  tree covers (a swap's token transfer), each once. A rule is scoped to one. */
  contexts: Call[]
}

const MAX_CONTEXTS = 512
const MAX_TREE_DEPTH = 16

/** Decode a base64 transaction envelope. Pure: no network. */
export function decodeEnvelope(b64: string, network: Network, ledger = 0): Recording {
  let env: xdr.TransactionEnvelope
  try {
    env = xdr.TransactionEnvelope.fromXDR(b64, 'base64')
  } catch (e) {
    throw new Refusal('RECORDING_FAILED', `not a transaction envelope: ${(e as Error).message}`)
  }
  const kind = env.switch().name
  const v1 =
    kind === 'envelopeTypeTx'
      ? env.v1()
      : kind === 'envelopeTypeTxFeeBump'
        ? env.feeBump().tx().innerTx().v1()
        : undefined
  if (!v1) throw new Refusal('RECORDING_FAILED', `unsupported envelope: ${kind}`)
  const tx = v1.tx()
  const op = tx
    .operations()
    .map((o) => o.body())
    .find((b) => b.switch().name === 'invokeHostFunction')
    ?.invokeHostFunctionOp()
  const host = op?.hostFunction()
  if (!op || host?.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Refusal(
      'RECORDING_FAILED',
      'the transaction invokes no contract function, so there is no call to scope a policy to'
    )
  }
  const contexts: Call[] = [callOf(host.invokeContract())]
  const signers = new Set<string>()
  for (const entry of op.auth()) {
    const creds = entry.credentials()
    if (creds.switch().name === 'sorobanCredentialsAddress') {
      signers.add(Address.fromScAddress(creds.address().address()).toString())
    }
    walk(entry.rootInvocation(), contexts, 0)
  }
  const unique = [...new Map(contexts.map((c) => [JSON.stringify(c), c])).values()]
  if (unique.length > MAX_CONTEXTS) throw new Refusal('RECORDING_FAILED', 'too many calls')
  return {
    network,
    source: encodeMuxedAccountToAddress(tx.sourceAccount(), true),
    ledger,
    signers: [...signers],
    contexts: unique,
  }
}

/** A contract call, its arguments read by `read`. */
export const callOf = (a: xdr.InvokeContractArgs, read = (x: xdr.ScVal) => fromScVal(x)): Call => ({
  contract: Address.fromScAddress(a.contractAddress()).toString(),
  fn: a.functionName().toString(),
  args: a.args().map(read),
})

function walk(inv: xdr.SorobanAuthorizedInvocation, out: Call[], depth: number): void {
  if (depth > MAX_TREE_DEPTH) throw new Refusal('RECORDING_FAILED', 'authorisation tree too deep')
  const f = inv.function()
  if (f.switch().name === 'sorobanAuthorizedFunctionTypeContractFn')
    out.push(callOf(f.contractFn()))
  for (const sub of inv.subInvocations()) walk(sub, out, depth + 1)
}

/** Fetch a transaction by hash and decode it. */
export async function recordHash(
  server: rpc.Server,
  network: Network,
  hash: string
): Promise<Recording> {
  const tx = await server.getTransaction(hash)
  if (tx.status === 'NOT_FOUND')
    throw new Refusal('RECORDING_FAILED', `transaction ${hash} not found on ${network}`, {
      retryable: true,
    })
  if (tx.status !== 'SUCCESS') {
    throw new Refusal(
      'RECORDING_FAILED',
      `transaction ${hash} failed on chain: it is not a flow that happened`
    )
  }
  const b64 = tx.envelopeXdr.toXDR('base64')
  // The RPC chooses the envelope it returns. Hash it under this network and require the hash asked
  // for (a fee bump also answers to its inner transaction's hash), so a recording is of that flow.
  const t = TransactionBuilder.fromXDR(b64, PASSPHRASE[network])
  const hashes = [t.hash().toString('hex')]
  if (t instanceof FeeBumpTransaction) hashes.push(t.innerTransaction.hash().toString('hex'))
  if (!hashes.includes(hash.toLowerCase())) {
    throw new Refusal(
      'RECORDING_FAILED',
      `the RPC answered transaction ${hash} with an envelope whose hash on ${network} is ${hashes[0]}: the answer is not trusted`
    )
  }
  return decodeEnvelope(b64, network, tx.ledger)
}
