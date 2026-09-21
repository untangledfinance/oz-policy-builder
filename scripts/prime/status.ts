// `prime status` - one screen, four gates.
//
// Everything a demo needs to establish before anyone tries to break it: who
// can move the custody account, what the gatekeeper will release and to whom,
// what the mandate pins, and what is currently at work in a venue.

import { C, POOL, addr, custodyPk, horizon, loadState, readCall, secrets, server, u32v } from './chain.ts'
import { readGateConfig } from './gate.ts'

type Flags = Record<string, string | boolean>

export async function status(flags: Flags): Promise<void> {
  const s = loadState()
  const admin = secrets().admin.publicKey()

  const [acct, allowance, cfg, latest, count, position] = await Promise.all([
    horizon.loadAccount(custodyPk()) as Promise<any>,
    readCall(s.sac, 'allowance', [addr(custodyPk()), addr(s.gate)], admin),
    readGateConfig(s.gate),
    server.getLatestLedger(),
    readCall(s.prime, 'get_context_rules_count', [], admin),
    readCall(POOL, 'get_positions', [addr(s.prime)], admin) as Promise<any>,
  ])

  const n = Number(count ?? 0)
  const rules: any[] = []
  for (let id = 0; id < n + 8 && rules.length < n; id++) {
    const r: any = await readCall(s.prime, 'get_context_rule', [u32v(id)], admin)
    if (r) rules.push(r)
  }

  const signers = acct.signers.map((x: any) => ({ key: x.key, weight: x.weight }))
  const med = Number(acct.thresholds.med_threshold)
  const oneKeyEnough = signers.some((x: any) => x.weight >= med)
  const left = s.allowanceExpiryLedger - latest.sequence
  const shares = position?.supply ? Object.values(position.supply)[0] : undefined

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          contracts: { prime: s.prime, adapter: s.adapter, gate: s.gate, interpreter: s.interpreter, sac: s.sac, venue: POOL },
          gate3: { account: custodyPk(), thresholds: acct.thresholds, signers, oneKeyEnough },
          gate1: { limitRemaining: String(allowance ?? 0), expiresAtLedger: s.allowanceExpiryLedger, ledgersRemaining: left },
          gate2: { caller: cfg?.caller ?? s.adapter, allowList: cfg?.allowed ?? [] },
          gate4: rules.map((r) => ({ id: Number(r.id), name: String(r.name ?? ''), policed: (r.policies ?? []).length > 0 })),
          position: shares ? String(shares) : null,
        },
        null,
        2,
      ),
    )
    return
  }

  const row = (k: string, v: string) => console.log(`  ${C.dim(k.padEnd(26, '.'))} ${v}`)

  console.log(C.bold('\n━━ GATE 3 · who can change anything ') + C.dim('· yours'))
  row('custody account', custodyPk())
  row('XLM balance', acct.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0')
  row('thresholds', `low ${acct.thresholds.low_threshold} / med ${med} / high ${acct.thresholds.high_threshold}`)
  for (const sg of signers) row('signer', `${sg.key}  weight ${sg.weight}`)
  row(
    'one key alone',
    oneKeyEnough ? C.amber('CAN move value — Gate 3 is NOT in force') : C.green('cannot move value'),
  )

  console.log(C.bold('\n━━ GATE 1 · how much, until when ') + C.dim('· yours'))
  row('gatekeeper', s.gate)
  row('limit remaining', String(allowance ?? 0))
  row(
    'expires',
    left > 0 ? `ledger ${s.allowanceExpiryLedger}  (${left} to go, ~${Math.round((left * 5) / 60)} min)` : C.amber('EXPIRED'),
  )

  console.log(C.bold('\n━━ GATE 2 · which addresses it may release to ') + C.dim('· yours'))
  row('answers only to', cfg?.caller ?? s.adapter)
  for (const a of cfg?.allowed ?? []) {
    row('may release to', `${a}${a === s.adapter ? C.dim('  (the execution step)') : ''}`)
  }
  row('anything else', C.green('refused by the contract'))

  console.log(C.bold('\n━━ GATE 4 · the mandate ') + C.dim('· ours'))
  for (const r of rules) {
    const policed = (r.policies ?? []).length > 0
    row(
      `rule #${Number(r.id)}`,
      `${String(r.name ?? '(unnamed)')}  ${policed ? C.green('policed') : C.amber('NO POLICY — unrestricted')}`,
    )
  }
  row('venue', POOL)

  console.log(C.bold('\n━━ AT WORK'))
  row('position in Prime’s name', shares ? `${shares} shares` : C.dim('none open'))
  row('prime', s.prime)
  row('execution step', s.adapter)

  console.log(
    C.dim('\n  Try to break it:  bun scripts/prime.ts demo run all\n'),
  )
}
