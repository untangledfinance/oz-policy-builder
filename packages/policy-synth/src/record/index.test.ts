import { describe, expect, it } from 'bun:test'
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import type { ToolError } from '../errors.ts'
import type { OnChainEvent, RecordedTransaction } from '../types.ts'
import { type RpcFetcher, recordTransaction } from './index.ts'
import type { SorobanTxResponse } from './rpc.ts'

interface TransferFixture {
  envXdr: string
  from: string
  to: string
  token: string
}

function buildTransferFixture(opts: { token?: string } = {}): TransferFixture {
  const sourceKp = Keypair.random()
  const acc = new Account(sourceKp.publicKey(), '0')
  const fromKp = Keypair.random()
  const toKp = Keypair.random()
  const from = Address.fromString(fromKp.publicKey())
  const to = Address.fromString(toKp.publicKey())
  const token = opts.token ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
  const op = Operation.invokeContractFunction({
    contract: token,
    function: 'transfer',
    args: [
      xdr.ScVal.scvAddress(from.toScAddress()),
      xdr.ScVal.scvAddress(to.toScAddress()),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString('0'),
          lo: xdr.Uint64.fromString('100'),
        })
      ),
    ],
    auth: [],
  })
  const tx = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  return {
    envXdr: tx.toEnvelope().toXDR().toString('base64'),
    from: fromKp.publicKey(),
    to: toKp.publicKey(),
    token,
  }
}

function buildFetcher(opts: { envelopeXdr: string; events?: OnChainEvent[] }): RpcFetcher {
  const env = xdr.TransactionEnvelope.fromXDR(opts.envelopeXdr, 'base64')
  // Build proper SDK TransactionEvent[] from OnChainEvent[] so the events
  // actually reach the events-based validator (the previous buildFetcher
  // ignored opts.events, which made the SEP-41-on-chain success test
  // incoherent). The contractId is the on-ledger 32-byte contract hash;
  // events.topics / events.data are encoded into ContractEventV0.
  const transactionEventsXdr: xdr.TransactionEvent[] = (opts.events ?? []).map((e) => {
    const topicsScval: xdr.ScVal[] = e.topics.map((t) => {
      if (t === 'transfer' || t === 'mint' || t === 'burn') return xdr.ScVal.scvSymbol(t)
      if (t.startsWith('G') || t.startsWith('C')) {
        return xdr.ScVal.scvAddress(Address.fromString(t).toScAddress())
      }
      return xdr.ScVal.scvSymbol(t)
    })
    const dataScval =
      e.data.type === 'i128'
        ? xdr.ScVal.scvI128(
            new xdr.Int128Parts({
              hi: xdr.Int64.fromString('0'),
              lo: xdr.Uint64.fromString(e.data.value),
            })
          )
        : xdr.ScVal.scvVoid()
    const v0 = new xdr.ContractEventV0({ topics: topicsScval, data: dataScval })
    const body = new xdr.ContractEventBody(0, v0)
    const contractEvent = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: Buffer.from(
        Address.fromString(e.contract).toScAddress().contractId() as Uint8Array
      ),
      type: new xdr.ContractEventType('contract'),
      body,
    })
    return new xdr.TransactionEvent({
      stage: new xdr.TransactionEventStage('soroban'),
      event: contractEvent,
    })
  })
  const fetcher: RpcFetcher = async (hash: string): Promise<SorobanTxResponse | null> => {
    void hash
    return {
      status: 'SUCCESS',
      ledger: 12345,
      createdAt: Math.floor(Date.now() / 1000),
      txHash: 'a'.repeat(64),
      envelopeXdr: env,
      events: {
        transactionEventsXdr,
        contractEventsXdr: [],
      },
    }
  }
  return fetcher
}

describe('recordTransaction input validation', () => {
  it('rejects when neither hash nor xdr is provided', async () => {
    const r = await recordTransaction({ network: 'testnet' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('RECORDING_FAILED')
  })

  it('rejects when both hash and xdr are provided', async () => {
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'abc',
      xdr: 'AAAA',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('RECORDING_FAILED')
  })

  it('rejects when network is missing', async () => {
    const r = await recordTransaction({
      network: '' as never,
      xdr: 'AAAA',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('RECORDING_FAILED')
  })

  it('rejects a confidenceOverride outside [0, 1] (would disable the gate)', async () => {
    const r = await recordTransaction({ network: 'testnet', xdr: 'AAAA', confidenceOverride: -0.5 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_FAILED')
      expect(r.error.message).toContain('confidenceOverride')
    }
  })

  it('rejects a NaN confidenceOverride (a plain typeof/comparison check would miss it)', async () => {
    const r = await recordTransaction({
      network: 'testnet',
      xdr: 'AAAA',
      confidenceOverride: Number.NaN,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_FAILED')
      expect(r.error.message).toContain('finite')
    }
  })
})

describe('recordTransaction on-chain mode (injected fetcher)', () => {
  it('returns a RecordedTransaction when the fetcher yields a recognised SEP-41 transfer envelope', async () => {
    const fx = buildTransferFixture()
    // Inject an event that ACTUALLY matches the parsed transfer (the fixture
    // builds the envelope with its own from/to; the event reuses them). The
    // events-based validator cross-checks parsed movements against the raw
    // event-derived movements, so the topics + data here MUST match the
    // envelope's from/to/amount.
    const event: OnChainEvent = {
      contract: fx.token,
      topics: ['transfer', fx.from, fx.to],
      data: { type: 'i128', value: '100' },
    }
    const fetcher = buildFetcher({ envelopeXdr: fx.envXdr, events: [event] })
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'a'.repeat(64),
      fetcher,
    })
    // SEP-41 transfer is recognised by interface (any token address), so
    // parseConfidence reaches 1.0 and the recording clears the gate.
    expect(r.ok).toBe(true)
    if (r.ok) {
      const data: RecordedTransaction = r.data
      expect(data.network).toBe('testnet')
      expect(data.invocations.length).toBe(1)
      expect(data.invocations[0]?.fn).toBe('transfer')
      expect(data.parseConfidence.overall).toBe(1.0)
      expect(data.parseConfidence.knownContracts).toContain(fx.token)
      // Coherence check: the parsed TokenMovement derived from the event
      // matches the fixture's (token, from, to, amount).
      expect(data.tokenMovements).toEqual([
        { token: fx.token, from: fx.from, to: fx.to, amount: '100' },
      ])
    }
  })

  it('refuses an UNRECOGNISED contract (fail-closed preserved)', async () => {
    // Build an envelope that calls an unknown fn on a contract that is not
    // pinned, so the registry returns null and the recorder still marks it
    // unknown. The gate must refuse.
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    // Synthesise a valid, unpinned contract strkey from a fixed 32-byte hash
    // so the SDK accepts it. Using a real strkey shape (C...) that is not in
    // the registry's pinned mainnet/testnet sets keeps this fixture out of
    // the recognised set.
    const unknownContract = Address.contract(Buffer.alloc(32, 0x99)).toString()
    const op = Operation.invokeContractFunction({
      contract: unknownContract,
      function: 'completely_unknown_fn',
      args: [],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const envXdr = tx.toEnvelope().toXDR().toString('base64')
    const fetcher = buildFetcher({ envelopeXdr: envXdr })
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'a'.repeat(64),
      fetcher,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_VALIDATION_FAILED')
      expect((r.error.details as { overall?: number })?.overall).toBeLessThan(1.0)
    }
  })

  it('accepts the recording when no events are present and confidenceOverride = 0', async () => {
    const fx = buildTransferFixture()
    const fetcher = buildFetcher({ envelopeXdr: fx.envXdr })
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'a'.repeat(64),
      fetcher,
      confidenceOverride: 0,
    })
    // No events -> events validation skipped; freshness gate threshold lowered.
    expect(r.ok).toBe(true)
    if (r.ok) {
      const data: RecordedTransaction = r.data
      expect(data.network).toBe('testnet')
      expect(data.invocations.length).toBe(1)
      expect(data.invocations[0]?.fn).toBe('transfer')
      expect(data.ledgerSequence).toBe(12345)
      expect(typeof data.fetchedAt).toBe('number')
    }
  })

  it('returns RECORDING_FAILED when the fetcher reports NOT_FOUND', async () => {
    const fetcher: RpcFetcher = async () => null
    // Item 2: explicit null cross-network fetcher keeps this offline
    // (the production default would auto-build createRpcServer(otherNetwork)
    // and trigger a real RPC round-trip; tests opt in to opt-out).
    const crossNetworkFetcher: RpcFetcher = async () => null
    const r = await recordTransaction({
      network: 'testnet',
      hash: 'abc',
      fetcher,
      crossNetworkFetcher,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_FAILED')
      expect(r.error.retryable).toBe(true)
    }
  })

  // ===== FIX 2: per-invocation, order-independent recognition =====
  // Any unrecognised (contract, fn, args) call MUST lower confidence
  // regardless of whether another invocation to the same contract was
  // recognised. The test asserts the recording refuses in BOTH operation
  // orders.

  function buildMultiOpEnvelope(opts: {
    contract: string
    operations: Array<{ fn: string; args: xdr.ScVal[] }>
  }): string {
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const builder = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
    for (const op of opts.operations) {
      builder.addOperation(
        Operation.invokeContractFunction({
          contract: opts.contract,
          function: op.fn,
          args: op.args,
          auth: [],
        })
      )
    }
    return builder.setTimeout(30).build().toEnvelope().toXDR().toString('base64')
  }

  function transferArgs(): xdr.ScVal[] {
    const from = Address.fromString(Keypair.random().publicKey())
    const to = Address.fromString(Keypair.random().publicKey())
    return [
      xdr.ScVal.scvAddress(from.toScAddress()),
      xdr.ScVal.scvAddress(to.toScAddress()),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('100') })
      ),
    ]
  }

  it('refuses a tx with recognised SEP-41 THEN unknown call to the same contract', async () => {
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const envXdr = buildMultiOpEnvelope({
      contract: token,
      operations: [
        { fn: 'transfer', args: transferArgs() }, // recognised
        { fn: 'completely_unknown_fn', args: [] }, // NOT recognised
      ],
    })
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_VALIDATION_FAILED')
      expect((r.error.details as { overall?: number })?.overall).toBeLessThan(1.0)
    }
  })

  it('refuses a tx with unknown THEN recognised SEP-41 call to the same contract (reverse order)', async () => {
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const envXdr = buildMultiOpEnvelope({
      contract: token,
      operations: [
        { fn: 'completely_unknown_fn', args: [] }, // NOT recognised
        { fn: 'transfer', args: transferArgs() }, // recognised
      ],
    })
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_VALIDATION_FAILED')
      expect((r.error.details as { overall?: number })?.overall).toBeLessThan(1.0)
    }
  })
})

describe('recordTransaction XDR/simulation mode', () => {
  it('decodes a Soroban envelope XDR for a recognised SEP-41 transfer with no events', async () => {
    const fx = buildTransferFixture()
    const r = await recordTransaction({ network: 'testnet', xdr: fx.envXdr })
    // SEP-41 transfer is recognised by interface -> parseConfidence.overall = 1.0
    // even with no events (the events-based validation is skipped, but the
    // confidence gate passes because there are no unknown contracts).
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.parseConfidence.overall).toBe(1.0)
    }
  })

  it('refuses an UNRECOGNISED XDR-mode contract (fail-closed preserved)', async () => {
    // Unknown contract + unknown fn -> registry returns null -> unknown
    // contract -> parseConfidence < 1 -> refuse.
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const unknownContract = Address.contract(Buffer.alloc(32, 0x99)).toString()
    const op = Operation.invokeContractFunction({
      contract: unknownContract,
      function: 'completely_unknown_fn',
      args: [],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const envXdr = tx.toEnvelope().toXDR().toString('base64')
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_VALIDATION_FAILED')
      expect(r.error.severity).toBe('error')
      expect(r.error.retryable).toBe(false)
      expect(r.error.remediation?.userQuestion?.code).toBe('PARSE_CONFIDENCE_BELOW_THRESHOLD')
    }
  })

  it('accepts XDR mode when a confidenceOverride is supplied that meets the gate', async () => {
    const fx = buildTransferFixture()
    // SEP-41 transfer already passes the default 1.0 gate in XDR mode; this
    // test confirms the override path is still wired (no crash, no rejection
    // when threshold is 0).
    const r = await recordTransaction({
      network: 'testnet',
      xdr: fx.envXdr,
      confidenceOverride: 0.0,
    })
    expect(r.ok).toBe(true)
  })

  it('rejects malformed base64 XDR with RECORDING_FAILED', async () => {
    const r = await recordTransaction({ network: 'testnet', xdr: 'not-base64!@#' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('RECORDING_FAILED')
  })
})

describe('recordTransaction refuse gate', () => {
  it('returns RECORDING_VALIDATION_FAILED with severity=error and details=ParseConfidence when below threshold', async () => {
    // Use an UNRECOGNISED contract to exercise the refuse gate.
    const sourceKp = Keypair.random()
    const acc = new Account(sourceKp.publicKey(), '0')
    const unknownContract = Address.contract(Buffer.alloc(32, 0x99)).toString()
    const op = Operation.invokeContractFunction({
      contract: unknownContract,
      function: 'completely_unknown_fn',
      args: [],
      auth: [],
    })
    const tx = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
    const envXdr = tx.toEnvelope().toXDR().toString('base64')
    const r = await recordTransaction({ network: 'testnet', xdr: envXdr })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const e: ToolError = r.error
      expect(e.code).toBe('RECORDING_VALIDATION_FAILED')
      expect(e.severity).toBe('error')
      expect(e.retryable).toBe(false)
      expect(e.details).toBeDefined()
      expect((e.details as { overall?: number })?.overall).toBeLessThan(1.0)
      expect(e.remediation?.userQuestion).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Item 2: cross-network hash sanity check. When the requested network's
// fetcher reports NOT_FOUND, the recorder probes the OTHER network's fetcher
// (auto-built from createRpcServer in production, injectable for offline
// tests). If the hash exists on the other network, the error message tells
// the user which network to use. The trade-off is one extra RPC round-trip
// only on the NOT_FOUND path; the happy path is unchanged.
// ---------------------------------------------------------------------------

function buildNullFetcher(): RpcFetcher {
  return async () => null
}

function buildFoundFetcher(envXdr: string): RpcFetcher {
  const env = xdr.TransactionEnvelope.fromXDR(envXdr, 'base64')
  return async () => ({
    status: 'SUCCESS' as const,
    ledger: 12345,
    createdAt: Math.floor(Date.now() / 1000),
    txHash: 'a'.repeat(64),
    envelopeXdr: env,
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
  })
}

describe('recordTransaction cross-network sanity check (item 2)', () => {
  it('reports a wrong-network match when the hash exists on the OTHER network', async () => {
    const fx = buildTransferFixture()
    const primary = buildNullFetcher() // mainnet says NOT_FOUND
    const cross = buildFoundFetcher(fx.envXdr) // testnet has it
    const r = await recordTransaction({
      network: 'mainnet',
      hash: 'a'.repeat(64),
      fetcher: primary,
      crossNetworkFetcher: cross,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('RECORDING_FAILED')
    // Actionable message: points at the actual network so the user knows
    // to re-run with --network testnet.
    expect(r.error.message.toLowerCase()).toContain('testnet')
    expect(r.error.message.toLowerCase()).toContain('mainnet')
  })

  it('falls back to the generic NOT_FOUND message when neither network has the hash', async () => {
    const primary = buildNullFetcher()
    const cross = buildNullFetcher()
    const r = await recordTransaction({
      network: 'mainnet',
      hash: 'a'.repeat(64),
      fetcher: primary,
      crossNetworkFetcher: cross,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('RECORDING_FAILED')
    // The pre-fix message stays when there is no cross-network hit.
    expect(r.error.message).toContain('not found')
    expect(r.error.message).toContain('mainnet')
    // The actionable "use --network <X>" guidance must NOT appear when no
    // cross-network hit was detected (we have no evidence the user is on
    // the wrong network).
    expect(r.error.message.toLowerCase()).not.toContain('use --network')
  })

  it('does NOT probe the cross-network fetcher when the primary fetcher finds the hash (happy path is offline-cheap)', async () => {
    // Sanity: the cross-network fetcher is only called on NOT_FOUND. If the
    // primary returns a real envelope, we never touch the cross-network one.
    const fx = buildTransferFixture()
    const event: OnChainEvent = {
      contract: fx.token,
      topics: ['transfer', fx.from, fx.to],
      data: { type: 'i128', value: '100' },
    }
    const primary = buildFetcher({ envelopeXdr: fx.envXdr, events: [event] })
    let crossCalled = false
    const cross: RpcFetcher = async () => {
      crossCalled = true
      return null
    }
    const r = await recordTransaction({
      network: 'mainnet',
      hash: 'a'.repeat(64),
      fetcher: primary,
      crossNetworkFetcher: cross,
    })
    expect(r.ok).toBe(true)
    expect(crossCalled).toBe(false)
  })
})
