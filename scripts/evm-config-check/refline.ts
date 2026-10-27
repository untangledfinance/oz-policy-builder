// Runs the Prime reference line on Base Sepolia, or on a local anvil fork of it.
//
// Each phase of script/RefLine.s.sol (setup, schedule, move, recover) first runs as a forge
// simulation against the chain: it checks every step and writes the phase's transactions to a plan.
// This driver then sends each planned transaction from the key it names, waits for its receipt and
// checks that it landed as planned: status 1 for a move, status 0 for a refusal, with the revert data
// the simulation predicted (read again with eth_call just before sending, and replayed against the
// block before it after). Before the move and recover phases it waits out the timelock delay. Every
// transaction, its hash, block, gas and fee go to refline/<mode>-run.json.
//
//   anvil --fork-url https://sepolia.base.org --port 8547 --chain-id 84532
//   KEYS=/path/keys.json bun refline.ts                       # MODE=anvil, RPC=http://127.0.0.1:8547
//   KEYS=/path/keys.json MODE=live RPC=https://sepolia.base.org bun refline.ts
//
// KEYS names a JSON file of throwaway keys, { role: { address, privateKey } } for deployer, custody1
// to custody3, prime1 to prime3, agent, trustee and stranger. Keep it outside the repository. Base
// Sepolia (84532) only: any other chain is refused.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE_SEPOLIA = 84532
const SAFE_141 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' // SafeL2 1.4.1
const ROLES_211 = '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5' // Zodiac Roles v2.1.1 mastercopy
const MODE = process.env.MODE ?? 'anvil'
const RPC = process.env.RPC ?? 'http://127.0.0.1:8547'
const KEYS = process.env.KEYS
const MOVE_DELAY = Number(process.env.MOVE_DELAY ?? '120')
const DELAY = Number(process.env.DELAY ?? '300')
const PHASES = (process.env.PHASES ?? 'setup,schedule,move,recover').split(',')
const DIR = join(import.meta.dir, 'refline')
const STATE = join(DIR, `${MODE}-state.json`)
const RUN = join(DIR, `${MODE}-run.json`)
// a refusal cannot be estimated, so it is sent with a fixed gas limit; the fee is Base-like: a small tip
// over twice the base fee (an RPC's suggested tip can be far higher on a fork)
const REFUSED_GAS = '1000000'
const TIP = BigInt(process.env.TIP_WEI ?? '1000000')

if (MODE !== 'anvil' && MODE !== 'live') throw new Error(`MODE must be anvil or live, not ${MODE}`)
if (!KEYS) throw new Error('KEYS must name the throwaway key file (kept outside the repository)')
for (const [name, v] of [
  ['MOVE_DELAY', MOVE_DELAY],
  ['DELAY', DELAY],
] as const) {
  if (!Number.isInteger(v) || v < 60)
    throw new Error(`${name} must be a whole number of seconds, 60 or more`)
}

type Key = { address: string; privateKey: string }
const keys: Record<string, Key> = JSON.parse(readFileSync(KEYS, 'utf8'))
for (const role of ['deployer', 'agent', 'stranger', 'trustee', 'custody1', 'prime1']) {
  if (!keys[role]?.privateKey) throw new Error(`KEYS has no ${role}`)
}

type Planned = {
  n: number
  label: string
  from: string
  to: string
  value: string
  data: string
  expect: 'ok' | 'revert'
  revert: string
  created: string
  clock: '' | 'move' | 'recovery'
}
type Sent = {
  phase: string
  n: number
  label: string
  from: string
  role: string
  to: string
  hash: string
  block: number
  time: number
  clock?: string
  status: number
  gasUsed: number
  effectiveGasPrice: string
  l1Fee: string | null
  l1FeeEstimate: string | null
  created?: string
  revert?: string
  refusal?: string
}

let rpcId = 0
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      })
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
      const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } }
      if (body.error) {
        const err = new Error(`${method}: ${body.error.message}`) as Error & { data?: unknown }
        err.data = body.error.data
        throw err
      }
      return body.result as T
    } catch (e) {
      const data = (e as { data?: unknown }).data
      if (data !== undefined || attempt >= 4) throw e
      await Bun.sleep(1000 * (attempt + 1))
    }
  }
}

/// The revert data of a call, or null if it succeeds.
async function revertOf(
  from: string,
  to: string,
  data: string,
  block = 'latest'
): Promise<string | null> {
  try {
    await rpc('eth_call', [{ from, to, data }, block])
    return null
  } catch (e) {
    const d = (e as { data?: unknown }).data
    if (typeof d === 'string') return d.toLowerCase()
    if (d && typeof d === 'object' && 'data' in d)
      return String((d as { data: string }).data).toLowerCase()
    throw e
  }
}

function run(cmd: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, {
    cwd: import.meta.dir,
    env: { ...process.env, FORK_URL: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = p.stdout.toString()
  if (p.exitCode !== 0) {
    throw new Error(
      `${cmd.slice(0, 3).join(' ')} failed (${p.exitCode}):\n${out}\n${p.stderr.toString()}`
    )
  }
  return out.trim()
}

// ------------------------------------------------------------------ revert data, decoded

const ROLES_STATUS = [
  'Ok',
  'DelegateCallNotAllowed',
  'TargetAddressNotAllowed',
  'FunctionNotAllowed',
  'SendNotAllowed',
  'OrViolation',
  'NorViolation',
  'ParameterNotAllowed',
  'ParameterLessThanAllowed',
  'ParameterGreaterThanAllowed',
  'ParameterNotAMatch',
  'NotEveryArrayElementPasses',
  'NoArrayElementPasses',
  'ParameterNotSubsetOfAllowed',
  'BitmaskOverflow',
  'BitmaskNotAllowed',
  'CustomConditionViolation',
  'AllowanceExceeded',
  'CallAllowanceExceeded',
  'EtherAllowanceExceeded',
]
const ERRORS: Record<string, string> = {
  '0xfd8e9f28': 'NoMembership()',
  '0x4a0bfec1': 'NotAuthorized(address)',
  '0xd27b44a9': 'ModuleTransactionFailed()',
  '0x118cdaa7': 'OwnableUnauthorizedAccount(address)',
  '0xe2517d3f': 'AccessControlUnauthorizedAccount(address,bytes32)',
  '0x5ead8eb5': 'TimelockUnexpectedOperationState(bytes32,bytes32)',
  '0xe2850c59': 'TimelockUnauthorizedCaller(address)',
  '0x4684c122': 'FunctionSignatureTooShort()',
  '0x742638b4': 'CalldataOutOfBounds()',
}

export function decodeRevert(data: string): string {
  const sel = data.slice(0, 10)
  if (sel === '0xd0a9bf58' && data.length === 2 + 8 + 128) {
    const status = Number.parseInt(data.slice(10, 74), 16)
    return `ConditionViolation(${status} ${ROLES_STATUS[status] ?? '?'})`
  }
  if (sel === '0x08c379a0') {
    const len = Number.parseInt(data.slice(74, 138), 16)
    return `Error("${Buffer.from(data.slice(138, 138 + 2 * len), 'hex').toString('utf8')}")`
  }
  return ERRORS[sel] ?? `unknown ${sel}`
}

// ------------------------------------------------------------------ sending

async function l1FeeEstimate(raw: string): Promise<string | null> {
  // Base's GasPriceOracle predeploy: getL1Fee(bytes) for the signed transaction (a slight overestimate).
  const len = (raw.length - 2) / 2
  const data =
    '0x49948e0e' +
    (32).toString(16).padStart(64, '0') +
    len.toString(16).padStart(64, '0') +
    raw.slice(2).padEnd(Math.ceil(len / 32) * 64, '0')
  try {
    const r = await rpc<string>('eth_call', [
      { to: '0x420000000000000000000000000000000000000F', data },
      'latest',
    ])
    return BigInt(r).toString()
  } catch {
    return null
  }
}

async function receipt(hash: string): Promise<Record<string, string>> {
  for (let i = 0; i < 180; i++) {
    const r = await rpc<Record<string, string> | null>('eth_getTransactionReceipt', [hash])
    if (r) return r
    await Bun.sleep(1000)
  }
  throw new Error(`no receipt for ${hash}`)
}

async function send(phase: string, p: Planned): Promise<Sent> {
  const key = keys[p.from]
  if (!key) throw new Error(`no key for ${p.from}`)
  const tag = `${phase}#${p.n} ${p.label}`
  const head = await rpc<{ baseFeePerGas: string }>('eth_getBlockByNumber', ['latest', false])
  const maxFee = 2n * BigInt(head.baseFeePerGas) + TIP
  const args = [
    'cast',
    'mktx',
    '--private-key',
    key.privateKey,
    '--rpc-url',
    RPC,
    '--priority-gas-price',
    TIP.toString(),
    '--gas-price',
    maxFee.toString(),
  ]
  let observed: string | null = null
  if (p.expect === 'revert') {
    observed = await revertOf(key.address, p.to, p.data)
    if (observed !== p.revert.toLowerCase()) {
      throw new Error(`${tag}: eth_call gives ${observed}, the plan ${p.revert}`)
    }
    args.push('--gas-limit', REFUSED_GAS)
  }
  if (p.to === '') args.push('--create', p.data)
  else args.push(p.to, ...(p.data === '0x' ? [] : [p.data]))
  if (p.value !== '0') args.push('--value', p.value)
  const raw = run(args)
  const hash = run(['cast', 'keccak', raw])
  const l1 = await l1FeeEstimate(raw)
  await rpc('eth_sendRawTransaction', [raw])
  const r = await receipt(hash)
  const status = Number(r.status)
  const want = p.expect === 'ok' ? 1 : 0
  if (status !== want) throw new Error(`${tag}: status ${status}, planned ${want} (${hash})`)
  if (p.created && r.contractAddress?.toLowerCase() !== p.created.toLowerCase()) {
    throw new Error(`${tag}: created ${r.contractAddress}, planned ${p.created}`)
  }
  const block = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [r.blockNumber, false])
  const sent: Sent = {
    phase,
    n: p.n,
    label: p.label,
    from: key.address,
    role: p.from,
    to: p.to || (r.contractAddress ?? ''),
    hash,
    block: Number(r.blockNumber),
    time: Number(block.timestamp),
    status,
    gasUsed: Number(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice).toString(),
    l1Fee: r.l1Fee ? BigInt(r.l1Fee).toString() : null,
    l1FeeEstimate: l1,
  }
  if (p.created) sent.created = r.contractAddress
  if (p.clock) sent.clock = p.clock
  if (observed) {
    // the same call against the state of the block before, after the fact
    const replay = await revertOf(
      key.address,
      p.to,
      p.data,
      `0x${(sent.block - 1).toString(16)}`
    ).catch(() => observed)
    if (replay !== observed)
      throw new Error(`${tag}: replay at block ${sent.block - 1} gives ${replay}`)
    sent.revert = observed
    sent.refusal = decodeRevert(observed)
  }
  const shown = sent.refusal ? ` refused ${sent.refusal}` : ''
  console.log(`${tag}: ${hash} block ${sent.block} gas ${sent.gasUsed}${shown}`)
  return sent
}

// ------------------------------------------------------------------ phases

const checkCounts: Record<string, number> = {}
const SIGS: Record<string, string> = {
  setup: 'setupPhase()',
  schedule: 'schedulePhase()',
  move: 'movePhase()',
  recover: 'recoverPhase()',
}
// the timelock whose delay must pass before a phase
const WAITS: Record<string, { clock: 'move' | 'recovery'; delay: number }> = {
  move: { clock: 'move', delay: MOVE_DELAY },
  recover: { clock: 'recovery', delay: DELAY },
}

function simulate(phase: string): Planned[] {
  const plan = join(DIR, `${MODE}-${phase}.plan.jsonl`)
  const keysJson = JSON.stringify(
    Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, { privateKey: k.privateKey }]))
  )
  run(
    ['forge', 'script', 'script/RefLine.s.sol:RefLine', '--sig', SIGS[phase], '--fork-url', RPC],
    { KEYS_JSON: keysJson, PLAN: plan, STATE, MOVE_DELAY: String(MOVE_DELAY), DELAY: String(DELAY) }
  )
  const lines = readFileSync(plan, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
  const checks = lines.find((l) => 'checks' in l)?.checks
  if (typeof checks !== 'number') throw new Error(`${phase}: the simulation wrote no check count`)
  console.log(`${phase}: simulation passed, ${checks} checks`)
  checkCounts[phase] = checks
  return lines.filter((l) => !('checks' in l)) as Planned[]
}

/// Waits until the chain's clock is past the last schedule on `clock` plus its delay.
async function waitFor(txs: Sent[], clock: 'move' | 'recovery', delay: number): Promise<void> {
  const last = Math.max(
    ...txs.filter((t) => t.clock === clock && t.status === 1).map((t) => t.time)
  )
  if (!Number.isFinite(last)) throw new Error(`nothing was scheduled on the ${clock} timelock`)
  const ready = last + delay + 2
  for (;;) {
    const head = await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false])
    const now = Number(head.timestamp)
    if (now > ready) return
    if (MODE === 'anvil') {
      await rpc('evm_increaseTime', [ready - now + 1])
      await rpc('evm_mine', [])
      console.log(`anvil: clock moved ${ready - now + 1} s for the ${clock} delay`)
    } else {
      console.log(`waiting ${ready - now} s for the ${clock} delay`)
      await Bun.sleep(Math.min(ready - now + 2, 30) * 1000)
    }
  }
}

/// What each address of the line runs: no contract of ours. The Safes are proxies whose singleton
/// (storage slot 0) is the canonical SafeL2, the gate and the band module are 45-byte ERC-1167 proxies of
/// the Roles v2.1.1 mastercopy, and each timelock's runtime equals TimelockController 5.6.0 as forge
/// built it from the npm package.
async function codeCheck(state: Record<string, string>): Promise<Record<string, unknown>> {
  const artifact = JSON.parse(
    readFileSync(
      join(import.meta.dir, 'out/TimelockController.sol/TimelockController.json'),
      'utf8'
    )
  ) as { deployedBytecode: { object: string } }
  const built = run(['cast', 'keccak', artifact.deployedBytecode.object])
  const out: Record<string, unknown> = {}
  for (const name of [
    'custody',
    'prime',
    'gate',
    'primeRoles',
    'moveTimelock',
    'recoveryTimelock',
  ]) {
    const address = state[name]
    const code = await rpc<string>('eth_getCode', [address, 'latest'])
    const entry: Record<string, unknown> = {
      address,
      bytes: (code.length - 2) / 2,
      codeHash: run(['cast', 'keccak', code]),
    }
    if (name === 'custody' || name === 'prime') {
      const slot0 = await rpc<string>('eth_getStorageAt', [address, '0x0', 'latest'])
      entry.singleton = `0x${slot0.slice(-40)}`
      if (entry.singleton !== SAFE_141.toLowerCase())
        throw new Error(`${name}: singleton ${entry.singleton}`)
    } else if (name === 'gate' || name === 'primeRoles') {
      entry.implementation = `0x${code.slice(22, 62)}`
      if (code.length !== 92 || entry.implementation !== ROLES_211.toLowerCase()) {
        throw new Error(`${name}: not a proxy of the Roles mastercopy`)
      }
    } else {
      entry.equalsTimelockController560 = entry.codeHash === built
      if (!entry.equalsTimelockController560)
        throw new Error(`${name}: runtime differs from the build`)
    }
    out[name] = entry
  }
  out.timelockController560Build = built
  return out
}

async function main(): Promise<void> {
  const chainId = Number(await rpc<string>('eth_chainId', []))
  if (chainId !== BASE_SEPOLIA) throw new Error(`chain ${chainId} is not Base Sepolia; refusing`)
  mkdirSync(DIR, { recursive: true })
  if (MODE === 'anvil') {
    await rpc('anvil_setBalance', [keys.deployer.address, '0xde0b6b3a7640000'])
  }
  const log: { txs: Sent[]; [k: string]: unknown } = (() => {
    try {
      return JSON.parse(readFileSync(RUN, 'utf8'))
    } catch {
      return { txs: [] }
    }
  })()
  log.network = 'base-sepolia'
  log.chainId = chainId
  log.mode =
    MODE === 'anvil' ? 'anvil fork of Base Sepolia (not on chain)' : 'Base Sepolia, on chain'
  log.moveDelay = MOVE_DELAY
  log.recoveryDelay = DELAY
  log.deployer = keys.deployer.address
  for (const phase of PHASES.filter((p) => p !== '')) {
    if (!SIGS[phase]) throw new Error(`unknown phase ${phase}`)
    const wait = WAITS[phase]
    if (wait) await waitFor(log.txs, wait.clock, wait.delay)
    if (phase === 'setup') {
      log.forkBlock = Number(await rpc<string>('eth_blockNumber', []))
      log.started = new Date().toISOString()
    }
    log.txs = log.txs.filter((t) => t.phase !== phase)
    for (const p of simulate(phase)) {
      log.txs.push(await send(phase, p))
      writeFileSync(RUN, `${JSON.stringify(log, null, 2)}\n`)
    }
    log.state = JSON.parse(readFileSync(STATE, 'utf8'))
  }
  if (log.state) log.code = await codeCheck(log.state as Record<string, string>)
  const gas = log.txs.reduce((a, t) => a + t.gasUsed, 0)
  const l2 = log.txs.reduce((a, t) => a + BigInt(t.gasUsed) * BigInt(t.effectiveGasPrice), 0n)
  const l1 = log.txs.reduce((a, t) => a + BigInt(t.l1Fee ?? t.l1FeeEstimate ?? '0'), 0n)
  log.totals = {
    txs: log.txs.length,
    moves: log.txs.filter((t) => t.status === 1).length,
    refused: log.txs.filter((t) => t.status === 0).length,
    gasUsed: gas,
    l2FeeWei: l2.toString(),
    l1FeeWei: l1.toString(),
    l1FeeIs: log.txs.every((t) => t.l1Fee) ? 'charged' : 'estimated with GasPriceOracle.getL1Fee',
  }
  log.checks = { ...(log.checks as Record<string, number> | undefined), ...checkCounts }
  log.finished = new Date().toISOString()
  writeFileSync(RUN, `${JSON.stringify(log, null, 2)}\n`)
  console.log(JSON.stringify(log.totals))
}

if (import.meta.main) await main()
