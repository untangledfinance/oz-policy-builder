// The Safe transactions the evm_review readChain tests review, against the move-timelock setup of
// scripts/evm-chain/Setup.s.sol on a local Base Sepolia fork (fixtures/evm/chain-addresses.json),
// and the changes each recorded fork state makes to that setup. `recordEvm` runs on the fork only
// (scripts/record-chain.ts evm <state>): it changes the state as the owners or a key could, reads
// what each review needs, and puts the fork back.

import addresses from '../fixtures/evm/chain-addresses.json'
import { hex } from '../src/bytes.ts'
import { type ConditionFlat, encodeArgs, selectorOf, type T, type V } from '../src/evm.ts'
import { type EvmSnapshot, readEvmChain } from '../src/evm-chain.ts'
import type { Rpc } from '../src/jsonrpc.ts'

export const A = Object.fromEntries(
  Object.entries(addresses).map(([k, v]) => [k, (v as string).toLowerCase()])
) as Record<keyof typeof addresses, string>
export const POOL = '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27'
export const USDC = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f'
export const key = (s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`
export const TRADE = key('prime-trading')
export const BAND = key('agent-low')

export function call(sig: string, ...args: V[]): string {
  const inner = sig.slice(sig.indexOf('(') + 1, -1)
  const types = (
    inner ? inner.replace('(uint8,uint8,uint8,bytes)[]', 'conditions').split(',') : []
  ) as T[]
  return `0x${selectorOf(sig)}${hex(encodeArgs(types, args))}`
}
const word = (v: bigint | string) =>
  typeof v === 'bigint' ? v.toString(16).padStart(64, '0') : v.slice(2).padStart(64, '0')
const c = (parent: number, paramType: number, operator: number, compValue = ''): ConditionFlat => ({
  parent,
  paramType,
  operator,
  compValue,
})
const multiSend = (entries: [string, string][]) =>
  call(
    'multiSend(bytes)',
    entries
      .map(
        ([to, data]) =>
          `00${to.slice(2)}${word(0n)}${word(BigInt((data.length - 2) / 2))}${data.slice(2)}`
      )
      .join('')
  )
const withdrawTree = [c(0, 5, 5), c(0, 1, 16, word(USDC)), c(0, 1, 0), c(0, 1, 15)]
const approveTree = [c(0, 5, 5), c(0, 1, 16, word(POOL)), c(0, 1, 18, word(1_001_000_000n))]

/** Each case: the Safe transaction, the Safe, the role and the readChain inputs. */
export const CASES = {
  /** custody re-scopes the gate's withdraw (to custody only), knowing its move timelock */
  gateRescope: {
    safeTx: {
      to: A.gate,
      data: call(
        'scopeFunction(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)',
        TRADE,
        POOL,
        `0x${selectorOf('withdraw(address,uint256,address)')}`,
        withdrawTree,
        0n
      ),
      nonce: '1',
    },
    safe: A.custody,
    role: 'custody',
    timelock: A.moves,
  },
  /** the Prime owners touch the agent's band: the live band scoping on TLx is read */
  bandRescope: {
    safeTx: {
      to: A.primeRoles,
      data: call('scopeTarget(bytes32,address)', BAND, A.moves),
      nonce: '1',
    },
    safe: A.prime,
    role: 'prime',
    timelock: A.moves,
  },
  /** custody adds an ERC-3643 token as a venue: approve to the pool only, under 1,001 */
  tokenVenue: {
    safeTx: {
      to: '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526',
      operation: 1,
      data: multiSend([
        [A.gate, call('scopeTarget(bytes32,address)', TRADE, A.token)],
        [
          A.gate,
          call(
            'scopeFunction(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)',
            TRADE,
            A.token,
            `0x${selectorOf('approve(address,uint256)')}`,
            approveTree,
            0n
          ),
        ],
      ]),
      nonce: '1',
    },
    safe: A.custody,
    role: 'custody',
  },
  /** the Prime owners propose a move on TLx themselves: supply 5 USDC to the pool for custody */
  schedule: {
    safeTx: {
      to: A.moves,
      data: call(
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
        A.gate,
        0n,
        call(
          'execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)',
          POOL,
          0n,
          call('supply(address,uint256,address,uint16)', USDC, 5_000_000n, A.custody, 0n).slice(2),
          0n,
          TRADE,
          true
        ).slice(2),
        `0x${'0'.repeat(64)}`,
        `0x${'0'.repeat(63)}9`,
        3600n
      ),
      nonce: '1',
    },
    safe: A.prime,
    role: 'prime',
  },
  /** custody takes the pool off the trading role with revokeTarget alone */
  revokePool: {
    safeTx: { to: A.gate, data: call('revokeTarget(bytes32,address)', TRADE, POOL), nonce: '1' },
    safe: A.custody,
    role: 'custody',
  },
  /** custody scopes USDC again for trading (after a revokeTarget, the stored function scopes return) */
  reviveUsdc: {
    safeTx: { to: A.gate, data: call('scopeTarget(bytes32,address)', TRADE, USDC), nonce: '1' },
    safe: A.custody,
    role: 'custody',
  },
} as const
export type CaseName = keyof typeof CASES
export const input = (n: CaseName) => {
  const k = CASES[n]
  return {
    ...k,
    safeTx: { ...k.safeTx },
    chainId: 84532,
    role: k.role as 'custody' | 'prime',
  } as Parameters<typeof readEvmChain>[0]
}

/** The fork states, each a change to the setup made the way its holder could make it. */
export const STATES: Record<string, { cases: CaseName[]; change: [string, string, string][] }> = {
  good: {
    cases: ['gateRescope', 'bandRescope', 'tokenVenue', 'schedule', 'reviveUsdc'],
    change: [],
  },
  // a key with the gate's ownership opened POOL to the trading role (allowTarget)
  openTarget: {
    cases: ['gateRescope'],
    change: [[A.custody, A.gate, call('allowTarget(bytes32,address,uint8)', TRADE, POOL, 0n)]],
  },
  // USDC transfer allowed with any arguments (allowFunction), on a target the role has scoped
  wildcard: {
    cases: ['gateRescope', 'tokenVenue'],
    change: [
      [
        A.custody,
        A.gate,
        call(
          'allowFunction(bytes32,address,bytes4,uint8)',
          TRADE,
          USDC,
          `0x${selectorOf('transfer(address,uint256)')}`,
          0n
        ),
      ],
    ],
  },
  // the same, then USDC revoked: the wildcard waits for a scopeTarget
  dormant: {
    cases: ['reviveUsdc'],
    change: [
      [
        A.custody,
        A.gate,
        call(
          'allowFunction(bytes32,address,bytes4,uint8)',
          TRADE,
          USDC,
          `0x${selectorOf('transfer(address,uint256)')}`,
          0n
        ),
      ],
      [A.custody, A.gate, call('revokeTarget(bytes32,address)', TRADE, USDC)],
    ],
  },
  // a key enabled as a module of custody, and custody down to 2 of 3
  rogue: {
    cases: ['gateRescope'],
    change: [
      [A.custody, A.custody, call('enableModule(address)', `0x${'be'.repeat(20)}`)],
      [A.custody, A.custody, call('changeThreshold(uint256)', 2n)],
    ],
  },
  // the move timelock gave custody its admin role back (a scheduled self-call, run)
  timelockAdmin: {
    cases: ['gateRescope'],
    change: [
      [A.moves, A.moves, call('grantRole(bytes32,address)', `0x${'0'.repeat(64)}`, A.custody)],
    ],
  },
  // the agent's band opened to any schedule (allowFunction on TLx)
  looseBand: {
    cases: ['bandRescope'],
    change: [
      [
        A.prime,
        A.primeRoles,
        call(
          'allowFunction(bytes32,address,bytes4,uint8)',
          BAND,
          A.moves,
          `0x${selectorOf('schedule(address,uint256,bytes,bytes32,bytes32,uint256)')}`,
          0n
        ),
      ],
    ],
  },
  // the issuer froze custody and removed it from the identity registry
  tokenFrozen: {
    cases: ['tokenVenue'],
    change: [
      [A.deployer, A.token, call('setAddressFrozen(address,bool)', A.custody, true)],
      [A.deployer, A.registry, call('setVerified(address,bool)', A.custody, false)],
    ],
  },
  // a foreign unwrap adapter registered for MultiSend batches on the gate
  foreignUnwrapper: {
    cases: ['gateRescope'],
    change: [
      [
        A.custody,
        A.gate,
        call(
          'setTransactionUnwrapper(address,bytes4,address)',
          '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526',
          `0x${selectorOf('multiSend(bytes)')}`,
          `0x${'de'.repeat(20)}`
        ),
      ],
    ],
  },
  // the gate taken off the Safe: its rules move nothing
  gateOff: {
    cases: ['gateRescope'],
    change: [
      [
        A.custody,
        A.custody,
        call(
          'disableModule(address,address)',
          '0x0000000000000000000000000000000000000001',
          A.gate
        ),
      ],
    ],
  },
}

/** On the fork: change the state, read every case, put the fork back. Returns one merged snapshot. */
export async function recordEvm(state: string, rpc: Rpc): Promise<EvmSnapshot> {
  const s = STATES[state]
  if (!s) throw new Error(`no state ${state}`)
  if (Number(BigInt(String(await rpc('eth_chainId', [])))) !== 84532)
    throw new Error('not the Base Sepolia fork')
  const id = await rpc('evm_snapshot', [])
  try {
    for (const [from, to, data] of s.change) {
      await rpc('anvil_impersonateAccount', [from])
      await rpc('anvil_setBalance', [from, '0x56BC75E2D63100000'])
      const hash = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }])
      let receipt: { status: string } | null = null
      for (let k = 0; k < 50 && !receipt; k++) {
        receipt = (await rpc('eth_getTransactionReceipt', [hash])) as typeof receipt
        if (!receipt) await Bun.sleep(100)
      }
      if (receipt?.status !== '0x1')
        throw new Error(`${state}: the change ${data.slice(0, 10)} to ${to} reverted`)
    }
    const merged: EvmSnapshot = { chainId: 84532, block: '', answers: {} }
    for (const n of s.cases) {
      const snap = await readEvmChain(input(n), rpc)
      merged.block = snap.block
      Object.assign(merged.answers, snap.answers)
    }
    return merged
  } finally {
    await rpc('evm_revert', [id])
  }
}
