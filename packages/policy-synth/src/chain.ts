// Everything that touches the network, over one `rpc.Server`: a connection
// pinned to the network's own endpoint, read-only calls by simulation, the
// interpreter's live fingerprint. Tests point it at a recorded server.

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { GRAMMAR_VERSION, INTERPRETER, type Network, PASSPHRASE, RPC_URL } from './config.ts'
import { Refusal } from './envelope.ts'

export interface Endpoint {
  network: Network
  rpcUrl?: string | undefined
  /** Use `rpcUrl` although it is not the network's own endpoint. */
  allowUnpinnedRpcUrl?: boolean | undefined
}

/** A server for the network. A different endpoint is refused unless asked for:
 *  every answer binds to whoever served it. Plain http is for a loopback host only. */
export function connect(e: Endpoint): rpc.Server {
  const url = e.rpcUrl ?? RPC_URL[e.network]
  if (url !== RPC_URL[e.network] && e.allowUnpinnedRpcUrl !== true) {
    throw new Refusal(
      'INVALID_INPUT',
      `rpcUrl is not the ${e.network} endpoint (${RPC_URL[e.network]}); set allowUnpinnedRpcUrl to use it`
    )
  }
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)
  if (!url.startsWith('https://') && !loopback)
    throw new Refusal('INVALID_INPUT', 'rpcUrl must be https')
  return new rpc.Server(url, { allowHttp: loopback })
}

/** The wasm sha256 pinned for `address` on `network`, or undefined when it is not the pin. */
export const pinnedWasm = (network: Network, address: string): string | undefined =>
  INTERPRETER[network]?.address === address ? INTERPRETER[network]?.wasmSha256 : undefined

/** The interpreter a network uses: its pin, or the one the caller names (mainnet has none yet). */
export function interpreterFor(network: Network, address?: string): string {
  const pinned = INTERPRETER[network]?.address
  if (address !== undefined && address !== pinned) {
    if (pinned !== undefined)
      throw new Refusal(
        'INTERPRETER_MISMATCH',
        `${address} is not the pinned ${network} interpreter ${pinned}`
      )
    if (!StrKey.isValidContract(address))
      throw new Refusal('INVALID_INPUT', 'interpreterAddress is not a contract address')
    return address
  }
  if (pinned === undefined) {
    throw new Refusal(
      'INTERPRETER_MISMATCH',
      `no grammar-${GRAMMAR_VERSION} interpreter is pinned for ${network}; pass interpreterAddress (it is verified live)`
    )
  }
  return pinned
}

const SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32))

/** A call by simulation, whatever its outcome. The source account is made up: a
 *  simulation never looks at it, and asking the network for an unused key is a 404. */
export const simulate = (
  server: rpc.Server,
  network: Network,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<rpc.Api.SimulateTransactionResponse> =>
  server.simulateTransaction(
    txOf(network, new Account(SOURCE, '0'), new Contract(contract).call(fn, ...args))
  )

/** A read-only call: its return value. */
export async function read(
  server: rpc.Server,
  network: Network,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal> {
  const sim = await simulate(server, network, contract, fn, ...args)
  if (rpc.Api.isSimulationError(sim))
    throw new Refusal('SIMULATION_ERROR', `${fn}: ${reasonOf(sim.error)}`)
  if (!sim.result) throw new Refusal('SIMULATION_ERROR', `${fn}: no result`)
  return sim.result.retval
}

/** A one-operation transaction from `source`, unsigned and without time bounds. */
export const txOf = (network: Network, source: Account, op: xdr.Operation, fee = BASE_FEE) =>
  new TransactionBuilder(source, { fee, networkPassphrase: PASSPHRASE[network] })
    .addOperation(op)
    .setTimeout(0)
    .build()

/** Soroban's own `Error(Type, #Code)` forms, and nothing about which host answered. */
export const reasonOf = (error: string): string =>
  [...new Set(error.match(/Error\([^)]*\)/g) ?? [])].join(', ') || 'refused'

/** `fn` over `items`, at most `width` at a time, in order. */
export async function pool<T, R>(
  items: T[],
  width: number,
  fn: (x: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}

/** A contract's data entries, by key: the values, undefined where absent. */
export async function entries(
  server: rpc.Server,
  keys: xdr.LedgerKey[]
): Promise<(xdr.ScVal | undefined)[]> {
  if (keys.length === 0) return []
  const got = await server.getLedgerEntries(...keys)
  return keys.map((k) => {
    const hit = got.entries.find((e) => e.key.toXDR('base64') === k.toXDR('base64'))
    return hit?.val.switch().name === 'contractData' ? hit.val.contractData().val() : undefined
  })
}

export const dataKey = (contract: string, key: xdr.ScVal): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  )

export interface Fingerprint {
  address: string
  grammarVersion: number
  wasmSha256: string
  /** The live contract speaks this grammar and runs the build that was expected. */
  matches: boolean
}

/** What is deployed at `address` right now: its `grammar_version()` and the sha256
 *  of the code it runs (the executable of its instance entry). */
export async function fingerprint(
  server: rpc.Server,
  network: Network,
  address: string,
  expectedWasmSha256?: string
): Promise<Fingerprint> {
  const instance = dataKey(address, xdr.ScVal.scvLedgerKeyContractInstance())
  const [version, got] = await Promise.all([
    read(server, network, address, 'grammar_version'),
    server.getLedgerEntries(instance),
  ])
  const exec = got.entries[0]?.val.contractData().val().instance().executable()
  if (exec?.switch().name !== 'contractExecutableWasm') {
    throw new Refusal('INTERPRETER_MISMATCH', `${address} is not a wasm contract on ${network}`)
  }
  const grammarVersion = Number(version.u32())
  const wasmSha256 = Buffer.from(exec.wasmHash()).toString('hex')
  const matches =
    grammarVersion === GRAMMAR_VERSION && (expectedWasmSha256 ?? wasmSha256) === wasmSha256
  return { address, grammarVersion, wasmSha256, matches }
}
