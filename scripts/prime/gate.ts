// `prime gate` - the client-owned gatekeeper: Gates 1 and 2.
//
// The gatekeeper holds the spending limit the custody account approves, and
// the list of addresses funds may reach. It has no admin and no setter, so
// changing the list means deploying another one and re-approving.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Address, Asset, hash, Operation, scValToNative, xdr } from '@stellar/stellar-sdk'
import {
  addr,
  C,
  custodyPk,
  i128v,
  invokeOp,
  kv,
  LIMIT,
  loadState,
  PASSPHRASE,
  readCall,
  STATE_PATH,
  type State,
  secrets,
  send,
  server,
  u32v,
  vec,
  wasmPath,
} from './chain.ts'

type Flags = Record<string, string | boolean>

const need = (f: Flags, k: string): string => {
  const v = f[k]
  if (typeof v !== 'string' || !v) throw new Error(`--${k} is required`)
  return v
}

/** Addresses are the whole point of this contract, so reject anything that is
 *  not one rather than deploying a gate that can never release funds. */
function parseAllowList(raw: string): string[] {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length) throw new Error('--allow-list is empty')
  for (const a of list) {
    try {
      Address.fromString(a)
    } catch {
      throw new Error(`not a Stellar address: ${a}`)
    }
  }
  return [...new Set(list)]
}

export async function gateSetup(flags: Flags): Promise<void> {
  const dry = flags['dry-run'] === true
  const allowed = parseAllowList(need(flags, 'allow-list'))
  const limit = flags.limit ? BigInt(String(flags.limit)) : LIMIT
  const expiresIn = flags['expires-in'] ? Number(flags['expires-in']) : 6000

  // The caller is the only address the gate answers to. It defaults to the
  // adapter from a previous `prime demo setup`, because that is what Blend
  // actually spends from.
  let caller = typeof flags.caller === 'string' ? flags.caller : undefined
  let prior: State | undefined
  if (existsSync(STATE_PATH)) {
    prior = loadState()
    caller ??= prior.adapter
  }
  if (!caller)
    throw new Error('--caller is required (no scripts/.demo-state.json to take an adapter from)')

  const s = secrets()
  const sac = Asset.native().contractId(PASSPHRASE)
  const latest = await server.getLatestLedger()
  const expiry = latest.sequence + expiresIn

  console.log(C.bold('\nGatekeeper'))
  console.log(`  ${C.dim('custody'.padEnd(18, '.'))} ${custodyPk()}`)
  console.log(`  ${C.dim('caller'.padEnd(18, '.'))} ${caller}`)
  console.log(`  ${C.dim('allow-list'.padEnd(18, '.'))} ${allowed.length} address(es)`)
  for (const a of allowed) console.log(`  ${C.dim(''.padEnd(18))} ${a}`)
  console.log(`  ${C.dim('spending limit'.padEnd(18, '.'))} ${limit}`)
  console.log(`  ${C.dim('expires at'.padEnd(18, '.'))} ledger ${expiry} (${expiresIn} from now)`)

  if (dry) {
    console.log(
      `\n  ${C.amber('DRY RUN')}  would deploy the gatekeeper and approve the limit to it.`
    )
    console.log(`  ${C.dim('')}         Nothing was sent to the network.`)
    return
  }

  const wasm = readFileSync(wasmPath('custody-gate', 'custody_gate'))
  await await send(s.admin, Operation.uploadContractWasm({ wasm }), 'upload gate')
  const res = await send(
    s.admin,
    Operation.createCustomContract({
      address: Address.fromString(s.admin.publicKey()),
      wasmHash: hash(wasm),
      salt: hash(Buffer.from(`gate-${Date.now()}-${Math.random()}`)),
      constructorArgs: [
        xdr.ScVal.scvMap([
          kv('allowed', vec(allowed.map(addr))),
          kv('caller', addr(caller)),
          kv('custody', addr(custodyPk())),
        ]),
      ],
    }),
    'create gate'
  )
  const gate = Address.fromScVal(res.returnValue!).toString()
  console.log(`\n  deployed ${C.bold(gate)}`)

  await await send(
    s.custody,
    invokeOp(sac, 'approve', [addr(custodyPk()), addr(gate), i128v(limit), u32v(expiry)]),
    'approve gate'
  )
  console.log(`  approved ${limit} to it, expiring at ledger ${expiry}`)

  if (prior) {
    writeFileSync(
      STATE_PATH,
      `${JSON.stringify({ ...prior, gate, allowanceExpiryLedger: expiry }, null, 2)}\n`
    )
    console.log(`  ${C.dim(`updated ${STATE_PATH}`)}`)
  }
  console.log(C.green('\n  Gate 1 and Gate 2 are now in force.'))
}

/** The gate has no getter - deliberately, since it has no admin either - so
 *  its configuration is read straight out of instance storage. */
export async function readGateConfig(
  gate: string
): Promise<{ custody: string; caller: string; allowed: string[] } | undefined> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(gate).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
  const entries = await server.getLedgerEntries(key)
  const storage = entries.entries[0]?.val?.contractData()?.val()?.instance()?.storage()
  const entry = storage?.find((e: any) => e.key().sym?.()?.toString() === 'cfg')
  if (!entry) return undefined
  const cfg: any = scValToNative(entry.val())
  return {
    custody: String(cfg.custody),
    caller: String(cfg.caller),
    allowed: (cfg.allowed ?? []).map((a: any) => String(a)),
  }
}

export async function gateInfo(flags: Flags): Promise<void> {
  const s = loadState()
  const admin = secrets().admin.publicKey()
  const [allowance, latest, cfg] = await Promise.all([
    readCall(s.sac, 'allowance', [addr(custodyPk()), addr(s.gate)], admin),
    server.getLatestLedger(),
    readGateConfig(s.gate),
  ])

  const left = s.allowanceExpiryLedger - latest.sequence
  const out = {
    gate: s.gate,
    custody: custodyPk(),
    caller: cfg?.caller ?? s.adapter,
    allowanceRemaining: String(allowance ?? 0),
    expiresAtLedger: s.allowanceExpiryLedger,
    ledgersRemaining: left,
    allowList: cfg?.allowed ?? [s.adapter],
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2))
    return
  }
  console.log(C.bold('\nGatekeeper'))
  console.log(`  ${C.dim('contract'.padEnd(22, '.'))} ${out.gate}`)
  console.log(`  ${C.dim('holds the limit for'.padEnd(22, '.'))} ${out.custody}`)
  console.log(`  ${C.dim('answers only to'.padEnd(22, '.'))} ${out.caller}`)
  console.log(C.bold('\nGate 1 — how much, until when'))
  console.log(`  ${C.dim('limit remaining'.padEnd(22, '.'))} ${out.allowanceRemaining}`)
  console.log(
    `  ${C.dim('expires'.padEnd(22, '.'))} ledger ${out.expiresAtLedger}  ${
      left > 0 ? `(${left} to go, about ${Math.round((left * 5) / 60)} min)` : C.amber('(expired)')
    }`
  )
  console.log(C.bold('\nGate 2 — where funds may go'))
  for (const a of out.allowList) console.log(`  ${C.dim('allowed'.padEnd(22, '.'))} ${a}`)
  console.log(`  ${C.dim('anything else'.padEnd(22, '.'))} refused by the contract`)
}
