// Has anything moved underneath us since the last time we looked?
//
// Two things can change without touching this repository, and neither
// announces itself:
//
//   1. A Stellar protocol upgrade. Testnet leads mainnet, so a protocol
//      candidate is live on testnet for a while before it reaches the network
//      the interpreter is actually deployed to. That window is the only cheap
//      chance to find a break.
//   2. An OpenZeppelin `stellar-contracts` release. We deploy instances of
//      their example policies built from a pinned tag. The pin records what we
//      built; it does not notice a new release.
//
// The pins in `schemas.ts` are a record, and a record does not raise its hand.
// This script is the hand: it reads the live state and compares it against the
// baseline below, exiting non-zero when they differ so a scheduled run fails
// loudly rather than printing into a log nobody reads.
//
// Updating the baseline is the deliberate act of saying "we looked at this and
// it is fine", which is the whole point - a baseline that auto-updates records
// nothing.
//
// Usage: bun packages/policy-synth/scripts/upstream-drift-check.ts

import { PINNED_OZ_STELLAR_CONTRACTS_TAG, RPC_URL_BY_NETWORK } from '../src/run/schemas'

/** The state we last reviewed. A difference is a prompt to look, not a fault. */
const BASELINE = {
  /** Protocol version per network, as reviewed on 2026-08-28. Testnet running
   *  ahead of mainnet is normal and expected, not drift. */
  protocolVersion: { testnet: 28, mainnet: 27 },
  /** Latest STABLE upstream release. Release candidates are ignored: we do not
   *  deploy from an rc, so an rc appearing is not something to act on. */
  ozLatestStable: 'v0.7.2',
} as const

type Network = keyof typeof BASELINE.protocolVersion

async function liveProtocolVersion(network: Network): Promise<number> {
  const res = await fetch(RPC_URL_BY_NETWORK[network], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
  })
  if (!res.ok) throw new Error(`${network} RPC returned HTTP ${res.status}`)
  const body = (await res.json()) as { result?: { protocolVersion?: number } }
  const v = body.result?.protocolVersion
  if (typeof v !== 'number') throw new Error(`${network} RPC gave no protocolVersion`)
  return v
}

/** Latest non-prerelease tag. The GitHub releases list is newest-first, but
 *  `/releases/latest` already excludes prereleases, so an rc cannot mask a
 *  stable release here. */
async function liveOzLatestStable(): Promise<string> {
  const res = await fetch(
    'https://api.github.com/repos/OpenZeppelin/stellar-contracts/releases/latest',
    { headers: { accept: 'application/vnd.github+json' } }
  )
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`)
  const body = (await res.json()) as { tag_name?: string }
  if (!body.tag_name) throw new Error('GitHub gave no tag_name')
  return body.tag_name
}

const drift: string[] = []

for (const network of ['testnet', 'mainnet'] as const) {
  const live = await liveProtocolVersion(network)
  const known = BASELINE.protocolVersion[network]
  if (live === known) {
    console.log(`OK   ${network} protocol ${live}`)
  } else {
    console.log(`DRIFT ${network} protocol ${known} -> ${live}`)
    drift.push(
      `${network} moved to protocol ${live}. Run e2e-network.ts against it and, ` +
        `if it passes, update BASELINE.protocolVersion.${network}.`
    )
  }
}

const ozLive = await liveOzLatestStable()
if (ozLive === BASELINE.ozLatestStable) {
  console.log(`OK   OpenZeppelin latest stable ${ozLive}`)
} else {
  console.log(`DRIFT OpenZeppelin ${BASELINE.ozLatestStable} -> ${ozLive}`)
  drift.push(
    `OpenZeppelin published ${ozLive}. Our deployed policy instances are built ` +
      `from ${PINNED_OZ_STELLAR_CONTRACTS_TAG}. Decide whether to rebuild and redeploy, ` +
      `then update BASELINE.ozLatestStable.`
  )
}

if (drift.length > 0) {
  console.log(`\n${drift.length} thing(s) moved:\n`)
  for (const d of drift) console.log(`  - ${d}`)
  process.exit(1)
}

console.log('\nNothing moved since the baseline.')
