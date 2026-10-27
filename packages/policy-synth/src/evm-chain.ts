// `evm_review` with `readChain`: the unsigned Safe transaction checked against the contracts it
// meets on a test network, read through the operator's RPC. The bytes-only review runs first and is
// unchanged; this adds what only the chain knows: the Safe's owners, threshold, modules, guard and
// fallback handler (after the batch), each Roles module's owner, avatar and target and its code,
// the scopes already stored on the roles the batch touches (an open target, an allowFunction, or a
// stored condition tree that under-reads stays live beside what the batch writes, and a revoked
// target's function scopes wait to come back), the members of those roles, each OpenZeppelin
// TimelockController the batch or its roles name (who holds admin, proposer, canceller, executor,
// and the delay), and each ERC-3643 token's identity registry, freeze and pause state for the Safe.
//
// As for Solana, a pure check runs over a snapshot (`reviewEvmOnChain`) and `readEvmChain` fills it
// in rounds; the snapshot is the answers to the JSON-RPC calls the checks asked, every one at one
// block, so a recorded one replays offline. Storage holds no index of a role's targets, so the read
// probes the roles, targets and functions the transaction names, the addresses its conditions pin,
// and `targets`; and Roles stores an EqualTo value as its hash, which is matched against the
// addresses and words the review knows. Layouts: Safe v1.4.1 (storage slots of the guard and the
// fallback handler), Zodiac Roles v2.1.1 at `218a5164` (Core.sol `roles` at slot 4 of a proxy,
// Types.sol Role and TargetAddress, packers/BufferPacker.sol, WriteOnce.sol), OpenZeppelin
// TimelockController 5.6.0.

import { DecodeError, hex, keccak256 } from './bytes.ts'
import { fact, group, type Node } from './card.ts'
import { Refusal } from './envelope.ts'
import {
  ABI,
  type ConditionFlat,
  decodeArgs,
  EVM,
  type EvmContext,
  type EvmInput,
  type EvmReview,
  EXEC_DEFAULT,
  EXEC_WITH_ROLE,
  encodeArgs,
  reviewEvm,
  roleName,
  scoping,
  selectorOf,
  VENUE,
  ZERO,
} from './evm.ts'
import { type Rpc, RpcError, unread } from './jsonrpc.ts'

/** The networks `readChain` reads: test networks and a local fork. A mainnet is refused. */
export const TESTNETS: Record<number, string> = {
  84532: 'Base Sepolia',
  11155111: 'Sepolia',
  31337: 'a local node',
}
export const evmRpcUrl = (): string =>
  process.env.POLICY_BUILDER_EVM_RPC_URL ?? 'https://sepolia.base.org'

/** Zodiac Roles v2.1.1: `mapping(bytes32 => Role) roles` sits at slot 4 of a proxy's storage
 *  (read off a v2.1.1 proxy's state, and checked in the tests against a scoping it holds). */
export const ROLES_SLOT = 4n
const SENTINEL = '0x0000000000000000000000000000000000000001'
const enc = new TextEncoder()
const kc = (s: string) => `0x${hex(keccak256(enc.encode(s)))}`
/** Safe 1.4.1 storage slots (GuardManager, FallbackManager), and 1.5.0's module guard. */
const SLOT = {
  guard: kc('guard_manager.guard.address'),
  fallback: kc('fallback_manager.handler.address'),
  moduleGuard: kc('module_manager.module_guard.address'),
}
const TIMELOCK_ROLE = {
  admin: `0x${'0'.repeat(64)}`,
  proposer: kc('PROPOSER_ROLE'),
  executor: kc('EXECUTOR_ROLE'),
  canceller: kc('CANCELLER_ROLE'),
} as const
const PROXY_RUNTIME = `0x363d3d373d3d3d363d73${EVM.rolesMastercopy.slice(2)}5af43d82803e903d91602b57fd5bf3`
const CANONICAL_HANDLERS = new Set([
  '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99', // CompatibilityFallbackHandler 1.4.1
  '0x2a15de4410d4c8af0a7b6c12803120f43c42b820', // ExtensibleFallbackHandler 1.5.0
  '0x3efcbb83a4a7afcb4f68d501e2c2203a38be77f4', // CompatibilityFallbackHandler 1.5.0
])

// ---- words ----

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0')
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, '0')
const h32 = (hexs: string) => `0x${hex(keccak256(Buffer.from(hexs, 'hex')))}`
const big = (w: string) => BigInt(w === '0x' ? 0 : w)
const asAddress = (w: string) => `0x${w.slice(-40).toLowerCase()}`
const call = (sig: string, args: string[] = []) => `0x${selectorOf(sig)}${args.join('')}`

/** Storage slots of a Roles proxy (Types.sol Role: members, targets, scopeConfig). */
export const rolesSlot = {
  role: (key: string) => big(h32(`${key.slice(2)}${word(ROLES_SLOT)}`)),
  member: (key: string, a: string) => h32(`${addrWord(a)}${word(rolesSlot.role(key))}`),
  target: (key: string, t: string) => h32(`${addrWord(t)}${word(rolesSlot.role(key) + 1n)}`),
  scope: (key: string, t: string, sel: string) =>
    h32(`${t.slice(2).toLowerCase()}${sel}${'0'.repeat(16)}${word(rolesSlot.role(key) + 2n)}`),
}

/** A scopeConfig header (BufferPacker.sol): count, options, wildcarded, pointer. */
export function header(w: string) {
  const v = big(w)
  return {
    count: Number(v >> 240n),
    options: Number((v >> 224n) & 0xffn),
    wildcarded: ((v >> 216n) & 1n) === 1n,
    pointer: `0x${(v & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`,
  }
}
/** The packed conditions at a WriteOnce pointer (its code, after the leading 00). */
export function unpack(code: string, count: number): ConditionFlat[] {
  const b = Buffer.from(code.slice(2), 'hex')
  if (b[0] !== 0) throw new DecodeError('the pointer holds no WriteOnce data')
  const buf = b.subarray(1)
  if (buf.length < count * 2) throw new DecodeError('the packed conditions are cut short')
  let at = count * 2
  return Array.from({ length: count }, (_, k) => {
    const bits = buf[2 * k + 1] as number
    const c: ConditionFlat = {
      parent: buf[2 * k] as number,
      paramType: (bits >> 5) & 7,
      operator: bits & 0x1f,
      compValue: '',
    }
    if (c.operator >= 16) {
      if (at + 32 > buf.length) throw new DecodeError('a compValue is cut short')
      c.compValue = buf.subarray(at, at + 32).toString('hex')
      at += 32
    }
    return c
  })
}

// ---- the snapshot ----

export interface EvmAnswer {
  result?: unknown
  error?: { code: number; message: string }
}
export interface EvmSnapshot {
  chainId: number
  /** The block every read was made at, as hex. */
  block: string
  /** The answer to each call, keyed `method:params`. */
  answers: Record<string, EvmAnswer>
}
const keyOf = (method: string, params: unknown[]) => `${method}:${JSON.stringify(params)}`

interface Ctx extends EvmContext {
  snap: EvmSnapshot
  /** An answer, `undefined` when not read yet; `null` for a call that reverted. */
  ask: (method: string, params: unknown[]) => string | null | undefined
  facts: Node[]
}

/** Roles call names by what they do to a (role, target) or (role, target, function). */
const TARGET_WRITE: Record<string, 'Target' | 'Function' | 'None'> = {
  allowTarget: 'Target',
  scopeTarget: 'Function',
  revokeTarget: 'None',
}
const CLEARANCE = ['None', 'Target', 'Function']

function chainChecks(
  c: EvmContext,
  snap: EvmSnapshot,
  miss: Map<string, [string, unknown[]]>
): Node {
  const tag = snap.block
  const ask = (method: string, params: unknown[]): string | null | undefined => {
    const p =
      method === 'eth_getCode' || method === 'eth_call' || method === 'eth_getStorageAt'
        ? [...params, tag]
        : params
    const k = keyOf(method, p)
    const a = snap.answers[k]
    if (a === undefined) {
      miss.set(k, [method, p])
      return undefined
    }
    if (a.error) {
      // a revert is an answer; any other node error is not
      if (method === 'eth_call') return null
      c.flag(`the chain read of ${method} failed: ${a.error.message}`)
      return undefined
    }
    return String(a.result)
  }
  const x: Ctx = { ...c, snap, ask, facts: [] }
  x.facts.push(
    fact(
      'network',
      `${TESTNETS[snap.chainId] ?? snap.chainId} (${snap.chainId}), block ${big(snap.block)}`
    )
  )
  if (snap.chainId !== c.chainId)
    c.flag(
      `the chain read reached chain ${snap.chainId}, not chain ${c.chainId} the transaction is hashed for`
    )
  if (c.safe === null) return group('On chain', 'chain', x.facts)
  const safe = safeState(x, c.safe)
  rolesState(x, safe)
  timelocks(x, safe)
  tokens(x)
  return group('On chain', 'chain', x.facts)
}

const ethCall = (x: Ctx, to: string, data: string) => x.ask('eth_call', [{ to, data }])
const words = (r: string) => (r.slice(2).match(/.{64}/g) ?? []) as string[]
/** An `address[]` return (the first returned value). */
function addresses(r: string): string[] {
  const w = words(r)
  const at = Number(BigInt(`0x${w[0] ?? '0'}`)) / 32
  const n = Number(BigInt(`0x${w[at] ?? '0'}`))
  if (at + 1 + n > w.length) throw new DecodeError('an address[] runs past the return data')
  return w.slice(at + 1, at + 1 + n).map((v) => asAddress(v))
}

interface SafeState {
  owners: string[]
  threshold: bigint
  modules: string[]
}

function safeState(x: Ctx, safe: string): SafeState | null {
  const code = x.ask('eth_getCode', [safe])
  const version = ethCall(x, safe, call('VERSION()'))
  const ownersR = ethCall(x, safe, call('getOwners()'))
  const thresholdR = ethCall(x, safe, call('getThreshold()'))
  const nonceR = ethCall(x, safe, call('nonce()'))
  const modulesR = ethCall(
    x,
    safe,
    call('getModulesPaginated(address,uint256)', [addrWord(SENTINEL), word(50)])
  )
  const guard = x.ask('eth_getStorageAt', [safe, SLOT.guard])
  const handler = x.ask('eth_getStorageAt', [safe, SLOT.fallback])
  const moduleGuard = x.ask('eth_getStorageAt', [safe, SLOT.moduleGuard])
  if (
    [code, version, ownersR, thresholdR, nonceR, modulesR, guard, handler, moduleGuard].includes(
      undefined
    )
  )
    return null
  if (code === '0x' || !ownersR || !thresholdR || !nonceR || !modulesR) {
    x.flag(
      `${x.safe} is not a Safe on this network: ${code === '0x' ? 'no code there' : 'it does not answer the Safe calls'}`
    )
    return null
  }
  let st: SafeState
  try {
    st = { owners: addresses(ownersR), threshold: big(thresholdR), modules: addresses(modulesR) }
  } catch (e) {
    x.flag(
      `${x.safe} answers the Safe calls with data that does not decode: ${(e as Error).message}`
    )
    return null
  }
  let ver = ''
  try {
    ver = String(decodeArgs(Buffer.from((version as string).slice(2), 'hex'), ['bytes'])[0])
    ver = Buffer.from(ver, 'hex').toString('latin1')
  } catch {
    ver = 'unknown'
  }
  const nonce = big(nonceR)
  x.facts.push(
    fact('Safe', `${x.show(x.safe as string)}, version ${ver}, nonce ${nonce}`),
    fact('owners now', `${st.owners.map(x.show).join(', ')}; threshold ${st.threshold}`),
    fact('modules now', st.modules.map(x.show).join(', ') || 'none')
  )
  if (x.tx.nonce !== null) {
    const n = BigInt(x.tx.nonce)
    if (n < nonce)
      x.warn(
        `the transaction's nonce ${n} is already used (the Safe is at ${nonce}): it can never run`
      )
    else if (n > nonce)
      x.warn(
        `the transaction's nonce ${n} is ahead of the Safe's ${nonce}: ${n - nonce} other transaction(s) run first`
      )
  }
  for (const [what, w] of [
    ['guard', guard],
    ['module guard', moduleGuard],
  ] as const)
    if (big(w as string) !== 0n)
      x.flag(
        `the Safe runs a ${what} ${x.show(asAddress(w as string))}, which the design never sets: it sees and can refuse ${what === 'guard' ? "the owners' own" : 'every module'} transactions`
      )
  const fh = asAddress(handler as string)
  if (fh !== ZERO) {
    x.facts.push(fact('fallback handler', x.show(fh)))
    if (!CANONICAL_HANDLERS.has(fh))
      x.warn(
        `the Safe's fallback handler ${fh} is not a canonical Safe handler: it answers every call the Safe does not know, EIP-1271 signature checks included`
      )
  }

  // Owners, threshold and modules after the batch.
  const owners = [...st.owners]
  let threshold = st.threshold
  const modules = new Set(st.modules)
  for (const c of x.calls) {
    if (c.to !== x.safe || !c.args) continue
    const a = c.args as Record<string, string>
    if (c.fn === 'addOwnerWithThreshold') {
      owners.push((a.owner as string).toLowerCase())
      threshold = BigInt(a.threshold as string)
    } else if (c.fn === 'removeOwner') {
      owners.splice(owners.indexOf((a.owner as string).toLowerCase()), 1)
      threshold = BigInt(a.threshold as string)
    } else if (c.fn === 'swapOwner')
      owners.splice(
        owners.indexOf((a.oldOwner as string).toLowerCase()),
        1,
        (a.newOwner as string).toLowerCase()
      )
    else if (c.fn === 'changeThreshold') threshold = BigInt(a.threshold as string)
    else if (c.fn === 'enableModule') modules.add((a.module as string).toLowerCase())
    else if (c.fn === 'disableModule') modules.delete((a.module as string).toLowerCase())
  }
  const changed = x.calls.some(
    (c) =>
      c.to === x.safe &&
      ['addOwnerWithThreshold', 'removeOwner', 'swapOwner', 'changeThreshold'].includes(c.fn ?? '')
  )
  if (changed)
    x.facts.push(fact('owners after', `${owners.map(x.show).join(', ')}; threshold ${threshold}`))
  const when = changed ? 'after this transaction' : 'on chain'
  const n = BigInt(owners.length)
  if (x.i.role === 'custody') {
    if (threshold < n)
      x.flag(
        `the custody Safe ${when} needs ${threshold} of its ${n} owners: one party can be left out, the trustee included; custody's threshold equals its owners`
      )
    if (n < 3n) x.warn(`the custody Safe ${when} has ${n} owner(s); the design's custody is 3 of 3`)
  } else if (threshold < 2n)
    x.flag(`the Prime account ${when} lets one owner act alone (threshold ${threshold})`)

  // Every enabled module, after the batch, must be a Roles v2.1.1 proxy: anything else can make the
  // Safe call anything, past every rule.
  const created = new Set(x.created.map((m) => m.address))
  for (const m of modules) {
    if (created.has(m)) continue
    const code = x.ask('eth_getCode', [m])
    if (code === undefined) continue
    if (code !== PROXY_RUNTIME)
      x.flag(
        `module ${x.show(m)} is enabled on the Safe and is ${code === '0x' ? 'an address with no code (a key: it can make the Safe call anything)' : 'not a Zodiac Roles v2.1.1 proxy'}: it can make the Safe call anything, past every rule`
      )
  }
  return { owners, threshold, modules: [...modules] }
}

/** The Roles modules the batch writes to or the Safe has enabled, with their stored scopes. */
function rolesState(x: Ctx, safe: SafeState | null) {
  const created = new Set(x.created.map((m) => m.address))
  const rolesCalls = x.calls.filter(
    (c) =>
      c.fn &&
      c.args &&
      (c.fn in TARGET_WRITE ||
        [
          'allowFunction',
          'scopeFunction',
          'revokeFunction',
          'assignRoles',
          'setAllowance',
          'setDefaultRole',
          'setTransactionUnwrapper',
        ].includes(c.fn))
  )
  const modules = new Set([...rolesCalls.map((c) => c.to), ...(safe?.modules ?? [])])
  for (const m of modules) {
    if (created.has(m)) continue
    const code = x.ask('eth_getCode', [m])
    if (code === undefined) continue
    if (code !== PROXY_RUNTIME) {
      if (rolesCalls.some((c) => c.to === m))
        x.flag(
          `the batch writes Roles calls to ${x.show(m)}, which is not a Zodiac Roles v2.1.1 proxy on chain`
        )
      continue
    }
    const owner = ethCall(x, m, call('owner()'))
    const avatar = ethCall(x, m, call('avatar()'))
    const target = ethCall(x, m, call('target()'))
    if (owner && avatar && target) {
      const [o, a, t] = [owner, avatar, target].map(asAddress) as [string, string, string]
      x.facts.push(
        fact(
          `Roles module ${x.show(m)}`,
          `owner ${x.show(o)}, avatar ${x.show(a)}, target ${x.show(t)}${safe ? (safe.modules.includes(m) ? ', enabled' : ', NOT enabled') : ''}`
        )
      )
      if (o !== x.safe)
        x.flag(
          `Roles module ${x.show(m)} is owned by ${o}, not the Safe: that key can rewrite its rules alone${safe?.modules.includes(m) ? ', and the module is enabled on the Safe' : ''}`
        )
      if (a !== x.safe || t !== x.safe)
        x.flag(
          `Roles module ${x.show(m)} acts for avatar ${a} and target ${t}, not the Safe: its EqualToAvatar pins and its calls go there`
        )
    }
    // Unwrap adapters for the MultiSend batches (Periphery.sol:19-35): only the Roles one, or none.
    for (const ms of [EVM.multiSend, EVM.multiSendCallOnly]) {
      const ad = ethCall(
        x,
        m,
        call('unwrappers(bytes32)', [
          `${ms.slice(2)}${selectorOf('multiSend(bytes)')}${'0'.repeat(16)}`,
        ])
      )
      if (ad === undefined) continue
      if (ad === null) {
        x.flag(
          `Roles module ${x.show(m)} does not answer unwrappers(): its unwrap adapters cannot be read`
        )
        continue
      }
      const adapter = asAddress(ad)
      const set = x.calls.find(
        (c) =>
          c.to === m &&
          c.fn === 'setTransactionUnwrapper' &&
          String((c.args as Record<string, string>).to).toLowerCase() === ms
      )
      if (adapter !== ZERO && adapter !== EVM.unwrapper && !set)
        x.flag(
          `Roles module ${x.show(m)} unwraps ${x.show(ms)} batches with adapter ${adapter}, not the Roles MultiSend unwrapper: an adapter splits calls before the rules see them`
        )
      if (adapter !== ZERO) x.facts.push(fact(`unwrapper for ${x.show(ms)}`, x.show(adapter)))
    }
    if (safe && !safe.modules.includes(m) && rolesCalls.some((c) => c.to === m))
      x.warn(
        `the batch writes rules to ${x.show(m)}, which the Safe has not enabled (on chain or in this batch): its rules move nothing until it is`
      )
    scopes(
      x,
      m,
      rolesCalls.filter((c) => c.to === m)
    )
  }
}

/** What the batch does to one (role, target), in order. */
function scopes(x: Ctx, m: string, calls: EvmContext['calls']) {
  const roles = new Set<string>()
  const targets = new Set<string>([...(x.i.targets ?? []).map((t) => t.toLowerCase())])
  const after = new Map<string, 'Target' | 'Function' | 'None'>()
  const fnAfter = new Map<string, 'wild' | 'scoped' | 'none'>()
  const revoked = new Set<string>()
  const members = new Set<string>(
    [...(x.i.recipients ?? []), ...(x.i.timelock ? [x.i.timelock] : [])].map((r) => r.toLowerCase())
  )
  for (const c of calls) {
    const a = c.args as Record<string, unknown>
    if (c.fn === 'assignRoles') {
      for (const k of a.roleKeys as string[]) roles.add(k)
      members.add((a.module as string).toLowerCase())
      continue
    }
    if (typeof a.roleKey !== 'string') continue
    roles.add(a.roleKey)
    const t = typeof a.targetAddress === 'string' ? a.targetAddress.toLowerCase() : undefined
    if (!t) continue
    targets.add(t)
    if (c.fn && c.fn in TARGET_WRITE) {
      after.set(`${a.roleKey}|${t}`, TARGET_WRITE[c.fn] as 'Target')
      if (c.fn === 'revokeTarget') revoked.add(`${a.roleKey}|${t}`)
    } else if (typeof a.selector === 'string') {
      const f = `${a.roleKey}|${t}|${a.selector.slice(2)}`
      fnAfter.set(
        f,
        c.fn === 'allowFunction' ? 'wild' : c.fn === 'scopeFunction' ? 'scoped' : 'none'
      )
    }
    // addresses a scoping pins are targets the role may already reach
    if (c.fn === 'scopeFunction')
      for (const cf of a.conditions as ConditionFlat[])
        if (
          cf.operator === 16 &&
          cf.compValue.length === 64 &&
          cf.compValue.startsWith('0'.repeat(24))
        )
          targets.add(`0x${cf.compValue.slice(24)}`)
  }
  for (const s of [x.safe as string, EVM.multiSend, EVM.multiSendCallOnly, m]) targets.add(s)
  // What an EqualTo hash may stand for: every address and word the review knows.
  const known = new Map<string, string>()
  const remember = (w: string) => known.set(h32(w), w)
  for (const a of [...targets, ...members, x.safe as string, ZERO]) remember(addrWord(a))
  for (const k of roles) remember(k.slice(2))
  for (const v of [0n, 1n]) remember(word(v))
  const selectors = [
    ...new Set([...Object.keys(VENUE), ...EXEC_WITH_ROLE, ...EXEC_DEFAULT, ...Object.keys(ABI)]),
  ]

  const allowanceKeys = new Set<string>()
  for (const c of calls) {
    const a = c.args as Record<string, unknown>
    if (c.fn === 'setAllowance') allowanceKeys.add(String(a.key))
    if (c.fn === 'scopeFunction')
      for (const cf of a.conditions as ConditionFlat[])
        if (cf.operator >= 28 && cf.compValue.length === 64) allowanceKeys.add(`0x${cf.compValue}`)
  }
  for (const role of roles) {
    const touchedRole = calls.some(
      (c) =>
        (c.args as Record<string, unknown>).roleKey === role ||
        ((c.args as Record<string, unknown>).roleKeys as string[] | undefined)?.includes(role)
    )
    const say = (msg: string) => (touchedRole ? x.flag(msg) : x.warn(msg))
    const memberList: string[] = []
    for (const a of members) {
      const w = x.ask('eth_getStorageAt', [m, rolesSlot.member(role, a)])
      if (w !== undefined && big(w as string) === 1n) memberList.push(a)
    }
    const rows: Node[] = []
    for (const t of targets) {
      const w = x.ask('eth_getStorageAt', [m, rolesSlot.target(role, t)])
      if (w === undefined) continue
      const v = big(w as string)
      const live = CLEARANCE[Number(v & 0xffn)] ?? `clearance ${v & 0xffn}`
      const options = Number((v >> 8n) & 0xffn)
      const now = after.get(`${role}|${t}`) ?? live
      const where = `role ${roleName(role)} on ${x.show(m)}, target ${x.show(t)}`
      if (live !== 'None')
        rows.push(
          fact(
            `target ${x.show(t)}`,
            `${live}${options ? `, execution options ${options}` : ''}${now !== live ? `; ${now} after this transaction` : ''}`
          )
        )
      if (now === 'Target' && !after.has(`${role}|${t}`))
        say(
          `${where} is open on chain (allowTarget): EVERY function with ANY arguments, an under-read scoping this transaction leaves in place`
        )
      if (live !== 'Function' && now !== 'Function' && !revoked.has(`${role}|${t}`)) continue
      // The function scopes stored for this target, and what each is after the batch.
      const stored: string[] = []
      for (const sel of selectors) {
        const h = x.ask('eth_getStorageAt', [m, rolesSlot.scope(role, t, sel)])
        if (!h || big(h) === 0n) continue
        const name = (VENUE[sel] ?? ABI[sel])?.name ?? `0x${sel}`
        const hd = header(h)
        const write = fnAfter.get(`${role}|${t}|${sel}`)
        if (write === 'none' || write === 'scoped') continue // the batch replaces or removes it; the bytes review reads the new one
        stored.push(hd.wildcarded ? `${name} (ANY arguments)` : name)
        const fw = `${where}, function ${name} (stored on chain)`
        if (now !== 'Function') continue
        if (hd.wildcarded || write === 'wild') {
          if (write !== 'wild')
            say(
              `${fw} allows ANY arguments (allowFunction): an under-read scoping this transaction leaves in place`
            )
          continue
        }
        const code = x.ask('eth_getCode', [hd.pointer])
        if (code === undefined) continue
        let flat: ConditionFlat[]
        try {
          flat = unpack(code as string, hd.count).map((cf) =>
            cf.operator === 16 && cf.compValue
              ? known.has(`0x${cf.compValue}`)
                ? { ...cf, compValue: known.get(`0x${cf.compValue}`) as string }
                : { ...cf, hashed: true }
              : cf
          )
        } catch (e) {
          say(`${fw}: its stored conditions do not read: ${(e as Error).message}`)
          continue
        }
        for (const cf of flat)
          if (cf.operator >= 28 && cf.compValue.length === 64)
            allowanceKeys.add(`0x${cf.compValue}`)
        const local: string[] = []
        const recipients = new Set((x.i.recipients ?? []).map((r) => r.toLowerCase()))
        const shown = scoping(
          [role, t, `0x${sel}`, flat, BigInt(hd.options)],
          `the live scoping of ${name} on ${t} (role ${roleName(role)})`,
          x.i.role,
          recipients,
          (p) => local.push(p),
          () => {},
          x.show
        )
        for (const p of local)
          say(`${p}; it is stored on chain and this transaction leaves it in place`)
        rows.push(group(`stored scoping ${name} on ${x.show(t)}`, 'scope', shown))
      }
      if (revoked.has(`${role}|${t}`) && stored.length)
        x.warn(
          `${where}: after the revokeTarget these function scopes stay stored and come back on a later scopeTarget: ${stored.join(', ')}`
        )
      else if (now === 'None' && stored.length)
        rows.push(
          fact(`dormant on ${x.show(t)}`, `${stored.join(', ')} (stored; back on a scopeTarget)`)
        )
    }
    x.facts.push(
      group(`Role ${roleName(role)} on ${x.show(m)} now`, 'role', [
        fact(
          'members read',
          memberList.map(x.show).join(', ') || 'none of the addresses the review knows'
        ),
        ...rows,
      ])
    )
  }
  allowanceFacts(x, m, allowanceKeys)
}

/** An allowance (`allowances(key)`, Core.sol): balance, refill and period, read for the review. */
function allowanceFacts(x: Ctx, m: string, keys: Set<string>) {
  for (const k of keys) {
    const r = ethCall(x, m, call('allowances(bytes32)', [k.slice(2)]))
    if (!r) continue
    const [refill, maxRefill, period, balance, timestamp] = words(r).map((w) => BigInt(`0x${w}`))
    x.facts.push(
      fact(
        `allowance ${roleName(k)} on ${x.show(m)}`,
        `balance ${balance}, refill ${refill} every ${period} s up to ${maxRefill === (1n << 128n) - 1n ? 'no ceiling' : maxRefill}, last at ${timestamp}`
      )
    )
  }
}

/** Each TimelockController the batch calls or a role names: who holds what, and its delay. */
function timelocks(x: Ctx, safe: SafeState | null) {
  const candidates = new Set<string>(
    (x.i.timelock ? [x.i.timelock] : []).map((t) => t.toLowerCase())
  )
  for (const c of x.calls) {
    if (
      ['grantRole', 'revokeRole', 'renounceRole', 'schedule', 'cancel', 'execute'].includes(
        c.fn ?? ''
      )
    )
      candidates.add(c.to)
    if (c.fn === 'assignRoles')
      candidates.add(((c.args as Record<string, string>).module as string).toLowerCase())
  }
  for (const t of candidates) {
    const delay = ethCall(x, t, call('getMinDelay()'))
    if (delay === undefined) continue
    if (delay === null || delay === '0x') {
      if (t === x.i.timelock?.toLowerCase())
        x.flag(`${t} does not answer getMinDelay(): it is not a TimelockController`)
      continue
    }
    const accounts = new Set<string>([
      t,
      x.safe as string,
      ZERO,
      ...(safe?.owners ?? []),
      ...(x.i.recipients ?? []).map((r) => r.toLowerCase()),
    ])
    for (const c of x.calls) {
      const a = c.args as Record<string, unknown> | null
      for (const v of Object.values(a ?? {}))
        if (typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v)) accounts.add(v.toLowerCase())
    }
    const holds = new Map<string, Set<string>>()
    let unknown = false
    for (const [name, r] of Object.entries(TIMELOCK_ROLE)) {
      const set = new Set<string>()
      for (const a of accounts) {
        const v = ethCall(x, t, call('hasRole(bytes32,address)', [r.slice(2), addrWord(a)]))
        if (v === undefined) unknown = true
        else if (v && big(v) === 1n) set.add(a)
      }
      holds.set(name, set)
    }
    if (unknown) continue
    // the batch's own grants and renounces on this timelock
    for (const c of x.calls) {
      if (c.to !== t || !c.args) continue
      const a = c.args as Record<string, string>
      const name = Object.entries(TIMELOCK_ROLE).find(([, r]) => r === a.role)?.[0]
      if (!name) continue
      const who = ((a.account ?? a.callerConfirmation) as string).toLowerCase()
      if (c.fn === 'grantRole') holds.get(name)?.add(who)
      else holds.get(name)?.delete(who)
    }
    const d = big(delay)
    const list = (n: string) =>
      [...(holds.get(n) ?? [])]
        .map((a) => (a === ZERO ? 'anyone (address 0)' : x.show(a)))
        .join(', ') || 'none of the addresses read'
    x.facts.push(
      group(`Timelock ${x.show(t)}`, 'timelock', [
        fact('delay', `${d} s`),
        fact('admin', list('admin')),
        fact('proposers', list('proposer')),
        fact('cancellers', list('canceller')),
        fact('executors', list('executor')),
      ])
    )
    const granted = new Set(
      x.calls
        .filter((c) => c.to === t && c.fn === 'grantRole')
        .map((c) => String((c.args as Record<string, string>).account).toLowerCase())
    )
    for (const a of holds.get('admin') ?? [])
      if (a !== t)
        x.flag(
          `${x.show(a)} holds timelock ${x.show(t)}'s admin role ${granted.has(a) ? 'after this transaction' : 'on chain'}: it can change the delay and who proposes, cancels and executes, without waiting; the timelock administers itself once set up`
        )
    if (d === 0n)
      x.flag(
        `timelock ${x.show(t)} has no delay: a scheduled call runs at once, with no time to cancel it`
      )
    if (x.i.role === 'custody' && !(holds.get('canceller') ?? new Set()).has(x.safe as string))
      x.warn(
        `the custody Safe cannot cancel on timelock ${x.show(t)}: a scheduled call it objects to runs anyway`
      )
    for (const a of holds.get('proposer') ?? [])
      if (safe?.owners.includes(a))
        x.warn(`${x.show(a)}, one owner's key, can propose on timelock ${x.show(t)} alone`)
    // Calls this batch schedules on it: the delay it asks, and whether the timelock may make the call.
    for (const c of x.calls) {
      if (c.to !== t || c.fn !== 'schedule' || !c.args) continue
      const a = c.args as Record<string, string>
      if (BigInt(a.delay as string) < d)
        x.warn(
          `the batch schedules on ${x.show(t)} with a delay of ${a.delay} s, under its minimum ${d} s: it would fail`
        )
      const data = a.data as string
      if (!EXEC_WITH_ROLE.has(data.slice(0, 8))) continue
      try {
        const rk = decodeArgs(
          Buffer.from(data.slice(8), 'hex'),
          (ABI[data.slice(0, 8)] as (typeof ABI)[string]).types
        )[4] as string
        const gate = (a.target as string).toLowerCase()
        const w = x.ask('eth_getStorageAt', [gate, rolesSlot.member(rk, t)])
        if (w !== undefined && big(w as string) !== 1n)
          x.warn(
            `the scheduled call asks role ${roleName(rk)} on ${x.show(gate)}, which timelock ${x.show(t)} is not a member of on chain: it would fail`
          )
      } catch {
        // flagged by the bytes review
      }
    }
  }
}

/** ERC-3643 tokens: the Safe's identity, freeze and the token's pause, read for each one named. */
function tokens(x: Ctx) {
  const ERC20 = new Set(['approve', 'transfer', 'transferFrom', 'increaseAllowance'])
  const candidates = new Set<string>((x.i.tokens ?? []).map((t) => t.toLowerCase()))
  for (const c of x.calls) {
    const a = c.args as Record<string, unknown> | null
    if (!a || typeof a.targetAddress !== 'string' || typeof a.selector !== 'string') continue
    if (ERC20.has(VENUE[a.selector.slice(2)]?.name ?? ''))
      candidates.add(a.targetAddress.toLowerCase())
  }
  const who = [x.safe as string, ...(x.i.recipients ?? []).map((r) => r.toLowerCase())]
  for (const t of candidates) {
    const registry = ethCall(x, t, call('identityRegistry()'))
    if (registry === undefined) continue
    if (registry === null || registry === '0x' || big(registry) === 0n) {
      if ((x.i.tokens ?? []).some((v) => v.toLowerCase() === t))
        x.flag(`token ${x.show(t)} does not answer identityRegistry(): it is not an ERC-3643 token`)
      continue
    }
    const reg = asAddress(registry)
    const compliance = ethCall(x, t, call('compliance()'))
    const paused = ethCall(x, t, call('paused()'))
    const rows: Node[] = [
      fact('identity registry', x.show(reg)),
      ...(compliance ? [fact('compliance', x.show(asAddress(compliance)))] : []),
    ]
    if (paused && big(paused) === 1n)
      x.warn(`token ${x.show(t)} is paused: no transfer moves until its agent unpauses it`)
    for (const a of who) {
      const verified = ethCall(x, reg, call('isVerified(address)', [addrWord(a)]))
      const frozen = ethCall(x, t, call('isFrozen(address)', [addrWord(a)]))
      const part = ethCall(x, t, call('getFrozenTokens(address)', [addrWord(a)]))
      if (verified === undefined || frozen === undefined || part === undefined) continue
      const isSafe = a === x.safe
      const v = verified !== null && big(verified) === 1n
      const f = frozen !== null && big(frozen) === 1n
      const p = part === null ? 0n : big(part)
      rows.push(
        fact(
          isSafe ? 'the Safe' : x.show(a),
          `${v ? 'verified' : 'NOT verified'}${f ? ', FROZEN' : ''}${p ? `, ${p} frozen` : ''}`
        )
      )
      const say = isSafe ? x.flag : x.warn
      if (!v)
        say(
          `${isSafe ? 'the Safe' : x.show(a)} is not verified in token ${x.show(t)}'s identity registry: a transfer to it is refused`
        )
      if (f)
        say(
          `${isSafe ? 'the Safe' : x.show(a)} is FROZEN on token ${x.show(t)}: nothing moves in or out`
        )
      if (p > 0n)
        x.warn(`${p} of token ${x.show(t)} is frozen in ${isSafe ? 'the Safe' : x.show(a)}`)
    }
    x.facts.push(group(`ERC-3643 token ${x.show(t)}`, 'token', rows))
  }
}

// ---- the review with the chain, and the read ----

/** `reviewEvm`, then the checks against `snap`. Pure: a read the checks need that `snap` lacks is a
 *  problem. */
export function reviewEvmOnChain(
  i: EvmInput,
  snap: EvmSnapshot
): EvmReview & { chain: { chainId: number; block: string; reads: number } } {
  const miss = new Map<string, [string, unknown[]]>()
  const r = reviewEvm(i, (c) => {
    const node = chainChecks(c, snap, miss)
    if (miss.size)
      c.flag(
        `the chain read did not answer ${miss.size} call(s) (${[...miss.keys()].slice(0, 3).join('; ')}), so the checks that need them were not made`
      )
    return node
  })
  return {
    ...r,
    chain: {
      chainId: snap.chainId,
      block: String(big(snap.block)),
      reads: Object.keys(snap.answers).length,
    },
  }
}

function needs(i: EvmInput, snap: EvmSnapshot) {
  const miss = new Map<string, [string, unknown[]]>()
  reviewEvm(i, (c) => {
    chainChecks(c, snap, miss)
    return null
  })
  return miss
}

/** Read what the review of `i` needs, in rounds, at one block. Refuses a mainnet and a node on
 *  another chain than the transaction's; a failed read refuses the review. */
export async function readEvmChain(
  i: EvmInput,
  rpc: Rpc,
  o: { concurrency?: number } = {}
): Promise<EvmSnapshot> {
  reviewEvm(i)
  const chainId = i.chainId ?? 84532
  if (!TESTNETS[chainId])
    throw new Refusal(
      'INVALID_INPUT',
      `chain ${chainId} is not a test network; readChain reads Base Sepolia, Sepolia or a local node only`
    )
  let id: number
  let block: string
  try {
    id = Number(BigInt(String(await rpc('eth_chainId', []))))
    block = `0x${BigInt(String(await rpc('eth_blockNumber', []))).toString(16)}`
  } catch (e) {
    throw unread('the network', e)
  }
  if (id !== chainId)
    throw new Refusal(
      'INVALID_INPUT',
      `the EVM RPC endpoint serves chain ${id}, not chain ${chainId}`
    )
  const snap: EvmSnapshot = { chainId: id, block, answers: {} }
  for (let round = 0; round < 12; round++) {
    const want = [...needs(i, snap)]
    if (want.length === 0) return snap
    const width = o.concurrency ?? 8
    for (let k = 0; k < want.length; k += width)
      await Promise.all(
        want.slice(k, k + width).map(async ([key, [method, params]]) => {
          try {
            snap.answers[key] = { result: await rpc(method, params) }
          } catch (e) {
            if (e instanceof RpcError && method === 'eth_call')
              snap.answers[key] = { error: { code: e.code, message: e.message } }
            else throw unread(`${method}`, e)
          }
        })
      )
  }
  throw unread('the chain', new Error('the reads did not settle in 12 rounds'))
}

export { encodeArgs }
