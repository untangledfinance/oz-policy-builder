// `prime exec` - attempt a move through all four gates.
//
// Without --submit these stop at the authorised simulation: every gate has had
// its say and nothing was sent. That is the fast path, and it is enough to show
// whether a move is permitted. --submit lands it and prints the transaction
// hash, which costs a ledger close.
//
// --as and --rule are what make this a demonstration rather than a runner. A
// caller chooses both the key that signs and the rule that authorises, so the
// interesting questions are what happens when the wrong key tries, and what
// happens when a key names a rule looser than the mandate:
//
//   prime exec withdraw --to <stranger>              refused by the mandate
//   prime exec withdraw --as admin                   refused, not a signer there
//   prime exec withdraw --as admin --rule 0,2 --to <stranger>
//                                                    PERMITTED - rule 0 is
//                                                    unpoliced, which is the
//                                                    exposure docs 9.7 names

import { Keypair, xdr } from '@stellar/stellar-sdk'
import {
  addr,
  asPrime,
  C,
  call,
  custodyPk,
  grant,
  i128v,
  invokeOp,
  kv,
  loadState,
  MOVE,
  POOL,
  readCall,
  type State,
  secrets,
  sym,
  u32v,
  vec,
} from './chain.ts'

type Flags = Record<string, string | boolean>

const amountOf = (f: Flags) => (f.amount ? BigInt(String(f.amount)) : MOVE)

/** --as picks which key attempts the move: a name from scripts/.env, or a raw
 *  secret. The point is to try an action as a key that should not be able to
 *  do it and watch which layer says no. */
function signerFrom(flags: Flags): { kp: Keypair; label: string } {
  const who = typeof flags.as === 'string' ? flags.as : 'agent'
  const s = secrets()
  const named: Record<string, Keypair> = {
    agent: s.agent,
    admin: s.admin,
    custody: s.custody,
    cosign: s.cosign,
  }
  if (named[who]) return { kp: named[who], label: who }
  if (who.startsWith('S')) {
    try {
      return { kp: Keypair.fromSecret(who), label: 'the key you supplied' }
    } catch {
      throw new Error('--as must be agent, admin, custody, cosign, or a secret key')
    }
  }
  throw new Error(`unknown --as "${who}". Use agent, admin, custody, cosign, or a secret key.`)
}

/** --rule names which context rule authorises the call. A caller picks this,
 *  which is exactly why a key must not sit on a rule looser than its mandate. */
const rulesFor = (flags: Flags, fallback: number[]): number[] =>
  flags.rule !== undefined
    ? String(flags.rule)
        .split(',')
        .map((x) => Number(x.trim()))
    : fallback

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
        ])
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
  return {
    calls: vec([call(venue, 'submit', args)]),
    grants: vec([grant(s, venue, 'submit', args)]),
  }
}

async function run(
  s: State,
  batch: { calls: xdr.ScVal; grants: xdr.ScVal },
  ruleIds: number[],
  label: string,
  submit: boolean,
  kp = secrets().agent
): Promise<void> {
  const t = performance.now()
  const res = await asPrime({
    kp,
    prime: s.prime,
    makeOp: (auth) =>
      invokeOp(
        s.adapter,
        'execute',
        [addr(s.prime), addr(s.interpreter), batch.calls, batch.grants],
        auth
      ),
    ruleIds,
    signers: [kp.publicKey(), s.adapter],
    label,
    submit,
  })
  const took = Math.round(performance.now() - t)

  if (res.denied) {
    const code = (res.reason ?? '').match(/Error\(Contract, #(\d+)\)/)?.[1]
    const where =
      res.stage !== 'policy'
        ? 'a contract you own (Gate 1 or 2)'
        : code === '210' || code === '204'
          ? 'the account — this key is not a signer on the rule it named'
          : 'the mandate (Gate 4)'
    console.log(`\n  ${C.red('REFUSED')} by ${where}   ${C.dim(`${took}ms`)}`)
    console.log(C.dim(`  ${(res.reason ?? '').slice(0, 400)}`))
    process.exit(1)
  }
  if (!submit) {
    console.log(`\n  ${C.green('PERMITTED')} by every gate   ${C.dim(`${took}ms`)}`)
    console.log(
      C.dim('  Simulated against the real contracts. Nothing was sent. Add --submit to land it.')
    )
    return
  }
  const hash = res.got?.txHash ?? res.got?.hash
  console.log(`\n  ${C.green('SUBMITTED')} and confirmed   ${C.dim(`${took}ms`)}`)
  if (hash) {
    console.log(`  ${C.dim('tx'.padEnd(24, '.'))} ${C.bold(hash)}`)
    console.log(
      `  ${C.dim('explorer'.padEnd(24, '.'))} https://stellar.expert/explorer/testnet/tx/${hash}`
    )
  }
  const after = await readCall(s.sac, 'balance', [addr(custodyPk())], secrets().admin.publicKey())
  console.log(`  ${C.dim('custody balance now'.padEnd(24, '.'))} ${after ?? '?'}`)
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
  const who = signerFrom(flags)
  const amount = amountOf(flags)
  const venue = typeof flags.venue === 'string' ? flags.venue : POOL
  await preamble(s, 'Supply', [
    `${C.dim('amount'.padEnd(24, '.'))} ${amount}`,
    `${C.dim('venue'.padEnd(24, '.'))} ${venue}`,
    `${C.dim('path'.padEnd(24, '.'))} custody → gatekeeper → execution step → venue`,
    `${C.dim('attempted by'.padEnd(24, '.'))} ${who.label}  ${who.kp.publicKey()}`,
    `${C.dim('naming rule(s)'.padEnd(24, '.'))} ${rulesFor(flags, [s.rootRuleId, s.childRuleId]).join(', ')}`,
  ])
  if (flags['dry-run'] === true) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }
  await run(
    s,
    supplyBatch(s, amount, venue),
    rulesFor(flags, [s.rootRuleId, s.childRuleId]),
    'supply',
    flags.submit === true,
    who.kp
  )
}

export async function execWithdraw(flags: Flags): Promise<void> {
  const s = loadState()
  const who = signerFrom(flags)
  const amount = amountOf(flags)
  // `--to stranger` is a keyword for the funded address setup created, so a
  // live demo never has to paste a 56-character key.
  const rawTo = typeof flags.to === 'string' ? flags.to : custodyPk()
  const to = rawTo === 'stranger' ? s.stranger : rawTo === 'custody' ? custodyPk() : rawTo
  const venue = typeof flags.venue === 'string' ? flags.venue : POOL
  await preamble(s, 'Withdraw', [
    `${C.dim('amount'.padEnd(24, '.'))} ${amount}`,
    `${C.dim('to'.padEnd(24, '.'))} ${to}${to === custodyPk() ? C.dim('  (your account)') : C.amber('  (NOT your account)')}`,
    `${C.dim('venue'.padEnd(24, '.'))} ${venue}`,
    `${C.dim('attempted by'.padEnd(24, '.'))} ${who.label}  ${who.kp.publicKey()}`,
    `${C.dim('naming rule(s)'.padEnd(24, '.'))} ${rulesFor(flags, [s.withdrawRuleId, s.childRuleId]).join(', ')}`,
  ])
  if (flags['dry-run'] === true) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }
  await run(
    s,
    withdrawBatch(s, amount, to, venue),
    rulesFor(flags, [s.withdrawRuleId, s.childRuleId]),
    'withdraw',
    flags.submit === true,
    who.kp
  )
}
