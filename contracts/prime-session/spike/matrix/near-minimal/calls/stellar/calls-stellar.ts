// Contract calls through a session key on Stellar testnet: an OZ smart account (weighted 2-of-3 seats), the round-9 prime-session
// contract as the only signer of a session rule, and the policy-interpreter as that rule's policy. The rule scopes the session
// to one test contract (venue) and puts an argument predicate on it:
//   deposit(from, amount, on_behalf_of): from == the account, 1 <= amount <= CAP, on_behalf_of == the account
//   submit(from, spender, to, requests):  a Blend-shaped call: from, spender and to all == the account, exactly one request,
//     its token == XLM, its amount <= CAP, its request_type in {0, 1, 2, 3}
// The venue moves no token: it keeps a ledger, so a call is proven by its effect on state. A second deployment of the same
// wasm stands in for "another contract". Owners sign natively with local ed25519 keys (Freighter-style signAuthEntry for the
// grant, key signatures for seat votes): no NEAR. Every refusal is matched to a contract error code, and a control shows the
// seats (2-of-3, rule 0) can make the same call.
import { Sdk, XLM, PASS, friendbot, invokeAs, localSigner, accountSig, signaturePayload, nonce, log, server, submit } from '/home/ubuntu/work/near-session-spike/stellar.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const S_ = Sdk.xdr.ScVal, xdr = Sdk.xdr;
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const HERE = '/home/ubuntu/work/calls-spike/stellar';
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
const CAP = 1000n;
const FILE = process.env.CALLS_STATE ?? `${HERE}/state-calls-stellar.json`;
const st: Record<string, any> = {};
const results: any[] = [];
const save = () => writeFileSync(FILE, JSON.stringify({ ...st, results }, null, 1));
const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: Sdk.xdr.ScVal[]) => S_.scvVec(x);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const i128 = (n: bigint) => Sdk.nativeToScVal(n, { type: 'i128' });
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const map = (e: [Sdk.xdr.ScVal, Sdk.xdr.ScVal][]) => S_.scvMap(e.map(([k, v]) => new Sdk.xdr.ScMapEntry({ key: k, val: v }))
  .sort((l, r) => (l.key().switch().name === 'scvSymbol' && r.key().switch().name === 'scvSymbol') ? Buffer.compare(Buffer.from(l.key().sym()), Buffer.from(r.key().sym())) : Buffer.compare(l.key().toXDR(), r.key().toXDR())));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 200);
const now = async () => (await server.getLatestLedger()).sequence;

function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  log(pass ? 'PASS' : 'FAIL', name, ok ? `ok ${detail}` : `refused: ${detail}`);
  return pass;
}

// ── Keys: a relayer and three seats (the first is the Freighter-style key that also owns the session contract) ───────
const relayer = Sdk.Keypair.random(), seats = [Sdk.Keypair.random(), Sdk.Keypair.random(), Sdk.Keypair.random()];
const [F, B, C] = seats;
for (const k of [relayer, ...seats]) await friendbot(k.publicKey());
log('relayer', relayer.publicKey(), 'seats', seats.map((k) => k.publicKey()).join(' '));
const seat = (k: Sdk.Keypair) => localSigner(k);

// ── Deploy: venue x2, prime-session (owner F), the Prime Account ───────────────────────────────────────────────────
const upload = async (file: string) => { const { ret } = await submit(relayer, Sdk.Operation.uploadContractWasm({ wasm: readFileSync(file) })); return Buffer.from(ret!.bytes()); };
const create = async (wasm: Buffer, args: Sdk.xdr.ScVal[]) => { const { ret } = await submit(relayer, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(relayer.publicKey()), wasmHash: wasm, constructorArgs: args, salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) })); return Sdk.Address.fromScVal(ret!).toString(); };
const venueWasm = await upload(`${HERE}/venue/target/wasm32v1-none/release/calls_venue.wasm`), psWasm = await upload(`${HERE}/prime_session.r9.wasm`);
st.venue = await create(venueWasm, []); st.venue2 = await create(venueWasm, []); st.S = await create(psWasm, [addr(F.publicKey())]);
const weights = map([[sym('signer_weights'), map(seats.map((k) => [delegated(k.publicKey()), u32(1)] as [Sdk.xdr.ScVal, Sdk.xdr.ScVal]))], [sym('threshold'), u32(2)]]);
st.prime = await create(Buffer.from(ACCOUNT_WASM_HASH, 'hex'), [vec(seats.map((k) => delegated(k.publicKey()))), map([[addr(WEIGHTED), weights]])]);
st.venueWasm = venueWasm.toString('hex'); st.psWasm = psWasm.toString('hex'); save();
log('venue', st.venue, 'venue2', st.venue2, 'prime-session', st.S, 'Prime Account', st.prime);

const call = (fn: string, ...a: Sdk.xdr.ScVal[]) => new Sdk.Contract(st.prime).call(fn, ...a);
const sim = async (op: Sdk.xdr.Operation) => (await server.simulateTransaction(new Sdk.TransactionBuilder(await server.getAccount(relayer.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(op).setTimeout(30).build())) as any;
const view = async (contract: string, fn: string, ...a: Sdk.xdr.ScVal[]) => Sdk.scValToNative((await sim(new Sdk.Contract(contract).call(fn, ...a))).result.retval);
async function ruleId(name: string) { const n = Number(await view(st.prime, 'get_context_rules_count')); for (let i = 0; i < n + 10; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === name) return i; } return -1; }
const deposits = async (venue: string, of: string) => BigInt(await view(venue, 'deposits', addr(of)));
const kindTotal = async (kind: number) => BigInt(await view(st.venue, 'kind_total', u32(kind)));
const callsOf = async (venue: string) => Number(await view(venue, 'calls'));
const snapFull = async () => { const k: bigint[] = []; for (const i of [0, 1, 2, 3, 4, 5]) k.push(await kindTotal(i)); return `${await callsOf(st.venue)}|${await callsOf(st.venue2)}|${await deposits(st.venue, st.prime)}|${k.join(',')}`; };

// ── Calls ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const venueCall = (venue: string, fn: string, ...a: Sdk.xdr.ScVal[]) => new Sdk.Contract(venue).call(fn, ...a);
const depositOp = (amount: bigint, o: { venue?: string; from?: string; who?: string } = {}) => venueCall(o.venue ?? st.venue, 'deposit', addr(o.from ?? st.prime), i128(amount), addr(o.who ?? st.prime));
const withdrawOp = (amount: bigint, o: { venue?: string } = {}) => venueCall(o.venue ?? st.venue, 'withdraw', addr(st.prime), i128(amount), addr(st.prime));
const request = (r: { address?: string; amount: bigint; type: number }) => map([[sym('address'), addr(r.address ?? XLM)], [sym('amount'), i128(r.amount)], [sym('request_type'), u32(r.type)]]);
const submitOp = (reqs: { address?: string; amount: bigint; type: number }[], o: { spender?: string; to?: string; venue?: string } = {}) =>
  venueCall(o.venue ?? st.venue, 'submit', addr(st.prime), addr(o.spender ?? st.prime), addr(o.to ?? st.prime), vec(reqs.map(request)));

// ── Predicate and rule ─────────────────────────────────────────────────────────────────────────────────────────────
const lit = (a: string) => ({ kind: 'literal_address' as const, value: a });
const fnIs = (n: string) => ({ op: 'eq' as const, left: { kind: 'call_fn' as const }, right: { kind: 'literal_symbol' as const, value: n } });
const argIs = (i: number, a: string) => ({ op: 'eq' as const, left: { kind: 'call_arg' as const, index: i }, right: lit(a) });
const field = (f: string) => ({ kind: 'call_arg_field' as const, index: 3, element: 0, field: f });
const i = (v: bigint) => ({ kind: 'literal_i128' as const, value: v.toString() });
const predicate = () => encodePredicate({ op: 'or', children: [
  { op: 'and', children: [fnIs('deposit'), argIs(0, st.prime), argIs(2, st.prime),
    { op: 'gte', left: { kind: 'call_arg', index: 1 }, right: i(1n) }, { op: 'lte', left: { kind: 'call_arg', index: 1 }, right: i(CAP) }] },
  { op: 'and', children: [fnIs('submit'), argIs(0, st.prime), argIs(1, st.prime), argIs(2, st.prime),
    { op: 'eq', left: { kind: 'call_arg_len', index: 3 }, right: { kind: 'literal_u32', value: 1 } },
    { op: 'eq', left: field('address'), right: lit(XLM) },
    { op: 'gte', left: field('amount'), right: i(1n) }, { op: 'lte', left: field('amount'), right: i(CAP) },
    { op: 'in', needle: field('request_type'), haystack: [0, 1, 2, 3].map((value) => ({ kind: 'literal_u32' as const, value })) }] },
] } as any) as { encodedPredicate: string; predicateHash: string };
function sessionRule(name: string) {
  const p = predicate(); st.predicateHash = p.predicateHash; st.predicateBytes = Buffer.from(p.encodedPredicate, 'base64').length;
  return buildAddContextRuleArgs({ contextRuleType: { kind: 'call_contract', contract: st.venue }, name, validUntilLedger: null, signers: [{ kind: 'delegated', address: st.S }], policies: [] },
    { signers: [{ kind: 'delegated', address: st.S }], policies: [{ kind: 'interpreter', interpreterAddress: INTERPRETER, predicateBlobBase64: p.encodedPredicate }], installNonce: 1, encodedPredicate: p.encodedPredicate, predicateHash: p.predicateHash })
    .map((v: any) => Sdk.xdr.ScVal.fromXDR(v.toXDR('base64'), 'base64'));
}

// ── Running one call ───────────────────────────────────────────────────────────────────────────────────────────────
type Signer = { address: string; signNested: (p: Buffer) => Promise<Sdk.xdr.ScVal> };
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: Signer[], want?: RegExp) {
  let r: any;
  try { r = await invokeAs({ feePayer: relayer, op, account: st.prime, ruleIds, signers }); } catch (e: any) { r = { ok: false, error: String(e?.message ?? e).slice(0, 300), ms: 0 }; }
  const pass = record(name, expectOk, r.ok, r.ok ? `${r.ms} ms ${r.hash}` : short(r.error), want);
  return { pass, ...r };
}
const proofSigner = (kp: Sdk.Keypair): Signer => ({ address: st.S, signNested: async (p) => vec([S_.scvBytes(kp.rawPublicKey()), S_.scvBytes(kp.sign(p))]) });
const POLICY = /Error\(Contract, #10[0-5]\)/;
/** One move by a session: expectOk, or refused with `want`; a refused move must leave the venue ledger untouched. */
async function move(name: string, expectOk: boolean, kp: Sdk.Keypair, rule: number, op: Sdk.xdr.Operation, want?: RegExp) {
  const before = await snapFull();
  const r = await run(name, expectOk, op, [rule], [proofSigner(kp)], want);
  if (!expectOk) record(`   ${name.split(' ')[0]} venue ledgers unchanged by the refused call`, true, before === await snapFull(), await snapFull());
  return r;
}
/** The same call made by two seats under rule 0 (no policy): it must succeed, so only the session rule refuses it. */
const control = (name: string, op: Sdk.xdr.Operation) => run(name, true, op, [0], [seat(F!), seat(B!)]);

// ── Grants (the owner's Soroban authorization entry for grant(key, until)) ────────────────────────────────────────────
async function authorize(S: string, key: Buffer, until: number, owner = F!): Promise<Sdk.xdr.SorobanAuthorizationEntry> {
  const n = new xdr.Int64(nonce()), exp = (await now()) + 60;
  const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(S).toScAddress(), functionName: 'grant', args: [S_.scvBytes(key), u32(until)] })), subInvocations: [] });
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
    address: new Sdk.Address(owner.publicKey()).toScAddress(), nonce: n, signatureExpirationLedger: exp, signature: accountSig(owner.rawPublicKey(), owner.sign(signaturePayload(n, exp, root))) })), rootInvocation: root });
}
async function sendGrant(name: string, expectOk: boolean, key: Buffer, until: number, entries: Sdk.xdr.SorobanAuthorizationEntry[]) {
  const fn = new Sdk.Contract(st.S).call('grant', S_.scvBytes(key), u32(until));
  const op = Sdk.Operation.invokeHostFunction({ func: fn.body().invokeHostFunctionOp().hostFunction(), auth: entries });
  const tx = new Sdk.TransactionBuilder(await server.getAccount(relayer.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const s = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(s)) return record(name, expectOk, false, short(s.error));
  const ready = Sdk.rpc.assembleTransaction(tx, s).build(); ready.sign(relayer);
  const sent = await server.sendTransaction(ready);
  if (sent.status === 'ERROR') return record(name, expectOk, false, short(JSON.stringify(sent.errorResult)));
  for (let k = 0; k < 40; k++) { const r = await server.getTransaction(sent.hash); if (r.status !== 'NOT_FOUND') return record(name, expectOk, r.status === 'SUCCESS', r.status === 'SUCCESS' ? sent.hash : r.status); await new Promise((res) => setTimeout(res, 1000)); }
  return record(name, expectOk, false, 'timeout');
}
async function session(name: string): Promise<Sdk.Keypair> {
  const kp = Sdk.Keypair.random(), until = (await now()) + 720;
  await sendGrant(name, true, kp.rawPublicKey(), until, [await authorize(st.S, kp.rawPublicKey(), until)]);
  return kp;
}

// ── Setup checks ───────────────────────────────────────────────────────────────────────────────────────────────────
{ const r0: any = Sdk.scValToNative((await sim(call('get_context_rule', u32(0)))).result.retval);
  const signers = JSON.stringify(r0.signers);
  record('P0. rule 0 signers are exactly the three seat keys (no prime-session)', true, seats.every((k) => signers.includes(k.publicKey())) && !signers.includes(st.S) && r0.signers.length === 3, `${r0.signers.length} signers`); }
{ const v = Number(await view(INTERPRETER, 'grammar_version')); st.grammarVersion = v; record('P1. the testnet policy-interpreter speaks a grammar version', true, v > 0, `grammar ${v}`); }
await run('P2. two seats (F + B) install the session rule: CallContract(venue), signer prime-session, interpreter predicate', true, call('add_context_rule', ...sessionRule('venue_calls')), [0], [seat(F!), seat(B!)]);
st.rule = await ruleId('venue_calls'); save();
{ const r: any = Sdk.scValToNative((await sim(call('get_context_rule', u32(st.rule)))).result.retval); const j = JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  record('P3. the session rule exists, scoped to the venue, with prime-session as its only signer and the interpreter as its policy', true, j.includes(st.venue) && j.includes(st.S) && j.includes(INTERPRETER) && r.signers.length === 1 && r.policies.length === 1, `rule ${st.rule}, predicate ${st.predicateBytes} bytes, hash ${st.predicateHash?.slice(0, 12)}`); }

const K = await session('G0. owner F signs one grant authorization (signAuthEntry-style); relayer submits grant(key, until)');
st.sessionKey = K.publicKey(); save();
const R = st.rule as number;
const OK = true;

// ── D. deposit(from, amount, on_behalf_of) ─────────────────────────────────────────────────────────────────────────
log('--- deposit: from == account, 1 <= amount <= 1000, on_behalf_of == account');
await move('D1. allowed: deposit(account, 100, account)', OK, K, R, depositOp(100n));
record('D2. the venue shows 100 for the account, one call, authorized by the account (last = the account, not the session key or prime-session)', true,
  (await deposits(st.venue, st.prime)) === 100n && (await callsOf(st.venue)) === 1 && (await view(st.venue, 'last')) === st.prime, `deposits ${await deposits(st.venue, st.prime)}, calls ${await callsOf(st.venue)}, last ${String(await view(st.venue, 'last')).slice(0, 6)}`);
await move(`D3. boundary: amount equal to the cap (${CAP})`, OK, K, R, depositOp(CAP));
await move('D4. boundary: amount 1 (lower bound)', OK, K, R, depositOp(1n));
await move(`D5. amount over the cap (${CAP + 1n})`, false, K, R, depositOp(CAP + 1n), POLICY);
await move('D6. amount 2^100', false, K, R, depositOp(1n << 100n), POLICY);
await move('D7. amount 0', false, K, R, depositOp(0n), POLICY);
await move('D8. negative amount -5 (it would pass an upper bound alone)', false, K, R, depositOp(-5n), POLICY);
await move('D9. different on_behalf_of (a stranger)', false, K, R, depositOp(100n, { who: seats[2]!.publicKey() }), POLICY);
await move("D10. on_behalf_of is the session key's own G address", false, K, R, depositOp(100n, { who: K.publicKey() }), POLICY);
await move('D11. another function on the same venue: withdraw(account, 1, account)', false, K, R, withdrawOp(1n), POLICY);
await move('D12. the allowed deposit on another contract (a second venue deployment)', false, K, R, depositOp(100n, { venue: st.venue2 }));

// ── S. submit(from, spender, to, requests): the Blend-shaped call ──────────────────────────────────────────────────────
log('--- submit: from, spender, to == account; one request; token == XLM, amount <= 1000, request_type in {0,1,2,3}');
await move('S1. allowed: submit with one request, type 0 (supply), 50', OK, K, R, submitOp([{ amount: 50n, type: 0 }]));
record('S2. the venue shows 50 in kind 0 and no other kind', true, (await kindTotal(0)) === 50n && (await kindTotal(1)) === 0n && (await kindTotal(4)) === 0n, `kind0 ${await kindTotal(0)}`);
for (const t of [1, 2, 3]) await move(`S3-${t}. allowed: request type ${t}`, OK, K, R, submitOp([{ amount: 10n, type: t }]));
await move('S4. request type 4', false, K, R, submitOp([{ amount: 10n, type: 4 }]), POLICY);
await move('S5. request type 5', false, K, R, submitOp([{ amount: 10n, type: 5 }]), POLICY);
await move('S6. two requests in one submit (types 0 and 0)', false, K, R, submitOp([{ amount: 10n, type: 0 }, { amount: 10n, type: 0 }]), POLICY);
await move('S7. no request (an empty vector)', false, K, R, submitOp([]), POLICY);
await move(`S8. request amount over the cap (${CAP + 1n})`, false, K, R, submitOp([{ amount: CAP + 1n, type: 0 }]), POLICY);
await move('S9. request token is another address (the venue itself)', false, K, R, submitOp([{ address: st.venue, amount: 10n, type: 0 }]), POLICY);
await move('S10. spender is another address', false, K, R, submitOp([{ amount: 10n, type: 0 }], { spender: seats[2]!.publicKey() }), POLICY);
await move('S11. to is another address', false, K, R, submitOp([{ amount: 10n, type: 0 }], { to: seats[2]!.publicKey() }), POLICY);
await move('S12. the allowed submit on another contract (a second venue deployment)', false, K, R, submitOp([{ amount: 10n, type: 0 }], { venue: st.venue2 }));

// ── X. The session cannot do what its rule does not name ─────────────────────────────────────────────────────────────────
log('--- scope');
await run('X1. the session proof presented for rule 0 (the seats rule)', false, depositOp(10n), [0], [proofSigner(K)]);
await run("X2. a stranger's key signs the session proof (not granted)", false, depositOp(10n), [R], [proofSigner(Sdk.Keypair.random())]);
await run('X3. the session removes rule 0 through its own rule', false, call('remove_context_rule', u32(0)), [R], [proofSigner(K)]);
await run('X4. the session adds a rule through its own rule', false, call('add_context_rule', ...sessionRule('evil')), [R], [proofSigner(K)]);

// ── C. Controls: the seats can make each refused call, so the session rule is what refused it ───────────────────────────────
log('--- controls: the same calls made by two seats under rule 0 (no policy)');
{ const t0 = await snapFull();
  await control('C1. two seats: deposit over the cap', depositOp(CAP + 1n));
  await control('C2. two seats: deposit for a stranger', depositOp(100n, { who: seats[2]!.publicKey() }));
  await control('C3. two seats: withdraw', withdrawOp(1n));
  await control('C4. two seats: deposit on the second venue', depositOp(100n, { venue: st.venue2 }));
  await control('C5. two seats: submit with request type 4', submitOp([{ amount: 10n, type: 4 }]));
  await control('C6. two seats: submit with two requests', submitOp([{ amount: 10n, type: 0 }, { amount: 10n, type: 0 }]));
  await control('C7. two seats: negative deposit', depositOp(-5n));
  record('C8. the controls changed the ledgers as asked (venue 1 and 2 both saw calls)', true, (await snapFull()) !== t0 && (await callsOf(st.venue2)) === 1, `${t0} -> ${await snapFull()}`); }

// ── R. Revoke and end apply to contract calls too ───────────────────────────────────────────────────────────────────────
log('--- revoke');
{ const k2 = await session('R1. a second session');
  await move('R2. the second session makes the allowed deposit(account, 5, account)', OK, k2, R, depositOp(5n));
  await sendGrant('R3. the owner revokes it: grant(key, 0), one authorization', true, k2.rawPublicKey(), 0, [await authorize(st.S, k2.rawPublicKey(), 0)]);
  await move('R4. the revoked session makes the same allowed deposit', false, k2, R, depositOp(5n));
  await move('R5. the first session still works', OK, K, R, depositOp(5n)); }

const pass = results.filter((r) => r.pass).length;
log(`${pass}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) log('FAIL', r.name, r.detail);
process.exit(0);
