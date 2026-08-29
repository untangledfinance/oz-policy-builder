// src/synth/spend-attribution.test.ts - spend is what leaves the account the
// policy governs, not only what leaves the wallet that submitted the call.
//
// This is a regression test for a silent failure that reached the chain. A
// smart account spends from ITSELF while a wallet submits the transaction, so
// matching the source account alone found no spend, the flow was classified
// incoming-only, no amount bound was required, and a rule that capped nothing
// installed with every check green. The agent key then moved one stroop over
// the cap it was supposedly under, and the transfer succeeded.
//
// The asymmetry is what makes it dangerous: the failure is silent and always in
// the permissive direction.

import { describe, expect, it } from 'bun:test'
import type { RecordedTransaction } from '../types.ts'
import { lower } from './lower.ts'

const WALLET = 'GDI64EFSV4IVJ53EWNXAPTZG3XR6O5YM4AYR7DI67Z6DRFDU3DHR6TH2'
const TREASURY = 'CAEI3JCERLHEWVARAUSLJOBSF4555B5O4KGIGSC3TBHHCWABO6M7GULQ'
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

/** A treasury transfer: funds leave the CONTRACT, the WALLET submits. */
function treasuryTransfer(): RecordedTransaction {
  return {
    network: 'testnet',
    signers: [WALLET],
    invocations: [
      {
        contract: TOKEN,
        fn: 'transfer',
        args: [
          { type: 'address', value: TREASURY },
          { type: 'address', value: WALLET },
          { type: 'i128', value: '153000000' },
        ],
        subInvocations: [],
      },
    ],
    tokenMovements: [{ token: TOKEN, from: TREASURY, to: WALLET, amount: '153000000' }],
    events: [],
    authEntries: [],
    ledgerSequence: 1,
    fetchedAt: 1,
    parseConfidence: {
      overall: 1,
      knownContracts: [TOKEN],
      unknownContracts: [],
      opaqueScVals: [],
      thresholdUsed: 1,
    },
    sourceAccount: WALLET,
  } as RecordedTransaction
}

describe('outgoing spend attribution', () => {
  it('counts what leaves the governed smart account', () => {
    const facts = lower(treasuryTransfer(), TREASURY)
    expect(facts.spendByToken[TOKEN]).toBe('153000000')
  })

  it('finds no spend when the governed account is not named, which is how the cap went missing', () => {
    const facts = lower(treasuryTransfer())
    expect(facts.spendByToken[TOKEN]).toBeUndefined()
  })

  it('still counts what leaves the submitting wallet', () => {
    const tx = treasuryTransfer()
    tx.tokenMovements = [{ token: TOKEN, from: WALLET, to: TREASURY, amount: '5000000' }]
    expect(lower(tx, TREASURY).spendByToken[TOKEN]).toBe('5000000')
  })

  it('does not double count when the governed account IS the source', () => {
    const tx = treasuryTransfer()
    tx.tokenMovements = [{ token: TOKEN, from: WALLET, to: TREASURY, amount: '5000000' }]
    expect(lower(tx, WALLET).spendByToken[TOKEN]).toBe('5000000')
  })

  it('ignores incoming movements, which are not spend', () => {
    const tx = treasuryTransfer()
    tx.tokenMovements = [{ token: TOKEN, from: WALLET, to: TREASURY, amount: '5000000' }]
    expect(lower(tx, TREASURY).spendByToken[TOKEN]).not.toBe('153000000')
  })
})
