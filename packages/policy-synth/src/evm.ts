// The owner's side of the review on EVM: what an unsigned Safe transaction does, read out of its
// bytes alone. Like `review_unsigned` for Stellar it asks no RPC, so a wallet or the Prime app can
// run it on the transaction an owner is about to sign. It decodes the Safe transaction (and a
// MultiSend batch) into the calls it makes, decodes every Zodiac Roles v2.1.1 scoping (targets,
// functions, condition trees, allowances, members, unwrappers) and checks them against the
// configuration-only design (docs/evm.md, scripts/evm-config-check/test/ConfigOnly.t.sol): a
// scoping that reads looser than it looks, a recipient that is not pinned to custody, the
// revokeTarget gap, trailing calldata. It cannot tell a consistent rewrite from the owner's intent,
// so the review shows the authority the bytes grant for the owner to read.
//
// Sources: Safe `v1.4.1` (contracts/), Zodiac Roles v2.1.1 at `218a5164` (packages/evm/contracts/).

import { DecodeError, hex, keccak256 } from './bytes.ts'
import { fact, group, lines, type Node, warned } from './card.ts'
import { messageOf, Refusal } from './envelope.ts'

// ---- addresses (Safe 1.4.1 canonical deployments; Roles mastercopies.json v2.1.1) ----

export const EVM = {
  multiSend: '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526',
  multiSendCallOnly: '0x9641d764fc13c8b624c04430c7356c1c7c8102e2',
  createCall: '0x9b35af71d77eaf8d7e40252370304687390a1a52',
  rolesMastercopy: '0xf2964ce6161ce0e75964fe7927ce114cb0b283d5',
  unwrapper: '0x93b7fcbc63ed8a3a24b59e1c3e6649d50b7427c0',
} as const
export const ZERO = `0x${'0'.repeat(40)}`
const CHAINS: Record<number, string> = {
  84532: 'Base Sepolia',
  11155111: 'Sepolia',
  8453: 'Base',
  1: 'Ethereum',
}
/** The creation code of an ERC-1167 proxy to the Roles v2.1.1 mastercopy (ConfigOnly.t.sol `proxyCode`). */
export const ROLES_PROXY_CODE = `3d602d80600a3d3981f3363d3d373d3d3d363d73${EVM.rolesMastercopy.slice(2)}5af43d82803e903d91602b57fd5bf3`

// ---- ABI ----

/** The ABI types the review reads. */
export type T =
  | 'address'
  | 'bool'
  | 'bytes32'
  | 'bytes4'
  | 'bytes'
  | 'uint8'
  | 'uint16'
  | 'uint48'
  | 'uint64'
  | 'uint160'
  | 'uint128'
  | 'uint256'
  | 'bytes32[]'
  | 'bool[]'
  | 'conditions'
export type V = string | bigint | boolean | string[] | boolean[] | ConditionFlat[]
export interface ConditionFlat {
  parent: number
  paramType: number
  operator: number
  compValue: string
  /** Read off the chain: Roles stores an EqualTo value as its keccak-256, and this one matched no
   *  value the review knows, so `compValue` is the hash. */
  hashed?: boolean
}

const enc = new TextEncoder()
export const selectorOf = (signature: string) =>
  hex(keccak256(enc.encode(signature)).subarray(0, 4))

interface Fn {
  name: string
  types: T[]
  params: string[]
}
/** A function the review reads, by its signature; the selector is computed. */
const fn = (sig: string, params: string[]): [string, Fn] => {
  const name = sig.slice(0, sig.indexOf('('))
  const inner = sig.slice(sig.indexOf('(') + 1, -1)
  const types = (
    inner ? inner.replace('(uint8,uint8,uint8,bytes)[]', 'conditions').split(',') : []
  ) as T[]
  return [selectorOf(sig), { name, types, params }]
}
export const ABI: Record<string, Fn> = Object.fromEntries([
  // Safe
  fn('execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)', [
    'to',
    'value',
    'data',
    'operation',
    'safeTxGas',
    'baseGas',
    'gasPrice',
    'gasToken',
    'refundReceiver',
    'signatures',
  ]),
  fn('enableModule(address)', ['module']),
  fn('disableModule(address,address)', ['prevModule', 'module']),
  fn('addOwnerWithThreshold(address,uint256)', ['owner', 'threshold']),
  fn('removeOwner(address,address,uint256)', ['prevOwner', 'owner', 'threshold']),
  fn('swapOwner(address,address,address)', ['prevOwner', 'oldOwner', 'newOwner']),
  fn('changeThreshold(uint256)', ['threshold']),
  fn('setGuard(address)', ['guard']),
  fn('setModuleGuard(address)', ['moduleGuard']),
  fn('setFallbackHandler(address)', ['handler']),
  fn('multiSend(bytes)', ['transactions']),
  fn('performCreate2(uint256,bytes,bytes32)', ['value', 'deploymentData', 'salt']),
  fn('performCreate(uint256,bytes)', ['value', 'deploymentData']),
  // Zodiac Roles v2.1.1
  fn('setUp(bytes)', ['initParams']),
  fn('assignRoles(address,bytes32[],bool[])', ['module', 'roleKeys', 'memberOf']),
  fn('setDefaultRole(address,bytes32)', ['module', 'roleKey']),
  fn('allowTarget(bytes32,address,uint8)', ['roleKey', 'targetAddress', 'options']),
  fn('scopeTarget(bytes32,address)', ['roleKey', 'targetAddress']),
  fn('revokeTarget(bytes32,address)', ['roleKey', 'targetAddress']),
  fn('allowFunction(bytes32,address,bytes4,uint8)', [
    'roleKey',
    'targetAddress',
    'selector',
    'options',
  ]),
  fn('revokeFunction(bytes32,address,bytes4)', ['roleKey', 'targetAddress', 'selector']),
  fn('scopeFunction(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)', [
    'roleKey',
    'targetAddress',
    'selector',
    'conditions',
    'options',
  ]),
  fn('setAllowance(bytes32,uint128,uint128,uint128,uint64,uint64)', [
    'key',
    'balance',
    'maxRefill',
    'refill',
    'period',
    'timestamp',
  ]),
  fn('setTransactionUnwrapper(address,bytes4,address)', ['to', 'selector', 'adapter']),
  fn('transferOwnership(address)', ['newOwner']),
  fn('renounceOwnership()', []),
  fn('setAvatar(address)', ['avatar']),
  fn('setTarget(address)', ['target']),
  fn('execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)', [
    'to',
    'value',
    'data',
    'operation',
    'roleKey',
    'shouldRevert',
  ]),
  fn('execTransactionWithRoleReturnData(address,uint256,bytes,uint8,bytes32,bool)', [
    'to',
    'value',
    'data',
    'operation',
    'roleKey',
    'shouldRevert',
  ]),
  // OpenZeppelin TimelockController
  fn('grantRole(bytes32,address)', ['role', 'account']),
  fn('revokeRole(bytes32,address)', ['role', 'account']),
  fn('renounceRole(bytes32,address)', ['role', 'callerConfirmation']),
  fn('schedule(address,uint256,bytes,bytes32,bytes32,uint256)', [
    'target',
    'value',
    'data',
    'predecessor',
    'salt',
    'delay',
  ]),
  fn('cancel(bytes32)', ['id']),
  fn('execute(address,uint256,bytes,bytes32,bytes32)', [
    'target',
    'value',
    'payload',
    'predecessor',
    'salt',
  ]),
  fn('updateDelay(uint256)', ['newDelay']),
])

/** The venue calls a scoping may allow, with the argument that names who receives (a recipient,
 *  or `spender` for an approval) and the amount. */
interface Venue extends Fn {
  recipient?: number
  spender?: number
  /** Whose debt a borrow opens (Aave sends the funds to the caller; `onBehalfOf` is the debtor). */
  debtor?: number
  amount?: number
  borrow?: true
  /** A grant the design never makes from custody (credit delegation, Permit2). */
  never?: string
}
const venue = (sig: string, params: string[], extra: Partial<Venue>): [string, Venue] => {
  const [s, f] = fn(sig, params)
  return [s, { ...f, ...extra }]
}
export const VENUE: Record<string, Venue> = Object.fromEntries([
  venue('approve(address,uint256)', ['spender', 'amount'], { spender: 0, amount: 1 }),
  venue('transfer(address,uint256)', ['to', 'amount'], { recipient: 0, amount: 1 }),
  venue('transferFrom(address,address,uint256)', ['from', 'to', 'amount'], {
    recipient: 1,
    amount: 2,
  }),
  venue(
    'supply(address,uint256,address,uint16)',
    ['asset', 'amount', 'onBehalfOf', 'referralCode'],
    {
      recipient: 2,
      amount: 1,
    }
  ),
  venue(
    'deposit(address,uint256,address,uint16)',
    ['asset', 'amount', 'onBehalfOf', 'referralCode'],
    {
      recipient: 2,
      amount: 1,
    }
  ),
  venue('withdraw(address,uint256,address)', ['asset', 'amount', 'to'], {
    recipient: 2,
    amount: 1,
  }),
  venue(
    'borrow(address,uint256,uint256,uint16,address)',
    ['asset', 'amount', 'interestRateMode', 'referralCode', 'onBehalfOf'],
    { debtor: 4, amount: 1, borrow: true }
  ),
  venue('approveDelegation(address,uint256)', ['delegatee', 'amount'], {
    spender: 0,
    amount: 1,
    never: 'credit delegation lets another address borrow against custody',
  }),
  venue('increaseAllowance(address,uint256)', ['spender', 'addedValue'], { spender: 0, amount: 1 }),
  venue('approve(address,address,uint160,uint48)', ['token', 'spender', 'amount', 'expiration'], {
    spender: 1,
    amount: 2,
    never: 'Permit2 adds signature routes out of custody',
  }),
  venue(
    'repay(address,uint256,uint256,address)',
    ['asset', 'amount', 'interestRateMode', 'onBehalfOf'],
    {
      recipient: 3,
      amount: 1,
    }
  ),
])
export const EXEC_WITH_ROLE = new Set([
  selectorOf('execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)'),
  selectorOf('execTransactionWithRoleReturnData(address,uint256,bytes,uint8,bytes32,bool)'),
])
const MULTISEND = selectorOf('multiSend(bytes)')
/** The gate's plain module entry points: they act with the caller's default role, not a pinned one. */
export const EXEC_DEFAULT = new Set([
  selectorOf('execTransactionFromModule(address,uint256,bytes,uint8)'),
  selectorOf('execTransactionFromModuleReturnData(address,uint256,bytes,uint8)'),
])

const BITS: Partial<Record<T, number>> = {
  uint8: 8,
  uint16: 16,
  uint48: 48,
  uint64: 64,
  uint160: 160,
  uint128: 128,
  uint256: 256,
}

/** ABI-decode `data` (the arguments, after the selector) as `types`. */
export function decodeArgs(data: Uint8Array, types: T[]): V[] {
  const word = (at: number) => {
    if (at < 0 || at + 32 > data.length)
      throw new DecodeError(`the calldata is cut short at byte ${at}`)
    return data.subarray(at, at + 32)
  }
  const big = (at: number) => BigInt(`0x${hex(word(at))}`)
  const small = (at: number) => {
    const v = big(at)
    if (v > BigInt(data.length))
      throw new DecodeError(`an offset or length ${v} points past the calldata`)
    return Number(v)
  }
  const bytesAt = (at: number) => {
    const n = small(at)
    if (at + 32 + n > data.length) throw new DecodeError('a bytes value runs past the calldata')
    return hex(data.subarray(at + 32, at + 32 + n))
  }
  const one = (t: T, head: number, base: number): V => {
    const w = word(head)
    switch (t) {
      case 'address':
        if (w.subarray(0, 12).some((x) => x !== 0))
          throw new DecodeError('an address with high bits set')
        return `0x${hex(w.subarray(12))}`
      case 'bool': {
        const v = big(head)
        if (v > 1n) throw new DecodeError(`${v} is not a bool`)
        return v === 1n
      }
      case 'bytes32':
        return `0x${hex(w)}`
      case 'bytes4':
        if (w.subarray(4).some((x) => x !== 0)) throw new DecodeError('a bytes4 with low bits set')
        return `0x${hex(w.subarray(0, 4))}`
      case 'bytes':
        return bytesAt(base + small(head))
      case 'bytes32[]':
      case 'bool[]': {
        const at = base + small(head)
        const n = small(at)
        return Array.from({ length: n }, (_, k) =>
          one(t === 'bool[]' ? 'bool' : 'bytes32', at + 32 + 32 * k, 0)
        ) as string[] | boolean[]
      }
      case 'conditions': {
        const at = base + small(head)
        const n = small(at)
        const start = at + 32
        return Array.from({ length: n }, (_, k) => {
          const tuple = start + small(start + 32 * k)
          const field = (j: number) => Number(one('uint8', tuple + 32 * j, tuple))
          return {
            parent: field(0),
            paramType: field(1),
            operator: field(2),
            compValue: bytesAt(tuple + small(tuple + 96)),
          }
        })
      }
      default: {
        const v = big(head)
        if (v >> BigInt(BITS[t] ?? 256) !== 0n) throw new DecodeError(`${v} does not fit a ${t}`)
        return v
      }
    }
  }
  return types.map((t, k) => one(t, 32 * k, 0))
}

/** The canonical ABI encoding of `values` as `types`: what a well-formed call carries, byte for byte. */
export function encodeArgs(types: T[], values: V[]): Uint8Array {
  const pad = (b: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(b.length / 32) * 32)
    out.set(b)
    return out
  }
  const uint = (v: bigint | number) => Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex')
  const bytes = (h: string) => Buffer.concat([uint(h.length / 2), pad(Buffer.from(h, 'hex'))])
  const tuple = (ts: T[], vs: V[]): Buffer => {
    const heads: Buffer[] = []
    const tails: Buffer[] = []
    let tail = 32 * ts.length
    ts.forEach((t, k) => {
      const v = vs[k] as V
      const dyn = (body: Buffer) => {
        heads.push(uint(tail))
        tails.push(body)
        tail += body.length
      }
      if (t === 'address') heads.push(uint(BigInt(v as string)))
      else if (t === 'bool') heads.push(uint(v ? 1 : 0))
      else if (t === 'bytes32') heads.push(Buffer.from((v as string).slice(2), 'hex'))
      else if (t === 'bytes4')
        heads.push(Buffer.from(pad(Buffer.from((v as string).slice(2), 'hex'))))
      else if (t === 'bytes') dyn(bytes(v as string))
      else if (t === 'bytes32[]' || t === 'bool[]') {
        const items = v as (string | boolean)[]
        dyn(
          Buffer.concat([
            uint(items.length),
            tuple(
              items.map(() => (t === 'bool[]' ? 'bool' : 'bytes32')),
              items
            ),
          ])
        )
      } else if (t === 'conditions') {
        const cs = v as ConditionFlat[]
        const each = cs.map((c) =>
          tuple(
            ['uint8', 'uint8', 'uint8', 'bytes'],
            [BigInt(c.parent), BigInt(c.paramType), BigInt(c.operator), c.compValue]
          )
        )
        const offs: Buffer[] = []
        let o = 32 * cs.length
        for (const e of each) {
          offs.push(uint(o))
          o += e.length
        }
        dyn(Buffer.concat([uint(cs.length), ...offs, ...each]))
      } else heads.push(uint(v as bigint))
    })
    return Buffer.concat([...heads, ...tails])
  }
  return tuple(types, values)
}

export interface Call {
  /** Where the call sits: `safe` (the Safe transaction itself) or `batch k`. */
  at: string
  operation: number
  to: string
  value: string
  data: string
  fn: string | null
  args: Record<string, unknown> | null
}

/** EIP-55 checksum. */
export const checksum = (a: string) => {
  const lower = a.toLowerCase().slice(2)
  const h = hex(keccak256(enc.encode(lower)))
  return `0x${[...lower].map((c, k) => (Number.parseInt(h[k] as string, 16) >= 8 ? c.toUpperCase() : c)).join('')}`
}

// ---- Roles condition trees ----

const PARAM = ['None', 'Static', 'Dynamic', 'Tuple', 'Array', 'Calldata', 'AbiEncoded']
const OP: Record<number, string> = {
  0: 'Pass',
  1: 'And',
  2: 'Or',
  3: 'Nor',
  5: 'Matches',
  6: 'ArraySome',
  7: 'ArrayEvery',
  8: 'ArraySubset',
  15: 'EqualToAvatar',
  16: 'EqualTo',
  17: 'GreaterThan',
  18: 'LessThan',
  19: 'SignedIntGreaterThan',
  20: 'SignedIntLessThan',
  21: 'Bitmask',
  22: 'Custom',
  28: 'WithinAllowance',
  29: 'EtherWithinAllowance',
  30: 'CallWithinAllowance',
}
const LOGICAL = new Set([1, 2, 3])

interface Cond {
  index: number
  paramType: number
  operator: number
  compValue: string
  hashed?: boolean
  children: Cond[]
}

/** The flat list as the tree Roles stores (Integrity.sol: the root is 0, its own parent; every
 *  other node's parent comes before it). */
function treeOf(flat: ConditionFlat[]): Cond {
  if (flat.length === 0)
    throw new DecodeError('no condition: a scoped function needs at least the root')
  const nodes: Cond[] = flat.map((c, index) => ({ ...c, index, children: [] }))
  flat.forEach((c, k) => {
    if (k === 0) {
      if (c.parent !== 0) throw new DecodeError('the first condition is not the root')
      return
    }
    if (c.parent >= k)
      throw new DecodeError(
        `condition ${k} names parent ${c.parent}, which does not come before it`
      )
    nodes[c.parent]?.children.push(nodes[k] as Cond)
  })
  return nodes[0] as Cond
}

/** Whether a node lets through less than everything. An `Or` is as open as its most open branch. */
function constrains(c: Cond): boolean {
  if (c.operator === 0) return c.children.some(constrains)
  if (c.operator === 2) return c.children.length > 0 && c.children.every(constrains)
  if (c.operator === 1 || c.operator === 5) return c.children.some(constrains)
  return true
}

const AVATAR = 'avatar'
/** The values a Static argument may take under `c`: `null` when any value passes. */
function allowed(c: Cond): Set<string> | null {
  if (c.operator === 15) return new Set([AVATAR])
  if (c.operator === 16 && c.hashed) return new Set([`the value hashed 0x${c.compValue}`])
  if (c.operator === 16 && c.compValue.length === 64) return new Set([`0x${c.compValue.slice(24)}`])
  if (c.operator === 1) {
    const sets = c.children.map(allowed).filter((s): s is Set<string> => s !== null)
    return sets[0] ?? null
  }
  if (c.operator === 2) {
    const sets = c.children.map(allowed)
    return sets.length > 0 && sets.every((s) => s !== null)
      ? new Set(sets.flatMap((s) => [...(s as Set<string>)]))
      : null
  }
  return null
}

/** The argument nodes of a function call: the children of each `Matches` that stands for it
 *  (the root, or the branches of a root `And`/`Or`). */
function argumentSets(root: Cond): { kind: 'and' | 'or'; sets: Cond[] } {
  if (root.operator === 5) return { kind: 'and', sets: [root] }
  if (root.operator === 1 || root.operator === 2)
    return {
      kind: root.operator === 1 ? 'and' : 'or',
      sets: root.children.filter((c) => c.operator === 5),
    }
  return { kind: 'and', sets: [] }
}

/** What an argument may be across a call's Matches: under an `Or` every branch must pin it. */
function argAllowed(root: Cond, k: number): Set<string> | null {
  const { kind, sets } = argumentSets(root)
  const each = sets.map((m) => (m.children[k] ? allowed(m.children[k] as Cond) : null))
  if (kind === 'or')
    return each.length > 0 && each.every((s) => s !== null)
      ? new Set(each.flatMap((s) => [...(s as Set<string>)]))
      : null
  return each.find((s) => s !== null) ?? null
}
const hasOp = (c: Cond, ops: number[]): boolean =>
  ops.includes(c.operator) || c.children.some((x) => hasOp(x, ops))

/** The parameter type a node stands for, looking through a logical node to its children. */
const effectiveType = (c: Cond): number | 'mixed' => {
  // Calldata and AbiEncoded read the same bytes as Dynamic (Integrity.sol:256-299).
  if (!LOGICAL.has(c.operator)) return c.paramType === 5 || c.paramType === 6 ? 2 : c.paramType
  const ts = [...new Set(c.children.map(effectiveType))]
  return ts.length === 1 ? (ts[0] as number) : 'mixed'
}
const wants = (t: T): number[] =>
  t === 'bytes'
    ? [2, 5, 6]
    : t === 'bytes32[]' || t === 'bool[]'
      ? [4]
      : t === 'conditions'
        ? [4]
        : [1]

function describe(c: Cond, names: string[] = []): Node {
  const label = `${names[0] ? `${names[0]}: ` : ''}${OP[c.operator] ?? `operator ${c.operator}`} (${PARAM[c.paramType] ?? c.paramType})`
  const v = c.compValue
  let value = v ? `0x${v}` : ''
  if (c.operator === 15) value = 'the avatar (the Safe the module acts for)'
  else if (c.hashed)
    value = `a value whose keccak-256 is 0x${v} (stored hashed; it matches no address the review knows)`
  else if (c.operator >= 28 && c.operator <= 30 && v.length === 64)
    value = `allowance ${roleName(`0x${v}`)}`
  else if (c.operator === 21 && v.length === 64)
    value = `shift ${Number.parseInt(v.slice(0, 4), 16)}, mask 0x${v.slice(4, 34)}, expected 0x${v.slice(34)}${
      v.slice(4, 12) === 'ffffffff'
        ? ` (selector 0x${v.slice(34, 42)}${VENUE[v.slice(34, 42)] ? `, ${VENUE[v.slice(34, 42)]?.name}` : ''})`
        : ''
    }`
  else if (c.operator >= 16 && c.operator <= 20 && v.length === 64 && c.paramType === 1)
    value = v.startsWith('0'.repeat(24)) ? checksumOr(`0x${v.slice(24)}`) : roleName(`0x${v}`)
  const node = value ? fact(label, value) : group(label, 'condition', [])
  if (c.children.length) node.children = c.children.map((x) => describe(x))
  return node
}
/** A word as an address when it looks like one, else as a number. */
const checksumOr = (a: string) => {
  const big = BigInt(a)
  return big < 1n << 128n ? String(big) : checksum(a)
}

// ---- the review ----

export type EvmRole = 'custody' | 'prime'

export interface EvmReview {
  role: EvmRole
  chainId: number
  safe: string | null
  /** The EIP-712 hash the owners sign (Safe 1.3+ domain), when the nonce is known. */
  safeTxHash: string | null
  tx: {
    to: string
    value: string
    data: string
    operation: number
    safeTxGas: string
    baseGas: string
    gasPrice: string
    gasToken: string
    refundReceiver: string
    nonce: string | null
  }
  calls: Call[]
  problems: string[]
  warnings: string[]
  signable: boolean
  review: string[]
  reviewTree: Node[]
}

const address = /^0x[0-9a-fA-F]{40}$/
const uintText = /^\d+$/

export interface SafeTxInput {
  to: string
  value?: string | undefined
  data?: string | undefined
  operation?: number | undefined
  safeTxGas?: string | undefined
  baseGas?: string | undefined
  gasPrice?: string | undefined
  gasToken?: string | undefined
  refundReceiver?: string | undefined
  nonce?: string | undefined
}

/** The Safe transaction hash (Safe.sol `getTransactionHash`, 1.3+ domain {chainId, verifyingContract}). */
export function safeTxHash(
  safe: string,
  chainId: number,
  t: EvmReview['tx'] & { nonce: string }
): string {
  const k = (s: string) => keccak256(enc.encode(s))
  const domain = encodeArgs(
    ['bytes32', 'uint256', 'address'],
    [
      `0x${hex(k('EIP712Domain(uint256 chainId,address verifyingContract)'))}`,
      BigInt(chainId),
      safe,
    ]
  )
  const typeHash = k(
    'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
  )
  const struct = encodeArgs(
    [
      'bytes32',
      'address',
      'uint256',
      'bytes32',
      'uint8',
      'uint256',
      'uint256',
      'uint256',
      'address',
      'address',
      'uint256',
    ],
    [
      `0x${hex(typeHash)}`,
      t.to,
      BigInt(t.value),
      `0x${hex(keccak256(Buffer.from(t.data.slice(2), 'hex')))}`,
      BigInt(t.operation),
      BigInt(t.safeTxGas),
      BigInt(t.baseGas),
      BigInt(t.gasPrice),
      t.gasToken,
      t.refundReceiver,
      BigInt(t.nonce),
    ]
  )
  const digest = keccak256(
    Buffer.concat([Buffer.from([0x19, 0x01]), keccak256(domain), keccak256(struct)])
  )
  return `0x${hex(digest)}`
}

const bad = (why: string) => new Refusal('INVALID_INPUT', why)

/** What an on-chain read sees of the review in progress (`readEvmChain` supplies it). */
export interface EvmContext {
  i: EvmInput
  safe: string | null
  chainId: number
  tx: EvmReview['tx']
  /** The calls, each decoded (`fn`, `args`) when the review reads it. */
  calls: Call[]
  /** Roles proxies this transaction deploys. */
  created: { address: string }[]
  flag: (p: string) => void
  warn: (w: string) => void
  show: (a: string) => string
}
export type EvmInput = Parameters<typeof reviewEvm>[0]

/** Review an unsigned Safe transaction from its bytes alone. */
export function reviewEvm(
  i: {
    safeTx?: SafeTxInput | undefined
    /** `execTransaction` calldata, as a relayer would send it; its signatures must be empty. */
    calldata?: string | undefined
    /** The nonce, for the hash, when `calldata` is given. */
    nonce?: string | undefined
    /** The Safe the owner means to act through. */
    safe?: string | undefined
    chainId?: number | undefined
    role: EvmRole
    /** Addresses other than the avatar a recipient may be pinned to (a trustee). */
    recipients?: string[] | undefined
    raw?: boolean | undefined
    /** With `readChain`: more targets to read the stored scopes of. */
    targets?: string[] | undefined
    /** With `readChain`: a TimelockController to read (the gate's move or recovery timelock). */
    timelock?: string | undefined
    /** With `readChain`: ERC-3643 tokens to read the Safe's identity and freeze state on. */
    tokens?: string[] | undefined
  },
  onChain?: (c: EvmContext) => Node | null
): EvmReview {
  const problems: string[] = []
  const warnings: string[] = []
  const flag = (p: string) => problems.push(p)
  const warn = (w: string) => warnings.push(w)
  const chainId = i.chainId ?? 84532
  const safe = i.safe?.toLowerCase() ?? null
  const recipients = new Set((i.recipients ?? []).map((a) => a.toLowerCase()))
  const show = (a: string) => {
    const l = a.toLowerCase()
    const name =
      l === safe
        ? i.role === 'custody'
          ? 'custody Safe'
          : 'Prime account'
        : ((
            {
              [EVM.multiSend]: 'MultiSend 1.4.1',
              [EVM.multiSendCallOnly]: 'MultiSendCallOnly 1.4.1',
              [EVM.createCall]: 'CreateCall 1.4.1',
              [EVM.rolesMastercopy]: 'Roles v2.1.1 mastercopy',
              [EVM.unwrapper]: 'Roles MultiSend unwrapper',
            } as Record<string, string>
          )[l] ?? (recipients.has(l) ? 'recipient' : undefined))
    const c = checksum(l)
    const s = i.raw ? c : `${c.slice(0, 8)}…${c.slice(-6)}`
    return name ? `${s} [${name}]` : s
  }

  // The Safe transaction, as fields or as execTransaction calldata.
  let tx: EvmReview['tx']
  if (i.calldata !== undefined) {
    const data = hexBytes(i.calldata, 'calldata')
    const sel = hex(data.subarray(0, 4))
    const f = ABI[sel]
    if (f?.name !== 'execTransaction') throw bad('the calldata is not a Safe execTransaction call')
    let a: V[]
    try {
      a = decodeArgs(data.subarray(4), f.types)
    } catch (e) {
      throw bad(`the execTransaction calldata does not decode: ${messageOf(e)}`)
    }
    if (hex(encodeArgs(f.types, a)) !== hex(data.subarray(4)))
      flag(
        'the execTransaction calldata is not its canonical encoding: it carries bytes past its last argument'
      )
    if ((a[9] as string).length > 0)
      flag(
        `it already carries ${(a[9] as string).length / 2} bytes of signatures: this is a review of unsigned bytes, and a signed transaction can be submitted by whoever holds it`
      )
    tx = {
      to: a[0] as string,
      value: String(a[1]),
      data: `0x${a[2] as string}`,
      operation: Number(a[3]),
      safeTxGas: String(a[4]),
      baseGas: String(a[5]),
      gasPrice: String(a[6]),
      gasToken: a[7] as string,
      refundReceiver: a[8] as string,
      nonce: i.nonce ?? null,
    }
  } else if (i.safeTx) {
    const s = i.safeTx
    const num = (v: string | undefined, what: string) => {
      if (v === undefined) return '0'
      if (!uintText.test(v) || BigInt(v) >> 256n) throw bad(`${what} is not a uint256`)
      return BigInt(v).toString()
    }
    const addr = (v: string | undefined, what: string) => {
      if (v === undefined) return ZERO
      if (!address.test(v)) throw bad(`${what} is not an address`)
      return v.toLowerCase()
    }
    if (s.operation !== undefined && s.operation !== 0 && s.operation !== 1)
      throw bad('operation is 0 (call) or 1 (delegatecall)')
    tx = {
      to: addr(s.to, 'to'),
      value: num(s.value, 'value'),
      data: `0x${hex(hexBytes(s.data ?? '0x', 'data'))}`,
      operation: s.operation ?? 0,
      safeTxGas: num(s.safeTxGas, 'safeTxGas'),
      baseGas: num(s.baseGas, 'baseGas'),
      gasPrice: num(s.gasPrice, 'gasPrice'),
      gasToken: addr(s.gasToken, 'gasToken'),
      refundReceiver: addr(s.refundReceiver, 'refundReceiver'),
      nonce: s.nonce === undefined ? (i.nonce ?? null) : num(s.nonce, 'nonce'),
    }
  } else throw bad('give the Safe transaction as `safeTx` or as `calldata`')

  if (safe === null)
    flag('no safe was given, so the Safe it is signed for, and its hash, cannot be checked')
  if (BigInt(tx.gasPrice) > 0n)
    flag(
      `it pays a gas refund (gasPrice ${tx.gasPrice}) from the Safe to ${tx.refundReceiver === ZERO ? 'the submitter' : tx.refundReceiver}: the builder never sets one`
    )
  else if (tx.gasToken !== ZERO || tx.refundReceiver !== ZERO)
    warn('it names a gas token or refund receiver; with gasPrice 0 neither is paid')
  if (BigInt(tx.safeTxGas) > 0n)
    warn(
      `safeTxGas is ${tx.safeTxGas}: the inner call may then fail without reverting, and the nonce is spent`
    )
  const hash =
    safe !== null && tx.nonce !== null
      ? safeTxHash(safe, chainId, { ...tx, nonce: tx.nonce })
      : null
  if (safe !== null && tx.nonce === null)
    warn('no nonce was given, so the hash the owners sign is not shown: compare it in the wallet')

  // The calls: the Safe's own, or each of a MultiSend batch.
  const calls: Call[] = []
  const created: { address: string }[] = []
  const top: Call = {
    at: 'safe',
    operation: tx.operation,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    fn: null,
    args: null,
  }
  const isBatch = tx.data.slice(2, 10) === MULTISEND
  if (tx.operation === 1 && !(tx.to === EVM.multiSend && isBatch))
    flag(
      `it delegatecalls ${tx.to}: the Safe would run that contract's code as itself (SignMessageLib, for one, would approve an EIP-1271 message: a permit); the builder delegatecalls only MultiSend 1.4.1`
    )
  if (isBatch && (tx.to === EVM.multiSend || tx.to === EVM.multiSendCallOnly)) {
    try {
      const a = decodeArgs(Buffer.from(tx.data.slice(10), 'hex'), ['bytes'])
      if (hex(encodeArgs(['bytes'], a)) !== tx.data.slice(10))
        flag(
          'the multiSend calldata is not its canonical encoding: it carries bytes past its last argument'
        )
      calls.push(...unpack(a[0] as string))
    } catch (e) {
      flag(`the MultiSend batch does not decode: ${messageOf(e)}`)
    }
    if (tx.to === EVM.multiSendCallOnly && calls.some((c) => c.operation !== 0))
      flag('MultiSendCallOnly refuses a delegatecall in its batch')
  } else calls.push(top)

  // What each call does, checked. A function revoked anywhere in the batch counts for a revokeTarget:
  // the batch is atomic.
  const revoked = new Set<string>()
  for (const c of calls)
    if (c.data.slice(2, 10) === selectorOf('revokeFunction(bytes32,address,bytes4)'))
      try {
        const [k, t] = decodeArgs(Buffer.from(c.data.slice(10), 'hex'), [
          'bytes32',
          'address',
          'bytes4',
        ])
        revoked.add(`${k}|${t}`)
      } catch {
        // flagged below, where the call is read
      }
  const body: Node[] = []
  if (BigInt(tx.value) > 0n) flag(`the Safe transaction sends ${tx.value} wei`)
  calls.forEach((c, n) => {
    const where = c.at === 'safe' ? 'the call' : `batch call ${n}`
    const kids: Node[] = []
    const sel = c.data.slice(2, 10)
    const f = ABI[sel] ?? VENUE[sel]
    if (BigInt(c.value) > 0n) flag(`${where} sends ${c.value} wei to ${c.to}`)
    if (c.at !== 'safe' && c.operation === 1) {
      const ok = c.to === EVM.createCall && f?.name === 'performCreate2'
      if (!ok)
        flag(
          `${where} delegatecalls ${c.to}: the Safe would run its code as itself; the builder delegatecalls only CreateCall to deploy a Roles proxy`
        )
    }
    if (c.data === '0x') {
      body.push(group(`${n}: sends ${c.value} wei to ${show(c.to)}`, 'call', []))
      return
    }
    if (!f) {
      flag(`${where} calls ${show(c.to)} with selector 0x${sel}, a call this review does not read`)
      body.push(group(`${n}: ${show(c.to)} 0x${sel}`, 'call', [fact('data', c.data)]))
      return
    }
    let a: V[]
    try {
      a = decodeArgs(Buffer.from(c.data.slice(10), 'hex'), f.types)
    } catch (e) {
      flag(`${where} (${f.name}) does not decode: ${messageOf(e)}`)
      body.push(group(`${n}: ${show(c.to)} ${f.name}`, 'call', [fact('data', c.data)]))
      return
    }
    if (hex(encodeArgs(f.types, a)) !== c.data.slice(10))
      flag(
        `${where} (${f.name}) carries calldata past its last argument, or is not its canonical encoding`
      )
    c.fn = f.name
    c.args = Object.fromEntries(f.params.map((p, k) => [p, plain(a[k] as V)]))
    const arg = (k: number) => a[k] as V
    const role = (k: number) => roleName(arg(k) as string)
    const self = safe !== null && c.to === safe
    switch (f.name) {
      case 'performCreate2': {
        const code = arg(1) as string
        if (code !== ROLES_PROXY_CODE)
          flag(`${where} deploys code that is not an ERC-1167 proxy to the Roles v2.1.1 mastercopy`)
        else if (safe !== null) created.push({ address: create2(safe, arg(2) as string, code) })
        kids.push(
          fact(
            'deploys',
            code === ROLES_PROXY_CODE ? 'a Roles v2.1.1 proxy' : `${code.length / 2} bytes of code`
          ),
          ...(created.length
            ? [fact('at', show((created.at(-1) as { address: string }).address))]
            : [])
        )
        break
      }
      case 'setUp': {
        let init: V[] = []
        try {
          init = decodeArgs(Buffer.from(arg(0) as string, 'hex'), ['address', 'address', 'address'])
        } catch (e) {
          flag(
            `${where}: setUp's parameters do not decode as (owner, avatar, target): ${messageOf(e)}`
          )
        }
        const [owner, avatar, target] = init as string[]
        if (init.length && (owner !== safe || avatar !== safe || target !== safe))
          flag(
            `${where}: the Roles module is set up with owner ${owner}, avatar ${avatar} and target ${target}; all three must be the Safe itself`
          )
        kids.push(fact('owner, avatar, target', init.map((x) => show(x as string)).join(', ')))
        break
      }
      case 'enableModule':
        if (!self) flag(`${where} calls enableModule on ${c.to}, not on the Safe under review`)
        if (!created.some((x) => x.address === arg(0)))
          warn(
            `${where} enables module ${arg(0)}, which this transaction does not deploy: what it runs is not in the bytes, and an enabled module can make the Safe call anything`
          )
        kids.push(fact('module', show(arg(0) as string)))
        break
      case 'disableModule':
        kids.push(fact('module', show(arg(1) as string)))
        break
      case 'setGuard':
      case 'setModuleGuard':
      case 'setFallbackHandler':
        if (arg(0) !== ZERO)
          flag(
            `${where} sets a ${f.name.slice(3)} (${arg(0)}), which the design never sets: it runs on the Safe's own calls`
          )
        kids.push(fact(f.params[0] as string, show(arg(0) as string)))
        break
      case 'changeThreshold':
      case 'addOwnerWithThreshold':
      case 'removeOwner': {
        const t = arg(
          f.name === 'changeThreshold' ? 0 : f.name === 'addOwnerWithThreshold' ? 1 : 2
        ) as bigint
        const least = i.role === 'custody' ? 3n : 2n
        if (t < least)
          flag(
            `${where} sets the threshold to ${t}: the ${i.role === 'custody' ? 'custody Safe is 3 of 3, so nothing changes without the trustee' : 'Prime account is 2 of 3, so no owner acts alone'}`
          )
        if (f.name !== 'changeThreshold')
          warn(
            `${where} changes the Safe's owners (${f.name}): check the threshold still needs every party it should`
          )
        kids.push(
          fact('threshold', String(t)),
          ...(f.name !== 'changeThreshold'
            ? [fact('owner', show(arg(f.name === 'addOwnerWithThreshold' ? 0 : 1) as string))]
            : [])
        )
        break
      }
      case 'swapOwner':
        warn(`${where} swaps an owner of the Safe`)
        kids.push(fact('out', show(arg(1) as string)), fact('in', show(arg(2) as string)))
        break
      case 'allowTarget':
        flag(
          `${where} opens target ${arg(1)} to role ${role(0)} for EVERY function and argument (allowTarget): an under-read scoping; scope the target and its functions instead`
        )
        optionsCheck(arg(2) as bigint, where, flag, warn)
        kids.push(
          fact('role', role(0)),
          fact('target', `${show(arg(1) as string)}, ANY function, ANY arguments`)
        )
        break
      case 'allowFunction': {
        const v = VENUE[(arg(2) as string).slice(2)]
        if (EXEC_DEFAULT.has((arg(2) as string).slice(2)))
          flag(
            `${where} lets the role reach execTransactionFromModule, which acts with the caller's default role`
          )
        flag(
          `${where} allows ${v?.name ?? arg(2)} on ${arg(1)} with ANY arguments (allowFunction): an under-read scoping${v?.recipient !== undefined ? `, its ${v.params[v.recipient]} included` : ''}`
        )
        optionsCheck(arg(3) as bigint, where, flag, warn)
        kids.push(
          fact('role', role(0)),
          fact('target', show(arg(1) as string)),
          fact('function', `${v?.name ?? arg(2)}, ANY arguments`)
        )
        break
      }
      case 'scopeTarget':
        warn(
          `${where} scopes target ${arg(1)} for role ${role(0)}: any function scope stored for it before (a revokeTarget keeps them) comes back with it; the stored scopes are not in these bytes`
        )
        kids.push(
          fact('role', role(0)),
          fact('target', `${show(arg(1) as string)}, listed functions only`)
        )
        break
      case 'revokeFunction':
        kids.push(
          fact('role', role(0)),
          fact('target', show(arg(1) as string)),
          fact('function', String(VENUE[(arg(2) as string).slice(2)]?.name ?? arg(2)))
        )
        break
      case 'revokeTarget':
        // Allowed (removing a venue is a legitimate change, and it takes effect at once), but the
        // owner must know the function scopes stay stored and revive on a later scopeTarget.
        if (!revoked.has(`${arg(0)}|${arg(1)}`))
          warn(
            `${where} revokes target ${arg(1)} for role ${role(0)} without revoking its functions in the same batch: the target is closed at once, but every function scope on it stays stored and comes back as it was if the target is scoped again (PermissionBuilder.sol:72-97); to remove the target for good, revokeFunction each of its functions too`
          )
        else
          warn(
            `${where} revokes target ${arg(1)} after revoking some of its functions: check every function scoped on it is revoked; the stored scopes are not in these bytes`
          )
        kids.push(fact('role', role(0)), fact('target', show(arg(1) as string)))
        break
      case 'scopeFunction':
        kids.push(...scoping(a, where, i.role, recipients, flag, warn, show))
        break
      case 'setAllowance':
        kids.push(
          fact('allowance', roleName(arg(0) as string)),
          fact('balance', String(arg(1))),
          fact(
            'refill',
            `${arg(3)} every ${arg(4)} s, up to ${arg(2) === 0n ? 'no ceiling' : arg(2)}`
          )
        )
        break
      case 'assignRoles': {
        const keys = arg(1) as string[]
        const on = arg(2) as boolean[]
        if (keys.length !== on.length)
          flag(`${where}: assignRoles names ${keys.length} roles and ${on.length} flags`)
        kids.push(
          fact('member', show(arg(0) as string)),
          ...keys.map((k, j) => fact(on[j] ? 'joins' : 'leaves', roleName(k)))
        )
        break
      }
      case 'setDefaultRole':
        warn(
          `${where} sets a default role for ${arg(0)}: its plain module calls then act with that role`
        )
        kids.push(fact('module', show(arg(0) as string)), fact('role', role(1)))
        break
      case 'setTransactionUnwrapper': {
        const [to, s, adapter] = [arg(0), (arg(1) as string).slice(2), arg(2)] as string[]
        const ok =
          adapter === ZERO ||
          ((to === EVM.multiSendCallOnly || to === EVM.multiSend) &&
            s === MULTISEND &&
            adapter === EVM.unwrapper)
        if (!ok)
          flag(
            `${where} registers unwrap adapter ${adapter} for ${to} ${s}: an adapter splits calls before the rules see them; the design registers only the Roles MultiSend unwrapper for MultiSend`
          )
        kids.push(
          fact('for', `${show(to as string)} 0x${s}`),
          fact('adapter', show(adapter as string)),
          fact(
            'note',
            'it applies to every role of this module, and the batch target itself is not checked against the role, only each call inside it'
          )
        )
        break
      }
      case 'transferOwnership':
      case 'setAvatar':
      case 'setTarget':
        flag(
          `${where} calls ${f.name}(${arg(0)}) on a Roles module: its owner, avatar and target stay the Safe (EqualToAvatar reads the avatar at each call, PermissionLoader.sol:59-63, so a new avatar moves every custody pin)`
        )
        kids.push(fact(f.params[0] as string, show(arg(0) as string)))
        break
      case 'schedule': {
        // A move or a recovery proposed to an OpenZeppelin TimelockController: it runs, as the
        // timelock, once the delay is over, by anyone who executes it.
        const [target, value, data, , , delay] = a as [
          string,
          bigint,
          string,
          string,
          string,
          bigint,
        ]
        const sel = data.slice(0, 8)
        const g = ABI[sel] ?? VENUE[sel]
        if (value > 0n) flag(`${where} schedules a call that sends ${value} wei`)
        kids.push(
          fact('timelock', show(c.to)),
          fact('calls', `${show(target)} ${g?.name ?? `0x${sel}`}`),
          fact('after', `${delay} s`)
        )
        if (EXEC_WITH_ROLE.has(sel)) {
          try {
            const [to, v, d, op, rk, sr] = decodeArgs(
              Buffer.from(data.slice(8), 'hex'),
              (ABI[sel] as Fn).types
            ) as [string, bigint, string, bigint, string, boolean]
            const venue = VENUE[d.slice(0, 8)]
            if (op !== 0n)
              flag(`${where}: the scheduled gate call asks for a delegatecall (operation ${op})`)
            if (v > 0n) flag(`${where}: the scheduled gate call sends ${v} wei`)
            if (!sr)
              warn(
                `${where}: the scheduled gate call does not set shouldRevert, so a failing step would not revert`
              )
            kids.push(
              fact('role', roleName(rk)),
              fact('move', `${venue?.name ?? `0x${d.slice(0, 8)}`} on ${show(to)}`),
              ...(venue && d.length >= 8 + 64 * venue.types.length
                ? (() => {
                    try {
                      const va = decodeArgs(Buffer.from(d.slice(8), 'hex'), venue.types)
                      return venue.params.map((p, k) =>
                        fact(
                          p,
                          typeof va[k] === 'string' && address.test(va[k] as string)
                            ? show(va[k] as string)
                            : String(plain(va[k] as V))
                        )
                      )
                    } catch {
                      return [fact('arguments', 'do not decode')]
                    }
                  })()
                : [])
            )
          } catch (e) {
            flag(`${where}: the scheduled gate call does not decode: ${messageOf(e)}`)
          }
        } else
          warn(
            `${where} schedules ${g?.name ?? `0x${sel}`} on ${target}: once the delay is over anyone may make the timelock call it`
          )
        break
      }
      case 'cancel':
        kids.push(fact('timelock', show(c.to)), fact('operation', String(arg(0))))
        break
      case 'execute':
        warn(
          `${where} runs a call scheduled on timelock ${c.to}: what it does was fixed when it was scheduled`
        )
        kids.push(fact('timelock', show(c.to)), fact('calls', show(arg(0) as string)))
        break
      case 'updateDelay':
        warn(
          `${where} calls updateDelay on ${c.to} directly: only the timelock itself may change its delay, so this reverts unless it is scheduled`
        )
        break
      case 'renounceOwnership':
        flag(
          `${where} renounces ownership of a Roles module: no one could change or stop its rules again`
        )
        break
      case 'multiSend':
        flag(`${where} nests a batch in a batch, which the builder never makes`)
        break
      case 'execTransaction':
        flag(`${where} calls another Safe's execTransaction from inside this one`)
        break
      case 'performCreate':
        flag(`${where} deploys code with CREATE, which the builder never uses`)
        break
      default:
        if (VENUE[sel])
          flag(
            `${where} makes the Safe itself call ${f.name} on ${c.to}: a configuration transaction moves no funds and grants no approval; the gate's rules do that`
          )
        else
          for (const [k, p] of f.params.entries())
            kids.push(
              fact(
                p,
                typeof arg(k) === 'string' && address.test(arg(k) as string)
                  ? show(arg(k) as string)
                  : String(plain(arg(k)))
              )
            )
    }
    body.push(
      group(
        `${n}: ${show(c.to)} ${f.name}${c.operation === 1 ? ' (delegatecall)' : ''}`,
        'call',
        kids
      )
    )
  })

  // The chain, when a reader supplies it.
  const chainNode = onChain
    ? onChain({ i, safe, chainId, tx, calls, created, flag, warn, show })
    : null

  const head = group('Safe transaction', 'transaction', [
    fact('safe', safe ? show(safe) : 'not given'),
    fact('chain', `${chainId}${CHAINS[chainId] ? ` (${CHAINS[chainId]})` : ''}`),
    fact('to', `${show(tx.to)}${tx.operation === 1 ? ', DELEGATECALL' : ''}`),
    fact('value', `${tx.value} wei`),
    fact('gas', `safeTxGas ${tx.safeTxGas}, baseGas ${tx.baseGas}, gasPrice ${tx.gasPrice}`),
    fact('nonce', tx.nonce ?? 'not given'),
    fact('safeTxHash', hash ?? 'not computed'),
    fact('calls', `${calls.length}${isBatch ? ' (a MultiSend batch)' : ''}`),
  ])
  const reviewTree = [
    ...(problems.length
      ? [
          group(
            `Do not sign: ${problems.length} problem(s)`,
            'problems',
            problems.map((p) => fact('problem', p))
          ),
        ]
      : []),
    ...(warnings.length ? [warned(warnings)] : []),
    head,
    ...(chainNode ? [chainNode] : []),
    ...body,
  ]
  return {
    role: i.role,
    chainId,
    safe,
    safeTxHash: hash,
    tx,
    calls,
    problems,
    warnings,
    signable: problems.length === 0,
    review: lines(reviewTree),
    reviewTree,
  }
}

function hexBytes(s: string, what: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) throw bad(`${what} is not 0x-prefixed hex bytes`)
  return Buffer.from(s.slice(2), 'hex')
}

/** A role key: its text when it is a short ASCII name (`TRADE`), else the hex. */
export function roleName(k: string): string {
  const b = Buffer.from(k.slice(2), 'hex')
  const end = b.indexOf(0)
  const text = b.subarray(0, end < 0 ? b.length : end)
  return text.length > 0 &&
    b.subarray(text.length).every((x) => x === 0) &&
    /^[\x20-\x7e]+$/.test(text.toString('latin1'))
    ? `"${text.toString('latin1')}"`
    : k
}

const plain = (v: V): unknown =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? (v as unknown[]).map((x) => (typeof x === 'bigint' ? x.toString() : x))
      : v

/** The address CREATE2 gives `code` deployed by `deployer` with `salt`. */
function create2(deployer: string, salt: string, code: string): string {
  const h = keccak256(
    Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from(deployer.slice(2), 'hex'),
      Buffer.from(salt.slice(2), 'hex'),
      keccak256(Buffer.from(code, 'hex')),
    ])
  )
  return `0x${hex(h.subarray(12))}`
}

/** A MultiSend batch: op (1) ‖ to (20) ‖ value (32) ‖ length (32) ‖ data, repeated to the end. */
function unpack(batch: string): Call[] {
  const b = Buffer.from(batch, 'hex')
  const out: Call[] = []
  let o = 0
  while (o < b.length) {
    if (o + 85 > b.length) throw new DecodeError(`batch call ${out.length} is cut short`)
    const operation = b[o] as number
    if (operation > 1) throw new DecodeError(`batch call ${out.length} has operation ${operation}`)
    const to = `0x${b.subarray(o + 1, o + 21).toString('hex')}`
    const value = BigInt(`0x${b.subarray(o + 21, o + 53).toString('hex')}`)
    const len = BigInt(`0x${b.subarray(o + 53, o + 85).toString('hex')}`)
    if (len > BigInt(b.length - o - 85))
      throw new DecodeError(`batch call ${out.length} runs past the batch`)
    const data = b.subarray(o + 85, o + 85 + Number(len))
    out.push({
      at: `batch ${out.length}`,
      operation,
      to,
      value: value.toString(),
      data: `0x${data.toString('hex')}`,
      fn: null,
      args: null,
    })
    o += 85 + Number(len)
  }
  if (out.length === 0) throw new DecodeError('the batch is empty')
  return out
}

function optionsCheck(
  o: bigint,
  where: string,
  flag: (p: string) => void,
  warn: (w: string) => void
) {
  if (o === 2n || o === 3n)
    flag(
      `${where} lets the role DELEGATECALL (ExecutionOptions ${o}): the Safe would run the target's code as itself`
    )
  else if (o === 1n) warn(`${where} lets the role send ETH with the call (ExecutionOptions Send)`)
  else if (o > 3n) flag(`${where} carries ExecutionOptions ${o}, which Roles does not define`)
}

/** `scopeFunction(roleKey, target, selector, conditions, options)`: the tree, read and checked. */
export function scoping(
  a: V[],
  where: string,
  role: EvmRole,
  recipients: Set<string>,
  flag: (p: string) => void,
  warn: (w: string) => void,
  show: (a: string) => string
): Node[] {
  const [roleKey, target, selector, flat, options] = a as [
    string,
    string,
    string,
    ConditionFlat[],
    bigint,
  ]
  const sel = selector.slice(2)
  const band = EXEC_WITH_ROLE.has(sel)
  const viaTimelock = sel === SCHEDULE
  const f: Venue | Fn | undefined = VENUE[sel] ?? (band || viaTimelock ? ABI[sel] : undefined)
  const name = f?.name ?? selector
  const what = `${where} (${name} on ${target}, role ${roleName(roleKey)})`
  optionsCheck(options, what, flag, warn)
  let root: Cond
  try {
    root = treeOf(flat)
  } catch (e) {
    flag(`${what}: the conditions are not a tree Roles accepts: ${messageOf(e)}`)
    return [fact('role', roleName(roleKey)), fact('target', show(target)), fact('function', name)]
  }
  if (hasOp(root, [22]))
    flag(`${what}: a Custom condition calls an outside contract, which the design never uses`)
  if (!constrains(root))
    flag(
      `${what}: the condition tree constrains nothing (every argument passes): an under-read scoping, as open as allowFunction`
    )
  if (role === 'custody' && f && 'borrow' in f && f.borrow)
    flag(
      `${what}: the gate lets the role borrow against custody's position, which the design never allows`
    )
  if (role === 'custody' && f && 'never' in f && f.never)
    flag(`${what}: ${f.never}, a grant the design never makes`)
  if (EXEC_DEFAULT.has(sel))
    flag(
      `${what}: it lets the band reach the gate's execTransactionFromModule, which acts with the caller's default role, not one the band pins; bands scope only execTransactionWithRole`
    )

  if (f) layout(root, f, what, flag)
  else
    warn(
      `${what}: a function this review has no ABI for, so its parameter layout is not checked; calldata past its last checked argument passes Roles, so the venue must decode it with the Solidity ABI decoder`
    )

  if (f && 'recipient' in f && f.recipient !== undefined)
    recipient(root, f, f.recipient, what, role === 'custody', recipients, flag, warn)
  if (f && 'spender' in f && f.spender !== undefined && argAllowed(root, f.spender) === null)
    flag(
      `${what}: the ${f.params[f.spender]} is not pinned, so custody could grant an allowance to anyone`
    )
  if (f && 'debtor' in f && f.debtor !== undefined && argAllowed(root, f.debtor) === null)
    warn(
      `${what}: the borrow's onBehalfOf (the debtor) is open: the Safe could borrow against anyone who delegated credit to it`
    )
  if (band) bandCheck(root, what, recipients, flag, warn)
  if (viaTimelock) timelockBand(root, what, recipients, flag, warn)

  const allowances = collect(root, [28, 29, 30]).map((c) => roleName(`0x${c.compValue}`))
  return [
    fact('role', roleName(roleKey)),
    fact('target', show(target)),
    fact('function', `${name} (0x${sel})`),
    ...(allowances.length ? [fact('within allowance', allowances.join(', '))] : []),
    group('Conditions', 'conditions', [describe(root, [])]),
  ]
}

const collect = (c: Cond, ops: number[]): Cond[] => [
  ...(ops.includes(c.operator) ? [c] : []),
  ...c.children.flatMap((x) => collect(x, ops)),
]

/** Each Matches standing for the call must read every parameter, each with its own type. */
function layout(root: Cond, f: Fn, what: string, flag: (p: string) => void) {
  const { sets } = argumentSets(root)
  if (sets.length === 0) {
    flag(
      `${what}: the root is ${OP[root.operator] ?? root.operator}, not a Matches over ${f.name}'s ${f.types.length} arguments`
    )
    return
  }
  for (const m of sets) {
    if (m.paramType !== 5 && m.paramType !== 6)
      flag(`${what}: the call's Matches is typed ${PARAM[m.paramType]}, not Calldata`)
    if (m.children.length < f.types.length)
      flag(
        `${what}: the Matches reads ${m.children.length} of ${f.name}'s ${f.types.length} arguments, so ${f.params.slice(m.children.length).join(', ')} pass(es) unread`
      )
    else if (m.children.length > f.types.length)
      flag(
        `${what}: the Matches has ${m.children.length} children for ${f.name}'s ${f.types.length} arguments: a wrong layout`
      )
    m.children.slice(0, f.types.length).forEach((c, k) => {
      const t = effectiveType(c)
      if (t === 'mixed' || !wants(f.types[k] as T).includes(t))
        flag(
          `${what}: argument ${k} (${f.params[k]}) is read as ${t === 'mixed' ? 'mixed types' : PARAM[t]}, but ${f.name} has a ${f.types[k]} there: a wrong layout`
        )
    })
  }
}

function recipient(
  root: Cond,
  f: Fn,
  k: number,
  what: string,
  custody: boolean,
  recipients: Set<string>,
  flag: (p: string) => void,
  warn: (w: string) => void
) {
  const p = f.params[k] as string
  const vals = argAllowed(root, k)
  if (vals === null) {
    if (custody)
      flag(
        `${what}: ${p} is not pinned (not EqualToAvatar): the role could send the funds or the position to anyone`
      )
    else warn(`${what}: ${p} is left open; the custody gate must pin it to custody`)
    return
  }
  for (const v of vals)
    if (v !== AVATAR && !recipients.has(v))
      flag(
        `${what}: ${p} may be ${v}, which is neither the avatar (EqualToAvatar) nor one of the given recipients`
      )
}

const SCHEDULE = selectorOf('schedule(address,uint256,bytes,bytes32,bytes32,uint256)')

/** A band through a move timelock: a scoping of the timelock's `schedule` whose call is the gate's
 *  execTransactionWithRole, read as a band one level down. The timelock then makes the gate call
 *  itself (it is the gate role's member), after its delay. */
function timelockBand(
  root: Cond,
  what: string,
  recipients: Set<string>,
  flag: (p: string) => void,
  warn: (w: string) => void
) {
  const zero = `0x${'0'.repeat(40)}`
  if (argAllowed(root, 0) === null)
    flag(`${what}: the band does not pin the scheduled call's target (the gate)`)
  const value = argAllowed(root, 1)
  if (value === null || [...value].some((v) => v !== zero))
    flag(`${what}: the band does not hold the scheduled call's value to 0`)
  for (const m of argumentSets(root).sets) {
    const data = m.children[2]
    if (!data) continue
    const parts = data.operator === 1 ? data.children : [data]
    const inner = parts.find((c) => c.operator === 5 && c.paramType === 5)
    const mask = parts.find((c) => c.operator === 21 && c.paramType === 2)
    if (!inner || !mask) {
      flag(
        `${what}: the band does not read the scheduled call (${inner ? 'no Bitmask on its selector' : 'no Calldata Matches on data'}), so the agent could schedule any call the timelock may make`
      )
      continue
    }
    const v = mask.compValue
    const e4 = v.slice(34, 42)
    if (
      v.length !== 64 ||
      v.slice(0, 4) !== '0000' ||
      v.slice(4, 34) !== `ffffffff${'0'.repeat(22)}` ||
      !EXEC_WITH_ROLE.has(e4)
    ) {
      flag(
        `${what}: the scheduled call's Bitmask does not pin it to the gate's execTransactionWithRole`
      )
      continue
    }
    const f = ABI[e4] as Fn
    layout({ ...inner, operator: 5 }, f, `${what}, scheduled ${f.name}`, flag)
    bandCheck({ ...inner, operator: 5 }, `${what}, scheduled ${f.name}`, recipients, flag, warn)
  }
}

/** A band: a scoping of the gate's execTransactionWithRole. Everything the agent could vary is pinned. */
function bandCheck(
  root: Cond,
  what: string,
  recipients: Set<string>,
  flag: (p: string) => void,
  warn: (w: string) => void
) {
  const pinned = (k: number) => argAllowed(root, k)
  const word = (v: bigint) => `0x${v.toString(16).padStart(40, '0')}`
  if (pinned(0) === null) flag(`${what}: the band does not pin the gate call's target (to)`)
  const value = pinned(1)
  if (value === null || [...value].some((v) => v !== word(0n)))
    flag(`${what}: the band does not hold the value sent through the gate to 0`)
  const op = pinned(3)
  if (op === null || [...op].some((v) => v !== word(0n)))
    flag(
      `${what}: the band does not hold the operation to a plain call (0): the agent could ask for a delegatecall`
    )
  if (pinned(4) === null)
    flag(
      `${what}: the band does not pin the gate role (roleKey), so the agent could pick any role the Prime account holds`
    )
  const revert = pinned(5)
  if (revert === null || [...revert].some((v) => v !== word(1n)))
    flag(
      `${what}: the band does not pin shouldRevert = true, so a failing step would not revert the batch`
    )

  // The inner call: a Calldata Matches beside a Bitmask on its selector.
  const { sets } = argumentSets(root)
  for (const m of sets) {
    const data = m.children[2]
    if (!data) continue
    const parts = data.operator === 1 ? data.children : [data]
    const inner = parts.find((c) => c.operator === 5 && c.paramType === 5)
    const mask = parts.find((c) => c.operator === 21 && c.paramType === 2)
    if (!inner) {
      flag(
        `${what}: the band does not read the inner call (no Calldata Matches on data), so any call through the gate passes`
      )
      continue
    }
    if (!mask) {
      flag(
        `${what}: the inner call has no Bitmask on its selector, so any function with the same layout passes (a withdraw padded to a supply's layout, for one)`
      )
      continue
    }
    // shift (2) | mask (15) | expected (15), Integrity.sol:116-124, PermissionChecker.sol:593-623.
    const v = mask.compValue
    const [shift, bits, x] = [v.slice(0, 4), v.slice(4, 34), v.slice(34)]
    const e4 = x.slice(0, 8)
    if (
      v.length !== 64 ||
      shift !== '0000' ||
      bits !== `ffffffff${'0'.repeat(22)}` ||
      x.slice(8) !== '0'.repeat(22)
    ) {
      flag(
        `${what}: the inner Bitmask does not pin exactly the four selector bytes at offset 0 (shift 0, mask ffffffff)`
      )
      continue
    }
    const fn = VENUE[e4]
    if (!fn) {
      warn(`${what}: the inner selector 0x${e4} is a function this review has no ABI for`)
      continue
    }
    layout({ ...inner, operator: 5 }, fn, `${what}, inner ${fn.name}`, flag)
    if (fn.recipient !== undefined)
      recipient(inner, fn, fn.recipient, `${what}, inner ${fn.name}`, false, recipients, flag, warn)
    if (fn.amount !== undefined) {
      const amount = inner.children[fn.amount]
      if (!amount || !hasOp(amount, [17, 18, 28]))
        warn(`${what}: the inner ${fn.name} has no ceiling or allowance on its amount`)
    }
  }
}
