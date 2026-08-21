// packages/policy-builder-cli/test/cli.test.ts
//
// Tests the CLI by spawning the bin script and asserting stdout/stderr/exit.
// Covers: happy path with --json, missing-arg path with non-zero exit, the
// --out file write, and the mandate + recording front-ends.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Address } from '@stellar/stellar-sdk'

const CLI_BIN = resolve(__dirname, '../bin/policy-builder.ts')
const FIXTURES = resolve(__dirname, 'fixtures')
const TMP = resolve(__dirname, '.tmp')

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runCli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', CLI_BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

const MANDATE_FIXTURE = {
  chain: 'stellar',
  contract: 'CTOKEN',
  method: 'transfer',
  spendingLimit: { token: 'CTOKEN', limit: '5000000', windowSeconds: 2592000 },
  expiry: { validUntilLedger: 1000000 },
}

const RECORDING_FIXTURE = {
  network: 'mainnet',
  signers: ['GCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKAGP5'],
  invocations: [
    {
      contract: 'CAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX4KO',
      fn: 'transfer',
      args: [
        { type: 'address', value: 'GCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKAGP5' },
        { type: 'address', value: 'GCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DJX7' },
        { type: 'i128', value: '1000000000' },
      ],
      subInvocations: [],
    },
  ],
  tokenMovements: [
    {
      token: 'CAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX4KO',
      from: 'GCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKAGP5',
      to: 'GCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DJX7',
      amount: '1000000000',
    },
  ],
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
  sourceAccount: 'GCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKAGP5',
}

// A real mainnet Blend `claim` recording (incoming yield, no spend). Synthesized
// WITH the interpreter opt-in, its only enforceable restriction - a per-claim
// frequency cap - lowers to an interpreter predicate, which OZ built-ins cannot
// express. Used to prove `--smart-account` threads the interpreter opt-in through.
const BLEND_CLAIM_FIXTURE = {
  network: 'mainnet',
  signers: ['hint:92377411'],
  invocations: [
    {
      contract: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
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
    knownContracts: ['CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'],
    unknownContracts: [],
    opaqueScVals: [],
    thresholdUsed: 1,
  },
  sourceAccount: 'GDBBXGF6AEUWUDBFD4LEN4IS5NQCHVPK5GOMVEGO6EZINZ4SG52BDQ5O',
}

// Per-claim frequency bound: at most 1 claim per 24h, with an explicit expiry.
const BLEND_RESPONSES = { windowSeconds: 86400, invocationLimit: 1, validUntilLedger: 200000000 }

// The C... smart account the interpreter policy is installed against (distinct
// from the pool contract, so it is not a self-call). Placeholder 0xee account.
const SMART_ACCOUNT = Address.contract(Buffer.alloc(32, 0xee)).toString()

// A mainnet SoroSwap swap recording. Used to prove the repeatable `--recipient`
// flag threads a swap-recipient allowlist through to the core (and that its
// absence pins the recorded recipient with a RECIPIENT_ALLOWLIST_EMPTY notice).
const SWAP_OWNER = Address.account(Buffer.alloc(32, 0x01)).toString()
const SWAP_ALT_RECIPIENT = Address.account(Buffer.alloc(32, 0xa1)).toString()
const SWAP_TOKEN_IN = Address.contract(Buffer.alloc(32, 0x01)).toString()
const SWAP_TOKEN_OUT = Address.contract(Buffer.alloc(32, 0x02)).toString()
const SOROSWAP_ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'
const SOROSWAP_FIXTURE = {
  network: 'mainnet',
  signers: [SWAP_OWNER],
  invocations: [
    {
      contract: SOROSWAP_ROUTER,
      fn: 'swap_exact_tokens_for_tokens',
      args: [
        { type: 'i128', value: '50000000' },
        { type: 'i128', value: '45000000' },
        {
          type: 'vec',
          value: [
            { type: 'address', value: SWAP_TOKEN_IN },
            { type: 'address', value: SWAP_TOKEN_OUT },
          ],
        },
        { type: 'address', value: SWAP_OWNER },
        { type: 'u64', value: '1700000000' },
      ],
      subInvocations: [],
    },
  ],
  tokenMovements: [
    { token: SWAP_TOKEN_IN, from: SWAP_OWNER, to: SOROSWAP_ROUTER, amount: '50000000' },
  ],
  events: [],
  authEntries: [],
  ledgerSequence: 1,
  fetchedAt: 0,
  parseConfidence: {
    overall: 1,
    knownContracts: [SOROSWAP_ROUTER],
    unknownContracts: [],
    opaqueScVals: [],
    thresholdUsed: 1,
  },
  sourceAccount: SWAP_OWNER,
}

// Written once for the whole file, not per test. Every test reads these
// fixtures and none of them mutates one, so rewriting them between tests
// bought nothing -- while tearing the directory down after each test raced the
// CLI subprocesses the tests spawn, which read fixtures by path. That race made
// this file fail intermittently with CLI_FILE_NOT_FOUND on a fixture the test
// had just written. Tests that need their own fixture write it inside the test
// under a distinct name.
beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(resolve(FIXTURES, 'mandate.json'), JSON.stringify(MANDATE_FIXTURE, null, 2))
  writeFileSync(resolve(FIXTURES, 'recorded-tx.json'), JSON.stringify(RECORDING_FIXTURE, null, 2))
  writeFileSync(resolve(FIXTURES, 'soroswap.json'), JSON.stringify(SOROSWAP_FIXTURE, null, 2))
  writeFileSync(resolve(FIXTURES, 'blend-claim.json'), JSON.stringify(BLEND_CLAIM_FIXTURE, null, 2))
  writeFileSync(resolve(FIXTURES, 'blend-responses.json'), JSON.stringify(BLEND_RESPONSES, null, 2))
})

afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
})

describe('policy-builder CLI', () => {
  it('prints help with no args (exit 0)', async () => {
    const r = await runCli([])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('policy-builder')
  })

  it('synthesize --recorded-tx --json exits 0 with JSON on stdout', async () => {
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; data: { contextRule: unknown } }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.contextRule).toBeDefined()
  })

  it('synthesize --recorded-tx accepts the { ok, data } artefact that record --out writes', async () => {
    // `record --out FILE` writes the { ok, data } envelope (same shape as --json);
    // feeding that file straight into `synthesize --recorded-tx FILE` must work.
    const envelopePath = resolve(FIXTURES, 'recorded-tx-envelope.json')
    writeFileSync(envelopePath, JSON.stringify({ ok: true, data: RECORDING_FIXTURE }, null, 2))
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      envelopePath,
      '--network',
      'mainnet',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; data: { contextRule: unknown } }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.contextRule).toBeDefined()
  })

  it('synthesize --recorded-tx --smart-account opts into the interpreter and emits the predicate document', async () => {
    // Without --smart-account the CLI runs OZ-only: a Blend claim yields empty
    // policyDocuments/policyRefs (the frequency cap is not an OZ built-in).
    // Passing --smart-account threads the interpreter opt-in through, so the
    // per-claim frequency cap lowers to a real interpreter predicate document.
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      SMART_ACCOUNT,
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      data: {
        policyDocuments: Array<{ predicateHash: string }>
        policyRefs: Array<{ kind: string }>
      }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.policyDocuments.length).toBeGreaterThan(0)
    expect(parsed.data.policyDocuments[0]?.predicateHash).toBe(
      '928b07824487221fdfcdaa7a420920258a4749c4e7e32d4919cf1e0dc9ab3f55'
    )
    expect(parsed.data.policyRefs.some((ref) => ref.kind === 'interpreter')).toBe(true)
  })

  it('synthesize --out writes the JSON artefact to disk', async () => {
    const outPath = resolve(TMP, 'policy.json')
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--out',
      outPath,
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    expect(existsSync(outPath)).toBe(true)
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as { ok: boolean; data: unknown }
    expect(written.ok).toBe(true)
  })

  it('synthesize without --mandate or --recorded-tx exits non-zero with the ToolError envelope', async () => {
    const r = await runCli(['synthesize', '--json'])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
  })

  it('synthesize --recorded-tx --smart-account "" (empty) rejects with CLI_MISSING_ARG', async () => {
    // Foot-gun: --smart-account <empty> silently dropped today, the recording is
    // synthesized WITHOUT the interpreter opt-in, and the user gets a "successful"
    // empty policy (0 policyDocuments) for a constraint that OZ cannot express.
    // The CLI must reject empty values up front instead.
    //
    // This test calls runSynthesizeCommand directly instead of spawning the
    // bin script: `Bun.spawn` (like `child_process.spawn`) drops `--flag ""`
    // before the child process even sees argv, so we cannot exercise this
    // path end-to-end via spawn. The validation lives in synthesize.ts and
    // is reachable from real shell invocations where the shell preserves
    // quoted empty args into the bun CLI binary.
    const { runSynthesizeCommand } = await import('../src/commands/synthesize.ts')
    const argv = [
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      '',
      '--json',
    ]
    await expect(
      runSynthesizeCommand(argv, { json: true, quiet: false, out: null })
    ).rejects.toMatchObject({
      toolError: { code: 'CLI_MISSING_ARG', message: expect.stringMatching(/--smart-account/) },
    })
  })

  it('synthesize --recorded-tx --smart-account (malformed non-strkey) exits non-zero with the CLI envelope', async () => {
    // Foot-gun: --smart-account <garbage> used to be passed straight through to
    // the interpreter adapter, surfacing a downstream error that did not name
    // the offending flag. The CLI must validate the C... 56-char strkey shape
    // up front and report it as a CLI_MISSING_ARG with the flag in the message.
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      'not-a-contract-address',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
    expect(parsed.error.message).toMatch(/--smart-account/)
  })

  it('synthesize --recorded-tx --install-nonce without --smart-account exits non-zero with the CLI envelope', async () => {
    // Foot-gun: --install-nonce is silently dropped when --smart-account is absent
    // (it lives inside the `if (pairs['smart-account'])` block). The user thinks
    // they are pinning a nonce and they are not. The CLI must reject the
    // combination with an actionable error.
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--install-nonce',
      '42',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
    expect(parsed.error.message).toMatch(
      /--smart-account.*--install-nonce|--install-nonce.*--smart-account/
    )
  })

  it('record with neither --hash nor --xdr exits non-zero with the CLI envelope', async () => {
    const r = await runCli(['record', '--network', 'testnet', '--json'])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    // CLI pre-flight catches missing source arg with a CLI-friendly code;
    // this is friendlier than letting the adapter surface a generic error.
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
  })

  it('unknown subcommand exits non-zero with usage on stderr', async () => {
    const r = await runCli(['from-tx'])
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('unknown command')
  })

  // === parity flags (Step 2) ===
  //
  // Each new flag must:
  //   1. reach the core (assert an observable effect on the synthesised policy)
  //   2. reject bad values up front with a CLI-friendly exit code

  it('synthesize --window-seconds <bad> exits non-zero with CLI_MISSING_ARG', async () => {
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--limit-amount',
      '1000000000',
      '--window-seconds',
      'not-a-number',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
  })

  it('synthesize --valid-until <ledger> reaches the core (contextRule.validUntilLedger reflects the override)', async () => {
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--limit-amount',
      '1000000000',
      '--valid-until',
      '1234567',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      data: { contextRule: { validUntilLedger?: number } }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.contextRule.validUntilLedger).toBe(1234567)
  })

  it('synthesize --valid-until <bad> exits non-zero with CLI_MISSING_ARG', async () => {
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--limit-amount',
      '1000000000',
      '--valid-until',
      'abc',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
  })

  it('synthesize --invocation-limit <n> reaches the core (no error on valid positive int)', async () => {
    // invocationLimit is consumed by the interpreter path; the recording path
    // surfaces it through the policy warnings / userResponses plumbing. We
    // assert the flag does not break the OZ-only synthesis (exit 0 + ok:true).
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--limit-amount',
      '1000000000',
      '--invocation-limit',
      '5',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  it('synthesize --limit-amount <bad non-i128> exits non-zero with CLI_MISSING_ARG', async () => {
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--limit-amount',
      '12.34',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
  })

  it('synthesize --recipient <bad address> exits non-zero with CLI_MISSING_ARG', async () => {
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--recipient',
      'not-an-address',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
  })

  it('synthesize SoroSwap without --recipient pins the recorded recipient (RECIPIENT_ALLOWLIST_EMPTY notice)', async () => {
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'soroswap.json'),
      '--network',
      'mainnet',
      '--smart-account',
      SMART_ACCOUNT,
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      data: { ambiguities: Array<{ code: string }> }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.ambiguities.some((a) => a.code === 'RECIPIENT_ALLOWLIST_EMPTY')).toBe(true)
  })

  it('synthesize --recipient (repeatable) threads a swap-recipient allowlist through, replacing the default pin', async () => {
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'soroswap.json'),
      '--network',
      'mainnet',
      '--smart-account',
      SMART_ACCOUNT,
      '--recipient',
      SWAP_OWNER,
      '--recipient',
      SWAP_ALT_RECIPIENT,
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      data: { ambiguities: Array<{ code: string }> }
    }
    expect(parsed.ok).toBe(true)
    // An explicit allowlist REPLACES the default pin -> no RECIPIENT_ALLOWLIST_EMPTY.
    expect(parsed.data.ambiguities.some((a) => a.code === 'RECIPIENT_ALLOWLIST_EMPTY')).toBe(false)
  })

  it('synthesize --confidence <out-of-range> exits non-zero with CLI_MISSING_ARG', async () => {
    // A confidence threshold above 1 would disable the recorder gate; the CLI
    // must reject it before the call reaches the core.
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--confidence',
      '1.5',
      '--json',
    ])
    expect(r.exitCode).not.toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('CLI_MISSING_ARG')
  })

  it('synthesize --confidence <in-range> reaches the core (low-confidence recording passes with low threshold)', async () => {
    // The SEP41 fixture has parseConfidence.overall = 1.0; without an
    // override the threshold is also 1.0 -> pass. With --confidence 0.4
    // the threshold drops; the recording still passes (1.0 >= 0.4) but
    // the call exercises the confidenceOverride path end-to-end.
    const r = await runCli([
      'synthesize',
      '--smart-account',
      SMART_ACCOUNT,
      '--recorded-tx',
      resolve(FIXTURES, 'recorded-tx.json'),
      '--network',
      'mainnet',
      '--limit-amount',
      '1000000000',
      '--confidence',
      '0.4',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  // === --explain (Phase 1) ===
  //
  // The flag is ADDITIVE: with --explain the output gains `review` +
  // `predicateTree` fields; without it the output is byte-identical to
  // today's. The card is deterministic (same policy in -> same card out)
  // and the constraint lines name every leaf readably.

  it('synthesize --explain adds review + predicateTree to the JSON output', async () => {
    // Two checks: (1) the success envelope carries both fields, (2) the
    // existing ProposedPolicy fields (policyDocuments, policyRefs, etc.)
    // are unchanged.
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      SMART_ACCOUNT,
      '--explain',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean
      data: {
        policyDocuments: Array<{ predicateHash: string }>
        policyRefs: Array<{ kind: string }>
        contextRule: { name: string }
        review?: {
          ruleName: string
          plainEnglish: string
          constraints: string[]
          expiry: string
          backend: string
          contentHash: string
        }
        predicateTree?: { op: string; children?: unknown[] }
      }
    }
    expect(parsed.ok).toBe(true)
    // Existing fields unchanged.
    expect(parsed.data.policyDocuments[0]?.predicateHash).toBe(
      '928b07824487221fdfcdaa7a420920258a4749c4e7e32d4919cf1e0dc9ab3f55'
    )
    // New fields present.
    expect(parsed.data.review).toBeDefined()
    expect(parsed.data.predicateTree).toBeDefined()
    expect(parsed.data.review?.ruleName).toBe(parsed.data.contextRule.name)
    expect(parsed.data.review?.backend).toMatch(/^(ts-model|interpreter-v1)$/)
    expect(parsed.data.review?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.data.predicateTree?.op).toBe('and')
  })

  it('synthesize without --explain leaves the JSON output unchanged (additive only)', async () => {
    // The two envelopes must be byte-identical EXCEPT for the absent
    // `review` + `predicateTree` fields. Strip those from the --explain
    // envelope and compare; the remaining shape must match the no-flag
    // envelope exactly.
    const noFlag = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      SMART_ACCOUNT,
      '--json',
    ])
    const withFlag = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      SMART_ACCOUNT,
      '--explain',
      '--json',
    ])
    expect(noFlag.exitCode).toBe(0)
    expect(withFlag.exitCode).toBe(0)
    const a = JSON.parse(noFlag.stdout.trim()) as { data: Record<string, unknown> }
    const b = JSON.parse(withFlag.stdout.trim()) as { data: Record<string, unknown> }
    // Strip the two explain-only fields.
    delete b.data.review
    delete b.data.predicateTree
    expect(b.data).toEqual(a.data)
  })

  it('synthesize --explain is deterministic across repeated runs (byte-identical card)', async () => {
    // The review card must be pure: same policy in -> same card out. No
    // clock, no timestamp, no per-run drift.
    async function runOnce() {
      const r = await runCli([
        'synthesize',
        '--recorded-tx',
        resolve(FIXTURES, 'blend-claim.json'),
        '--network',
        'mainnet',
        '--responses',
        resolve(FIXTURES, 'blend-responses.json'),
        '--smart-account',
        SMART_ACCOUNT,
        '--explain',
        '--json',
      ])
      return JSON.parse(r.stdout.trim()) as {
        data: {
          review: { contentHash: string; constraints: string[] }
          predicateTree: unknown
        }
      }
    }
    const a = await runOnce()
    const b = await runOnce()
    expect(a.data.review.contentHash).toBe(b.data.review.contentHash)
    expect(a.data.review.constraints).toEqual(b.data.review.constraints)
    expect(a.data.predicateTree).toEqual(b.data.predicateTree)
  })

  it('synthesize --explain on the Blend submit fixture produces non-empty constraint lines for the new leaves', async () => {
    // The Blend submit predicate carries call_arg_len + 3 call_arg_field
    // leaves. Every constraint line must be non-empty, readable, and named
    // (no "[object Object]", no "<call_arg_len>" style placeholders).
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      SMART_ACCOUNT,
      '--explain',
      '--json',
    ])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as {
      data: { review: { constraints: string[] } }
    }
    expect(parsed.data.review.constraints.length).toBeGreaterThan(0)
    for (const s of parsed.data.review.constraints) {
      expect(s.length).toBeGreaterThan(0)
      expect(s).not.toContain('[object Object]')
      expect(s).not.toContain('undefined')
      expect(s).not.toMatch(/<(call_arg_len|call_arg_field|amount|now|valid_until)>/)
    }
  })

  it('synthesize --explain human output states each constraint exactly once', async () => {
    // Without --json the review card is read off the screen, so every
    // constraint must appear once and only once. `plainEnglish` is the same
    // constraints joined into a sentence; printing it alongside the bullets
    // would say everything twice.
    const r = await runCli([
      'synthesize',
      '--recorded-tx',
      resolve(FIXTURES, 'blend-claim.json'),
      '--network',
      'mainnet',
      '--responses',
      resolve(FIXTURES, 'blend-responses.json'),
      '--smart-account',
      SMART_ACCOUNT,
      '--explain',
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Review card:')
    expect(r.stdout).toContain('Constraints:')

    // Each bullet is a constraint; none of them may also appear in a
    // semicolon-joined summary line.
    const bullets = r.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('- '))
      .map((l) => l.trim().slice(2))
    expect(bullets.length).toBeGreaterThan(0)
    for (const constraint of bullets) {
      const occurrences = r.stdout.split(constraint).length - 1
      expect(occurrences).toBe(1)
    }
  })
})
