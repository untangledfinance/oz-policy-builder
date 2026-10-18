// Simple 2-of-3 Prime Account: A = EVM wallet (MetaMask), B and C = Stellar wallets.
//   rule 0 (every call):  signers S (A's session-signer), B, C;  weighted_threshold {S:1,B:1,C:1} >= 2
//   session rules (one contract each): signer S;  policy-interpreter predicate
// A votes only through S: a session = fresh ed25519 key + ONE MetaMask EIP-712 grant.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sha256 as vsha, toBytes, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Sdk, XLM, friendbot, invokeAs, keypair, localSigner, log, server, submit } from './stellar.ts';
import { DOMAIN, TYPES } from './eip712.ts';
import { metamask } from './mm.ts';
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const S_ = Sdk.xdr.ScVal;
const SS_WASM = Buffer.from('2a490349074953de6c78d9852f618b3ea7b8f832a2a50b7834f592d317fdcbb7', 'hex'); // session-signer v2 (uploaded)
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5'; // grammar 4, pinned by the app
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF';
const FILE = 'state-simple.json';
const st: Record<string, any> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const save = (p: Record<string, unknown>) => { Object.assign(st, p); writeFileSync(FILE, JSON.stringify(st, null, 1)); };
const fee = keypair('secrets/fee-payer.json');               // the app's relayer: pays fees, signs nothing that matters
const kB = keypair('secrets/simple-b.json'), kC = keypair('secrets/simple-c.json'); // B and C: Stellar wallets (Freighter stand-ins)
const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: Sdk.xdr.ScVal[]) => S_.scvVec(x);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const map = (e: [Sdk.xdr.ScVal, Sdk.xdr.ScVal][]) => S_.scvMap(e.map(([k, v]) => new Sdk.xdr.ScMapEntry({ key: k, val: v }))
  .sort((l, r) => (l.key().switch().name === 'scvSymbol' && r.key().switch().name === 'scvSymbol') ? Buffer.compare(Buffer.from(l.key().sym()), Buffer.from(r.key().sym())) : Buffer.compare(l.key().toXDR(), r.key().toXDR())));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 200);
const now = async () => (await server.getLatestLedger()).sequence;

/** A starts a session: fresh key + one MetaMask signature. No transaction. */
async function session(ledgers = 720, wallet = metamask) {
  const kp = Sdk.Keypair.random(), until = (await now()) + ledgers;
  const g = await wallet.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message: { signer: st.S, sessionKey: toHex(kp.rawPublicKey()), validUntil: until, network: vsha(toBytes(Sdk.Networks.TESTNET)) } });
  const rs = Buffer.from(g.slice(2, 130), 'hex'), v = parseInt(g.slice(130, 132), 16);
  return { kp, until, rs, v, signer: { address: st.S as string, signNested: async (p: Buffer) => vec([S_.scvBytes(kp.rawPublicKey()), u32(until), S_.scvBytes(rs), u32(v), S_.scvBytes(kp.sign(p))]) } };
}
const B = localSigner(kB), C = localSigner(kC);
const results: Record<string, unknown> = { ...(st.results ?? {}) };
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: any[]) {
  const r = await invokeAs({ feePayer: fee, op, account: st.prime, ruleIds, signers });
  const pass = r.ok === expectOk;
  results[name] = { pass, ok: r.ok, ms: r.ms, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}` : `refused: ${short(r.error)}`);
  save({ results });
  return r;
}
const call = (fn: string, ...a: Sdk.xdr.ScVal[]) => new Sdk.Contract(st.prime).call(fn, ...a);
const sim = async (op: Sdk.xdr.Operation) => (await server.simulateTransaction(new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(op).setTimeout(30).build())) as any;
async function ruleId(name: string) { const n = Number(Sdk.scValToNative((await sim(call('get_context_rules_count'))).result.retval)); for (let i = 0; i < n + 10; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === name) return i; } return -1; }
function sessionRule(name: string, contract: string, predicate: unknown) {
  const p: any = encodePredicate(predicate);
  return buildAddContextRuleArgs({ contextRuleType: { kind: 'call_contract', contract }, name, validUntilLedger: null, signers: [{ kind: 'delegated', address: st.S }], policies: [] },
    { signers: [{ kind: 'delegated', address: st.S }], policies: [{ kind: 'interpreter', interpreterAddress: INTERPRETER, predicateBlobBase64: p.encodedPredicate }], installNonce: 1, encodedPredicate: p.encodedPredicate, predicateHash: p.predicateHash })
    .map((v: any) => Sdk.xdr.ScVal.fromXDR(v.toXDR('base64'), 'base64'));
}
const lit = (a: string) => ({ kind: 'literal_address', value: a });
const req = (type: number, stroops: bigint) => map([[sym('address'), addr(XLM)], [sym('amount'), Sdk.nativeToScVal(stroops, { type: 'i128' })], [sym('request_type'), u32(type)]]);
const submitOp = (reqs: Sdk.xdr.ScVal[], to?: string) => new Sdk.Contract(POOL).call('submit', addr(st.prime), addr(st.prime), addr(to ?? st.prime), vec(reqs));
const part = process.argv[2];

if (part === 'onboard') {
  // Step 1 - A connects MetaMask. The app deploys A's session-signer (owner = A's address). No signature from anyone.
  await friendbot(fee.publicKey()); await friendbot(kB.publicKey()); await friendbot(kC.publicKey());
  if (!st.S) {
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: SS_WASM, constructorArgs: [S_.scvBytes(Buffer.from(metamask.address.slice(2), 'hex'))] }));
    save({ S: Sdk.Address.fromScVal(ret!).toString(), sTx: hash, A: metamask.address, B: kB.publicKey(), C: kC.publicKey() });
    log('1. A\'s session-signer', st.S, hash);
  }
  // Step 2 - the app creates the Prime Account: rule 0 = S, B, C with weighted_threshold 1/1/1 >= 2.
  if (!st.prime) {
    const weights = map([[sym('signer_weights'), map([[delegated(st.S), u32(1)], [delegated(st.B), u32(1)], [delegated(st.C), u32(1)]])], [sym('threshold'), u32(2)]]);
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec([st.S, st.B, st.C].map(delegated)), map([[addr(WEIGHTED), weights]])] }));
    save({ prime: Sdk.Address.fromScVal(ret!).toString(), primeTx: hash });
    log('2. Prime Account', st.prime, hash);
  }
  if (!st.funded) {
    const { hash } = await submit(fee, new Sdk.Contract(XLM).call('transfer', addr(fee.publicKey()), addr(st.prime), Sdk.nativeToScVal(500_000_000n, { type: 'i128' })));
    save({ funded: hash }); log('3. funded with 50 XLM', hash);
  }
}
if (part === 'rules') {
  // Step 4 - A starts a session (one MetaMask signature) and B co-signs each rule install (one Freighter prompt each).
  const s = await session();
  log(`A's session: one MetaMask signature, valid until ledger ${s.until}`);
  if ((await ruleId('session_blend')) < 0) await run('R1. S+B install session_blend (Blend submit: this account only, kinds 0-3)', true, call('add_context_rule', ...sessionRule('session_blend', POOL, { op: 'and', children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'submit' } },
    { op: 'eq', left: { kind: 'call_arg', index: 0 }, right: lit(st.prime) }, { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: lit(st.prime) },
    { op: 'eq', left: { kind: 'call_arg', index: 2 }, right: lit(st.prime) }, { op: 'eq', left: { kind: 'call_arg_len', index: 3 }, right: { kind: 'literal_u32', value: 1 } },
    { op: 'in', needle: { kind: 'call_arg_field', index: 3, element: 0, field: 'request_type' }, haystack: [0, 1, 2, 3].map((value) => ({ kind: 'literal_u32', value })) } ] })), [0], [s.signer, B]);
  if ((await ruleId('session_xlm')) < 0) await run('R2. S+B install session_xlm (XLM transfer to the pool only)', true, call('add_context_rule', ...sessionRule('session_xlm', XLM, { op: 'and', children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } }, { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: lit(POOL) } ] })), [0], [s.signer, B]);
  save({ blendRule: await ruleId('session_blend'), xlmRule: await ruleId('session_xlm') });
  log('rules', st.blendRule, st.xlmRule);
}
if (part === 'use') {
  const s = await session();
  await run('U1. session alone: supply 5 XLM to Blend', true, submitOp([req(0, 50_000_000n)]), [st.blendRule, st.xlmRule], [s.signer]);
  await run('U2. session alone: withdraw 2 XLM', true, submitOp([req(1, 20_000_000n)]), [st.blendRule], [s.signer]);
  await run('U3. session alone: supply collateral 3 XLM (Blend kind 2, inside the policy)', true, submitOp([req(2, 30_000_000n)]), [st.blendRule, st.xlmRule], [s.signer]).then(() => {});
  await run('U4. session alone: XLM to an outside address', false, new Sdk.Contract(XLM).call('transfer', addr(st.prime), addr(fee.publicKey()), Sdk.nativeToScVal(10_000_000n, { type: 'i128' })), [st.xlmRule], [s.signer]);
}
if (part === 'borrow') {
  const s = await session();
  await run('U3b. session alone: borrow 0.5 XLM against collateral (Blend accepts, policy refuses)', false, submitOp([req(4, 5_000_000n)]), [st.blendRule], [s.signer]);
}
if (part === 'admin') {
  const s = await session();
  const tmp = (name: string) => call('add_context_rule', vec([sym('CallContract'), addr(POOL)]), S_.scvString(name), S_.scvVoid(), vec([delegated(st.S)]), S_.scvMap([]));
  await run('M1. session alone adds a rule (rule 0)', false, tmp('t1'), [0], [s.signer]);
  await run('M2. B alone adds a rule', false, tmp('t1'), [0], [B]);
  await run('M3. session + C add a rule', true, tmp('t_sc'), [0], [s.signer, C]);
  await run('M4. session + B remove it', true, call('remove_context_rule', u32(await ruleId('t_sc'))), [0], [s.signer, B]);
  await run('M5. a session rule cannot change the account (session_blend for add_context_rule)', false, tmp('t2'), [st.blendRule], [s.signer]);
  const stranger = await session(720, privateKeyToAccount(generatePrivateKey()));
  await run('M6. a session granted by another wallet + B', false, tmp('t3'), [0], [stranger.signer, B]);
}
if (part === 'expire') {
  const s = await session(3);
  log('short session until', s.until);
  while ((await now()) <= s.until + 1) await new Promise((r) => setTimeout(r, 2000));
  await run('M7. expired session + B', false, call('add_context_rule', vec([sym('CallContract'), addr(POOL)]), S_.scvString('t4'), S_.scvVoid(), vec([delegated(st.S)]), S_.scvMap([])), [0], [s.signer, B]);
}
if (part === 'revoke') {
  const s = await session();
  const g = await metamask.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message: { signer: st.S, sessionKey: toHex(s.kp.rawPublicKey()), validUntil: 0, network: vsha(toBytes(Sdk.Networks.TESTNET)) } });
  const rv = await submit(fee, new Sdk.Contract(st.S).call('revoke', S_.scvBytes(s.kp.rawPublicKey()), S_.scvBytes(Buffer.from(g.slice(2, 130), 'hex')), u32(parseInt(g.slice(130, 132), 16))));
  log('A revoked the session (one MetaMask signature + relayed tx)', rv.hash); results['M8a. A revokes a session'] = { pass: true, hash: rv.hash };
  await run('M8. revoked session + B', false, call('add_context_rule', vec([sym('CallContract'), addr(POOL)]), S_.scvString('t5'), S_.scvVoid(), vec([delegated(st.S)]), S_.scvMap([])), [0], [s.signer, B]);
  await run('M8b. revoked session alone: supply', false, submitOp([req(0, 10_000_000n)]), [st.blendRule, st.xlmRule], [s.signer]);
}
if (part === 'team') {
  // Rule 0 changes are ordinary 2-of-3 decisions: here the owner (session) + B replace C with D, then B + D restore C.
  const kD = keypair('secrets/simple-d.json'); await friendbot(kD.publicKey());
  const s = await session();
  const r0 = Sdk.scValToNative((await sim(call('get_context_rule', u32(0)))).result.retval) as any;
  const cId = Number(Sdk.scValToNative((await sim(call('get_signer_id', delegated(st.C)))).result.retval));
  await run('T1. session + B add D to rule 0', true, call('add_signer', u32(0), delegated(kD.publicKey())), [0], [s.signer, B]);
  await run('T2. session + B remove C from rule 0', true, call('remove_signer', u32(0), u32(cId)), [0], [s.signer, B]);
  await run('T3. C can no longer approve (C + B)', false, call('add_signer', u32(0), delegated(st.C)), [0], [C, B]);
  await run('T4. B + D add C back', true, call('add_signer', u32(0), delegated(st.C)), [0], [B, localSigner(kD)]);
  const dId = Number(Sdk.scValToNative((await sim(call('get_signer_id', delegated(kD.publicKey())))).result.retval));
  await run('T5. session + C remove D', true, call('remove_signer', u32(0), u32(dId)), [0], [s.signer, C]);
}
if (part === 'team2') {
  // A new rule-0 signer counts only after its weight is set on the weighted_threshold policy (a second 2-of-3 call).
  const kD = keypair('secrets/simple-d.json'), D = localSigner(kD);
  const s = await session();
  const rule0 = async () => (await sim(call('get_context_rule', u32(0)))).result.retval as Sdk.xdr.ScVal;
  // Through the account's own execute(): a policy cannot be re-entered while it is checking auth.
  const weight = async (who: string, w: number) => call('execute', addr(WEIGHTED), sym('set_signer_weight'), vec([delegated(who), u32(w), await rule0(), addr(st.prime)]));
  await run('T4a. session + B set D weight 1', true, await weight(kD.publicKey(), 1), [0], [s.signer, B]);
  await run('T4. B + D add C back', true, call('add_signer', u32(0), delegated(st.C)), [0], [B, D]);
  const dId = Number(Sdk.scValToNative((await sim(call('get_signer_id', delegated(kD.publicKey())))).result.retval));
  await run('T5. session + C remove D', true, call('remove_signer', u32(0), u32(dId)), [0], [s.signer, C]);
  await run('T5a. session + C set D weight 0 (cleanup)', true, await weight(kD.publicKey(), 0), [0], [s.signer, C]);
  await run('T6. D can no longer approve (D + B)', false, call('remove_signer', u32(0), u32(0)), [0], [D, B]);
  await run('T7. session alone cannot raise its own weight', false, await weight(st.S, 2), [0], [s.signer]);
  const w = Sdk.scValToNative((await sim(new Sdk.Contract(WEIGHTED).call('get_signer_weights', await rule0(), addr(st.prime)))).result.retval);
  log('weights now', JSON.stringify(w, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}
