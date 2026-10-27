// solana_review with readChain: the unsigned transaction against the accounts it meets on devnet.
// The accounts are PayFi's live sol-devnet line (payfi main b9021a8), read by `readSolanaChain` and
// recorded raw (fixtures/solana/devnet-chain.json, scripts/record-chain.ts); the transactions are
// built by PayFi's own encoders over that line (fixtures/solana/payfi-live.json). A correct live
// state passes; each mismatch is made by changing the recorded bytes the way the chain would hold
// them, and must be caught.

import { afterEach, describe, expect, it } from 'bun:test'
import chain from '../fixtures/solana/devnet-chain.json'
import golden from '../fixtures/solana/payfi-golden.json'
import live from '../fixtures/solana/payfi-live.json'
import { fromBase58 } from './bytes.ts'
import { Refusal } from './envelope.ts'
import type { Rpc } from './jsonrpc.ts'
import { PROGRAM, reviewSolana } from './solana.ts'
import {
  DEPLOYED,
  GENESIS,
  looser,
  marketOf,
  mintOf,
  policyAddress,
  programAddress,
  type RawAccount,
  readSolanaChain,
  reserveOf,
  reviewSolanaOnChain,
  ruleOf,
  type SolanaSnapshot,
  settingsOf,
  tokenAccountOf,
  vaultAddress,
} from './solana-chain.ts'
import { run } from './tools.ts'

const K = live.keys as Record<string, string>
const G = golden.keys as Record<string, string>
const SNAP: SolanaSnapshot = {
  genesisHash: chain.genesisHash,
  slot: chain.slot,
  accounts: chain.accounts as Record<string, RawAccount | null>,
}
const bytes = (k: string) => {
  const a = SNAP.accounts[k]
  if (!a) throw new Error(`no ${k} in the snapshot`)
  return new Uint8Array(Buffer.from(a.data, 'base64'))
}
/** The snapshot with account `k` changed: its bytes edited, or replaced (null: gone). */
function edited(
  k: string,
  edit: ((b: Buffer) => void) | null | Partial<RawAccount>
): SolanaSnapshot {
  const accounts = { ...SNAP.accounts }
  const was = accounts[k] as RawAccount
  if (edit === null) accounts[k] = null
  else if (typeof edit === 'function') {
    const b = Buffer.from(was.data, 'base64')
    edit(b)
    accounts[k] = { ...was, data: b.toString('base64') }
  } else accounts[k] = { ...was, ...edit }
  return { ...SNAP, accounts }
}
const custody = (transaction: string, account = K.settlement as string) =>
  ({ transaction, role: 'custody', account }) as const
const onChain = (transaction: string, account?: string, snap = SNAP) =>
  reviewSolanaOnChain(custody(transaction, account), snap)
function caught(r: { signable: boolean; problems: string[] }, re: RegExp) {
  expect(r.problems.filter((p) => re.test(p))).not.toEqual([])
  expect(r.signable).toBe(false)
}

describe('readChain reads the accounts the way the programs lay them out', () => {
  it('derives program addresses as Squads does (PayFi web3.js golden keys and the live line)', () => {
    expect(policyAddress(G.settlement as string, 1)).toBe(G.r1Policy as string)
    expect(policyAddress(G.settlement as string, 2)).toBe(G.r2Policy as string)
    expect(vaultAddress(G.settlement as string, 0)).toBe(G.settlementVault as string)
    expect(vaultAddress(G.lp as string, 1)).toBe(G.lpGateVault as string)
    for (const [n, seed] of [
      ['r1', 1],
      ['r2', 2],
      ['r2b', 3],
      ['r3', 4],
      ['r4', 5],
      ['r5', 6],
    ] as const)
      expect(policyAddress(K.settlement as string, seed)).toBe(K[n] as string)
    expect(vaultAddress(K.settlement as string, 0)).toBe(K.settlementVault as string)
    // the associated token account of the vault, a PDA of the ATA program
    expect(
      programAddress(
        [
          fromBase58(K.settlementVault as string, 32),
          fromBase58(PROGRAM.token2022, 32),
          fromBase58(K.mintPot as string, 32),
        ],
        PROGRAM.ata
      )
    ).toBe(K.vaultPot as string)
  })

  it("decodes each live rule to the rule PayFi's encoder installs (account bytes against instruction bytes)", () => {
    for (const [n, tx] of [
      ['r1', live.createR1],
      ['r2', live.createR2],
      ['r2b', live.createR2b],
      ['r3', live.createR3],
      ['r4', live.createR4],
      ['r5', live.createR5],
    ] as const) {
      const a = reviewSolana(custody(tx)).actions?.[0]
      if (a?.action !== 'PolicyCreate' || a.policy.kind !== 'ProgramInteraction')
        throw new Error('shape')
      const r = ruleOf(K[n] as string, bytes(K[n] as string))
      expect(r.settings).toBe(K.settlement as string)
      // Squads stores a rule's signers sorted by key bytes (policy.rs:185); compared here as sets
      const byKey = (x: { key: string }[]) => [...x].sort((p, q) => p.key.localeCompare(q.key))
      expect(byKey(r.signers)).toEqual(byKey(a.signers))
      expect(r.threshold).toBe(a.threshold)
      expect(r.timeLock).toBe(0)
      expect(r.expiration).toBeNull()
      if (r.policy.kind !== 'ProgramInteraction') throw new Error(`${n} is a ${r.policy.kind}`)
      expect(r.policy.accountIndex).toBe(a.policy.accountIndex)
      expect(r.policy.constraints).toEqual(a.policy.constraints)
      expect(r.policy.preHook).toBeNull()
      expect(r.policy.postHook).toBeNull()
      const lim = (l: { mint: string; maxPerPeriod: string; period: unknown }[]) =>
        l.map((x) => [x.mint, x.maxPerPeriod, x.period]).sort()
      expect(lim(r.policy.limits)).toEqual(lim(a.policy.limits))
    }
  })

  it("reads the settings, reserves, market and POT mint as PayFi's verifier expects them", () => {
    const s = settingsOf(bytes(K.settlement as string))
    expect(s.signers.map((x) => x.key).sort()).toEqual([K.poOps, K.trustee].sort() as string[])
    expect(s.signers.every((x) => x.permissions === 7)).toBe(true)
    expect([s.threshold, s.timeLock, s.policySeed]).toEqual([2, 300, '6'])
    expect(s.settingsAuthority).toBe('11111111111111111111111111111111')
    const pot = reserveOf(bytes(K.reservePot as string))
    expect([
      pot.market,
      pot.liquidityMint,
      pot.ltvPct,
      pot.liquidationThresholdPct,
      pot.permissionedOps,
      pot.borrowLimit,
    ]).toEqual([K.market as string, K.mintPot as string, 78, 80, '1', '0'])
    const sol = reserveOf(bytes(K.reserveSol as string))
    expect([sol.ltvPct, sol.liquidationThresholdPct, sol.permissionedOps, sol.borrowLimit]).toEqual(
      [65, 75, '0', '0']
    )
    expect(reserveOf(bytes(K.reserveUsdc as string)).permissionedOps).toBe('2')
    const m = marketOf(bytes(K.market as string))
    expect([
      m.permissioningAuthority,
      m.permissionedOps,
      m.emergencyCouncil,
      m.owner === m.ownerCached,
    ]).toEqual([K.lpGateVault as string, '0', '11111111111111111111111111111111', true])
    const mint = mintOf(bytes(K.mintPot as string))
    expect(mint.extensions.map((e) => e.name).sort()).toEqual([
      'DefaultAccountState',
      'MetadataPointer',
      'MintCloseAuthority',
      'TokenMetadata',
    ])
    expect(mint.extensions.find((e) => e.type === 6)?.value[0]).toBe(2)
    const t = tokenAccountOf(bytes(K.vaultPot as string))
    expect([t.mint, t.owner, t.state]).toEqual([
      K.mintPot as string,
      K.settlementVault as string,
      1,
    ])
  })
})

describe('readChain passes a correct live state', () => {
  it('an execution through live R2b: the rule, the reserve, the thawed destination and both builds check out', () => {
    const r = onChain(live.potOut, K.r2b)
    expect(r.problems).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.signable).toBe(true)
    expect(r.chain).toMatchObject({ cluster: 'devnet', slot: chain.slot })
    const text = r.review.join('\n')
    expect(text).toContain('On chain')
    expect(text).toMatch(/Kamino klend build: {2}deployed at slot 491561420 \(pinned 491561420\)/)
    expect(text).toMatch(
      /token account A6bGvb…9CQsSR: {2}Token-2022, mint .*, owner .*\[vault 0\], thawed/
    )
    expect(text).toContain('frozen by default: a holder needs a thaw')
  })

  it('an edit of R4 that pins its payout, and removing R4: the account and the rules that stay check out', () => {
    for (const tx of [live.updateR4Pinned, live.removeR4]) {
      const r = onChain(tx)
      expect(r.problems).toEqual([])
      expect(r.signable).toBe(true)
      expect(r.review.join('\n')).toMatch(/Rules on the account now: 6 \(of 6 ever created\)/)
    }
  })

  it('without readChain the review is the bytes-only one, unchanged', () => {
    for (const [tx, account] of [
      [live.potOut, K.r2b],
      [live.addTightDeposit, K.settlement],
    ] as const) {
      const offline = reviewSolana(custody(tx, account))
      const read = onChain(tx, account)
      expect(read.problems.slice(0, offline.problems.length)).toEqual(offline.problems)
      expect('chain' in offline).toBe(false)
      expect(offline.review.join('\n')).not.toContain('On chain')
    }
  })
})

describe('readChain catches a live mismatch', () => {
  it('a pinned destination that is not thawed (not on the thaw list)', () => {
    const snap = edited(K.vaultPot as string, (b) => {
      b[108] = 2
    })
    caught(
      onChain(live.potOut, K.r2b, snap),
      /the destination token account A6bGvb.* is FROZEN, so nothing can be paid into it .* not on the thaw list/
    )
    caught(
      onChain(live.createR2b, K.settlement, snap),
      /constraint 0: the destination token account .* is FROZEN/
    )
  })

  it('a destination that is not on chain, or not a token account, or holds another mint', () => {
    caught(onChain(live.potOut, K.r2b, edited(K.vaultPot as string, null)), /is not on chain/)
    caught(
      onChain(live.potOut, K.r2b, edited(K.vaultPot as string, { owner: PROGRAM.system })),
      /is not a token account/
    )
    const usdc = fromBase58(K.mintUsdc as string, 32)
    caught(
      onChain(
        live.potOut,
        K.r2b,
        edited(K.vaultPot as string, (b) => b.set(usdc, 0))
      ),
      /holds mint 4F5oLm.*, which no pinned reserve lends/
    )
  })

  it('a deploy slot that changed since the build the review was checked against', () => {
    const pd = (DEPLOYED[PROGRAM.klend] as { programData: string }).programData
    const snap = edited(pd, (b) => b.writeBigUInt64LE(491_561_421n, 4))
    caught(
      onChain(live.potOut, K.r2b, snap),
      /Kamino klend was deployed at slot 491561421, not the build this review was checked against/
    )
    const smrt = (DEPLOYED[PROGRAM.smartAccount] as { programData: string }).programData
    caught(
      onChain(
        live.removeR4,
        K.settlement,
        edited(smrt, (b) => b.writeBigUInt64LE(1n, 4))
      ),
      /Squads Smart Account was deployed at slot 1,/
    )
    // a local validator's clone is told, not refused
    const local = onChain(live.potOut, K.r2b, { ...snap, local: true })
    expect(local.problems).toEqual([])
    expect(local.warnings.some((w) => /deployed at slot 491561421/.test(w))).toBe(true)
  })

  it('a live rule looser than the design that a new rule shares a signer with (R4 pays to an open destination): told', () => {
    // R4 is PayFi's earlier choice (a 2-of-2 payout with daily caps) and grants this change
    // nothing, so it is a warning; the bypass of the change's own pins is the next case
    const r = onChain(live.addDuplicateR3)
    expect(r.problems).toEqual([])
    expect(
      r.warnings.some((w) =>
        /GtwrJ1…PHZcXd .* also sign\(s\) 2gMqxr…tNxjaK \[live rule 5\] \(seed 5\), a live rule looser than the design: live rule 5, constraint 0: the destination \(account 2\) is not pinned/.test(
          w
        )
      )
    ).toBe(true)
    expect(
      r.warnings.some((w) => /duplicates 3rz7tt…B5AM7w \[live rule 4\] \(seed 4\)/.test(w))
    ).toBe(true)
  })

  it('a live rule that admits the same instruction to a shared signer with a higher ceiling', () => {
    caught(
      onChain(live.addTightDeposit),
      /constraint 0 \(Kamino klend deposit_reserve_liquidity_and_obligation_collateral_v2\): GtwrJ1…PHZcXd .* also sign\(s\) E8MgqN…CiUMcC \[live rule 1\] \(seed 1\), whose constraint 0 admits the same instruction with a higher ceiling \(U64Le @8 ≤ 15000000000 against U64Le @8 ≤ 1000000000\)/
    )
  })

  it('a new withdraw without its has_debt read while a live rule borrows (offline it is only a warning)', () => {
    const offline = reviewSolana(custody(live.addLooseWithdraw))
    expect(offline.problems.some((p) => /has_debt/.test(p))).toBe(false)
    caught(
      onChain(live.addLooseWithdraw),
      /the withdraw lacks the has_debt == 0 read, and E8MgqN…CiUMcC \[live rule 1\] on chain lets this account borrow/
    )
  })

  it('an execution under a live rule looser than the design', () => {
    // the same execution, pointed at R4 (an open payout) instead of R2b
    const tx = Buffer.from(live.potOut, 'base64')
    const at = tx.indexOf(Buffer.from(fromBase58(K.r2b as string, 32)))
    tx.set(fromBase58(K.r4 as string, 32), at)
    const r = onChain(tx.toString('base64'), K.r4)
    expect(
      r.warnings.some((w) =>
        /the execution runs under 2gMqxr.*, a live rule looser than the design: live rule 5, constraint 0: the destination \(account 2\) is not pinned/.test(
          w
        )
      )
    ).toBe(true)
    expect(r.warnings.some((w) => /does not match the constraint 0 it claims/.test(w))).toBe(true)
  })

  it("a repay that reads another owner's obligations (the bytes review and the live rule)", () => {
    // R2's repay reads the obligation's owner @64; point it at the LP gate vault instead of the
    // Settlement vault
    const tx = Buffer.from(live.createR2, 'base64')
    const vault = Buffer.from(fromBase58(K.settlementVault as string, 32))
    expect(tx.indexOf(vault)).toBeGreaterThan(0)
    tx.set(fromBase58(K.lpGateVault as string, 32), tx.indexOf(vault))
    const offline = reviewSolana(custody(tx.toString('base64')))
    caught(
      offline,
      /the repay's obligation-owner read names BJN8X3\w+, not vault 0 of this account \(DYGGFC\w+\)/
    )
    expect(reviewSolana(custody(live.createR2)).problems).toEqual([])
    // the live R2 holds the right owner; the same rule live with the wrong one is caught
    const r2 = Buffer.from(bytes(K.r2 as string))
    const live2 = edited(K.r2 as string, (b) =>
      b.set(fromBase58(K.lpGateVault as string, 32), r2.indexOf(vault))
    )
    // a live rule looser than the design is told (the owners' earlier choice), as for R4
    expect(
      onChain(live.addTightDeposit, K.settlement, live2).warnings.some((w) =>
        /live rule 2, constraint 0: the repay's obligation-owner read names BJN8X3/.test(w)
      )
    ).toBe(true)
  })

  it('a controlled account, and custody that no longer needs every owner', () => {
    const key = fromBase58(K.poOps as string, 32)
    caught(
      onChain(
        live.removeR4,
        K.settlement,
        edited(K.settlement as string, (b) => b.set(key, 24))
      ),
      /the account is controlled: its settings authority GtwrJ1/
    )
    caught(
      onChain(
        live.removeR4,
        K.settlement,
        edited(K.settlement as string, (b) => b.writeUInt16LE(1, 56))
      ),
      /custody on chain needs 1 of its 2 voting owners: one party can be left out/
    )
  })

  it('an edit of a rule the account does not hold', () => {
    caught(
      onChain(live.updateR4Pinned, K.settlement, edited(K.r4 as string, null)),
      /it edits or removes 2gMqxr.*, which is not a live rule of this account/
    )
  })

  it('a reserve that is not klend, a market other than the one under review, and a mint that opens accounts thawed', () => {
    caught(
      onChain(live.potOut, K.r2b, edited(K.reservePot as string, { owner: PROGRAM.system })),
      /the reserve 8TFnjA.* is not a klend reserve/
    )
    caught(
      reviewSolanaOnChain({ ...custody(live.potOut, K.r2b), market: K.r2 as string }, SNAP),
      /belongs to market BcPH6P.*, not the market under review/
    )
    // DefaultAccountState Initialized: the TLV value byte of extension 6
    const mint = Buffer.from(bytes(K.mintPot as string))
    let at = 166
    while (mint.readUInt16LE(at) !== 6) at += 4 + mint.readUInt16LE(at + 2)
    const r = onChain(
      live.potOut,
      K.r2b,
      edited(K.mintPot as string, (b) => b.writeUInt8(1, at + 4))
    )
    expect(
      r.warnings.some((w) =>
        /does not open accounts frozen .* so its thaw list is no whitelist/.test(w)
      )
    ).toBe(true)
  })

  it("a Prime band: the custody rule it calls is read, and a looser one is caught (PayFi's LP band G1 into R1)", () => {
    const prime = (transaction: string) =>
      reviewSolanaOnChain({ transaction, role: 'prime', account: K.lp as string }, SNAP)
    const r = prime(live.createG1)
    // PayFi's LP account is 1 of 1, which a Prime account must not be; G1 is already installed
    expect(r.problems).toEqual([
      'the Prime account on chain lets one owner act alone (threshold 1)',
    ])
    expect(
      r.warnings.some((w) => /duplicates R82XzD…Ktfkfe \[live rule 1\] \(seed 1\)/.test(w))
    ).toBe(true)
    expect(
      r.warnings.some((w) =>
        /the custody rule E8MgqN…CiUMcC \[custody rule\] does not list this account's vault 1/.test(
          w
        )
      )
    ).toBe(true)
    expect(r.review.join('\n')).toMatch(
      /custody rule E8MgqN…CiUMcC \[custody rule\]: {2}of 8t63gb…bSC2VW, 1 of GtwrJ1…PHZcXd/
    )
    // the same band pointed at R4, which pays to an open destination
    const tx = Buffer.from(live.createG1, 'base64')
    tx.set(fromBase58(K.r4 as string, 32), tx.indexOf(Buffer.from(fromBase58(K.r1 as string, 32))))
    caught(
      prime(tx.toString('base64')),
      /the band calls 2gMqxr…tNxjaK \[custody rule\], a live custody rule looser than the design: live rule 5, constraint 0: the destination \(account 2\) is not pinned/
    )
  })

  it('an account the checks need that the read did not return', () => {
    const accounts = { ...SNAP.accounts }
    delete accounts[K.vaultPot as string]
    caught(
      onChain(live.potOut, K.r2b, { ...SNAP, accounts }),
      /the chain read did not return A6bGvbdPsF8emTLq4aeKVjnt269oBGVzH7sJXz9CQsSR/
    )
  })

  it('compares constraints for the same instruction, and tells calls with nothing in common apart', () => {
    const c = (keys: string[], data: { offset: string; v: string }[] = []) => ({
      programId: PROGRAM.klend,
      accounts: [{ index: 4, keys, owner: null }],
      data: data.map((d) => ({
        offset: d.offset,
        value: { type: 'U64Le' as const, value: d.v },
        operator: 'LessThanOrEqualTo' as const,
      })),
    })
    expect(looser(c(['A']), c(['A'], [{ offset: '8', v: '5' }]))).toEqual([
      'no ceiling on the amount',
    ])
    expect(looser(c(['A', 'B']), c(['A']))).toEqual([])
    expect(looser(c(['B']), c(['A']))).toBeNull()
    expect(looser({ ...c([]), accounts: [] }, c(['A']))).toEqual(['account 4 open'])
  })
})

describe('readSolanaChain reads what the checks need, devnet only', () => {
  /** An endpoint that answers from the recorded snapshot. */
  function replay(snap = SNAP, genesis: string = GENESIS.devnet) {
    const calls: { method: string; params: unknown[] }[] = []
    const rpc: Rpc = async (method, params) => {
      calls.push({ method, params })
      if (method === 'getGenesisHash') return genesis
      if (method === 'getMultipleAccounts') {
        const [keys, opts] = params as [string[], { dataSlice?: { length: number } }]
        return {
          context: { slot: snap.slot },
          value: keys.map((k) => {
            const a = snap.accounts[k]
            if (!a) return null
            const data = opts.dataSlice
              ? Buffer.from(a.data, 'base64').subarray(0, opts.dataSlice.length).toString('base64')
              : a.data
            return { ...a, data: [data, 'base64'] }
          }),
        }
      }
      throw new Error(`unexpected ${method}`)
    }
    return { rpc, calls }
  }

  it('reads in rounds to the same snapshot, the ProgramData head only, and reviews the same', async () => {
    const { rpc, calls } = replay()
    const i = custody(live.addTightDeposit)
    const snap = await readSolanaChain(i, rpc)
    const { chain: got, ...read } = reviewSolanaOnChain(i, snap)
    const { chain: want, ...recorded } = reviewSolanaOnChain(i, SNAP)
    expect(read).toEqual(recorded)
    expect(got.slot).toBe(want.slot)
    const pds = Object.values(DEPLOYED).map((d) => d.programData)
    for (const c of calls.filter((x) => x.method === 'getMultipleAccounts')) {
      const [keys, opts] = c.params as [string[], { dataSlice?: unknown }]
      expect(keys.some((k) => pds.includes(k))).toBe(opts.dataSlice !== undefined)
    }
    expect(calls.length).toBeLessThanOrEqual(8)
  })

  it('refuses mainnet and any other cluster, and a failed read refuses the review (retryable)', async () => {
    const i = custody(live.removeR4)
    await expect(readSolanaChain(i, replay(SNAP, GENESIS.mainnet).rpc)).rejects.toThrow(
      /serves mainnet; readChain reads devnet only/
    )
    await expect(readSolanaChain(i, replay(SNAP, GENESIS.testnet).rpc)).rejects.toThrow(
      /not devnet/
    )
    const down: Rpc = async () => {
      throw new Error('connection refused')
    }
    const e = await readSolanaChain(i, down).catch((x) => x)
    expect(e).toBeInstanceOf(Refusal)
    expect(e.extra.retryable).toBe(true)
    // bytes the decoder refuses are refused before any read
    const { rpc, calls } = replay()
    await expect(readSolanaChain({ transaction: 'AAEC', role: 'custody' }, rpc)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('the solana_review tool', () => {
  const before = process.env.POLICY_BUILDER_SOLANA_RPC_URL
  afterEach(() => {
    if (before === undefined) delete process.env.POLICY_BUILDER_SOLANA_RPC_URL
    else process.env.POLICY_BUILDER_SOLANA_RPC_URL = before
  })
  function serve() {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        hits++
        const body = (await req.json()) as { id: number; method: string; params: unknown[] }
        let result: unknown
        if (body.method === 'getGenesisHash') result = GENESIS.devnet
        else {
          const [keys, opts] = body.params as [string[], { dataSlice?: { length: number } }]
          result = {
            context: { slot: SNAP.slot },
            value: keys.map((k) => {
              const a = SNAP.accounts[k]
              if (!a) return null
              const data = opts.dataSlice
                ? Buffer.from(a.data, 'base64')
                    .subarray(0, opts.dataSlice.length)
                    .toString('base64')
                : a.data
              return { ...a, data: [data, 'base64'] }
            }),
          }
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      },
    })
    process.env.POLICY_BUILDER_SOLANA_RPC_URL = `http://127.0.0.1:${server.port}`
    return { server, hits: () => hits }
  }

  it('reads nothing without readChain, and reads the operator endpoint with it', async () => {
    const s = serve()
    try {
      const input = { transaction: live.potOut, role: 'custody', account: K.r2b }
      const off = (await run('solana_review', input)) as {
        ok: true
        data: { chain?: unknown; signable: boolean }
      }
      expect(off.ok).toBe(true)
      expect(off.data.chain).toBeUndefined()
      expect(s.hits()).toBe(0)
      const on = (await run('solana_review', { ...input, readChain: true })) as {
        ok: true
        data: { chain: { cluster: string }; signable: boolean; review: string[] }
      }
      expect(on.ok).toBe(true)
      expect(on.data.signable).toBe(true)
      expect(on.data.chain.cluster).toBe('devnet')
      expect(s.hits()).toBeGreaterThan(0)
      const frozen = (await run('solana_review', {
        transaction: live.addTightDeposit,
        role: 'custody',
        account: K.settlement,
        readChain: true,
      })) as {
        ok: true
        data: { signable: boolean; problems: string[] }
      }
      expect(frozen.data.signable).toBe(false)
    } finally {
      s.server.stop(true)
    }
  })

  it('refuses a plain-http endpoint that is not loopback, and an unreachable one as retryable', async () => {
    process.env.POLICY_BUILDER_SOLANA_RPC_URL = 'http://example.com'
    const input = { transaction: live.potOut, role: 'custody', account: K.r2b, readChain: true }
    const r = (await run('solana_review', input)) as { ok: false; error: { message: string } }
    expect(r.ok).toBe(false)
    expect(r.error.message).toMatch(/must be https/)
    process.env.POLICY_BUILDER_SOLANA_RPC_URL = 'http://127.0.0.1:9'
    const down = (await run('solana_review', input)) as {
      ok: false
      error: { code: string; retryable: boolean }
    }
    expect(down.ok).toBe(false)
    expect(down.error.code).toBe('SIMULATION_ERROR')
    expect(down.error.retryable).toBe(true)
  })
})
