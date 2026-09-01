//! Reading an OpenZeppelin smart account's context rules back off chain.
//!
//! `authority-overlap.ts` needs to know what a signer can already do before a
//! new policy is installed. That means every rule on the account: its context
//! type, its signers, its attached policies, and - for rules our interpreter
//! polices - the predicate itself.
//!
//! Without this, the overlap scan can only report on rules the CALLER supplied,
//! which means it answers "what did you tell me about" rather than "what is on
//! the account". Those are different questions, and only the second one is
//! worth anything to someone deciding whether to sign.
//!
//! The predicate is NOT reachable through a contract call. The interpreter
//! publishes only `grammar_version`, `install`, `enforce`, `uninstall` and
//! `rotate_master_signer_set`, so the stored document is read as a ledger entry
//! instead. That keeps this a purely client-side capability: adding a getter
//! would change a deployed contract's ABI and force a redeploy plus re-audit to
//! obtain data the ledger already exposes.
//!
//! The decoders are pure so they can be tested without a network; the caller
//! supplies raw `ScVal`s.

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { decodePredicate } from '../predicate/decode.ts'
import type { SignerDraft } from '../types.ts'
import type { ContextType, ObservedRule, SpendCap } from './authority-overlap.ts'

/** `storage.rs` - the third element of the persistent doc key tuple. */
export const K_DOC = 1

/** Persistent-storage key for a rule's stored document:
 *  `(account, rule_id, K_DOC)`. */
export function docKeyScVal(smartAccount: string, ruleId: number): xdr.ScVal {
  return xdr.ScVal.scvVec([
    new Address(smartAccount).toScVal(),
    xdr.ScVal.scvU32(ruleId),
    xdr.ScVal.scvU32(K_DOC),
  ])
}

/** Ledger key for the interpreter's persistent entry holding that document. */
export function docLedgerKey(
  interpreter: string,
  smartAccount: string,
  ruleId: number
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(interpreter).toScAddress(),
      key: docKeyScVal(smartAccount, ruleId),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
}

// ---- ScVal helpers -----

/** Field of a `#[contracttype]` struct, which the host encodes as a map keyed
 *  by field-name symbol. Returns undefined when the field is absent so a
 *  caller can distinguish "not there" from "there and empty". */
function mapField(v: xdr.ScVal, name: string): xdr.ScVal | undefined {
  if (v.switch() !== xdr.ScValType.scvMap()) return undefined
  for (const entry of v.map() ?? []) {
    const key = entry.key()
    if (key.switch() === xdr.ScValType.scvSymbol() && key.sym().toString() === name) {
      return entry.val()
    }
  }
  return undefined
}

function u32Of(v: xdr.ScVal | undefined): number | undefined {
  return v?.switch() === xdr.ScValType.scvU32() ? v.u32() : undefined
}

function addressOf(v: xdr.ScVal | undefined): string | undefined {
  if (!v || v.switch() !== xdr.ScValType.scvAddress()) return undefined
  return Address.fromScAddress(v.address()).toString()
}

/** An enum variant of a `#[contracttype]` enum: `ScVal::Vec([Symbol, ...args])`. */
function enumVariant(v: xdr.ScVal | undefined): { tag: string; args: xdr.ScVal[] } | undefined {
  if (!v || v.switch() !== xdr.ScValType.scvVec()) return undefined
  const items = v.vec() ?? []
  const head = items[0]
  if (!head || head.switch() !== xdr.ScValType.scvSymbol()) return undefined
  return { tag: head.sym().toString(), args: items.slice(1) }
}

// ---- decoders -----

/** OZ `ContextRuleType`. An unrecognised tag is reported as `default`, which
 *  is the widest reading and therefore the safe one: it makes the rule look
 *  like it could serve any call, so overlap is over-reported, never missed. */
export function decodeContextType(v: xdr.ScVal | undefined): ContextType {
  const variant = enumVariant(v)
  if (!variant) return { kind: 'default' }
  if (variant.tag === 'CallContract') {
    const addr = addressOf(variant.args[0])
    return addr ? { kind: 'call_contract', contract: addr } : { kind: 'default' }
  }
  if (variant.tag === 'CreateContract') {
    const arg = variant.args[0]
    const hash = arg?.switch() === xdr.ScValType.scvBytes() ? arg.bytes().toString('hex') : ''
    return { kind: 'create_contract', wasmHash: hash }
  }
  return { kind: 'default' }
}

/** OZ `Signer::Delegated(Address) | Signer::External(Address, Bytes)`. */
export function decodeSigner(v: xdr.ScVal): SignerDraft | undefined {
  const variant = enumVariant(v)
  if (!variant) return undefined
  if (variant.tag === 'Delegated') {
    const addr = addressOf(variant.args[0])
    return addr ? { kind: 'delegated', address: addr } : undefined
  }
  if (variant.tag === 'External') {
    const verifier = addressOf(variant.args[0])
    const keyArg = variant.args[1]
    const keyBytes =
      keyArg?.switch() === xdr.ScValType.scvBytes() ? keyArg.bytes().toString('hex') : ''
    return verifier ? { kind: 'external', verifier, keyBytes } : undefined
  }
  return undefined
}

/** A full OZ `ContextRule` as returned by `get_context_rule(id)`.
 *  `predicate` is filled in separately from the ledger entry. */
export function decodeContextRule(v: xdr.ScVal): ObservedRule | undefined {
  const id = u32Of(mapField(v, 'id'))
  if (id === undefined) return undefined

  const signersVal = mapField(v, 'signers')
  const signers: SignerDraft[] = []
  if (signersVal?.switch() === xdr.ScValType.scvVec()) {
    for (const s of signersVal.vec() ?? []) {
      const decoded = decodeSigner(s)
      if (decoded) signers.push(decoded)
    }
  }

  const policiesVal = mapField(v, 'policies')
  const policyAddresses: string[] = []
  if (policiesVal?.switch() === xdr.ScValType.scvVec()) {
    for (const p of policiesVal.vec() ?? []) {
      const addr = addressOf(p)
      if (addr) policyAddresses.push(addr)
    }
  }

  return {
    id,
    contextType: decodeContextType(mapField(v, 'context_type')),
    signers,
    policyAddresses,
  }
}

/** The interpreter's `StoredDoc { predicate_bytes }`. */
export function decodeStoredPredicateBytes(v: xdr.ScVal): Buffer | undefined {
  const field = mapField(v, 'predicate_bytes')
  if (!field || field.switch() !== xdr.ScValType.scvBytes()) return undefined
  return field.bytes()
}

/** Persistent-storage key for a rule's spend-cap data:
 *  `SpendingLimitStorageKey::AccountContext(account, rule_id)`, which the host
 *  encodes as an enum variant - the symbol first, then the payload. */
export function spendCapKeyScVal(smartAccount: string, ruleId: number): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('AccountContext'),
    new Address(smartAccount).toScVal(),
    xdr.ScVal.scvU32(ruleId),
  ])
}

/** Ledger key for the OZ spend cap's own persistent entry. The policy exposes
 *  `get_spending_limit_data`, but that PANICS when nothing is installed, and a
 *  panic is indistinguishable from an RPC fault at the call site. Reading the
 *  entry lets "no cap here" come back as an absence instead. */
export function spendCapLedgerKey(
  spendingLimit: string,
  smartAccount: string,
  ruleId: number
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(spendingLimit).toScAddress(),
      key: spendCapKeyScVal(smartAccount, ruleId),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
}

/** `SpendingLimitData`, of which only the two installed parameters matter here.
 *  The running total and the history are deliberately ignored: they say what
 *  has been spent so far, which changes every call, while the scan is about
 *  what the rule PERMITS. */
export function decodeSpendCap(v: xdr.ScVal): SpendCap | undefined {
  const periodLedgers = u32Of(mapField(v, 'period_ledgers'))
  const limit = mapField(v, 'spending_limit')
  if (periodLedgers === undefined || !limit) return undefined
  if (limit.switch() !== xdr.ScValType.scvI128()) return undefined
  const amount = scValToNative(limit)
  if (typeof amount !== 'bigint') return undefined
  return { amount: amount.toString(), periodLedgers }
}

// ---- collection -----

/** The three reads the scan needs. Kept as an interface so the collection
 *  below is testable without a network. */
export interface AccountRuleReader {
  /** OZ `get_context_rules_count()`. */
  getContextRuleCount(smartAccount: string): Promise<number>
  /** OZ `get_context_rule(id)`. Undefined when the id is absent. */
  getContextRule(smartAccount: string, ruleId: number): Promise<xdr.ScVal | undefined>
  /** The interpreter's persistent `StoredDoc` entry, read as a ledger entry.
   *  Undefined when no document is stored for that rule. */
  getStoredDoc(
    interpreter: string,
    smartAccount: string,
    ruleId: number
  ): Promise<xdr.ScVal | undefined>
  /** The OZ spend cap's persistent entry for this rule, read as a ledger entry.
   *  Optional so an existing reader keeps working: without it the scan simply
   *  reports no cap parameters, which is the same as it behaved before. */
  getSpendCapData?(
    spendingLimit: string,
    smartAccount: string,
    ruleId: number
  ): Promise<xdr.ScVal | undefined>
}

/** How far the id scan will probe before giving up. OZ imposes no per-account
 *  rule cap, so there is no exact bound to derive; this one is far above any
 *  realistic account and keeps a malformed `Count` from spinning forever. */
export const MAX_RULE_ID_SCAN = 512

export interface CollectedRules {
  rules: ObservedRule[]
  /** Rule ids whose stored predicate could not be read even though the
   *  interpreter is attached. Such a rule is reported without a predicate,
   *  which classifies it as opaque rather than as safely narrow. */
  unreadablePredicateRuleIds: number[]
  /** True when the scan stopped before accounting for every live rule. The
   *  result is then a SUBSET of the account's rules, so an empty overlap list
   *  proves nothing and the caller must not present it as safety. */
  incomplete: boolean
}

/**
 * Every context rule on the account, with predicates filled in for the rules
 * our interpreter polices.
 *
 * Rule ids are NOT contiguous. OZ assigns them from a monotonic `NextId` and
 * decrements `Count` on removal without ever reusing an id, so after any
 * removal `Count < NextId` and the live ids have gaps. Iterating `0..Count-1`
 * would silently skip live rules at higher ids, and a skipped rule is a missed
 * overlap - the one error that reports safety which does not exist. Instead the
 * scan walks ids upward until it has accounted for `Count` live rules.
 *
 * A rule whose predicate cannot be read is deliberately left without one. That
 * demotes it to the `foreign` class, so the scan reports it as opaque instead
 * of assuming it is narrow.
 */
export async function collectObservedRules(args: {
  reader: AccountRuleReader
  smartAccount: string
  interpreterAddress: string
  /** The pinned OZ spend cap. Supplying it fills in the PARAMETERS of a
   *  neighbour's cap; whether one is attached at all is decided from the
   *  rule's policy addresses and does not depend on this read succeeding. */
  spendingLimitAddress?: string
  maxRuleIdScan?: number
}): Promise<CollectedRules> {
  const count = await args.reader.getContextRuleCount(args.smartAccount)
  const limit = args.maxRuleIdScan ?? MAX_RULE_ID_SCAN
  const rules: ObservedRule[] = []
  const unreadablePredicateRuleIds: number[] = []

  let id = 0
  while (rules.length < count && id < limit) {
    const raw = await args.reader.getContextRule(args.smartAccount, id)
    id++
    if (!raw) continue
    const rule = decodeContextRule(raw)
    if (!rule) continue

    if (rule.policyAddresses.includes(args.interpreterAddress)) {
      const doc = await args.reader.getStoredDoc(
        args.interpreterAddress,
        args.smartAccount,
        rule.id
      )
      const bytes = doc ? decodeStoredPredicateBytes(doc) : undefined
      if (bytes) {
        try {
          rule.predicate = decodePredicate(bytes)
        } catch {
          unreadablePredicateRuleIds.push(rule.id)
        }
      } else {
        unreadablePredicateRuleIds.push(rule.id)
      }
    }

    const spendCapAddress = args.spendingLimitAddress
    if (spendCapAddress !== undefined && rule.policyAddresses.includes(spendCapAddress)) {
      const data = await args.reader.getSpendCapData?.(spendCapAddress, args.smartAccount, rule.id)
      const cap = data ? decodeSpendCap(data) : undefined
      // An unreadable cap is left absent rather than guessed at. The rule still
      // counts as capped, because attachment came from its policy addresses,
      // so failing this read weakens the REPORT and never the refusal.
      if (cap) rule.spendCap = cap
    }
    rules.push(rule)
  }

  return { rules, unreadablePredicateRuleIds, incomplete: rules.length < count }
}

/**
 * An `AccountRuleReader` over a live RPC server.
 *
 * The two OZ getters are read-only simulations: the source account is
 * constructed locally because a simulation never checks its sequence number,
 * and asking the network for a random key would 404.
 *
 * The stored document is fetched as a ledger entry rather than a contract
 * call, because the interpreter publishes no getter for it.
 */
export function accountRuleReaderFromServer(
  server: rpc.Server,
  networkPassphrase: string
): AccountRuleReader {
  async function simulateCall(
    contract: string,
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<xdr.ScVal | undefined> {
    const account = new Account(Keypair.random().publicKey(), '0')
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build()
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) return undefined
    return sim.result?.retval
  }

  return {
    async getContextRuleCount(smartAccount) {
      const val = await simulateCall(smartAccount, 'get_context_rules_count')
      return u32Of(val) ?? 0
    },
    async getContextRule(smartAccount, ruleId) {
      return simulateCall(smartAccount, 'get_context_rule', xdr.ScVal.scvU32(ruleId))
    },
    async getStoredDoc(interpreter, smartAccount, ruleId) {
      const key = docLedgerKey(interpreter, smartAccount, ruleId)
      const res = await server.getLedgerEntries(key)
      const entry = res.entries?.[0]?.val
      if (!entry || entry.switch() !== xdr.LedgerEntryType.contractData()) return undefined
      return entry.contractData().val()
    },
    async getSpendCapData(spendingLimit, smartAccount, ruleId) {
      const key = spendCapLedgerKey(spendingLimit, smartAccount, ruleId)
      const res = await server.getLedgerEntries(key)
      const entry = res.entries?.[0]?.val
      if (!entry || entry.switch() !== xdr.LedgerEntryType.contractData()) return undefined
      return entry.contractData().val()
    },
  }
}
