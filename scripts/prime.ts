#!/usr/bin/env bun
// `prime` - a small CLI for demonstrating the four gates on Stellar testnet.
//
// This is demo tooling. It is not the published policy-builder CLI in
// packages/, and it is not meant for mainnet: it reads throwaway testnet keys
// out of scripts/.env, which .gitignore covers.
//
//   prime accounts setup  [--cosigner G...] [--dry-run]
//   prime accounts info   [--json]
//
//   prime gate setup      --allow-list "C...,G..." [--caller C...]
//                         [--limit N] [--expires-in LEDGERS] [--dry-run]
//   prime gate info       [--json]
//
//   prime demo setup      [--dry-run]     deploy the whole stack, open a position
//   prime demo run [step] [--dry-run]     all | g1..g4 | one scenario id
//   prime demo info                       everything on chain right now
//
// Run it as `bun scripts/prime.ts ...`, or `./scripts/prime.ts ...`, or put it
// on PATH:  alias prime="bun $PWD/scripts/prime.ts"
//
// Every command takes --dry-run, which prints what would happen and sends
// nothing. Read commands take --json.

import { C, loadState, readState } from './prime/chain.ts'
import { accountsInfo, accountsSetup } from './prime/accounts.ts'
import { gateInfo, gateSetup } from './prime/gate.ts'
import { demoSetup, runDemo } from './prime/demo.ts'
import { execSupply, execWithdraw } from './prime/exec.ts'
import { rulesInstall, rulesList, rulesRemove } from './prime/rules.ts'

type Flags = Record<string, string | boolean>

/** `--k v` and `--flag`. A flag followed by another flag is boolean true. */
function parseFlags(argv: string[]): Flags {
  const out: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

async function demoInfo(flags: Flags): Promise<void> {
  const s = loadState()
  const shown = await readState(s, ['allowance', 'custody', 'position', 'ledger', 'thresholds'])
  if (flags.json) {
    console.log(JSON.stringify({ ...s, state: shown }, null, 2))
    return
  }
  console.log(C.bold('\nOn chain right now'))
  for (const [k, v] of Object.entries(shown)) console.log(`  ${C.dim(k.padEnd(30, '.'))} ${v}`)
  console.log(C.bold('\nContracts'))
  for (const k of ['prime', 'adapter', 'gate', 'interpreter', 'sac'] as const) {
    console.log(`  ${C.dim(k.padEnd(30, '.'))} ${s[k]}`)
  }
}

const HELP = `prime - four-gate demo CLI (Stellar testnet)

  prime accounts setup  [--cosigner G...] [--dry-run]   Gate 3: two keys, med/high 20
  prime accounts info   [--json]

  prime gate setup      --allow-list "C...,G..."        Gates 1 and 2
                        [--caller C...] [--limit N]
                        [--expires-in LEDGERS] [--dry-run]
  prime gate info       [--json]

  prime rules list      [--json]                        Gate 4: the mandate
  prime rules install supply   --max-per-move N         [--venue C...] [--return-to G...]
  prime rules install withdraw [--to G...]              [--venue C...]
  prime rules install venue    [--venue C...]           the venue context, bound to the adapter
  prime rules remove    --id N [--dry-run]

  prime exec supply     [--amount N] [--venue C...]     a move through all four gates
  prime exec withdraw   [--amount N] [--to G...]        add --submit to land it
                        [--dry-run] [--submit]

  prime demo setup      [--dry-run]                     deploy the stack, open a position
  prime demo run [step] [--dry-run]                     all | g1..g4 | scenario id
  prime demo info       [--json]

Flags:
  --dry-run   print what would happen; send nothing
  --json      machine-readable output (read commands)

Keys come from scripts/.env; \`prime demo setup\` writes one if it is missing.
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [group, verb] = argv
  const flags = parseFlags(argv)
  const rest = argv.slice(2)

  switch (`${group} ${verb}`) {
    case 'accounts setup':
      return accountsSetup(flags)
    case 'accounts info':
      return accountsInfo(flags)
    case 'gate setup':
      return gateSetup(flags)
    case 'gate info':
      return gateInfo(flags)
    case 'demo setup':
      return demoSetup()
    case 'demo run':
      return runDemo(rest)
    case 'demo info':
      return demoInfo(flags)
    case 'rules list':
      return rulesList(flags)
    case 'rules install':
      return rulesInstall(argv[2] ?? '', flags)
    case 'rules remove':
      return rulesRemove(flags)
    case 'exec supply':
      return execSupply(flags)
    case 'exec withdraw':
      return execWithdraw(flags)
  }

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    process.stdout.write(HELP)
    return
  }
  process.stderr.write(`unknown command: ${[group, verb].filter(Boolean).join(' ')}\n\n`)
  process.stdout.write(HELP)
  process.exit(2)
}

main().catch((e) => {
  process.stderr.write(`\n${C.red('error')} ${e?.message ?? e}\n`)
  process.exit(1)
})
