// packages/policy-builder-cli/src/commands/record.ts
//
// `policy-builder record` subcommand. Thin wrapper around the core
// `recordTransaction` - no business logic, just argv -> RecordInput + the
// canonical CLI envelope.

import type { RecordedTransaction } from '@crediolabs/policy-synth'
import { runRecordTransaction } from '@crediolabs/policy-synth/run'
import { CliError, type CliFlags, formatToolResponse, parsePairs } from '../output.ts'

export async function runRecordCommand(
  argv: ReadonlyArray<string>,
  flags: CliFlags
): Promise<RecordedTransaction> {
  const pairs = parsePairs(argv)
  const network = pairs.network
  if (!network) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: 'record: --network <mainnet|testnet> is required',
      severity: 'error',
      retryable: false,
    })
  }
  if (!pairs.hash && !pairs.xdr) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: 'record: exactly one of --hash <tx> or --xdr <b64> is required',
      severity: 'error',
      retryable: false,
    })
  }
  if (pairs.hash && pairs.xdr) {
    throw new CliError({
      code: 'CLI_MISSING_ARG',
      message: 'record: provide exactly one of --hash or --xdr, not both',
      severity: 'error',
      retryable: false,
    })
  }
  const args: Record<string, unknown> = { network }
  if (pairs.hash) args.hash = pairs.hash
  if (pairs.xdr) args.xdr = pairs.xdr
  const res = await runRecordTransaction(args)
  return formatToolResponse(res, flags, 'record')
}
