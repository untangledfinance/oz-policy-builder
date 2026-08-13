// Bypass the MCP tool shape (which strips `network` / `allowUnpinned*`) and
// call runInstallPolicy directly on mainnet. Reads the install args file
// already produced by build-predicate.ts (after the user / agent edited
// sourceAccount + network + mainnet pins), runs the install build, and
// writes the result to install-result.json.

import { readFileSync, writeFileSync } from 'node:fs'
import { runInstallPolicy } from '@crediolabs/policy-synth/run'

const argsPath = process.argv[2]
if (!argsPath) {
  console.error('usage: bun build-install-mainnet.ts <install-args.json>')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(argsPath, 'utf8'))

const res = await runInstallPolicy(raw)

const outPath = argsPath.replace(/install-args\.json$/, 'install-result.json')
writeFileSync(outPath, JSON.stringify(res, null, 2))

if (!res.ok) {
  console.error(`install build failed: ${res.error?.code ?? '?'} - ${res.error?.message ?? '?'}`)
  process.exit(1)
}

const data = res.data
const xdrLen = data.unsignedXdr?.length ?? 0
const _sigs = data.authEntries ?? data.signatures ?? []
console.log(
  JSON.stringify(
    {
      ok: true,
      smartAccount: data.smartAccount,
      sourceAccount: data.sourceAccount,
      unsignedXdr: xdrLen > 0 ? `<${xdrLen} chars>` : data.unsignedXdr,
      ...(xdrLen > 0 ? {} : {}),
      resultFile: outPath,
    },
    null,
    2
  )
)
console.log('ok: written install-result.json')
