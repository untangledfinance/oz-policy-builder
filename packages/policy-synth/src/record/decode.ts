// src/record/decode.ts - pure XDR -> invocation tree decoder.
//
// Inputs: a base64-encoded TransactionEnvelope XDR (or one already decoded),
// the raw transaction events (used only to identify contract emitters), and
// (optionally) the auth-entry set.
//
// Outputs:
//   - top-level ContractInvocation (the single Context `Policy::enforce` receives)
//   - subInvocations captured on each ContractInvocation from
//     SorobanAuthorizedInvocation.subInvocations - DIAGNOSTIC ONLY; v1 grammar
//     does NOT walk sub-invocations (see types.ts notes).
//   - decoded args vector mapped to the normalised `ScVal` subset
//   - sourceAccount, signers
//   - raw event list surfaced for downstream validation
//   - auth entries surfaced for downstream validation
//
// No network calls. No randomness. No globals.

import { Address, StrKey, xdr } from '@stellar/stellar-sdk'
import { identifyProtocol } from '../registry/identify.ts'
import {
  type ContractInvocation,
  MAX_SCVAL_DEPTH,
  type Network,
  type OnChainEvent,
  type ParseConfidence,
  type ScVal,
  type TokenMovement,
} from '../types.ts'

/** Result of decoding an envelope XDR plus the surrounding metadata from
 *  `getTransaction` (events + auth entries). All fields are plain JSON; the
 *  caller decides how to interpret them. */
export interface SerializableAuthEntry {
  authorizingAddress: string | null
  contract: string
  fn: string
}

export interface DecodedTransaction {
  sourceAccount: string
  /** Authorising signers from the envelope signatures (hex-encoded ed25519
   *  pubkey hints expanded to G... strkeys). The recorder cannot recover the
   *  strkey from the 4-byte hint alone; we record the hint bytes hex instead
   *  when no full strkey is available. */
  signers: string[]
  invocations: ContractInvocation[]
  /** Raw on-chain events (from getTransaction.events). Used by validate.ts to
   *  cross-check the parsed TokenMovement[] and ContractInvocation[]. */
  events: OnChainEvent[]
  /** Plain JSON projection of InvokeHostFunctionOp.auth(). */
  authEntries: SerializableAuthEntry[]
  /** Records that include at least one `ContractInvocation` whose decoded args
   *  vector or whose auth-tree contained an opaque ScVal. Empty list = full
   *  parseConfidence = 1.0 (modulo unknown contracts). */
  opaqueScVals: ParseConfidence['opaqueScVals']
  /** Contracts referenced in invocations whose (fn, args) did not match any
   *  known protocol ABI. Each unrecognised invocation is recorded separately
   *  so the freshness gate stays fail-closed regardless of operation order. */
  unknownContracts: ParseConfidence['unknownContracts']
  knownContracts: string[]
  ledgerSequence: number
}

/** Decode a TransactionEnvelope XDR (base64) into a fully parsed invocation tree. */
export function decodeEnvelopeXdr(
  envelopeXdrB64: string,
  events: OnChainEvent[] = [],
  _authEntries: unknown[] = [],
  ledgerSequence = 0,
  knownContracts: ReadonlySet<string> = new Set(),
  network: Network | null = null
): DecodedTransaction {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdrB64, 'base64')
  return decodeEnvelope(envelope, events, _authEntries, ledgerSequence, knownContracts, network)
}

/** Same as `decodeEnvelopeXdr` but accepts an already-decoded envelope. Useful
 *  for tests that build the envelope via SDK helpers (no XDR round-trip). */
export function decodeEnvelope(
  envelope: xdr.TransactionEnvelope,
  events: OnChainEvent[] = [],
  _authEntries: unknown[] = [],
  ledgerSequence = 0,
  knownContracts: ReadonlySet<string> = new Set(),
  network: Network | null = null
): DecodedTransaction {
  const envType = envelope.switch().name
  if (envType === 'envelopeTypeTxFeeBump') {
    // Fee-bump wraps a normal inner v1 transaction (a different account
    // pays the fee). The real operations + their authorizers live on the
    // INNER v1 envelope, so decode that and discard the outer fee-bump
    // shell (fee-bump v0 does not exist).
    const innerV1 = envelope.feeBump().tx().innerTx().v1()
    return decodeV1Envelope(innerV1, events, ledgerSequence, knownContracts, network)
  }
  if (envType !== 'envelopeTypeTx') {
    // TransactionV0 is out of scope (v1 protocol only). Fee-bump is handled
    // above; legacy envelopes reach this branch.
    throw new DecodeError(`unsupported envelope: ${envType}`)
  }
  return decodeV1Envelope(envelope.v1(), events, ledgerSequence, knownContracts, network)
}

/** Decode a v1 TransactionEnvelope (either a top-level v1 envelope or the
 *  inner v1 envelope of a fee-bump wrapper). Source, operations, auth
 *  entries, signers all come from this v1 envelope. */
function decodeV1Envelope(
  v1: xdr.TransactionV1Envelope,
  events: OnChainEvent[],
  ledgerSequence: number,
  knownContracts: ReadonlySet<string>,
  network: Network | null
): DecodedTransaction {
  const tx = v1.tx()
  const sourceAccount = decodeMuxedOrEd25519(tx.sourceAccount())

  const signers = extractSigners(v1, tx)

  const invocations: ContractInvocation[] = []
  const projectedAuthEntries: SerializableAuthEntry[] = []
  const opaqueScVals: ParseConfidence['opaqueScVals'] = []
  const knownContractSet = new Set<string>()
  const unknownContracts: ParseConfidence['unknownContracts'] = []
  const knownContractsOut: string[] = []

  for (const op of tx.operations()) {
    const body = op.body()
    if (body.switch().name !== 'invokeHostFunction') continue
    const invokeOp = body.invokeHostFunctionOp()
    const auth = invokeOp.auth()
    projectedAuthEntries.push(...auth.map(projectAuthEntry))
    const hostFn = invokeOp.hostFunction()
    if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') continue
    const invokeArgs = hostFn.invokeContract()
    const contract = decodeScAddressToC(invokeArgs.contractAddress())
    const fn = symbolValueFromBufferOrString(invokeArgs.functionName())
    const argsScval = invokeArgs.args()
    const args: ScVal[] = []
    argsScval.forEach((a: xdr.ScVal, i: number) => {
      args.push(scValToSubset(a, `args[${i}]`, opaqueScVals))
    })

    const subInvocations: ContractInvocation[] = decodeSubInvocations(auth, opaqueScVals)

    invocations.push({ contract, fn, args, subInvocations })

    recordInvocation(
      contract,
      fn,
      args,
      network,
      knownContracts,
      knownContractSet,
      knownContractsOut,
      unknownContracts
    )
  }

  return {
    sourceAccount,
    signers,
    invocations,
    events,
    authEntries: projectedAuthEntries,
    opaqueScVals,
    unknownContracts,
    knownContracts: knownContractsOut,
    ledgerSequence,
  }
}

/** Extract the union of signers from:
 *    - envelope-level signatures (the tx-level signers), and
 *    - Soroban auth entries that are `SorobanCredentials.sorobanCredentialsAddress`
 *      (the contract-Caller authorised via ed25519/address credentials).
 *  Returns G... strkeys (or address strkeys for non-account credentials). */
function extractSigners(v1: xdr.TransactionV1Envelope, tx: xdr.Transaction): string[] {
  const set = new Set<string>()
  for (const sig of v1.signatures()) {
    // Each signature has a 4-byte hint. We cannot recover the full strkey from
    // a 4-byte hint alone - so we record it as `hint:<hex>` to preserve signal
    // for the downstream reviewer without claiming a match we cannot prove.
    const hintBytes = sig.hint()
    set.add(`hint:${Buffer.from(hintBytes).toString('hex')}`)
  }
  // Soroban address credentials - recover the strkey address.
  for (const op of tx.operations()) {
    const body = op.body()
    if (body.switch().name !== 'invokeHostFunction') continue
    const invokeOp = body.invokeHostFunctionOp()
    for (const entry of invokeOp.auth()) {
      const creds = entry.credentials()
      const kind = creds.switch().name
      if (kind === 'sorobanCredentialsAddress') {
        const addrCreds = creds.address()
        const scAddr = addrCreds.address()
        try {
          const strkey = decodeScAddressToAnyStrkey(scAddr)
          if (strkey) set.add(strkey)
        } catch {
          // ignore - we record it as opaque via freshness
        }
      }
      // sorobanCredentialsSourceAccount -> pulled from tx.sourceAccount() above
    }
  }
  return Array.from(set)
}

const MAX_AUTH_TREE_DEPTH = 16

function projectAuthEntry(entry: xdr.SorobanAuthorizationEntry): SerializableAuthEntry {
  const credentials = entry.credentials()
  const authorizingAddress =
    credentials.switch().name === 'sorobanCredentialsAddress'
      ? decodeScAddressToAnyStrkey(credentials.address().address())
      : null
  const fn = entry.rootInvocation().function()
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const contractFn = fn.contractFn()
    return {
      authorizingAddress,
      contract: decodeScAddressToC(contractFn.contractAddress()),
      fn: symbolValueFromBufferOrString(contractFn.functionName()),
    }
  }
  return { authorizingAddress, contract: '', fn: '__create_contract__' }
}

function decodeSubInvocations(
  authEntries: xdr.SorobanAuthorizationEntry[],
  opaqueScVals: ParseConfidence['opaqueScVals']
): ContractInvocation[] {
  return authEntries.flatMap((entry, index) => {
    const decoded = decodeAuthorizedInvocation(
      entry.rootInvocation(),
      opaqueScVals,
      `auth[${index}].root`,
      0
    )
    return decoded ? [decoded] : []
  })
}

function decodeAuthorizedInvocation(
  inv: xdr.SorobanAuthorizedInvocation,
  opaqueScVals: ParseConfidence['opaqueScVals'],
  path: string,
  depth: number
): ContractInvocation | null {
  if (depth >= MAX_AUTH_TREE_DEPTH) {
    opaqueScVals.push({ path, type: 'auth-tree-depth-exceeded' })
    return null
  }
  const fn = inv.function()
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') return null

  const contractFn = fn.contractFn()
  const contract = decodeScAddressToC(contractFn.contractAddress())
  const fnName = symbolValueFromBufferOrString(contractFn.functionName())
  const args = contractFn
    .args()
    .map((arg: xdr.ScVal, index: number) =>
      scValToSubset(arg, `${path}.args[${index}]`, opaqueScVals)
    )
  const subInvocations = inv.subInvocations().flatMap((child, index) => {
    const decoded = decodeAuthorizedInvocation(
      child,
      opaqueScVals,
      `${path}.subInvocations[${index}]`,
      depth + 1
    )
    return decoded ? [decoded] : []
  })
  return { contract, fn: fnName, args, subInvocations }
}

/** Decode an ScAddress (either account or contract) to its strkey form. */
export function decodeScAddressToAnyStrkey(scAddr: xdr.ScAddress): string | null {
  const kind = scAddr.switch().name
  if (kind === 'scAddressTypeAccount') {
    return decodePublicKeyToStrkey(scAddr.accountId())
  }
  if (kind === 'scAddressTypeContract') {
    const hashBytes = scAddr.contractId() as unknown as Uint8Array
    return Address.contract(Buffer.from(hashBytes)).toString()
  }
  return null
}

/** Decode an ScAddress to a C... contract strkey. */
export function decodeScAddressToC(scAddr: xdr.ScAddress): string {
  if (scAddr.switch().name === 'scAddressTypeContract') {
    const hashBytes = scAddr.contractId() as unknown as Uint8Array
    return Address.contract(Buffer.from(hashBytes)).toString()
  }
  if (scAddr.switch().name === 'scAddressTypeAccount') {
    const strkey = decodePublicKeyToStrkey(scAddr.accountId())
    if (strkey) return strkey
  }
  throw new DecodeError(`cannot convert ScAddress ${scAddr.switch().name} to contract strkey`)
}

/** Decode a tx source account (MuxedEd25519Account OR AccountId OR PublicKey).
 *  - muxedAccount -> underlying ed25519 account as G...
 *  - publicKeyTypeEd25519 -> G...
 */
function decodeMuxedOrEd25519(src: xdr.MuxedAccount): string {
  const kind = src.switch().name
  if (kind === 'keyTypeMuxedEd25519') {
    const ed = src.med25519().ed25519()
    return StrKey.encodeEd25519PublicKey(ed)
  }
  const ed = src.ed25519()
  return StrKey.encodeEd25519PublicKey(ed)
}

/** AccountId is a type alias for PublicKey in this SDK; extract the ed25519
 *  strkey from a PublicKey union. */
function decodePublicKeyToStrkey(pubKey: xdr.PublicKey): string | null {
  if (pubKey.switch().name === 'publicKeyTypeEd25519') {
    return StrKey.encodeEd25519PublicKey(pubKey.ed25519())
  }
  return null
}

/** `functionName()` returns `string | Buffer` per the SDK type definition; we
 *  accept both and normalise. */
function symbolValueFromBufferOrString(s: string | Buffer): string {
  return Buffer.isBuffer(s) ? s.toString('utf8') : s
}

/** Map an arbitrary ScVal into the normalised `ScVal` subset defined in
 *  types.ts. Anything outside the subset is wrapped as `{type:'other', value}`
 *  AND recorded in `opaqueScVals` so the freshness module can reduce
 *  parseConfidence. Recursion is bounded by `MAX_SCVAL_DEPTH` so a
 *  hand-crafted nested-vec payload cannot RangeError the JS stack; the
 *  over-depth branch is collapsed to a single opaque `depth-exceeded` token
 *  (the recorder's parseConfidence gate then fails the recording closed). */
export function scValToSubset(
  val: xdr.ScVal,
  path: string,
  opaqueScVals: ParseConfidence['opaqueScVals'],
  depth = 0
): ScVal {
  const kind = val.switch().name
  switch (kind) {
    case 'scvAddress': {
      const strkey = decodeScAddressToAnyStrkey(val.address())
      if (strkey === null) {
        opaqueScVals.push({ path, type: kind })
        return { type: 'other', value: kind }
      }
      return { type: 'address', value: strkey }
    }
    case 'scvI128': {
      const parts = val.i128()
      return { type: 'i128', value: i128PartsToBigInt(parts).toString() }
    }
    case 'scvU64': {
      return { type: 'u64', value: u64PartsToBigInt(val.u64()).toString() }
    }
    case 'scvU32': {
      return { type: 'u32', value: val.u32().toString() }
    }
    case 'scvSymbol': {
      return { type: 'symbol', value: val.sym().toString() }
    }
    case 'scvVec': {
      if (depth >= MAX_SCVAL_DEPTH) {
        // Over-depth branch: collapse to a single opaque terminal so the
        // downstream parseConfidence gate sees the fail-closed freshness hit.
        opaqueScVals.push({ path, type: 'depth-exceeded' })
        return { type: 'other', value: 'depth-exceeded' }
      }
      const arr = (val.vec() ?? []) as xdr.ScVal[]
      return {
        type: 'vec',
        value: arr.map((v: xdr.ScVal, i: number) =>
          scValToSubset(v, `${path}[${i}]`, opaqueScVals, depth + 1)
        ),
      }
    }
    case 'scvMap': {
      if (depth >= MAX_SCVAL_DEPTH) {
        opaqueScVals.push({ path, type: 'depth-exceeded' })
        return { type: 'other', value: 'depth-exceeded' }
      }
      // Map<Symbol, ScVal> is the canonical data shape for SAC/SEP-41
      // transfer/mint/burn events on Stellar mainnet (verified empirically
      // against txs 112d2392..., eb39f493..., 50d36f5c...). The entry key is
      // carried forward so readAmount can route to the conventional field
      // name without re-decoding the full XDR. Non-symbol / non-string keys
      // are stringified via the same key-to-string rule used for topics.
      const entries = (val.map() ?? []) as xdr.ScMapEntry[]
      return {
        type: 'map',
        value: entries.map((entry, i) => ({
          key: mapKeyToString(entry.key(), `${path}.key[${i}]`, opaqueScVals),
          val: scValToSubset(entry.val(), `${path}.val[${i}]`, opaqueScVals, depth + 1),
        })),
      }
    }
    case 'scvBytes': {
      return { type: 'bytes', value: Buffer.from(val.bytes() as Uint8Array).toString('hex') }
    }
    default: {
      opaqueScVals.push({ path, type: kind })
      return { type: 'other', value: kind }
    }
  }
}

/** Convert Int128Parts (hi: Int64, lo: Uint64) to a BigInt.
 *  hi is a signed 64-bit value; lo is unsigned. We use the SDK-provided
 *  `toString()` form which gives the signed decimal representation of the 64-bit
 *  Int64 directly. */
export function i128PartsToBigInt(parts: xdr.Int128Parts): bigint {
  const hiStr = parts.hi().toString()
  const loStr = parts.lo().toString()
  const hi = BigInt(hiStr)
  const lo = BigInt(loStr)
  return (hi << 64n) + lo
}

/** Convert UInt128Parts (hi: Uint64, lo: Uint64) to an unsigned BigInt. */
export function u128PartsToBigInt(parts: xdr.UInt128Parts): bigint {
  const hi = BigInt(parts.hi().toString())
  const lo = BigInt(parts.lo().toString())
  return (hi << 64n) + lo
}

export function u64PartsToBigInt(h: xdr.UnsignedHyper | xdr.Hyper): bigint {
  return BigInt(h.toString())
}

function recordInvocation(
  contract: string,
  fn: string,
  args: ScVal[],
  network: Network | null,
  knownSet: ReadonlySet<string>,
  knownContractSet: Set<string>,
  knownOut: string[],
  unknownOut: ParseConfidence['unknownContracts']
): void {
  // Recognition is evaluated PER INVOCATION using the (contract, fn, args)
  // triple. The first call to a contract is no more authoritative than the
  // second: an unrecognized call always contributes to the unknown count
  // regardless of whether another invocation to the same contract was
  // recognised. knownOut is deduplicated by contract (so the
  // parseConfidence denominator isn't inflated by repeat calls), but each
  // unrecognised invocation is recorded separately so the numerator
  // reflects every fail-closed hit.
  // `||` short-circuits, so `identifyProtocol` is still only consulted when the
  // contract is not already in `knownSet` - the same call order as before.
  if (knownSet.has(contract) || identifyProtocol(contract, fn, args, network ?? undefined)) {
    if (!knownContractSet.has(contract)) {
      knownContractSet.add(contract)
      knownOut.push(contract)
    }
    return
  }
  unknownOut.push({ contract, reason: 'no-abi' })
}

/** Convert a ScVal to a friendly string for use in OnChainEvent.topics
 *  (always-string scalar representation; vectors/bytes are stringified as JSON
 *  to keep the field string-typed). */
export function scValToTopicString(val: xdr.ScVal): string {
  const kind = val.switch().name
  if (kind === 'scvSymbol') return val.sym().toString()
  if (kind === 'scvString') return val.str().toString()
  if (kind === 'scvAddress') {
    const strkey = decodeScAddressToAnyStrkey(val.address())
    return strkey ?? `<unparsed-address:${kind}>`
  }
  if (kind === 'scvU64') return u64PartsToBigInt(val.u64()).toString()
  if (kind === 'scvU32') return val.u32().toString()
  if (kind === 'scvI128') return i128PartsToBigInt(val.i128()).toString()
  if (kind === 'scvBytes') return Buffer.from(val.bytes() as Uint8Array).toString('hex')
  return `<${kind}>`
}

/** Convert a Map<Symbol, ...> key ScVal to the string used in the normalised
 *  ScVal map representation. Uses the same string-form rule as
 *  `scValToTopicString` so SAC/SEP-41 event Map keys ("amount", "to_muxed_id")
 *  resolve to the same string in both the topic path and the map-entry path.
 *  Non-symbol / non-string keys record an opaque diagnostic and return a
 *  placeholder so the Map entry is still carried forward. */
function mapKeyToString(
  val: xdr.ScVal,
  path: string,
  opaqueScVals: ParseConfidence['opaqueScVals']
): string {
  const kind = val.switch().name
  if (kind === 'scvSymbol') return val.sym().toString()
  if (kind === 'scvString') return val.str().toString()
  if (kind === 'scvU64') return u64PartsToBigInt(val.u64()).toString()
  if (kind === 'scvU32') return val.u32().toString()
  if (kind === 'scvI128') return i128PartsToBigInt(val.i128()).toString()
  if (kind === 'scvBytes') return Buffer.from(val.bytes() as Uint8Array).toString('hex')
  opaqueScVals.push({ path, type: `unsupported-map-key:${kind}` })
  return `<${kind}>`
}

/** Build the OnChainEvent[] view from raw contract events. Diagnostic-only:
 *  captures the topics + data + emitter contract for the downstream
 *  validator. */
export function contractEventsToOnChainEvents(
  contractEvents: xdr.ContractEvent[][]
): OnChainEvent[] {
  const out: OnChainEvent[] = []
  for (const group of contractEvents) {
    for (const evt of group) {
      const body = evt.body().v0()
      const emitter = evt.contractId()
        ? Address.contract(Buffer.from(evt.contractId() as unknown as Uint8Array)).toString()
        : ''
      const topics = body.topics().map((t: xdr.ScVal) => scValToTopicString(t))
      const data = scValToSubset(body.data(), 'event.data', [])
      out.push({ contract: emitter, topics, data })
    }
  }
  return out
}

/** Build the OnChainEvent[] view from TransactionEvent[] (which wraps
 *  ContractEvent with a stage). Same shape as above. */
export function transactionEventsToOnChainEvents(txEvents: xdr.TransactionEvent[]): OnChainEvent[] {
  const contractEvents = txEvents.map((e) => [e.event()])
  return contractEventsToOnChainEvents(contractEvents)
}

/** Tiny typed error so callers can `instanceof DecodeError` without leaking
 *  SDK internals. */
export class DecodeError extends Error {
  override readonly name = 'DecodeError'
}

/** Helper used by validate.ts to map a TokenMovement back to a search key
 *  without re-parsing (the validate module must cross-check against the raw
 *  events, NOT against the parse). */
export function tokenMovementKey(m: TokenMovement): string {
  return `${m.token}|${m.from}|${m.to}|${m.amount}`
}
