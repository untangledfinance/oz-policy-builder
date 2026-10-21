// The command line: `policy-builder <tool> [json | --file path | - | --field value ...]`.
// Every tool in the table is a command (a unique prefix or suffix of its name is
// enough: `record`, `synthesize`, `install`, `info`). One JSON envelope goes to
// stdout, the same one the MCP server returns; the exit code is 1 when it is a refusal.

import { readFileSync, writeFileSync } from 'node:fs'
import { TOOLS, type Tool } from '@crediolabs/policy-synth/run'

export interface Io {
  stdin: () => string
  out: (s: string) => void
  err: (s: string) => void
}

const find = (name: string): Tool | undefined => {
  const hits = TOOLS.filter(
    (t) => t.name === name || t.name.startsWith(`${name}_`) || t.name.endsWith(`_${name}`)
  )
  return hits.length === 1 ? hits[0] : TOOLS.find((t) => t.name === name)
}

/** `--key value` pairs as input fields; a value that is JSON (a list, an object, a number the tool takes) is read as such. */
function flags(args: string[], tool: Tool): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!key?.startsWith('--') || args[i + 1] === undefined)
      throw new Error(`expected --field value, got ${key ?? 'nothing'}`)
    const value = args[i + 1] as string
    out[key.slice(2)] = (() => {
      try {
        const parsed: unknown = JSON.parse(value)
        // An amount or a hash of digits is a string the tool wants as one, not the number it parses to.
        return typeof parsed === 'number' &&
          tool.shape[key.slice(2)]?.safeParse(parsed).success !== true
          ? value
          : parsed
      } catch {
        return value
      }
    })()
  }
  return out
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv
  const tool = name === undefined ? undefined : find(name)
  if (!tool) {
    io.err(
      `usage: policy-builder <tool> [json | --file path | - | --field value ...] [--out path]\ntools:\n${TOOLS.map((t) => `  ${t.name}`).join('\n')}\n`
    )
    return name === undefined || name === 'help' || name === '--help' ? 0 : 2
  }
  try {
    const outAt = rest.indexOf('--out')
    const outPath = outAt >= 0 ? rest.splice(outAt, 2)[1] : undefined
    const [first, second] = rest
    const input =
      first === undefined
        ? {}
        : first === '-'
          ? JSON.parse(io.stdin())
          : first === '--file'
            ? JSON.parse(readFileSync(second as string, 'utf8'))
            : first.startsWith('--')
              ? flags(rest, tool)
              : JSON.parse(first)
    const res = await tool.run(input)
    const text = `${JSON.stringify(res, null, 2)}\n`
    if (outPath) writeFileSync(outPath, text)
    io.out(text)
    return res.ok ? 0 : 1
  } catch (e) {
    io.err(`${(e as Error).message}\n`)
    return 2
  }
}
