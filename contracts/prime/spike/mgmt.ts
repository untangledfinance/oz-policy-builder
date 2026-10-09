// Spike: owner policy management through a session, rule 0 untouchable without A.
//   rule 0 (unchanged): A (NEAR MPC), B, C - simple_threshold 2
//   rule M (new): CallContract(PRIME), signers A, S, B, C,
//     weighted_threshold {A:1, S:1, B:2, C:2} >= 3 (owner counts once)
//     + grammar-6 interpreter predicate (which admin calls, on which rules)
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 as vsha, toBytes, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Sdk, XLM, accountSig, invokeAs, keypair, localSigner, log, save, server, state } from './stellar.ts';
import { DOMAIN, TYPES } from './eip712.ts';
import { metamask, mpcSign } from './mm.ts';
const S_ = Sdk.xdr.ScVal;
const INTERP = 'CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ'; // grammar 6, testnet
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2'; // OZ weighted_threshold, testnet (app pin)
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF';
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const st = state();
const fee = keypair('secrets/fee-payer.json');
const PRIME: string = st.prime, SIGNER: string = st.signer2;
const kB = keypair('secrets/admin-b.json'), kC = keypair('secrets/admin-c.json');
const attacker = keypair('secrets/attacker.json').publicKey();

// --- encoding helpers -------------------------------------------------------
const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: Sdk.xdr.ScVal[]) => S_.scvVec(x);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const map = (entries: [Sdk.xdr.ScVal, Sdk.xdr.ScVal][]) => S_.scvMap(entries.map(([k, v]) => new Sdk.xdr.ScMapEntry({ key: k, val: v }))
  .sort((l, r) => (l.key().switch().name === 'scvSymbol' && r.key().switch().name === 'scvSymbol')
    ? Buffer.compare(Buffer.from(l.key().sym()), Buffer.from(r.key().sym())) : Buffer.compare(l.key().toXDR(), r.key().toXDR())));
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const P = { and: (c: Sdk.xdr.ScVal[]) => vec([sym('and'), vec(c)]), or: (c: Sdk.xdr.ScVal[]) => vec([sym('or'), vec(c)]),
  cmp: (op: string, l: Sdk.xdr.ScVal, r: Sdk.xdr.ScVal) => vec([sym(op), l, r]), in: (n: Sdk.xdr.ScVal, h: Sdk.xdr.ScVal[]) => vec([sym('in'), n, vec(h)]),
  fn: vec([sym('call_fn')]), arg: (i: number) => vec([sym('call_arg'), u32(i)]), path: (...s: number[]) => vec([sym('call_path'), ...s.map(u32)]) };
const lenStep = (i: number) => vec([sym('call_path'), u32(i), S_.scvBool(true)]);
function predicate(M: number, tight = process.env.TIGHT === '1' || (st.mgmtNonce ?? 1) >= 3) {
  return P.or([
    P.and([ P.cmp('eq', P.fn, sym('add_context_rule')),
            P.cmp('eq', P.path(0, 0), sym('CallContract')),
            P.in(P.path(0, 1), [addr(POOL), addr(XLM)]),
            ...(tight ? [ P.cmp('eq', lenStep(3), u32(1)),
                          P.cmp('eq', P.path(3, 0, 0), sym('Delegated')),
                          P.in(P.path(3, 0, 1), [addr(SIGNER)]) ] : []) ]),
    P.and([ P.in(P.fn, ['remove_context_rule', 'update_context_rule_valid_until', 'update_context_rule_name', 'add_policy', 'remove_policy'].map(sym)),
            P.cmp('gt', P.arg(0), u32(M)) ]),
  ]);
}
function mgmtRuleArgs(M: number) {
  const pred = Buffer.from(predicate(M).toXDR());
  const interp = map([[sym('grammar_version'), u32(6)], [sym('install_nonce'), u32(1)], [sym('policy_admins'), vec([delegated(st.admin)])],
    [sym('predicate'), S_.scvBytes(pred)], [sym('predicate_hash'), S_.scvBytes(Sdk.hash(pred))]]);
  const weights = map([[sym('signer_weights'), map([[delegated(st.admin), u32(1)], [delegated(SIGNER), u32(1)], [delegated(st.adminB), u32(2)], [delegated(st.adminC), u32(2)]])], [sym('threshold'), u32(3)]]);
  return [vec([sym('CallContract'), addr(PRIME)]), S_.scvString('owner_management'), S_.scvVoid(),
    vec([st.admin, SIGNER, st.adminB, st.adminC].map(delegated)), map([[addr(INTERP), interp], [addr(WEIGHTED), weights]])];
}
const rule = (target: string | null, name: string, signer: string) => [target ? vec([sym('CallContract'), addr(target)]) : vec([sym('Default')]),
  S_.scvString(name), S_.scvVoid(), vec([delegated(signer)]), S_.scvMap([])];
const call = (fn: string, ...a: Sdk.xdr.ScVal[]) => new Sdk.Contract(PRIME).call(fn, ...a);

// --- signers -----------------------------------------------------------------
const A = { address: st.admin, signNested: async (p: Buffer) => {
  const { sig, ms, nearTx } = await mpcSign(p, st.path); log(`  A via MetaMask -> NEAR MPC ${ms} ms (${nearTx})`);
  if (!ed25519.verify(sig, p, Sdk.StrKey.decodeEd25519PublicKey(st.admin))) throw new Error('bad MPC sig');
  return accountSig(Sdk.StrKey.decodeEd25519PublicKey(st.admin), sig); } };
const B = localSigner(kB), C = localSigner(kC);
async function sessionSigner(wallet = metamask) {
  const kp = Sdk.Keypair.random(), until = (await server.getLatestLedger()).sequence + 720;
  const g = await wallet.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message: { signer: SIGNER, sessionKey: toHex(kp.rawPublicKey()), validUntil: until, network: vsha(toBytes(Sdk.Networks.TESTNET)) } });
  const rs = Buffer.from(g.slice(2, 130), 'hex'), v = parseInt(g.slice(130, 132), 16);
  return { address: SIGNER, signNested: async (p: Buffer) => vec([S_.scvBytes(kp.rawPublicKey()), u32(until), S_.scvBytes(rs), u32(v), S_.scvBytes(kp.sign(p))]) };
}
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 200);
const results: Record<string, unknown> = { ...(st.mgmt ?? {}) };
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: any[]) {
  const r = await invokeAs({ feePayer: fee, op, account: PRIME, ruleIds, signers });
  const pass = r.ok === expectOk;
  results[name] = { pass, ok: r.ok, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}` : `refused: ${short(r.error)}`);
  save({ mgmt: results });
  return r;
}
const sim = async (op: Sdk.xdr.Operation) => {
  const tx = new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(op).setTimeout(30).build();
  return (await server.simulateTransaction(tx)) as any;
};
const part = process.argv[2];

if (part === 'setup') {
  if (st.mgmtRule != null) { log('already installed as rule', st.mgmtRule); process.exit(0); }
  // Recording simulation returns the new rule's id; the predicate needs it.
  const probe = await sim(call('add_context_rule', ...mgmtRuleArgs(9999)));
  if (probe.error) { log('probe failed', probe.error.slice(0, 600)); process.exit(1); }
  const M = (Sdk.scValToNative(probe.result.retval) as any).id as number;
  log('management rule will be id', M);
  const r = await invokeAs({ feePayer: fee, op: call('add_context_rule', ...mgmtRuleArgs(M)), account: PRIME, ruleIds: [0], signers: [A, B] });
  log('install', JSON.stringify(r));
  if (r.ok) save({ mgmtRule: M, mgmtTx: r.hash });
}
const M: number = st.mgmtRule;
if (part === 'a') {
  const S = await sessionSigner();
  const r1 = await run('W1. S+B add a rule for the Blend pool (via M)', true, call('add_context_rule', ...rule(POOL, 'mgmt_test', SIGNER)), [M], [S, B]);
  let id = -1; for (let i = M + 1; i < M + 12; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === 'mgmt_test') id = i; }
  log('new rule id', id); save({ mgmtTestRule: id });
  await run('W2. S+B change that rule\'s expiry', true, call('update_context_rule_valid_until', u32(id), u32((await server.getLatestLedger()).sequence + 5000)), [M], [S, B]);
  await run('W3. S+B remove that rule', true, call('remove_context_rule', u32(id)), [M], [S, B]);
  await run('W4. S+B add a signer to rule 0', false, call('add_signer', u32(0), delegated(attacker)), [M], [S, B]);
  await run('W5. S+B remove rule 0', false, call('remove_context_rule', u32(0)), [M], [S, B]);
  await run('W6. S+B remove M\'s interpreter', false, call('remove_policy', u32(M), u32(0)), [M], [S, B]);
  await run('W7. S+B add a rule for every call (Default)', false, call('add_context_rule', ...rule(null, 'evil', attacker)), [M], [S, B]);
  await run('W8. S+B add a rule scoped to the account itself', false, call('add_context_rule', ...rule(PRIME, 'evil', attacker)), [M], [S, B]);
}
if (part === 'b') {
  const S = await sessionSigner();
  await run('W9. S+B execute (XLM transfer out)', false, call('execute', addr(XLM), sym('transfer'), vec([addr(PRIME), addr(fee.publicKey()), Sdk.nativeToScVal(1n, { type: 'i128' })])), [M], [S, B]);
  await run('W10. S+B upgrade the account', false, call('upgrade', S_.scvBytes(Buffer.from(ACCOUNT_WASM_HASH, 'hex')), addr(fee.publicKey())), [M], [S, B]);
  await run('W11. S+B batch_add_signer on rule 0', false, call('batch_add_signer', u32(0), vec([delegated(attacker)])), [M], [S, B]);
  await run('W12. S+B expire M', false, call('update_context_rule_valid_until', u32(M), u32((await server.getLatestLedger()).sequence + 10)), [M], [S, B]);
  await run('W14. S alone (weight 1)', false, call('add_context_rule', ...rule(POOL, 'mgmt_test2', SIGNER)), [M], [S]);
  await run('W15. S+B through rule 0', false, call('add_context_rule', ...rule(POOL, 'mgmt_test2', SIGNER)), [0], [S, B]);
  await run('W16. S+B through the old XLM session rule', false, call('add_context_rule', ...rule(POOL, 'mgmt_test2', SIGNER)), [3], [S, B]);
  const stranger = await sessionSigner(privateKeyToAccount(generatePrivateKey()));
  await run('W17. a session granted by another wallet + B', false, call('add_context_rule', ...rule(POOL, 'mgmt_test2', SIGNER)), [M], [stranger, B]);
}
if (part === 'c') {
  const S = await sessionSigner();
  await run('W18. A+S: the owner twice (weight 2)', false, call('add_context_rule', ...rule(POOL, 'mgmt_test3', SIGNER)), [M], [A, S]);
}
if (part === 'd') {
  const r = await run('W19. B+C (weight 4) add a rule', true, call('add_context_rule', ...rule(XLM, 'mgmt_bc', SIGNER)), [M], [B, C]);
  let id = -1; for (let i = M + 1; i < M + 12; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === 'mgmt_bc') id = i; }
  const S0 = await sessionSigner();
  await run('W13. S+B add a signer to that later rule', false, call('add_signer', u32(id), delegated(attacker)), [M], [S0, B]);
  await run('W20. B+C remove it again', true, call('remove_context_rule', u32(id)), [M], [B, C]);
  // The predicate itself: re-install a permissive one directly on the interpreter.
  const loose = Buffer.from(P.cmp('eq', P.fn, sym('add_signer')).toXDR());
  const reinstall = new Sdk.Contract(INTERP).call('install',
    map([[sym('grammar_version'), u32(6)], [sym('install_nonce'), u32(2)], [sym('policy_admins'), vec([delegated(st.admin)])], [sym('predicate'), S_.scvBytes(loose)], [sym('predicate_hash'), S_.scvBytes(Sdk.hash(loose))]]),
    (await sim(call('get_context_rule', u32(M)))).result.retval, addr(PRIME));
  const S = await sessionSigner();
  await run('W21. S+B replace M\'s predicate on the interpreter', false, reinstall, [M], [S, B]);
  await run('W22. B+C replace it through rule 0 (no A)', false, reinstall, [0], [B, C]);
}
if (part === 'a6') {
  const S = await sessionSigner();
  const pid = Sdk.scValToNative((await sim(call('get_policy_id', addr(INTERP)))).result.retval) as number;
  const wid = Sdk.scValToNative((await sim(call('get_policy_id', addr(WEIGHTED)))).result.retval) as number;
  log('policy ids on the account: interpreter', pid, 'weighted', wid);
  await run('W6. S+B remove M\'s interpreter', false, call('remove_policy', u32(M), u32(pid)), [M], [S, B]);
  await run('W6b. S+B remove M\'s weighted_threshold', false, call('remove_policy', u32(M), u32(wid)), [M], [S, B]);
}

if (part === 'b2') {
  const S = await sessionSigner();
  await run('W9. S+B execute (XLM transfer out)', false, call('execute', addr(XLM), sym('transfer'), vec([addr(PRIME), addr(fee.publicKey()), Sdk.nativeToScVal(1n, { type: 'i128' })])), [M], [S, B]);
  await run('W10. S+B upgrade the account', false, call('upgrade', S_.scvBytes(Buffer.from(ACCOUNT_WASM_HASH, 'hex')), addr(fee.publicKey())), [M], [S, B]);
}

if (part === 'e') {
  // Positive control for W22: the same re-install (same predicate, nonce 2) with A signing as policy admin.
  const same = Buffer.from(predicate(M).toXDR());
  const reinstall = new Sdk.Contract(INTERP).call('install',
    map([[sym('grammar_version'), u32(6)], [sym('install_nonce'), u32(2)], [sym('policy_admins'), vec([delegated(st.admin)])], [sym('predicate'), S_.scvBytes(same)], [sym('predicate_hash'), S_.scvBytes(Sdk.hash(same))]]),
    (await sim(call('get_context_rule', u32(M)))).result.retval, addr(PRIME));
  const r = await invokeAs({ feePayer: fee, op: reinstall, account: PRIME, ruleIds: [0], signers: [A, B], others: { [st.admin]: A.signNested } });
  const pass = r.ok;
  results['W23. control: A+B, A also signing as policy admin, re-install the same predicate'] = { pass, ok: r.ok, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', 'W23 control', r.ok ? `ok ${r.ms} ms ${r.hash}` : `refused: ${short(r.error)}`);
  save({ mgmt: results });
}
const findRule = async (name: string) => { for (let i = M + 1; i < M + 20; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === name) return i; } return -1; };
if (part === 'f') {
  const S = await sessionSigner();
  await run('W24. S+B add an XLM rule whose only signer is the thief (before tightening)', true, call('add_context_rule', ...rule(XLM, 'thief_rule', attacker)), [M], [S, B]);
  const id = await findRule('thief_rule'); log('thief rule id', id);
  if (id > 0) await run('W24 cleanup: S+B remove it', true, call('remove_context_rule', u32(id)), [M], [S, B]);
}

if (part === 'tighten') {
  const tight = Buffer.from(predicate(M, true).toXDR());
  const reinstall = new Sdk.Contract(INTERP).call('install',
    map([[sym('grammar_version'), u32(6)], [sym('install_nonce'), u32(3)], [sym('policy_admins'), vec([delegated(st.admin)])], [sym('predicate'), S_.scvBytes(tight)], [sym('predicate_hash'), S_.scvBytes(Sdk.hash(tight))]]),
    (await sim(call('get_context_rule', u32(M)))).result.retval, addr(PRIME));
  const r = await invokeAs({ feePayer: fee, op: reinstall, account: PRIME, ruleIds: [0], signers: [A, B], others: { [st.admin]: A.signNested } });
  log('tighten', JSON.stringify(r));
  if (r.ok) save({ mgmtNonce: 3, tightenTx: r.hash });
}
if (part === 'g') {
  const S = await sessionSigner();
  await run('W24b. S+B add a rule whose only signer is the thief (after tightening)', false, call('add_context_rule', ...rule(XLM, 'thief_rule', attacker)), [M], [S, B]);
  await run('W24c. S+B add a rule with signers S and the thief', false, call('add_context_rule', rule(XLM, 'thief_rule2', SIGNER)[0]!, S_.scvString('thief_rule2'), S_.scvVoid(), vec([delegated(SIGNER), delegated(attacker)]), S_.scvMap([])), [M], [S, B]);
  await run('W25. S+B add a rule whose only signer is the session-signer (after tightening)', true, call('add_context_rule', ...rule(XLM, 'session_rule_ok', SIGNER)), [M], [S, B]);
  const id = await findRule('session_rule_ok');
  if (id > 0) await run('W25 cleanup: S+B remove it', true, call('remove_context_rule', u32(id)), [M], [S, B]);
}
