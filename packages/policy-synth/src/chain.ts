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
  scValToNative,
  contract as soroban,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  ADAPTER_WASM,
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETER_WASM,
  type Network,
  PASSPHRASE,
  RPC_URL,
} from './config.ts'
import { messageOf, Refusal } from './envelope.ts'
import { type Caps, CEILINGS, FLOORS } from './wire.ts'

export interface Endpoint {
  network: Network
  /** A library caller's own endpoint. A tool never takes one: its input is untrusted. */
  rpcUrl?: string | undefined
}

/** The operator's endpoint for a network, from the process environment
 *  (`POLICY_BUILDER_RPC_URL_TESTNET`, `POLICY_BUILDER_RPC_URL_MAINNET`). */
export const rpcOverride = (network: Network): string | undefined =>
  process.env[`POLICY_BUILDER_RPC_URL_${network.toUpperCase()}`]

/** A server for the network: the network's own endpoint, or the one the operator configured
 *  (an answer binds to whoever served it, and a request goes wherever it is pointed, so
 *  neither is ever a tool's input). Plain http is for a loopback host only. */
export function connect(e: Endpoint): rpc.Server {
  const url = e.rpcUrl ?? rpcOverride(e.network) ?? RPC_URL[e.network]
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)
  if (!url.startsWith('https://') && !loopback)
    throw new Refusal('INVALID_INPUT', 'the RPC endpoint must be https')
  return new rpc.Server(url, { allowHttp: loopback })
}

/** The wasm sha256 pinned for `address` on `network`, or undefined when it is not the pin. */
export const pinnedWasm = (network: Network, address: string): string | undefined =>
  INTERPRETER[network]?.address === address ? INTERPRETER[network]?.wasmSha256 : undefined

/** The interpreter a network uses: its pin, or the one the caller names (mainnet has none yet;
 *  what runs there is checked against the trusted builds). */
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
      `no interpreter is pinned for ${network}; pass interpreterAddress (it is verified live)`
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

/** `fn` over `items`, at most `width` at a time, in order. The first failure (or an
 *  abort of `signal`) stops the rest from being started. */
export async function pool<T, R>(
  items: T[],
  width: number,
  fn: (x: T) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let stopped = false
  const worker = async () => {
    for (let i = next++; i < items.length && !stopped; i = next++) {
      try {
        signal?.throwIfAborted()
        out[i] = await fn(items[i] as T)
      } catch (e) {
        stopped = true
        throw e
      }
    }
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

const limitsSeen = new Map<string, Caps>()
/** Forget every limit read so far (tests: the cache is shared by the whole process). */
export const forgetLimits = () => limitsSeen.clear()

/** The limits `address` was deployed with (`limits()`), read once per address: an instance cannot
 *  change them. Each is a whole number from its floor to its ceiling and there is no other field; a
 *  contract that answers anything else (or does not answer) is refused, so no predicate is ever
 *  judged against a number the contract itself would not have accepted. Call it only for a trusted
 *  interpreter. */
export async function limitsOf(
  server: rpc.Server,
  network: Network,
  address: string
): Promise<Caps> {
  const id = `${network}:${address}`
  const seen = limitsSeen.get(id)
  if (seen) return seen
  const got = scValToNative(await read(server, network, address, 'limits'))
  const refuse = (why: string) => new Refusal('INTERPRETER_MISMATCH', `${address} reports ${why}`)
  const fields = Object.keys(CEILINGS) as (keyof Caps)[]
  const extra = Object.keys(got ?? {}).filter((k) => !fields.includes(k as keyof Caps))
  if (extra.length > 0)
    throw refuse(`limits this package does not know (${extra}), so it is not trusted`)
  const caps = {} as Record<keyof Caps, number>
  for (const field of fields) {
    const v = got?.[field]
    if (!Number.isInteger(v) || v < FLOORS[field] || v > CEILINGS[field])
      throw refuse(
        `${field} = ${String(v)}; every limit is a whole number from ${FLOORS[field]} to ${CEILINGS[field]}`
      )
    caps[field] = v
  }
  const frozen: Caps = Object.freeze(caps)
  limitsSeen.set(id, frozen)
  return frozen
}

export interface Fingerprint {
  address: string
  grammarVersion: number
  wasmSha256: string
  /** The live contract speaks this grammar and runs a build this package trusts... */
  matches: boolean
  /** ...and then it is asked what it was deployed with (a build it does not trust is not asked). */
  limits?: Caps | undefined
}

/** What is deployed at `address` right now: its `grammar_version()` and the sha256
 *  of the code it runs (the executable of its instance entry). */
export async function fingerprint(
  server: rpc.Server,
  network: Network,
  address: string
): Promise<Fingerprint> {
  const [version, wasmSha256] = await Promise.all([
    read(server, network, address, 'grammar_version'),
    codeHash(server, address),
  ])
  if (wasmSha256 === undefined)
    throw new Refusal('INTERPRETER_MISMATCH', `${address} is not a wasm contract on ${network}`)
  const grammarVersion = Number(version.u32())
  const matches = grammarVersion === GRAMMAR_VERSION && INTERPRETER_WASM.has(wasmSha256)
  const limits = matches ? await limitsOf(server, network, address) : undefined
  return { address, grammarVersion, wasmSha256, matches, limits }
}

/** The sha256 of the wasm `address` runs (its instance entry's executable), or undefined when
 *  it is not a wasm contract (a Stellar Asset Contract, or nothing at all). */
export async function codeHash(server: rpc.Server, address: string): Promise<string | undefined> {
  const instance = dataKey(address, xdr.ScVal.scvLedgerKeyContractInstance())
  const exec = (await entries(server, [instance]))[0]?.instance().executable()
  return exec?.switch().name === 'contractExecutableWasm'
    ? Buffer.from(exec.wasmHash()).toString('hex')
    : undefined
}

/** What a contract signer is, from its instance on the ledger: a trusted execution adapter created
 *  with no gate (its instance holds `prime`, and `gate` as void) or one bound to a gate (`prime`, and
 *  `gate` an address) - but only when it also runs a pinned adapter build and its `prime` is this
 *  account; a contract that wears those two symbols but runs another build (or vouches for another
 *  account) is an `unverified adapter`, refused and never vouched for; a contract that is not deployed
 *  (`absent`); or any other contract. The two symbols are read from storage, but the trust in them
 *  rests on the reproducible code hash and the account match, because any contract can write the
 *  symbols in its constructor (SYNTH-IO-01). */
export type ContractKind =
  | 'null-gate adapter'
  | 'gated adapter'
  | 'unverified adapter'
  | 'absent'
  | 'contract'

const PRIME_KEY = xdr.ScVal.scvSymbol('prime').toXDR('base64')
const GATE_KEY = xdr.ScVal.scvSymbol('gate').toXDR('base64')

/** The kind of a contract from its instance. When `account` is given, a contract is vouched for as an
 *  adapter only if its `prime` equals that account; a code hash outside the pinned adapter set, or a
 *  `prime` that is not this account, downgrades an adapter-shaped contract to `unverified adapter`. */
export function kindOf(instance: xdr.ScVal | undefined, account?: string): ContractKind {
  if (instance === undefined) return 'absent'
  const inst = instance.instance()
  const storage = inst.storage() ?? []
  const at = (k: string) => storage.find((e) => e.key().toXDR('base64') === k)
  const primeEntry = at(PRIME_KEY)
  const gate = at(GATE_KEY)?.val().switch().name
  if (!primeEntry || gate === undefined) return 'contract'
  const shape =
    gate === 'scvVoid' ? 'null-gate adapter' : gate === 'scvAddress' ? 'gated adapter' : undefined
  if (shape === undefined) return 'contract'
  // Adapter-shaped, so the trust check: it must run a pinned adapter build (its two symbols are
  // forgeable, its reproducible code hash is not), and a genuine adapter's `prime` is the Prime it
  // serves. Either miss leaves it an unverified adapter, which the builder refuses.
  const exec = inst.executable()
  const wasm =
    exec.switch().name === 'contractExecutableWasm'
      ? Buffer.from(exec.wasmHash()).toString('hex')
      : undefined
  if (wasm === undefined || !ADAPTER_WASM.has(wasm)) return 'unverified adapter'
  if (account !== undefined) {
    const primeVal = primeEntry.val()
    const prime =
      primeVal.switch().name === 'scvAddress' ? Address.fromScVal(primeVal).toString() : undefined
    if (prime !== account) return 'unverified adapter'
  }
  return shape
}

/** The kind of each contract address, in one ledger read. `account` ties an adapter's `prime` to the
 *  account a rule is bound to (omit it only where that account is not known). A failed read throws:
 *  it never passes. */
export async function contractKinds(
  server: rpc.Server,
  addresses: string[],
  account?: string
): Promise<Record<string, ContractKind>> {
  const keys = addresses.map((a) => dataKey(a, xdr.ScVal.scvLedgerKeyContractInstance()))
  let got: (xdr.ScVal | undefined)[]
  try {
    got = await entries(server, keys)
  } catch (e) {
    throw new Refusal('SIMULATION_ERROR', `reading the contract signers: ${messageOf(e)}`, {
      retryable: true,
    })
  }
  return Object.fromEntries(addresses.map((a, n) => [a, kindOf(got[n], account)]))
}

/** The refusal for an interpreter that is not a trusted build. */
export const mismatch = (f: Fingerprint): Refusal =>
  new Refusal(
    'INTERPRETER_MISMATCH',
    `${f.address} answers grammar_version() = ${f.grammarVersion} with wasm ${f.wasmSha256}; this build trusts grammar_version() = ${GRAMMAR_VERSION} with ${[...INTERPRETER_WASM].join(' or ')}`,
    { details: f }
  )

const known = new Set<string>()

/** Refuse unless `address` runs a trusted build: the pin is trusted as it stands, anything else is
 *  read from the ledger once (the interpreter cannot be upgraded). Gives the limits it was deployed with. */
export async function ensureInterpreter(
  server: rpc.Server,
  network: Network,
  named?: string
): Promise<Caps> {
  const address = interpreterFor(network, named)
  const id = `${network}:${address}`
  if (INTERPRETER[network]?.address !== address && !known.has(id)) {
    const live = await fingerprint(server, network, address)
    if (!live.matches) throw mismatch(live)
    known.add(id)
  }
  return limitsOf(server, network, address)
}

/** Whether a wasm's spec has one `transfer(from: address, to: address or muxed address, amount: i128)`. */
export function hasTransfer(wasm: Buffer): boolean {
  try {
    const fns = soroban.Spec.fromWasm(wasm)
      .funcs()
      .filter((f) => f.name().toString() === 'transfer')
    const types = fns[0]?.inputs().map((x) => x.type().switch().name.slice(10).toLowerCase())
    return (
      fns.length === 1 &&
      ['address,address,i128', 'address,muxedaddress,i128'].includes(types?.join() ?? '')
    )
  } catch {
    return false
  }
}

/** Whether `address` is shown to be a SEP-41 token: a Stellar Asset Contract, or a wasm with such a
 *  `transfer`. A failure to read is no token: the install is refused, and can be retried. */
export async function isToken(server: rpc.Server, address: string): Promise<boolean> {
  try {
    const instance = dataKey(address, xdr.ScVal.scvLedgerKeyContractInstance())
    const exec = (await entries(server, [instance]))[0]?.instance().executable()
    if (exec?.switch().name !== 'contractExecutableWasm') return exec !== undefined
    return hasTransfer(await server.getContractWasmByHash(Buffer.from(exec.wasmHash())))
  } catch {
    return false
  }
}
