// `prime rules` - Gate 4, the mandate.
//
// A rule says what a signer may do in a context. The demo installs three:
//
//   supply    the batch shape: pull from the gate, then supply into the venue,
//             with the two amounts tied together and a ceiling on the size
//   venue     the pool's own context, bound to the adapter as executor
//   withdraw  proceeds must return to the custody account
//
// Predicates are built here rather than accepted as raw bytes. A CLI that took
// an arbitrary predicate would be a foot-gun: an unsatisfiable one bricks the
// rule, and a vacuous one silently constrains nothing.

import { Address, scValToNative, xdr } from '@stellar/stellar-sdk'
import { writeFileSync } from 'node:fs'
import {
  C,
  POOL,
  STATE_PATH,
  type State,
  addRuleArgs,
  addr,
  and,
  asPrime,
  callArg,
  callArgLen,
  cmp,
  custodyPk,
  eq,
  i128v,
  invokeOp,
  loadState,
  path,
  readCall,
  secrets,
  selector,
  server,
  sym,
  u32v,
  vec,
} from './chain.ts'

type Flags = Record<string, string | boolean>

const need = (f: Flags, k: string): string => {
  const v = f[k]
  if (typeof v !== 'string' || !v) throw new Error(`--${k} is required`)
  return v
}

const asAddress = (v: string, what: string): string => {
  try {
    Address.fromString(v)
  } catch {
    throw new Error(`--${what} is not a Stellar address: ${v}`)
  }
  return v
}

function save(s: State): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`)
}

// ------------------------------------------------------------------- list ---

export async function rulesList(flags: Flags): Promise<void> {
  const s = loadState()
  const admin = secrets().admin.publicKey()
  const only = typeof flags.signer === 'string' ? asAddress(flags.signer, 'signer') : undefined
  const count = Number((await readCall(s.prime, 'get_context_rules_count', [], admin)) ?? 0)

  const rules: any[] = []
  for (let id = 0; id < count + 8 && rules.length < count; id++) {
    const r: any = await readCall(s.prime, 'get_context_rule', [u32v(id)], admin)
    if (!r) continue
    rules.push({
      id: Number(r.id),
      name: String(r.name ?? ''),
      context: r.context_type ? String(Object.values(r.context_type)[0] ?? r.context_type) : '',
      signers: (r.signers ?? []).map((x: any) => String(Array.isArray(x) ? x[1] : x)),
      policies: (r.policies ?? []).map((x: any) => String(x)),
      validUntil: r.valid_until ?? null,
    })
  }

  const shown = only ? rules.filter((r) => r.signers.includes(only)) : rules
  const unpoliced = shown.filter((r) => r.policies.length === 0)

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          account: s.prime,
          count,
          signer: only ?? null,
          matched: shown.length,
          // A signer is only as constrained as the loosest rule it sits on:
          // the caller picks which rule authorises a call.
          effectivelyUnconstrained: unpoliced.length > 0,
          rules: shown,
        },
        null,
        2,
      ),
    )
    return
  }

  if (only) {
    console.log(C.bold(`\nRules that ${only} can name`))
    console.log(C.dim(`  ${shown.length} of ${count} on ${s.prime}\n`))
    if (!shown.length) {
      console.log(C.dim('  none — this key cannot authorise anything on this account\n'))
      return
    }
  } else {
    console.log(C.bold(`\nRules on ${s.prime}`))
    console.log(C.dim(`  ${count} installed\n`))
  }
  for (const r of shown) {
    const policed = r.policies.length > 0
    console.log(
      `  ${C.bold(`#${r.id}`)} ${r.name || C.dim('(unnamed)')}  ${
        policed ? C.green('policed') : C.amber('NO POLICY — unrestricted')
      }`,
    )
    if (r.context) console.log(`      ${C.dim('context'.padEnd(10, '.'))} ${r.context}`)
    for (const sg of r.signers) console.log(`      ${C.dim('signer'.padEnd(10, '.'))} ${sg}`)
    for (const p of r.policies) console.log(`      ${C.dim('policy'.padEnd(10, '.'))} ${p}`)
  }
  if (only) {
    // The caller chooses which rule authorises a call, so the weakest rule a
    // key sits on is the one that decides what that key can really do.
    if (unpoliced.length) {
      console.log(
        `\n  ${C.amber('UNCONSTRAINED')}  this key sits on ${unpoliced.length} rule(s) with no policy ` +
          `(${unpoliced.map((r) => `#${r.id}`).join(', ')}).`,
      )
      console.log(
        C.dim(
          '  A caller names the rule that authorises a call, so this key can name one of\n' +
            '  those and the mandate never runs. Put a policed key on the policed rule and\n' +
            '  nowhere else.',
        ),
      )
    } else {
      console.log(
        `\n  ${C.green('CONSTRAINED')}  every rule this key can name carries a policy.`,
      )
    }
    return
  }

  console.log(
    C.dim(
      '\n  Rule 0 carries unpoliced, permanent authority. Whoever signs it can install\n' +
        '  any rule, so it belongs on a multi-signature account you control.\n' +
        '  See what one key can do:  prime rules list --signer G...',
    ),
  )
}

// ---------------------------------------------------------------- install ---

/** The supply batch: pull exactly what gets supplied, into one named venue,
 *  under a ceiling, with proceeds addressed to custody. */
function supplyPredicate(o: {
  gate: string
  adapter: string
  prime: string
  sac: string
  venue: string
  returnTo: string
  ceiling: bigint
}) {
  const PULL = [u32v(0), u32v(0), sym('args'), u32v(2)]
  const SUPPLY = [u32v(0), u32v(1), sym('args'), u32v(3), u32v(0), sym('amount')]
  return and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(2)),
    eq(callArgLen(1), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(o.gate)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('pull')),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(1)]), addr(o.adapter)),
    cmp('gt', path(PULL), i128v(0n)),
    cmp('lt', path(PULL), i128v(o.ceiling)),
    eq(path([u32v(0), u32v(1), sym('target')]), addr(o.venue)),
    eq(path([u32v(0), u32v(1), sym('function_name')]), sym('submit')),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(0)]), addr(o.prime)),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(2)]), addr(o.returnTo)),
    eq(path([u32v(0), u32v(1), sym('args'), u32v(3), xdr.ScVal.scvBool(true)]), u32v(1)),
    eq(path([...SUPPLY.slice(0, 5), sym('address')]), addr(o.sac)),
    eq(path([...SUPPLY.slice(0, 5), sym('request_type')]), u32v(0)),
    eq(path(PULL), path(SUPPLY)),
  ])
}

const withdrawPredicate = (o: { venue: string; to: string; prime: string }) =>
  and([
    eq(selector('call_fn'), sym('execute')),
    eq(callArgLen(0), u32v(1)),
    eq(callArgLen(1), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('target')]), addr(o.venue)),
    eq(path([u32v(0), u32v(0), sym('function_name')]), sym('submit')),
    // Pin `from` too: without it the rule permits a withdrawal against any
    // account's position, not just this Prime's.
    eq(path([u32v(0), u32v(0), sym('args'), u32v(0)]), addr(o.prime)),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(2)]), addr(o.to)),
    eq(path([u32v(0), u32v(0), sym('args'), u32v(3), u32v(0), sym('request_type')]), u32v(1)),
    eq(path([u32v(0), u32v(0), sym('executor_authorizations'), xdr.ScVal.scvBool(true)]), u32v(0)),
  ])

const venuePredicate = (o: { prime: string; adapter: string }) =>
  and([
    eq(selector('call_fn'), sym('submit')),
    eq(callArg(0), addr(o.prime)),
    eq(callArg(1), addr(o.adapter)),
  ])

type Kind = 'supply' | 'withdraw' | 'venue'

export async function rulesInstall(kind: string, flags: Flags): Promise<void> {
  if (kind !== 'supply' && kind !== 'withdraw' && kind !== 'venue') {
    throw new Error(`unknown rule "${kind}". Use: supply | withdraw | venue`)
  }
  const s = loadState()
  const sec = secrets()
  const dry = flags['dry-run'] === true
  const venue = flags.venue ? asAddress(String(flags.venue), 'venue') : POOL
  const name = typeof flags.name === 'string' ? flags.name : `${kind}`

  let predicate: xdr.ScVal
  let scope: string
  let signer: string
  const summary: string[] = []

  if (kind === 'supply') {
    const ceiling = BigInt(need(flags, 'max-per-move'))
    const returnTo = flags['return-to'] ? asAddress(String(flags['return-to']), 'return-to') : custodyPk()
    predicate = supplyPredicate({
      gate: s.gate,
      adapter: s.adapter,
      prime: s.prime,
      sac: s.sac,
      venue,
      returnTo,
      ceiling,
    })
    scope = s.adapter
    signer = sec.agent.publicKey()
    summary.push(
      `two calls: pull from ${s.gate}, then submit to ${venue}`,
      `amount strictly below ${ceiling}, and the amount pulled must equal the amount supplied`,
      `proceeds addressed to ${returnTo}`,
    )
  } else if (kind === 'withdraw') {
    const to = flags.to ? asAddress(String(flags.to), 'to') : custodyPk()
    predicate = withdrawPredicate({ venue, to, prime: s.prime })
    scope = s.adapter
    signer = sec.agent.publicKey()
    summary.push(`one call: submit to ${venue}`, `withdrawal, addressed to ${to}`, 'no executor authorizations')
  } else {
    predicate = venuePredicate({ prime: s.prime, adapter: s.adapter })
    scope = venue
    signer = s.adapter
    summary.push(`the venue's own context at ${venue}`, `signed by the adapter ${s.adapter}`)
  }

  console.log(C.bold(`\nRule: ${name}`))
  console.log(`  ${C.dim('scope'.padEnd(12, '.'))} ${scope}`)
  console.log(`  ${C.dim('signer'.padEnd(12, '.'))} ${signer}`)
  console.log(`  ${C.dim('interpreter'.padEnd(12, '.'))} ${s.interpreter}`)
  for (const l of summary) console.log(`  ${C.dim('pins'.padEnd(12, '.'))} ${l}`)
  console.log(`  ${C.dim('predicate'.padEnd(12, '.'))} ${predicate.toXDR().length} bytes`)

  if (dry) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }

  const res = await asPrime({
    kp: sec.admin,
    prime: s.prime,
    makeOp: (auth) =>
      invokeOp(
        s.prime,
        'add_context_rule',
        addRuleArgs({
          scope,
          name,
          signer,
          interpreter: s.interpreter,
          predicate,
          adminPk: sec.admin.publicKey(),
        }),
        auth,
      ),
    ruleIds: [0],
    label: `install ${kind} rule`,
    submit: true,
  })
  if (res.denied) throw new Error(`install was refused at the ${res.stage} stage:\n  ${res.reason}`)
  const id = Number(scValToNative(res.got!.returnValue!).id)
  console.log(`\n  installed as rule ${C.bold(`#${id}`)}`)

  if (kind === 'venue') {
    const bind = await asPrime({
      kp: sec.admin,
      prime: s.prime,
      makeOp: (auth) =>
        invokeOp(s.interpreter, 'bind_executor', [vec([addr(s.prime), u32v(id)]), addr(s.adapter)], auth),
      ruleIds: [0],
      label: 'bind executor',
      submit: true,
    })
    if (bind.denied) throw new Error(`bind_executor was refused: ${bind.reason}`)
    console.log(`  bound the adapter as its executor`)
    save({ ...s, childRuleId: id })
  } else if (kind === 'supply') {
    save({ ...s, rootRuleId: id })
  } else {
    save({ ...s, withdrawRuleId: id })
  }
  console.log(C.dim(`  updated ${STATE_PATH}`))
}

// ----------------------------------------------------------------- remove ---

export async function rulesRemove(flags: Flags): Promise<void> {
  const s = loadState()
  const sec = secrets()
  const id = Number(need(flags, 'id'))
  if (id === 0) throw new Error('rule 0 is the account\'s own recovery rule and cannot be removed here')

  console.log(C.bold(`\nRemove rule #${id}`))
  const r: any = await readCall(s.prime, 'get_context_rule', [u32v(id)], sec.admin.publicKey())
  if (!r) throw new Error(`no rule #${id} on ${s.prime}`)
  console.log(`  ${C.dim('name'.padEnd(10, '.'))} ${String(r.name ?? '')}`)
  console.log(`  ${C.dim('signers'.padEnd(10, '.'))} ${(r.signers ?? []).length}`)

  if (flags['dry-run'] === true) {
    console.log(`\n  ${C.amber('DRY RUN')}  nothing was sent to the network`)
    return
  }
  const res = await asPrime({
    kp: sec.admin,
    prime: s.prime,
    makeOp: (auth) => invokeOp(s.prime, 'remove_context_rule', [u32v(id)], auth),
    ruleIds: [0],
    label: `remove rule ${id}`,
    submit: true,
  })
  if (res.denied) throw new Error(`remove was refused at the ${res.stage} stage:\n  ${res.reason}`)
  console.log(C.green(`\n  rule #${id} removed`))
}
