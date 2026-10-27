// Records the chain snapshots the `readChain` tests replay offline. Reads only; DEVNET and a Base
// Sepolia FORK only, never mainnet (the readers refuse it).
//
//   bun scripts/record-chain.ts solana         devnet (POLICY_BUILDER_SOLANA_RPC_URL, else the public endpoint):
//                                              every case of fixtures/solana/payfi-live.json, merged into
//                                              fixtures/solana/devnet-chain.json
//   bun scripts/record-chain.ts evm [state]    a local anvil fork of Base Sepolia (POLICY_BUILDER_EVM_RPC_URL,
//                                              default http://127.0.0.1:8545) set up by scripts/evm-chain/Setup.s.sol:
//                                              each state of test/evm-cases.ts made on the fork, every read the
//                                              review of its cases makes, into fixtures/evm/chain-<state>.json
import { writeFileSync } from 'node:fs'
import live from '../fixtures/solana/payfi-live.json'
import { httpRpc } from '../src/jsonrpc.ts'
import { readSolanaChain, type SolanaSnapshot, solanaRpcUrl } from '../src/solana-chain.ts'

const what = process.argv[2]

if (what === 'solana') {
  const K = live.keys as Record<string, string>
  const rpc = httpRpc(solanaRpcUrl(), { what: 'Solana' })
  const merged: SolanaSnapshot = { genesisHash: '', slot: 0, accounts: {} }
  const cases: [string, string, 'custody' | 'prime'][] = [
    [live.potOut, K.r2b as string, 'custody'],
    [live.createG1, K.lp as string, 'prime'],
    ...[
      live.updateR4Pinned,
      live.removeR4,
      live.addLooseWithdraw,
      live.addTightDeposit,
      live.addDuplicateR3,
      live.createR1,
    ].map((t) => [t, K.settlement as string, 'custody'] as [string, string, 'custody']),
  ]
  for (const [transaction, account, role] of cases) {
    await Bun.sleep(2_000) // the public endpoint rate-limits
    const s = await readSolanaChain({ transaction, role, account }, rpc)
    merged.genesisHash = s.genesisHash
    merged.slot = Math.max(merged.slot, s.slot)
    Object.assign(merged.accounts, s.accounts)
  }
  const file = new URL('../fixtures/solana/devnet-chain.json', import.meta.url)
  writeFileSync(
    file,
    `${JSON.stringify({ note: `Solana devnet accounts read by readSolanaChain for every case of payfi-live.json, slot ${merged.slot}, ${new Date().toISOString().slice(0, 10)}. Raw bytes as getMultipleAccounts returned them.`, ...merged }, null, 1)}\n`
  )
  console.log(`${Object.keys(merged.accounts).length} accounts at slot ${merged.slot}`)
} else if (what === 'evm') {
  const { recordEvm, STATES } = await import('../test/evm-cases.ts')
  const url = process.env.POLICY_BUILDER_EVM_RPC_URL ?? 'http://127.0.0.1:8545'
  const rpc = httpRpc(url, { what: 'EVM' })
  for (const state of process.argv[3] ? [process.argv[3]] : Object.keys(STATES)) {
    const snap = await recordEvm(state, rpc)
    writeFileSync(
      new URL(`../fixtures/evm/chain-${state}.json`, import.meta.url),
      `${JSON.stringify(snap, null, 1)}\n`
    )
    console.log(
      `${state}: ${Object.keys(snap.answers).length} reads at block ${BigInt(snap.block)}`
    )
  }
} else throw new Error('bun scripts/record-chain.ts solana | evm <state>')
