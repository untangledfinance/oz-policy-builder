// packages/policy-builder-mcp/test/run-tools.test.ts
//
// Tests for the tool-body adapters. Verifies:
//   - happy path -> core ToolResponse<T> { ok: true } surfaces unchanged
//   - core ToolError surfaces unchanged (severity, code, remediation)
//   - input validation failure returns a machine-readable ToolError (never throws)
//   - synthesize_policy dispatches BOTH front-ends correctly via the discriminated union
//   - the tool's try/catch envelope (item 6) converts a non-Error throw into a
//     structured ToolError (no "[object Object]" leak through the MCP transport)
//   - the interpreter opt-in threads end-to-end (item 7): a Blend-claim
//     recording with `interpreter: { smartAccountAddress }` synthesises to
//     `policyDocuments.length === 1` and a `policyRef` of kind `interpreter`

import { describe, expect, it } from 'bun:test'
import { runRecordTransaction, runSynthesizePolicy } from '@crediolabs/policy-synth/run'
import { Address } from '@stellar/stellar-sdk'
import { mcpResultFromCore } from '../src/tools/result.ts'

describe('runRecordTransaction', () => {
  it('returns a machine-readable ToolError when both hash and xdr are provided', async () => {
    const r = await runRecordTransaction({
      hash: 'a'.repeat(64),
      xdr: 'AAAA',
      network: 'testnet',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_FAILED')
      expect(r.error.severity).toBe('error')
      expect(r.error.remediation?.toolCall?.name).toBe('record_transaction')
    }
  })

  it('returns a machine-readable ToolError when neither hash nor xdr is provided', async () => {
    const r = await runRecordTransaction({ network: 'testnet' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_FAILED')
      expect(r.error.retryable).toBe(false)
    }
  })

  it('returns a machine-readable ToolError when network is missing', async () => {
    const r = await runRecordTransaction({ hash: 'a'.repeat(64) })
    expect(r.ok).toBe(false)
  })

  it('decodes a valid SEP-41 transfer XDR end-to-end through the adapter', async () => {
    // Build a valid SEP-41 transfer envelope via the public SDK (the core's
    // own fixtures do this; we mirror the shape so the adapter + core
    // pipeline is exercised).
    const { Account, Address, Keypair, Networks, Operation, TransactionBuilder, xdr } =
      await import('@stellar/stellar-sdk')
    const sourceKp = Keypair.random()
    const fromKp = Keypair.random()
    const toKp = Keypair.random()
    const token = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const op = Operation.invokeContractFunction({
      contract: token,
      function: 'transfer',
      args: [
        xdr.ScVal.scvAddress(Address.fromString(fromKp.publicKey()).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(toKp.publicKey()).toScAddress()),
        xdr.ScVal.scvI128(
          new xdr.Int128Parts({
            hi: xdr.Int64.fromString('0'),
            lo: xdr.Uint64.fromString('100'),
          })
        ),
      ],
      auth: [],
    })
    const envXdr = new TransactionBuilder(new Account(sourceKp.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
      .toEnvelope()
      .toXDR()
      .toString('base64')

    const r = await runRecordTransaction({ xdr: envXdr, network: 'testnet' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.network).toBe('testnet')
      expect(r.data.parseConfidence.overall).toBe(1.0)
    }
  })

  it('returns a structured ToolError (NOT "[object Object]") when a malformed hash is thrown past the core envelope (item 6)', async () => {
    // A malformed XDR (base64 that is not a valid TransactionEnvelope)
    // causes `@stellar/stellar-sdk`'s `xdr.TransactionEnvelope.fromXDR` to
    // throw past the core envelope. The tool's try/catch (item 6) must
    // convert that throw into a structured ToolError with code
    // `RECORDING_FAILED` - the SDK/MCP transport would otherwise
    // stringify the throw as "[object Object]".
    const malformedXdr = Buffer.from('not-a-real-xdr-blob').toString('base64')
    const r = await runRecordTransaction({ xdr: malformedXdr, network: 'testnet' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('RECORDING_FAILED')
    expect(r.error.severity).toBe('error')
    expect(r.error.retryable).toBe(false)
    expect(typeof r.error.message).toBe('string')
    expect(r.error.message).not.toContain('[object Object]')
  })
})

describe('runSynthesizePolicy (discriminated union)', () => {
  it('dispatches source=recording to synthesizeFromRecording', async () => {
    const G_OWNER = Address.account(Buffer.alloc(32, 0xa0)).toString()
    const G_BILLER = Address.account(Buffer.alloc(32, 0xa1)).toString()
    const SEP41_TOKEN = Address.contract(Buffer.alloc(32, 0x0b)).toString()
    const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0x0c)).toString()
    const recordedTx = {
      network: 'mainnet' as const,
      signers: [G_OWNER],
      invocations: [
        {
          contract: SEP41_TOKEN,
          fn: 'transfer',
          args: [
            { type: 'address', value: G_OWNER },
            { type: 'address', value: G_BILLER },
            { type: 'i128', value: '1000000000' },
          ],
          subInvocations: [],
        },
      ],
      tokenMovements: [{ token: SEP41_TOKEN, from: G_OWNER, to: G_BILLER, amount: '1000000000' }],
      events: [],
      authEntries: [],
      ledgerSequence: 1,
      fetchedAt: 0,
      parseConfidence: {
        overall: 1,
        knownContracts: [],
        unknownContracts: [],
        opaqueScVals: [],
        thresholdUsed: 1,
      },
      sourceAccount: G_OWNER,
    }
    const r = await runSynthesizePolicy({
      source: 'recording',
      recordedTx,
      network: 'mainnet',
      userResponses: {
        windowSeconds: 2592000,
        limitAmount: '1000000000',
        validUntilLedger: 1000000,
      },
      interpreter: { smartAccountAddress: SMART_ACCOUNT },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.contextRule.contextRuleType).toEqual({
      kind: 'call_contract',
      contract: SEP41_TOKEN,
    })
    expect(r.data.policyRefs[0]?.kind).toBe('interpreter')
    expect(r.data.policyDocuments).toHaveLength(1)
    expect(r.data.parseConfidence.overall).toBe(1)
  })

  it('returns a machine-readable ToolError when neither source branch matches (unknown source)', async () => {
    const r = await runSynthesizePolicy({
      source: 'codegen',
      mandate: { chain: 'stellar', contract: 'C' },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('SYNTHESIS_ERROR')
      expect(r.error.severity).toBe('error')
      expect(r.error.remediation?.toolCall?.name).toBe('synthesize_policy')
    }
  })
})

describe('tool validation error taxonomy', () => {
  it('maps malformed input to the calling tool error domain', async () => {
    const recording = await runRecordTransaction({ network: 'testnet' })
    const synthesis = await runSynthesizePolicy({ source: 'codegen' })

    expect(recording.ok).toBe(false)
    expect(synthesis.ok).toBe(false)
    if (recording.ok || synthesis.ok) throw new Error('expected validation failures')
    expect(recording.error.code).toBe('RECORDING_FAILED')
    expect(synthesis.error.code).toBe('SYNTHESIS_ERROR')
  })
})

describe('mcpResultFromCore', () => {
  it('maps ok:true into isError:false with structured content', () => {
    const r = mcpResultFromCore({ ok: true, data: { hello: 'world' } })
    expect(r.isError).toBe(false)
    if (!r.isError) {
      expect(r.structuredContent).toEqual({ hello: 'world' })
      expect(r.content[0]?.type).toBe('text')
      expect(r.content[0]?.text).toBe('{"hello":"world"}')
    }
  })

  it('maps ok:false into isError:true with the canonical ToolError', () => {
    const r = mcpResultFromCore({
      ok: false,
      error: {
        code: 'RECORDING_FAILED',
        message: 'm',
        severity: 'error',
        retryable: false,
      },
    })
    expect(r.isError).toBe(true)
    if (r.isError) {
      expect(r.structuredContent.code).toBe('RECORDING_FAILED')
      expect(r.structuredContent.severity).toBe('error')
      expect(r.content[0]?.text).toContain('RECORDING_FAILED')
    }
  })
})

// === item 7: MCP interpreter integration test ===
//
// Threads an interpreter opt-in (smartAccountAddress = a C... placeholder
// distinct from the pool) through `runSynthesizePolicy` on a Blend-claim
// recording. Mirrors the CLI test's `BLEND_CLAIM_FIXTURE` shape + the
// per-claim frequency bound responses (windowSeconds:86400, invocationLimit:1,
// validUntilLedger:200000000). Asserts:
//   - policyDocuments.length === 1
//   - a policyRef of kind 'interpreter' is present
// The 0xee placeholder address is distinct from the Blend pool address in the
// fixture (CAJJZ... vs C0xee...) so the SCOPE_SELF_CALL gate does not fire.

describe('runSynthesizePolicy - interpreter opt-in (item 7)', () => {
  it('threads a Blend-claim recording + interpreter opt-in end-to-end and emits an interpreter PolicyRef', async () => {
    const blendPool = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
    const smartAccount = Address.contract(Buffer.alloc(32, 0xee)).toString()
    // Sanity: the smart account must be distinct from the pool so the
    // SCOPE_SELF_CALL gate does not fire.
    expect(smartAccount).not.toBe(blendPool)

    const blendClaimRecording = {
      network: 'mainnet' as const,
      signers: ['hint:92377411'],
      invocations: [
        {
          contract: blendPool,
          fn: 'claim',
          args: [
            { type: 'address', value: 'GDBBXGF6AEUWUDBFD4LEN4IS5NQCHVPK5GOMVEGO6EZINZ4SG52BDQ5O' },
            {
              type: 'vec',
              value: [
                { type: 'u32', value: '1' },
                { type: 'u32', value: '2' },
              ],
            },
            { type: 'address', value: 'GDBBXGF6AEUWUDBFD4LEN4IS5NQCHVPK5GOMVEGO6EZINZ4SG52BDQ5O' },
          ],
          subInvocations: [],
        },
      ],
      tokenMovements: [
        {
          token: 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY',
          from: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
          to: 'GDBBXGF6AEUWUDBFD4LEN4IS5NQCHVPK5GOMVEGO6EZINZ4SG52BDQ5O',
          amount: '8437',
        },
      ],
      events: [],
      authEntries: [],
      ledgerSequence: 63626019,
      fetchedAt: 1784896842,
      parseConfidence: {
        overall: 1,
        knownContracts: [blendPool],
        unknownContracts: [],
        opaqueScVals: [],
        thresholdUsed: 1,
      },
      sourceAccount: 'GDBBXGF6AEUWUDBFD4LEN4IS5NQCHVPK5GOMVEGO6EZINZ4SG52BDQ5O',
    }

    const r = await runSynthesizePolicy({
      source: 'recording',
      recordedTx: blendClaimRecording,
      network: 'mainnet',
      userResponses: {
        windowSeconds: 86400,
        validUntilLedger: 200000000,
      },
      interpreter: { smartAccountAddress: smartAccount },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Item 7 assertions:
    expect(r.data.policyDocuments.length).toBe(1)
    expect(r.data.policyRefs.some((ref) => ref.kind === 'interpreter')).toBe(true)
  })
})
