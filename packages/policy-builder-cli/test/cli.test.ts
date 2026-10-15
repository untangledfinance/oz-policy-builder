import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOLS } from '@crediolabs/policy-synth/run'
import { main } from '../src/cli.ts'

const CONTRACT = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
async function cli(args: string[], stdin = '') {
  let out = ''
  let err = ''
  const code = await main(args, {
    stdin: () => stdin,
    out: (s) => (out += s),
    err: (s) => (err += s),
  })
  return { code, out, err, json: out ? JSON.parse(out) : undefined }
}

describe('policy-builder', () => {
  it('lists the tools, and exits 0 for help but 2 for a command it does not know', async () => {
    for (const a of [[], ['help'], ['--help']]) {
      const r = await cli(a)
      expect(r.code).toBe(0)
      for (const t of TOOLS) expect(r.err).toContain(t.name)
    }
    expect((await cli(['frobnicate'])).code).toBe(2)
  })

  it('names a tool by its name or by a unique end of it', async () => {
    for (const name of ['get_interpreter_info', 'info']) {
      const r = await cli([name])
      expect(r.code).toBe(0)
      expect(r.json).toMatchObject({ ok: true, data: { grammarVersion: 7, network: 'testnet' } })
    }
    expect((await cli(['policy'])).code).toBe(2) // ends seven tools: not unique
  })

  it('takes the input as a JSON argument, from a file, from stdin, or as --field value', async () => {
    const intent = {
      calls: [{ contract: CONTRACT, fn: 'pay', where: [{ rule: 'cap', at: [0], max: '5' }] }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'opb-cli-'))
    const file = join(dir, 'in.json')
    writeFileSync(file, JSON.stringify({ intent }))
    const results = await Promise.all([
      cli(['synthesize', JSON.stringify({ intent })]),
      cli(['synthesize', '--file', file]),
      cli(['synthesize', '-'], JSON.stringify({ intent })),
      cli(['synthesize', '--intent', JSON.stringify(intent)]),
    ])
    for (const r of results) {
      expect(r.code).toBe(0)
      expect(r.json.data.rules[0].review.at(-1)).toBe('argument 0 must be at most 5')
    }
  })

  it('--field value keeps a number a string where the tool wants one (an amount, a hash of digits)', async () => {
    const intent = JSON.stringify({ calls: [{ contract: CONTRACT, fn: 'transfer' }] })
    const r = await cli(['synthesize', '--intent', intent, '--limit', '100'])
    // `--limit 100` is the string "100", which the tool takes: no input error.
    expect(r.json.ok).toBe(true)
    const big = await cli(['synthesize', '--intent', intent, '--limit', '5000000'])
    expect(big.json.ok).toBe(true)
    const digits = '1'.repeat(64)
    const h = await cli(['record', '--hash', digits])
    expect(h.json.error.message).not.toContain('Expected string, received number')
    // A number stays a number where the tool takes one.
    const n = await cli(['install', '--installNonce', '2'])
    expect(JSON.stringify(n.json.error.message)).not.toContain('installNonce')
  })

  it('prints the refusal envelope and exits 1; exits 2 when the input is not JSON at all', async () => {
    const r = await cli(['synthesize', '{}'])
    expect(r.code).toBe(1)
    expect(r.json).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'INVALID_INPUT',
        severity: 'error',
        retryable: false,
      }),
    })
    expect((await cli(['synthesize', '{nope'])).code).toBe(2)
    expect((await cli(['synthesize', '--file', '/nonexistent'])).code).toBe(2)
    expect((await cli(['info', '--network'])).code).toBe(2)
  })

  it('--out also writes the envelope to a file', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'opb-cli-')), 'result.json')
    const r = await cli(['info', '--out', out])
    expect(readFileSync(out, 'utf8')).toBe(r.out)
  })
})
