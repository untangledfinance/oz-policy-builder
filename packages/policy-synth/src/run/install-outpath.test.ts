// src/run/install-outpath.test.ts - `install_policy` writes the unsigned
// envelope itself when given `outPath`.
//
// The envelope runs to several thousand characters. Before this option the only
// route onto disk was the caller re-emitting it, through a model or a shell
// argument, and that transport corrupts it: observed both as silent truncation
// and as files of exactly the right length whose bytes no longer parse. The
// failure surfaces at the signer as a malformed TRANSACTION, which sends you
// debugging the rule rather than the file.
//
// Two things are covered here, both reachable without a network. The path is
// validated before any work happens, and a build that fails leaves nothing
// behind - a signer watching a directory must never find a partial file.

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@stellar/stellar-sdk'
import { encodePredicate } from '../predicate/encode.ts'
import { runInstallPolicy } from './index.ts'
import { InstallPolicyInputSchema } from './schemas.ts'

const SMART_ACCOUNT = 'CDEG66TYZB2RTKRSIEA4UTFMRXOYESCEQUKWS7R2JN357PJDSY272PFK'
const SOURCE_ACCOUNT = Keypair.random().publicKey()

function makeRule(signers: { kind: 'delegated'; address: string }[]) {
  const pred = encodePredicate({
    op: 'eq',
    left: { kind: 'call_fn' },
    right: { kind: 'literal_symbol', value: 'transfer' },
  })
  return {
    contextRuleType: { kind: 'default' as const },
    name: 'test-rule',
    validUntilLedger: null,
    signers,
    policies: [
      {
        kind: 'interpreter' as const,
        interpreterAddress: SMART_ACCOUNT,
        predicateBlobBase64: pred.encodedPredicate,
      },
    ],
  }
}

const base = {
  smartAccount: SMART_ACCOUNT,
  sourceAccount: SOURCE_ACCOUNT,
  installNonce: 1,
}

describe('install_policy outPath validation', () => {
  it('accepts an absolute path', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      rule: makeRule([{ kind: 'delegated', address: SOURCE_ACCOUNT }]),
      outPath: '/tmp/envelope.xdr',
    })
    expect(parsed.success).toBe(true)
  })

  it('is optional, so existing callers are unaffected', () => {
    const parsed = InstallPolicyInputSchema.safeParse({
      ...base,
      rule: makeRule([{ kind: 'delegated', address: SOURCE_ACCOUNT }]),
    })
    expect(parsed.success).toBe(true)
  })

  // A relative path resolves against whatever directory the server happens to
  // be running in, which the caller does not know and cannot predict. It would
  // "succeed" and leave the file somewhere the signer never looks.
  it('rejects a relative path rather than resolving it against an unknown cwd', async () => {
    const res = await runInstallPolicy({
      ...base,
      rule: makeRule([{ kind: 'delegated', address: SOURCE_ACCOUNT }]),
      outPath: 'envelope.xdr',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.message).toContain('outPath')
  })

  it('rejects an empty path and a null byte', async () => {
    for (const bad of ['', '/tmp/env\0.xdr']) {
      const res = await runInstallPolicy({
        ...base,
        rule: makeRule([{ kind: 'delegated', address: SOURCE_ACCOUNT }]),
        outPath: bad,
      })
      expect(res.ok).toBe(false)
    }
  })
})

describe('install_policy outPath on a failed build', () => {
  // A rule naming no signer is refused before the envelope exists. Nothing may
  // be written: a signer watching the directory would otherwise pick up a file
  // for a transaction that was never built.
  it('writes no file when the install fails', async () => {
    const target = join(tmpdir(), `outpath-unwritten-${Date.now()}-${process.pid}.xdr`)
    const res = await runInstallPolicy({ ...base, rule: makeRule([]), outPath: target })
    expect(res.ok).toBe(false)
    // Assert WHY it failed. The path above is valid, so if this ever starts
    // failing on `outPath` instead the test would still pass while covering
    // nothing.
    if (!res.ok) expect(res.error.message).toContain('no signer')
    expect(existsSync(target)).toBe(false)
  })
})
