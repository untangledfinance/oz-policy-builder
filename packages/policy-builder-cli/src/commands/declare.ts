// packages/policy-builder-cli/src/commands/declare.ts
//
// `policy-builder declare` subcommand. The declarative counterpart to
// `synthesize`: instead of inferring a predicate from a transaction that
// happened, it takes the constraint stated outright.
//
// Thin wrapper around `runDeclarePolicy` - no business logic, just argv ->
// DeclarePolicyInput + the canonical CLI envelope.
//
// `--token native` resolves to the network's native SAC, which is why this
// command takes --network: the native SAC address differs per network, and
// pinning the wrong one produces a policy that silently matches nothing.

import { runDeclarePolicy } from '@crediolabs/policy-synth/run'
import { Asset, Networks } from '@stellar/stellar-sdk'
import { CliError, type CliFlags, formatToolResponse, parsePairs } from '../output.ts'

interface DeclareResult {
  predicate: unknown
  encodedPredicate: string
  predicateHash: string
  warnings: string[]
}

function missing(message: string): CliError {
  return new CliError({ code: 'CLI_MISSING_ARG', message, severity: 'error', retryable: false })
}

export async function runDeclareCommand(
  argv: ReadonlyArray<string>,
  flags: CliFlags
): Promise<DeclareResult> {
  const pairs = parsePairs(argv)
  const network = pairs.network
  if (network !== 'mainnet' && network !== 'testnet') {
    throw missing('declare: --network <mainnet|testnet> is required')
  }
  if (!pairs.fn) {
    throw missing('declare: --fn <method> is required (the method the policy pins)')
  }

  const args: Record<string, unknown> = { fn: pairs.fn }

  if (pairs.token) {
    // `native` is resolved HERE rather than in the core: the core stays pure
    // and network-agnostic, and resolving it needs the passphrase.
    args.contract =
      pairs.token === 'native'
        ? Asset.native().contractId(network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET)
        : pairs.token
  }
  if (pairs['max-amount'] !== undefined) args.maxAmount = pairs['max-amount']
  if (pairs['amount-arg'] !== undefined) args.amountArgIndex = Number(pairs['amount-arg'])
  if (pairs.to !== undefined) {
    args.recipients = (pairs.to as string)
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
  }
  if (pairs['to-arg'] !== undefined) args.recipientArgIndex = Number(pairs['to-arg'])
  if (pairs['allow-zero-cap'] !== undefined) args.allowZeroCap = true
  // Slippage floor: `--min-out-ratio 99/100 --in-arg 0 --out-arg 1`. All four
  // parts are required together - a ratio with no argument positions cannot
  // be lowered, and guessing them would bound the wrong values silently.
  if (pairs['min-out-ratio'] !== undefined) {
    const [num, den] = String(pairs['min-out-ratio']).split('/')
    if (!num || !den) {
      throw missing('declare: --min-out-ratio must be `num/den`, e.g. 99/100 for a 1% floor')
    }
    if (pairs['in-arg'] === undefined || pairs['out-arg'] === undefined) {
      throw missing('declare: --min-out-ratio also needs --in-arg <i> and --out-arg <j>')
    }
    args.minOutputRatio = {
      num,
      den,
      inputArgIndex: Number(pairs['in-arg']),
      outputArgIndex: Number(pairs['out-arg']),
    }
  }

  const res = runDeclarePolicy(args)
  const data = formatToolResponse(res, flags, 'declare') as DeclareResult

  // Warnings go to stderr so `--json` stdout stays a clean envelope, but they
  // are never silent: each one names an argument index that was GUESSED, and
  // a bound on the wrong argument constrains nothing while looking correct.
  if (!flags.quiet) {
    for (const w of data.warnings) process.stderr.write(`warning: ${w}\n`)
  }
  return data
}
