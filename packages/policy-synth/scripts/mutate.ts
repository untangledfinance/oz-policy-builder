// A small mutation runner: apply one textual mutation at a time to a source file,
// run the named tests, and count the mutants the tests kill.
//
//   bun scripts/mutate.ts <src file> <test file>... [--lines a-b] [--json out.json]
//
// Operators: comparison and logical flips, boolean literals, +/-, integer literals,
// some/every, negation removal. A surviving mutant is either a missing test or an
// equivalent mutant; each one is listed so it can be told which. The file is restored
// after every run (and on exit), so do not run the suite in the same tree meanwhile.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [file, ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest.splice(i, 2)[1] : undefined
}
const range = flag('--lines')?.split('-').map(Number)
const jsonOut = flag('--json')
const tests = rest
if (!file || tests.length === 0) throw new Error('usage: mutate.ts <src> <test>... [--lines a-b]')

const original = readFileSync(file, 'utf8')
const lines = original.split('\n')
const OPS: [RegExp, (m: string) => string][] = [
  [/===/g, () => '!=='],
  [/!==/g, () => '==='],
  [/ <= /g, () => ' < '],
  [/ >= /g, () => ' > '],
  [/ < /g, () => ' <= '],
  [/ > /g, () => ' >= '],
  [/ && /g, () => ' || '],
  [/ \|\| /g, () => ' && '],
  [/\btrue\b/g, () => 'false'],
  [/\bfalse\b/g, () => 'true'],
  [/ \+ /g, () => ' - '],
  [/ - /g, () => ' + '],
  [/\.some\(/g, () => '.every('],
  [/\.every\(/g, () => '.some('],
  [/\(!/g, () => '('],
  [/\b(\d+)\b/g, (m) => String(Number(m) + 1)],
]
const skip = (l: string) =>
  /^\s*(\/\/|\*|\/\*|import |export \* |export type|type |interface )/.test(l) ||
  /^\s*['"`]/.test(l)

interface Mutant {
  line: number
  before: string
  after: string
}
const mutants: Mutant[] = []
lines.forEach((l, i) => {
  if (skip(l) || (range && (i + 1 < (range[0] as number) || i + 1 > (range[1] as number)))) return
  for (const [re, to] of OPS) {
    for (const m of l.matchAll(re)) {
      const at = m.index ?? 0
      // Not inside a string literal on this line (an odd number of quotes before it).
      if ((l.slice(0, at).match(/['"`]/g) ?? []).length % 2 === 1) continue
      const after = l.slice(0, at) + to(m[0]) + l.slice(at + m[0].length)
      if (after !== l) mutants.push({ line: i + 1, before: l.trim(), after: after.trim() })
    }
  }
})

const restore = () => writeFileSync(file, original)
process.on('exit', restore)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))
const run = () =>
  spawnSync('bun', ['test', ...tests], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' })
    .status

if (run() !== 0) throw new Error('the tests fail on the unmutated file')
const survived: Mutant[] = []
let killed = 0
for (const [n, m] of mutants.entries()) {
  const mutated = [...lines]
  mutated[m.line - 1] =
    lines[m.line - 1]?.replace(m.before, m.after) === undefined
      ? ''
      : applyAt(lines[m.line - 1] as string, m)
  writeFileSync(file, mutated.join('\n'))
  const status = run()
  restore()
  if (status === 0) survived.push(m)
  else killed++
  process.stderr.write(`\r${n + 1}/${mutants.length} killed ${killed}`)
}
function applyAt(l: string, m: Mutant): string {
  // `after` was computed on the trimmed text of this very line: keep the indentation.
  return l.slice(0, l.length - l.trimStart().length) + m.after
}
console.log(`\n${file}: ${killed}/${mutants.length} mutants killed`)
for (const s of survived)
  console.log(`  SURVIVED line ${s.line}: ${s.before}\n        ->  ${s.after}`)
if (jsonOut)
  writeFileSync(jsonOut, JSON.stringify({ file, killed, total: mutants.length, survived }, null, 1))
