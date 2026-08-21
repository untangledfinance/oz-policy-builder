#!/usr/bin/env node

// packages/policy-builder-cli/bin/policy-builder.ts - subcommand router.
//
// Usage:
//   policy-builder record --network <mainnet|testnet> --hash <tx>
//                                 [--xdr <b64>] [--json] [--quiet] [--out <path>]
//   policy-builder synthesize --recorded-tx <path.json> --network <mainnet|testnet>
//                              [--responses <path.json>]
//                              [--confidence <0..1>]
//                              [--smart-account <C...>] [--install-nonce <n>]
//                              [--valid-until <ledger>] [--limit-amount <i128str>]
//                              [--recipient <C...|G...>]...
//                              [--explain] [--json] [--quiet] [--out <path>]
//
// --explain (Phase 1) makes the synthesised policy human-readable: the
// output gains `review` (the deterministic review-card summary) and
// `predicateTree` (the in-memory interpreter predicate as JSON). Without
// --explain the output is byte-identical to today.
//
// The router is hand-rolled (no commander / yargs dep). It splits argv into
// `command + subcommand-flags + global-flags` and dispatches to the matching
// command body. Bad args -> CliError -> non-zero exit (JSON envelope under
// --json).

import { runRecordCommand } from '../src/commands/record.ts'
import { runSynthesizeCommand } from '../src/commands/synthesize.ts'
import { emitCliError, parseFlags } from '../src/output.ts'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const subcommandArgs = argv.slice(1)

  // Pull out --json/--quiet/--out first so they survive any position.
  // We re-parse the subcommand args below so command bodies can use
  // parsePairs cleanly (those strip the leading -- prefix).
  const flags = parseFlags(subcommandArgs)

  try {
    switch (command) {
      case 'record':
        await runRecordCommand(subcommandArgs, flags)
        return
      case 'synthesize':
      case 'synth': {
        await runSynthesizeCommand(subcommandArgs, flags)
        return
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printHelp()
        return
      default:
        process.stderr.write(`unknown command: ${command}\n`)
        printHelp()
        process.exit(2)
    }
  } catch (e) {
    emitCliError(e, flags)
  }
}

function printHelp(): void {
  process.stdout.write(
    `policy-builder - OZ policy-synth CLI

Usage:
  policy-builder record     --network <mainnet|testnet> --hash <tx> | --xdr <b64>
                            [--json] [--quiet] [--out <path>]
  policy-builder synthesize --recorded-tx <path.json> --network <mainnet|testnet>
                            [--responses <path.json>]
                            [--confidence <0..1>]
                            [--smart-account <C...>] [--install-nonce <n>]
                            [--valid-until <ledger>] [--limit-amount <i128str>]
                            [--recipient <C...|G...>]...
                            [--explain] [--json] [--quiet] [--out <path>]

Flags:
  --json                    emit machine-readable JSON on stdout
  --quiet                   suppress progress / non-error output
  --out                     write artefact to file (JSON)
  --confidence              recorder confidence GATE threshold (0..1, inclusive);
                            rejects when parseConfidence.overall < threshold; does
                            not change the recording's parseConfidence.thresholdUsed
                            in the output
  --smart-account           C... account the interpreter policy installs against;
                            required for the recording to lower to a predicate
                            document (amount caps, recipient allowlists, exact
                            hop paths) instead of warnings
  --install-nonce           per-rule install nonce for the interpreter policy
                            (default 1); requires --smart-account
  --valid-until             per-field override of userResponses.validUntilLedger;
                            overrides the same field from --responses
  --limit-amount            per-field override of userResponses.limitAmount
                            (i128 decimal string); overrides the same field
                            from --responses
  --recipient               swap-recipient allowlist entry (C... contract or
                            G... wallet) for a SoroSwap swap; REPEATABLE. Absent,
                            the recorded recipient is pinned by default; supplying
                            --recipient REPLACES that pin with the given set
`
  )
}

await main()
