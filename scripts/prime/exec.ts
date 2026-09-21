// `prime exec` - the moves that ARE allowed, run through all four gates.
//
// Without --submit these stop at the authorised simulation: every gate has had
// its say and nothing was sent. That is the fast path, and it is enough to show
// a move is permitted. --submit lands it, which costs a ledger close.

import { C, MOVE, type State, addr, custodyPk, grant, i128v, invokeOp, kv, loadState, call, readCall, secrets, sym, u32v, vec, asPrime, POOL } from './chain.ts'
import { xdr } from '@stellar/stellar-sdk'

type Flags = Record<string, string | boolean>

const amountOf = (f: Flags) => (f.amount ? BigInt(String(f.amount)) : MOVE)

function supplyBatch(s: State, amount: bigint, venue: string) {
  const request = vec([
    xdr.ScVal.scvMap([
      kv('address', addr(s.sac)),
      kv('amount', i128v(amount)),
      kv('request_type', u32v(0)),
    ]),
  ])
  const args = [addr(s.prime), addr(s.adapter), addr(custodyPk()), request]
  const transferAuth = vec([
    sym('Contract'),
    xdr.ScVal.scvMap([
      kv(
        'context',
        xdr.ScVal.scvMap([
          kv('args', vec([addr(s.adapter), addr(venue), i128v(amount)])),
          kv('contract', addr(s.sac)),
          kv('fn_name', sym('transfer')),
        ]),
      ),
      kv('sub_invocations', vec([])),
    ]),
  ])
  return {
    calls: vec([
      call(s.gate, 'pull', [addr(s.sac), addr(s.adapter), i128v(amount)]),
      call(venue, 'submit', args, [transferAuth]),
    ]),
    grants: vec([grant(s, venue, 'submit', args)]),
  }
}

function withdrawBatch(s: State, amount: bigint, to: string, venue: string) {
  const args = [
    addr(s.prime),
    addr(s.adapter),
    addr(to),
    vec([
      xdr.ScVal.scvMap([
        kv('address', addr(s.sac)),
        kv('amount', i128v(amount)),
        kv('request_type', u32v(1)),
      ]),
    ]),
  ]
  return { calls: vec([call(venue, 'submit', args)]), grants: vec([grant(s, venue, 'submit', args)]) }
}

async function run(
  s: State,
  batch: { calls: xdr.ScVal; grants: xdr.ScVal },
  ruleIds: number[],
  label: string,
  submit: boolean,
): Promise<void> {
  const t = performance.now()
  const res = await asPrime({
    kp: secrets().agent,
    prime: s.prime,
    makeOp: (auth) =>
      invokeOp(s.adapter, 'execute', [addr(s.prime), addr(s.interpreter), batch.calls, batch.grants], auth),
    ruleIds,
    signers: [secrets().agent.publicKey(), s.adapter],
    label,
    submit,
  })
  const took = Math.round(performance.now() - t)

  if (res.denied) {
    const where = res.stage === 'policy' ? 'the mandate (Gate 4)' : 'a contract you own (Gate 1 or 2)'
    console.log(`\n  ${C.red('REFUSED')} by ${where}   ${C.dim(`${took}ms`)}`)
    console.log(C.dim(`  ${(res.reason ?? '').slice(0, 400)}`))
    process.exit(1)
  }
  if (!submit) {
    console.log(`\n  ${C.green('PERMITTED')} by every gate   ${C.dim(`${took}ms`)}`)
    console.log(C.dim('  Simulated against the real contracts. Nothing was sent. Add --submit to land it.'))
    return
  }
  console.log(`\n  ${C.green('SUBMITTED')} and confirmed   ${C.dim(`${took}ms`)}`)
}

async function preamble(s: State, title: string, lines: string[]): Promise<void> {
  const admin = secrets().admin.publicKey()
  const [allowance, balance] = await Promise.all([
    readCall(s.sac, 'allowance', [addr(custodyPk()), addr(s.gate)], admin),
    readCall(s.sac, 'balance', [addr(custodyPk())], admin),
  ])
  console.log(C.bold(`\n${title}`))
  for (const l of lines) console.log(`  ${l}`)
  console.log(C.bold('\nState before'))
  console.log(`  ${C.dim('spending limit left'.padEnd(24, '.'))} ${allowance ?? 0}`)
  console.log(`  ${C.dim('custody balance'.padEnd(24, '.'))} ${balance ?? 0}`)
}

export async function execSupply(flags: Flags): Promise<void> {
  const s = loadState()
  const amount = amountOf(flags)
  const venue = typeof flags.venue === 'string' ? flags.venue : POOL
  await preamble(s, 'Supply', [
    `${C.dim('amount'.padEnd(24, '.'))} ${amount}`,
    `${C.dim('venue'.padEnd(24, '.'))} ${venue}`,
    `${C.dim('path'.padEnd(24, '.'))} custody → gatekeeper → execution step → venue`,
  ])
  if (flags['dry-run'] === true) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }
  await run(s, supplyBatch(s, amount, venue), [s.rootRuleId, s.childRuleId], 'supply', flags.submit === true)
}

export async function execWithdraw(flags: Flags): Promise<void> {
  const s = loadState()
  const amount = amountOf(flags)
  const to = typeof flags.to === 'string' ? flags.to : custodyPk()
  const venue = typeof flags.venue === 'string' ? flags.venue : POOL
  await preamble(s, 'Withdraw', [
    `${C.dim('amount'.padEnd(24, '.'))} ${amount}`,
    `${C.dim('to'.padEnd(24, '.'))} ${to}${to === custodyPk() ? C.dim('  (your account)') : C.amber('  (NOT your account)')}`,
    `${C.dim('venue'.padEnd(24, '.'))} ${venue}`,
  ])
  if (flags['dry-run'] === true) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }
  await run(s, withdrawBatch(s, amount, to, venue), [s.withdrawRuleId, s.childRuleId], 'withdraw', flags.submit === true)
}
